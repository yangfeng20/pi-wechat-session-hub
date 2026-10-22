import { ConfigurationStore } from "../config/store.ts";
import type { ManagerConfiguration } from "../config/types.ts";
import type { GatewayInboundMessage, IlinkReplyContext } from "./channel-types.ts";
import { ProjectService, ProjectServiceError } from "../projects/project-service.ts";
import { parseProjectCommand, ProjectCommandParseError } from "../commands/project-command-parser.ts";
import { parseGatewayCommand, GatewayCommandParseError } from "./command-parser.ts";
import {
  DurableMessageQueue,
  DurableQueueError,
  type DurableQueueItem,
  type QueueDispatchResult,
  type QueueProcessor,
} from "./durable-message-queue.ts";
import { ManagerRegistry } from "../registry/manager-registry.ts";
import { GatewayLease } from "../registry/gateway-lease.ts";
import type { SessionIndexRecord } from "../registry/types.ts";
import { BackgroundWorkerManagerError } from "../runtime/background-worker-manager.ts";
import type { GatewayWorkerService } from "../runtime/gateway-worker-manager.ts";
import { UiWorkerManagerError } from "../runtime/ui-worker-manager.ts";

export type InboundGatewayMessage = GatewayInboundMessage;

export interface GatewayReceiveResult {
  messageId: string;
  state: string;
  duplicate: boolean;
  reply?: string;
}

export type GatewayReplySink = (
  routeId: string,
  messageId: string,
  reply: string,
  replyContext?: IlinkReplyContext,
) => Promise<void>;

/**
 * 管理消息进入 worker 到最终回复之间的可见处理状态。
 */
export interface GatewayProcessingIndicator {
  /**
   * 开始该 queue 消息的用户可见处理状态。
   *
   * @param messageId durable queue 消息 ID。
   * @param replyContext 对应入站消息的回复上下文。
   * @returns 无返回值。
   */
  start(messageId: string, replyContext?: IlinkReplyContext): void;

  /**
   * 结束该 queue 消息的用户可见处理状态。
   *
   * @param messageId durable queue 消息 ID。
   * @returns 无返回值。
   */
  stop(messageId: string): void;
}

/**
 * 表示消息发送者未通过个人微信 allowlist。
 */
export class GatewayAuthorizationError extends Error {
  /**
   * 创建微信授权错误。
   *
   * @param code 稳定错误代码。
   * @param message 不暴露本地配置的中文错误说明。
   */
  constructor(
    readonly code: "wechat_auth_unavailable" | "unauthorized_wechat_user",
    message: string,
  ) {
    super(message);
    this.name = "GatewayAuthorizationError";
  }
}

/**
 * 将授权消息路由到管理命令或当前 Pi session, 并经 durable queue 按 route FIFO 处理。
 */
export class GatewayCommandRouter {
  private readonly configStore: ConfigurationStore;
  private readonly projectService: ProjectService;
  private readonly workerManager: GatewayWorkerService;
  private readonly registry: ManagerRegistry;
  private readonly queue: DurableMessageQueue;
  private readonly lease: GatewayLease;
  private readonly replySink?: GatewayReplySink;
  private readonly processingIndicator?: GatewayProcessingIndicator;

  /**
   * 创建 Gateway 命令路由器。
   *
   * @param options 路由依赖和可选回复发送器。
   */
  constructor(options: {
    configStore: ConfigurationStore;
    projectService: ProjectService;
    workerManager: GatewayWorkerService;
    registry: ManagerRegistry;
    queue: DurableMessageQueue;
    lease: GatewayLease;
    replySink?: GatewayReplySink;
    processingIndicator?: GatewayProcessingIndicator;
  }) {
    this.configStore = options.configStore;
    this.projectService = options.projectService;
    this.workerManager = options.workerManager;
    this.registry = options.registry;
    this.queue = options.queue;
    this.lease = options.lease;
    this.replySink = options.replySink;
    this.processingIndicator = options.processingIndicator;
  }

  /**
   * 验证 sender allowlist, 持久化去重消息并等待 FIFO 处理结果。
   *
   * @param message 正规化后的微信消息。
   * @returns 去重、处理状态及可选回复。
   * @throws {GatewayAuthorizationError} 未配置 allowlist 或 sender 不匹配时抛出。
   */
  async receive(message: InboundGatewayMessage): Promise<GatewayReceiveResult> {
    await this.lease.assertOwned();
    const { config } = await this.configStore.load();
    this.assertAuthorized(message.senderId, config);
    if (!message.messageId.trim() || !message.text.trim()) {
      throw new GatewayCommandParseError("微信消息缺少 messageId 或正文, 已拒绝路由。");
    }

    let command;
    try {
      command = parseGatewayCommand(message.text);
    } catch (error) {
      if (!(error instanceof GatewayCommandParseError)) {
        throw error;
      }
      if (this.replySink) {
        await this.replySink(message.senderId, message.messageId, error.message, message.replyContext);
      }
      return {
        messageId: message.messageId,
        state: "rejected",
        duplicate: false,
        ...(this.replySink ? {} : { reply: error.message }),
      };
    }
    const routeId = message.senderId;
    if (command.kind === "retry") {
      return this.retryMessage(
        routeId,
        command.messageId,
        message.messageId,
        command.confirmed,
        config,
        message.replyContext,
      );
    }

    const result = await this.queue.dispatch(
      routeId,
      message.messageId,
      message.text,
      config.runtime.maxQueuePerSession,
      this.createProcessor(routeId, config),
      message.replyContext,
    );
    const normalized = toReceiveResult(result);
    if (this.replySink) {
      delete normalized.reply;
    }
    return normalized;
  }

  /**
   * 快速接收入站消息: 先完成授权与 durable enqueue, 再异步触发 route drain。
   *
   * Channel poller 应在收到此方法成功返回后提交 get_updates_buf, 不必等待 Pi 模型完成。
   *
   * @param message 正规化后的微信消息。
   * @returns 入队结果, 不包含模型回复。
   * @throws {GatewayAuthorizationError} sender 未授权时抛出。
   */
  async acceptInbound(message: InboundGatewayMessage): Promise<GatewayReceiveResult> {
    await this.lease.assertOwned();
    const { config } = await this.configStore.load();
    this.assertAuthorized(message.senderId, config);
    if (!message.messageId.trim() || !message.text.trim()) {
      throw new GatewayCommandParseError("微信消息缺少 messageId 或正文, 已拒绝路由。");
    }
    if (!this.replySink) {
      throw new Error("异步 Gateway 入站处理必须配置 replySink。");
    }

    let command;
    try {
      command = parseGatewayCommand(message.text);
    } catch (error) {
      if (!(error instanceof GatewayCommandParseError)) {
        throw error;
      }
      await this.replySink(message.senderId, message.messageId, error.message, message.replyContext);
      return {
        messageId: message.messageId,
        state: "rejected",
        duplicate: false,
      };
    }
    const routeId = message.senderId;
    if (command.kind === "retry") {
      return this.retryMessage(
        routeId,
        command.messageId,
        message.messageId,
        command.confirmed,
        config,
        message.replyContext,
      );
    }

    const enqueued = await this.queue.enqueue(
      routeId,
      message.messageId,
      message.text,
      config.runtime.maxQueuePerSession,
      message.replyContext,
    );
    this.queue.drainPending(routeId, this.createProcessor(routeId, config));
    return {
      messageId: message.messageId,
      state: enqueued.item.state,
      duplicate: enqueued.duplicate,
    };
  }

  /**
   * 在 Gateway 启动时恢复指定 route 的 queued 消息。
   *
   * @param routeId route 稳定 ID。
   * @returns 无返回值。
   */
  async drainPending(routeId: string): Promise<void> {
    if (!this.replySink) {
      throw new Error("Gateway 启动恢复队列需要配置 replySink。");
    }
    await this.lease.assertOwned();
    const { config } = await this.configStore.load();
    this.queue.drainPending(routeId, this.createProcessor(routeId, config));
  }

  /**
   * 生成单条 queue 消息处理器。
   *
   * @param routeId route 稳定 ID。
   * @param config 当前配置快照。
   * @returns 处理队列消息的异步函数。
   */
  private createProcessor(routeId: string, config: ManagerConfiguration): QueueProcessor {
    return async (item) => {
      this.processingIndicator?.start(item.messageId, item.replyContext);
      try {
        const reply = await this.processQueueItem(routeId, item, config);
        if (this.replySink) {
          await this.replySink(routeId, item.messageId, reply, item.replyContext);
        }
        return reply;
      } finally {
        this.processingIndicator?.stop(item.messageId);
      }
    };
  }

  /**
   * 对失败或中断的入站消息执行显式重试; retry control command 本身不重放。
   *
   * @param routeId 微信 route ID。
   * @param targetMessageId 需要重试的原始消息 ID。
   * @param controlMessageId 当前 /retry 命令 ID。
   * @param confirmed 是否带有显式确认标志。
   * @param config 当前配置快照。
   * @returns retry 结果。
   */
  private async retryMessage(
    routeId: string,
    targetMessageId: string,
    controlMessageId: string,
    confirmed: boolean,
    config: ManagerConfiguration,
    controlReplyContext?: IlinkReplyContext,
  ): Promise<GatewayReceiveResult> {
    if (!confirmed) {
      const warning = "重试会重新执行原 prompt, 可能重复产生副作用。确认后使用 /retry <message-id> --confirm。";
      if (this.replySink) {
        await this.replySink(routeId, controlMessageId, warning, controlReplyContext);
      }
      return {
        messageId: controlMessageId,
        state: "confirmation_required",
        duplicate: false,
        ...(this.replySink ? {} : { reply: warning }),
      };
    }

    let items: DurableQueueItem[];
    try {
      items = await this.queue.recoverInterrupted(routeId);
    } catch (error) {
      const message = error instanceof DurableQueueError
        ? error.message
        : "无法安全恢复当前 route queue。";
      if (this.replySink) {
        await this.replySink(routeId, controlMessageId, message, controlReplyContext);
      }
      return {
        messageId: controlMessageId,
        state: "retry_blocked",
        duplicate: false,
        ...(this.replySink ? {} : { reply: message }),
      };
    }
    const target = items.find((item) => item.messageId === targetMessageId);
    if (!target) {
      const notFound = `未找到 queue 消息: ${targetMessageId}。`;
      if (this.replySink) {
        await this.replySink(routeId, controlMessageId, notFound, controlReplyContext);
      }
      return {
        messageId: controlMessageId,
        state: "not_found",
        duplicate: false,
        ...(this.replySink ? {} : { reply: notFound }),
      };
    }
    let originalCommand;
    try {
      originalCommand = parseGatewayCommand(target.text);
    } catch {
      originalCommand = undefined;
    }
    if (!originalCommand || originalCommand.kind === "retry") {
      const notRetryable = "无法识别原 queue 命令; 不会自动重放 control command。";
      if (this.replySink) {
        await this.replySink(routeId, controlMessageId, notRetryable, controlReplyContext);
      }
      return {
        messageId: controlMessageId,
        state: "not_retryable",
        duplicate: false,
        ...(this.replySink ? {} : { reply: notRetryable }),
      };
    }

    try {
      await this.queue.retry(routeId, targetMessageId);
    } catch (error) {
      const message = error instanceof DurableQueueError ? error.message : "queue retry 失败。";
      if (this.replySink) {
        await this.replySink(routeId, controlMessageId, message, controlReplyContext);
      }
      return {
        messageId: controlMessageId,
        state: "retry_rejected",
        duplicate: false,
        ...(this.replySink ? {} : { reply: message }),
      };
    }

    const retryNotice = `已确认重试 ${targetMessageId}; 原 prompt 会再次执行, 请留意可能的重复副作用。`;
    if (this.replySink) {
      await this.replySink(routeId, controlMessageId, retryNotice, controlReplyContext);
    }
    const result = await this.queue.dispatch(
      routeId,
      targetMessageId,
      target.text,
      config.runtime.maxQueuePerSession,
      this.createProcessor(routeId, config),
      target.replyContext,
    );
    return {
      messageId: controlMessageId,
      state: result.item.state,
      duplicate: false,
      ...(this.replySink ? {} : { reply: result.reply ?? retryNotice }),
    };
  }

  /**
   * 登记或更改一个项目 alias。
   *
   * @param arguments_ /projects 后的原始参数。
   * @returns 命令回复。
   */
  private async handleProjects(arguments_: string): Promise<string> {
    let command;
    try {
      command = parseProjectCommand(arguments_);
    } catch (error) {
      if (error instanceof ProjectCommandParseError) {
        return error.message;
      }
      throw error;
    }

    if (command.action === "list") {
      const { config, projects } = await this.projectService.list();
      if (projects.length === 0) {
        return config.allowedProjectRoots.length === 0
          ? "尚无项目 alias。请先在配置文件设置 allowedProjectRoots。"
          : "尚无项目 alias, 可用 /projects add 登记项目。";
      }
      return [
        "已登记项目:",
        ...projects.map(([alias, project]) => {
          const defaultMark = config.defaultProject === alias ? " (默认)" : "";
          return `${alias}${defaultMark}: ${project.displayName}`;
        }),
      ].join("\n");
    }
    if (command.action === "add") {
      const project = await this.projectService.add(
        command.alias,
        command.displayName,
        command.path,
      );
      return `项目已登记: ${command.alias} - ${project.displayName}`;
    }
    if (command.action === "remove") {
      await this.projectService.remove(command.alias);
      return `已移除项目登记: ${command.alias}; 项目目录未删除。`;
    }
    await this.projectService.setDefault(command.alias);
    return `默认项目已设置为: ${command.alias}`;
  }

  /**
   * 创建 background 或 UI Pi session 并原子切换当前 route 绑定。
   *
   * @param routeId 微信 route ID。
   * @param mode 用户指定模式。
   * @param projectAlias 用户指定项目 alias。
   * @param name 可选 session 名称。
   * @param config 当前配置快照。
   * @returns 创建结果。
   */
  private async handleNew(
    routeId: string,
    mode: "background" | "ui" | undefined,
    projectAlias: string | undefined,
    name: string | undefined,
    config: ManagerConfiguration,
  ): Promise<string> {
    const requestedMode = mode ?? config.defaultMode;
    const alias = projectAlias ?? config.defaultProject;
    if (!alias) {
      return "尚未设置 defaultProject。请先通过 /projects default <alias> 选择项目。";
    }

    const oldSnapshot = await this.registry.readSnapshot();
    const oldRoute = Object.hasOwn(oldSnapshot.routes, routeId)
      ? oldSnapshot.routes[routeId]
      : undefined;
    const session = await this.workerManager.startNew(alias, name, requestedMode);
    const newSnapshot = await this.registry.readSnapshot();
    const owner = Object.values(newSnapshot.instances).find((instance) =>
      instance.sessionId === session.sessionId,
    );
    if (!owner) {
      await this.workerManager.stop(session.sessionId).catch(() => undefined);
      throw new BackgroundWorkerManagerError(
        "worker_not_found",
        "Pi worker 已启动, 但 registry 未登记 owner; 已尝试优雅停止。",
      );
    }

    try {
      await this.registry.setRoute(routeId, {
        sessionId: session.sessionId,
        workerInstanceId: owner.instanceId,
        generation: (oldRoute?.generation ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.workerManager.stop(session.sessionId).catch(() => undefined);
      throw error;
    }
    const modeText = requestedMode === "ui" ? "可见 UI" : "后台";
    const stateText = session.state === "pending" ? "pending, 等待首条 transcript 写入" : "active";
    return `${modeText} Pi session 已创建: ${session.name ?? session.sessionId.slice(0, 8)} (${alias}, ${stateText})。`;
  }

  /**
   * 列出 sessions, 不更改当前 route。
   *
   * @param projectAlias 可选项目筛选。
   * @param state 状态筛选。
   * @param page 页码。
   * @param config 当前配置快照。
   * @returns 分页清单文本。
   */
  private async formatSessions(
    projectAlias: string | undefined,
    state: "default" | "active" | "saved" | "pending" | "all",
    page: number,
    config: ManagerConfiguration,
  ): Promise<string> {
    const snapshot = await this.registry.readSnapshot();
    const activeSessionIds = new Set(
      Object.values(snapshot.instances)
        .filter((instance) => instance.state !== "stale" && instance.state !== "stopping")
        .map((instance) => instance.sessionId),
    );
    const sessions = Object.values(snapshot.sessions)
      .filter((session) => !projectAlias || session.projectAlias === projectAlias)
      .filter((session) => {
        if (state === "all") {
          return true;
        }
        if (state === "active") {
          return activeSessionIds.has(session.sessionId);
        }
        if (state === "default") {
          return activeSessionIds.has(session.sessionId) || session.state === "saved";
        }
        return session.state === state;
      })
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
    const pageSize = 10;
    const pageCount = Math.max(1, Math.ceil(sessions.length / pageSize));
    if (page > pageCount) {
      return `没有第 ${page} 页; 共 ${pageCount} 页。`;
    }
    const pageSessions = sessions.slice((page - 1) * pageSize, page * pageSize);
    if (pageSessions.length === 0) {
      return "没有匹配的 session。";
    }
    return [
      `Sessions (${page}/${pageCount}):`,
      ...pageSessions.map((session) => {
          const projectName = Object.hasOwn(config.projects, session.projectAlias)
            ? config.projects[session.projectAlias].displayName
            : session.projectAlias;
          const status = activeSessionIds.has(session.sessionId)
            ? session.state === "pending" ? "pending (worker online)" : "active"
            : session.state === "pending" ? "pending" : session.state === "active" ? "stale" : "saved";
          return `${session.sessionId.slice(0, 8)} | ${session.name ?? "未命名"} | ${projectName} | ${session.mode} | ${status}`;
      }),
    ].join("\n");
  }

  /**
   * 恢复唯一匹配的 session 并切换当前 route。
   *
   * @param routeId 微信 route ID。
   * @param selector session ID 前缀或名称。
   * @param mode 用户指定恢复模式。
   * @returns 恢复结果。
   */
  private async handleResume(
    routeId: string,
    selector: string,
    mode: "background" | "ui" | undefined,
  ): Promise<string> {
    const session = await this.resolveSessionSelector(selector);
    const resumed = await this.workerManager.resume(session.sessionId, mode);
    const snapshot = await this.registry.readSnapshot();
    const owner = Object.values(snapshot.instances).find((instance) =>
      instance.sessionId === session.sessionId,
    );
    if (!owner) {
      throw new BackgroundWorkerManagerError(
        "worker_not_found",
        "Pi session 已启动, 但 registry 未找到 owner。",
      );
    }
    await this.registry.setRoute(routeId, {
      sessionId: resumed.sessionId,
      workerInstanceId: owner.instanceId,
      generation: (Object.hasOwn(snapshot.routes, routeId) ? snapshot.routes[routeId].generation : 0) + 1,
      updatedAt: new Date().toISOString(),
    });
    return `已恢复 session ${resumed.name ?? resumed.sessionId.slice(0, 8)} (${resumed.projectAlias})。`;
  }

  /**
   * 停止当前 route 或指定的活跃 Pi session。
   *
   * @param routeId 微信 route ID。
   * @param selector 可选 session ID 前缀或名称。
   * @returns 停止结果。
   */
  private async handleStop(routeId: string, selector: string | undefined): Promise<string> {
    const snapshot = await this.registry.readSnapshot();
    const binding = Object.hasOwn(snapshot.routes, routeId)
      ? snapshot.routes[routeId]
      : undefined;
    const session = selector
      ? await this.resolveSessionSelector(selector)
      : binding && Object.hasOwn(snapshot.sessions, binding.sessionId)
        ? snapshot.sessions[binding.sessionId]
        : undefined;
    if (!session) {
      return "当前 route 没有活跃 session; 可使用 /sessions 查看列表。";
    }
    await this.workerManager.stop(session.sessionId);
    if (binding?.sessionId === session.sessionId) {
      await this.registry.setRoute(routeId, null);
    }
    const stoppedSession = (await this.registry.readSnapshot()).sessions[session.sessionId];
    return stoppedSession?.state === "pending"
      ? `session ${session.sessionId.slice(0, 8)} 已停止, 但尚无 transcript 文件, 因此不能恢复。`
      : `session ${session.sessionId.slice(0, 8)} 已停止并保存。`;
  }

  /**
   * 将普通文本投递到 route 当前绑定的 background 或 UI Pi worker。
   *
   * @param routeId 微信 route ID。
   * @param text prompt 正文。
   * @returns Pi assistant 回复。
   */
  private async handlePrompt(routeId: string, text: string): Promise<string> {
    const snapshot = await this.registry.readSnapshot();
    const binding = Object.hasOwn(snapshot.routes, routeId)
      ? snapshot.routes[routeId]
      : undefined;
    if (!binding) {
      return "当前没有活动 session。请先使用 /new --mode background|ui --project <alias> 创建 session。";
    }
    const session = Object.hasOwn(snapshot.sessions, binding.sessionId)
      ? snapshot.sessions[binding.sessionId]
      : undefined;
    if (!session) {
      return "当前 route 指向的 session 不在 registry 中, 已停止投递以避免错路由。";
    }
    const worker = Object.hasOwn(snapshot.instances, binding.workerInstanceId)
      ? snapshot.instances[binding.workerInstanceId]
      : undefined;
    if (!worker || worker.state === "stale" || worker.state === "stopping") {
      return "当前 route 没有可用的 Pi worker; 请使用 /resume <session-id> 重连。";
    }
    return this.workerManager.prompt(binding.sessionId, text);
  }

  /**
   * 格式化当前 Gateway、route、worker 和队列状态。
   *
   * @param routeId 微信 route ID。
   * @param config 当前配置快照。
   * @returns 不包含凭证和完整路径的状态文本。
   */
  private async formatStatus(routeId: string, config: ManagerConfiguration): Promise<string> {
    const snapshot = await this.registry.readSnapshot();
    const binding = Object.hasOwn(snapshot.routes, routeId)
      ? snapshot.routes[routeId]
      : undefined;
    const session = binding && Object.hasOwn(snapshot.sessions, binding.sessionId)
      ? snapshot.sessions[binding.sessionId]
      : undefined;
    const instance = binding && Object.hasOwn(snapshot.instances, binding.workerInstanceId)
      ? snapshot.instances[binding.workerInstanceId]
      : undefined;
    const queueItems = await this.queue.list(routeId);
    const pendingQueueCount = queueItems.filter((item) =>
      item.state === "queued" || item.state === "processing" || item.state === "failed" || item.state === "interrupted",
    ).length;
    const projectCount = Object.keys(config.projects).length;
    return [
      `Gateway: ${snapshot.gateway?.state ?? "offline"}`,
      `微信 route: ${session ? `${session.name ?? session.sessionId.slice(0, 8)} (${session.projectAlias})` : "未绑定"}`,
      `Worker: ${instance ? `${instance.mode}/${instance.state} PID ${instance.pid}` : "none"}`,
      `Queue: ${pendingQueueCount}`,
      `项目 alias: ${projectCount}`,
    ].join("\n");
  }

  /**
   * 按 sessionId 前缀或名称查找唯一 session。
   *
   * @param selector 用户输入选择器。
   * @returns 唯一匹配 session。
   */
  private async resolveSessionSelector(selector: string): Promise<SessionIndexRecord> {
    const snapshot = await this.registry.readSnapshot();
    const normalized = selector.toLowerCase();
    const matches = Object.values(snapshot.sessions).filter((session) =>
      session.sessionId.toLowerCase().startsWith(normalized) ||
      session.name?.toLowerCase() === normalized,
    );
    if (matches.length === 0) {
      throw new BackgroundWorkerManagerError("session_not_found", `未找到 session: ${selector}。`);
    }
    if (matches.length > 1) {
      throw new GatewayCommandParseError(`session selector 匹配到多个结果: ${selector}; 请使用更长 ID。`);
    }
    return matches[0];
  }

  /**
   * 对授权用户的 queue 文本执行路由命令。
   *
   * @param routeId 微信 route ID。
   * @param item durable queue 项。
   * @param config 当前配置快照。
   * @returns 命令或 agent 回复。
   */
  private async processQueueItem(
    routeId: string,
    item: DurableQueueItem,
    config: ManagerConfiguration,
  ): Promise<string> {
    let command;
    try {
      command = parseGatewayCommand(item.text);
    } catch (error) {
      if (error instanceof GatewayCommandParseError) {
        return error.message;
      }
      throw error;
    }
    return this.processCommand(routeId, command, config);
  }

  /**
   * 执行已解析的 Gateway command 或投递普通 prompt。
   *
   * @param routeId 微信 route ID。
   * @param command 已规范化命令。
   * @param config 当前配置快照。
   * @returns 回复文本。
   */
  private async processCommand(
    routeId: string,
    command: ReturnType<typeof parseGatewayCommand>,
    config: ManagerConfiguration,
  ): Promise<string> {
    try {
      switch (command.kind) {
        case "help":
          return GATEWAY_HELP_TEXT;
        case "status":
          return await this.formatStatus(routeId, config);
        case "projects":
          return await this.handleProjects(command.arguments);
        case "new":
          return await this.handleNew(routeId, command.mode, command.projectAlias, command.name, config);
        case "sessions":
          return await this.formatSessions(command.projectAlias, command.state, command.page, config);
        case "resume":
          return await this.handleResume(routeId, command.selector, command.mode);
        case "stop":
          return await this.handleStop(routeId, command.selector);
        case "retry":
          return "`/retry` 需要由 queue 控制面直接处理, 不能作为普通 FIFO 消息执行。";
        case "prompt":
          return await this.handlePrompt(routeId, command.text);
      }
    } catch (error) {
      if (
        error instanceof ProjectServiceError ||
        error instanceof BackgroundWorkerManagerError ||
        error instanceof UiWorkerManagerError ||
        error instanceof DurableQueueError
      ) {
        return error.message;
      }
      throw error;
    }
  }

  /**
   * 仅允许配置中的个人微信用户进入消息队列。
   *
   * @param senderId 消息发送者 ID。
   * @param config 当前配置。
   * @returns 无返回值。
   * @throws {GatewayAuthorizationError} allowlist 未配置或 sender 不匹配时抛出。
   */
  private assertAuthorized(senderId: string, config: ManagerConfiguration): void {
    const authorizedUserId = config.wechat.authorizedUserId;
    if (!authorizedUserId.trim()) {
      throw new GatewayAuthorizationError(
        "wechat_auth_unavailable",
        "微信 allowlist 尚未配置, 消息未写入队列。",
      );
    }
    if (senderId !== authorizedUserId) {
      throw new GatewayAuthorizationError(
        "unauthorized_wechat_user",
        "消息来源未授权, 已在队列和路由前拒绝。",
      );
    }
  }
}

const GATEWAY_HELP_TEXT = [
  "/new [--mode background|ui] [--project <alias>] [--name <名称>]",
  "/projects [add <alias> --name <名称> --path <绝对路径> | remove <alias> | default <alias>]",
  "/sessions [--project <alias>] [--state default|active|saved|pending|all] [--page <n>]",
  "/resume <session-id-or-name> [--mode background|ui]",
  "/stop [session-id-or-name]",
  "/retry <message-id> --confirm - 显式重试失败/中断消息; 会重新执行, 可能重复产生副作用",
  "/status",
  "/help",
].join("\n");

/**
 * 将 durable queue dispatch 结果规范化为 Gateway receive 结果。
 *
 * @param result queue dispatch 结果。
 * @returns Gateway 层结果。
 */
function toReceiveResult(result: QueueDispatchResult): GatewayReceiveResult {
  return {
    messageId: result.item.messageId,
    state: result.item.state,
    duplicate: result.duplicate,
    ...(result.reply === undefined ? {} : { reply: result.reply }),
  };
}
