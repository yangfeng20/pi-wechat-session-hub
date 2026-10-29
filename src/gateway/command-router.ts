import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ConfigurationStore } from "../config/store.ts";
import type { ManagerConfiguration, RuntimeMode } from "../config/types.ts";
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
   * 创建后台或可见 UI Pi session 并原子切换当前 route 绑定。
   *
   * @param routeId 微信 route ID。
   * @param mode 新会话运行模式, 缺省为后台。
   * @param projectAlias 用户指定项目 alias。
   * @param name 可选 session 名称。
   * @param config 当前配置快照。
   * @returns 创建结果。
   */
  private async handleNew(
    routeId: string,
    mode: RuntimeMode | undefined,
    projectAlias: string | undefined,
    name: string | undefined,
    config: ManagerConfiguration,
  ): Promise<string> {
    const requestedMode = mode ?? "background";
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
    const indexedSession = newSnapshot.sessions[session.sessionId];
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
    const stateText = indexedSession?.state === "pending" ? "等待首条 transcript 写入" : "活跃";
    const modeText = requestedMode === "ui" ? "可见 UI" : "后台";
    return `${modeText} Pi session 已创建: ${indexedSession?.name ?? `#${indexedSession?.publicIndex ?? "?"}`} (${alias}, ${stateText})。`;
  }

  /**
   * 列出 sessions, 不更改当前 route。
   *
   * @param routeId 当前微信 route ID。
   * @param projectAlias 可选项目筛选。
   * @param state 状态筛选。
   * @param page 页码。
   * @param config 当前配置快照。
   * @returns 分页清单文本。
   */
  private async formatSessions(
    routeId: string,
    projectAlias: string | undefined,
    state: "default" | "active" | "saved" | "pending" | "all",
    page: number,
    config: ManagerConfiguration,
  ): Promise<string> {
    const snapshot = await this.registry.readSnapshot();
    const currentRouteSessionId = snapshot.routes[routeId]?.sessionId;
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
    const pageSize = 5;
    const pageCount = Math.max(1, Math.ceil(sessions.length / pageSize));
    if (page > pageCount) {
      return `没有第 ${page} 页; 共 ${pageCount} 页。`;
    }
    const pageSessions = sessions.slice((page - 1) * pageSize, page * pageSize);
    if (pageSessions.length === 0) {
      return "没有匹配的会话。";
    }
    const displaySessions = await Promise.all(pageSessions.map(async (session) => ({
      session,
      title: await resolveSessionTitle(session),
    })));
    const currentRouteSession = currentRouteSessionId
      ? snapshot.sessions[currentRouteSessionId]
      : undefined;
    const currentRouteLabel = currentRouteSession
      ? `当前微信路由：#${currentRouteSession.publicIndex ?? "?"}`
      : undefined;
    const cards = displaySessions.map(({ session, title }) => {
      const projectName = Object.hasOwn(config.projects, session.projectAlias)
        ? config.projects[session.projectAlias].displayName
        : session.projectAlias;
      const status = activeSessionIds.has(session.sessionId)
        ? session.state === "pending" ? "等待首条记录" : "活跃"
        : session.state === "pending" ? "等待首条记录" : "已保存";
      const mode = activeSessionIds.has(session.sessionId) && session.mode === "ui" ? "前台" : "后台";
      const currentMark = currentRouteSessionId === session.sessionId ? "【当前】" : "";
      return `${currentMark}#${session.publicIndex ?? "?"} ${title}\n项目：${projectName} · ${mode} · ${status}`;
    });
    const pageHint = pageCount > 1
      ? page < pageCount
        ? `下一页：${buildSessionsPageCommand(page + 1, projectAlias, state)}`
        : `上一页：${buildSessionsPageCommand(page - 1, projectAlias, state)}`
      : undefined;
    return [
      `会话列表 · 第 ${page}/${pageCount} 页 · 共 ${sessions.length} 个`,
      ...(currentRouteLabel ? [currentRouteLabel] : []),
      ...cards,
      "切换会话：/resume <索引或名称>",
      ...(pageHint ? [pageHint] : []),
    ].join("\n\n");
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
  ): Promise<string> {
    const session = await this.resolveSessionSelector(selector);
    const previousRoute = (await this.registry.readSnapshot()).routes[routeId];
    await this.workerManager.resume(session.sessionId);
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
      sessionId: session.sessionId,
      workerInstanceId: owner.instanceId,
      generation: (Object.hasOwn(snapshot.routes, routeId) ? snapshot.routes[routeId].generation : 0) + 1,
      updatedAt: new Date().toISOString(),
    });
    const confirmation = `已恢复会话 #${session.publicIndex ?? "?"} ${session.name ?? "未命名"} (${session.projectAlias})。`;
    if (previousRoute?.sessionId === session.sessionId || owner.state !== "idle") {
      return confirmation;
    }
    const latestAssistantText = await readLatestAssistantText(session.sessionFile);
    if (!latestAssistantText) {
      return confirmation;
    }
    const preview = truncateResumeAssistantText(latestAssistantText);
    return `${confirmation}\n\n最近一次回复${preview.truncated ? "（节选）" : ""}：\n${preview.text}${
      preview.truncated ? "\n\n[内容较长, 完整回复仍保留在会话记录中。]" : ""
    }`;
  }

  /**
   * 只读展示指定或当前 route 会话的最近一轮对话, 不更改 route 绑定, 也不投递 prompt。
   *
   * @param routeId 微信 route ID。
   * @param selector 可选会话索引或名称。
   * @param config 当前配置快照。
   * @returns 最近一轮对话的只读摘要。
   */
  private async handleLast(
    routeId: string,
    selector: string | undefined,
    config: ManagerConfiguration,
  ): Promise<string> {
    const snapshot = await this.registry.readSnapshot();
    const boundSessionId = Object.hasOwn(snapshot.routes, routeId)
      ? snapshot.routes[routeId].sessionId
      : undefined;
    const session = selector
      ? await this.resolveSessionSelector(selector)
      : boundSessionId && Object.hasOwn(snapshot.sessions, boundSessionId)
        ? snapshot.sessions[boundSessionId]
        : undefined;
    if (!session) {
      return "当前微信路由没有绑定会话。使用 /sessions 查看列表, 或 /last <索引> 查看指定会话。";
    }
    const running = Object.values(snapshot.instances).some((instance) =>
      instance.sessionId === session.sessionId && instance.state === "running"
    );
    const projectName = Object.hasOwn(config.projects, session.projectAlias)
      ? config.projects[session.projectAlias].displayName
      : session.projectAlias;
    const title = await resolveSessionTitle(session);
    const header = [
      `会话 #${session.publicIndex ?? "?"} ${title} · ${projectName}`,
      `最后活动：${formatLocalMinute(session.lastActivityAt)} · ${session.mode === "ui" ? "前台" : "后台"}`,
    ];
    const turn = await readLatestTurn(session.sessionFile);
    if (!turn) {
      return [
        ...header,
        "",
        session.state === "pending"
          ? "该会话尚未写入任何对话记录。"
          : "未能读取该会话的对话记录。",
      ].join("\n");
    }

    const body: string[] = [];
    if (turn.userText) {
      const userPreview = truncateTurnText(turn.userText);
      body.push(`你：\n${userPreview.text}`, ...(userPreview.truncated ? ["[提问较长, 已截断。]"] : []));
    }
    if (turn.assistantText) {
      const assistantPreview = truncateTurnText(turn.assistantText);
      body.push(
        `AI${assistantPreview.truncated ? "（节选）" : ""}：\n${assistantPreview.text}`,
        ...(assistantPreview.truncated ? ["[回复较长, 完整内容仍在会话记录中。]"] : []),
      );
    } else {
      body.push("AI：尚未产生回复。");
    }
    return [
      ...header,
      ...(running ? ["⚠️ 该会话正在运行, 以下为目前已落盘的内容。"] : []),
      "",
      "最近一轮对话",
      ...body,
      "",
      selector ? "发送 /resume " + (session.publicIndex ?? selector) + " 可切换到此会话。" : "发送任意内容可继续对话。",
    ].join("\n");
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
      ? `会话 #${session.publicIndex ?? "?"} 已停止, 但尚无 transcript 文件, 因此不能恢复。`
      : `会话 #${session.publicIndex ?? "?"} 已停止并保存。`;
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
      return "当前没有活动会话。请先使用 /new --project <alias> 创建后台会话, 再用 /resume <索引> 切换。";
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
      return "当前 route 没有可用的 Pi worker; 请使用 /resume <索引> 重连。";
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
      item.state === "queued" || item.state === "failed" || item.state === "interrupted",
    ).length;
    const projectCount = Object.keys(config.projects).length;
    const projectName = session
      ? Object.hasOwn(config.projects, session.projectAlias)
        ? config.projects[session.projectAlias].displayName
        : session.projectAlias
      : undefined;
    const sessionTitle = session
      ? `#${session.publicIndex ?? "?"} ${await resolveSessionTitle(session)}`
      : "未绑定";
    const workerLabel = instance
      ? `${instance.mode === "ui" ? "前台" : "后台"} · ${formatWorkerState(instance.state)}`
      : "未运行";
    return [
      `Hub 状态：${formatGatewayState(snapshot.gateway?.state)}`,
      `当前微信会话：${sessionTitle}`,
      ...(projectName ? [`项目：${projectName}`] : []),
      `Pi：${workerLabel}`,
      `未完成消息：${pendingQueueCount} 条`,
      `已登记项目：${projectCount} 个`,
    ].join("\n");
  }

  /**
   * 按稳定数字索引或名称查找唯一 session。
   *
   * @param selector 用户输入选择器。
   * @returns 唯一匹配 session。
   */
  private async resolveSessionSelector(selector: string): Promise<SessionIndexRecord> {
    const snapshot = await this.registry.readSnapshot();
    const normalized = selector.toLowerCase();
    if (/^[1-9]\d*$/.test(normalized)) {
      const publicIndex = Number(normalized);
      const indexedSession = Object.values(snapshot.sessions).find((session) =>
        session.publicIndex === publicIndex,
      );
      if (indexedSession) {
        return indexedSession;
      }
    }
    const matches = Object.values(snapshot.sessions).filter((session) =>
      session.name?.toLowerCase() === normalized,
    );
    if (matches.length === 0) {
      throw new BackgroundWorkerManagerError("session_not_found", `未找到会话索引或名称: ${selector}。`);
    }
    if (matches.length > 1) {
      throw new GatewayCommandParseError(`会话名称匹配到多个结果: ${selector}; 请使用数字索引。`);
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
          return await this.formatSessions(routeId, command.projectAlias, command.state, command.page, config);
        case "resume":
          return await this.handleResume(routeId, command.selector);
        case "last":
          return await this.handleLast(routeId, command.selector, config);
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

const SESSION_TITLE_LIMIT = 32;
const RESUME_ASSISTANT_TEXT_LIMIT = 800;
const LAST_TURN_TEXT_LIMIT = 600;
const TAIL_READ_BYTES = 256 * 1024;
const TAIL_READ_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 生成保留当前筛选条件的会话翻页命令.
 *
 * @param page 目标页码.
 * @param projectAlias 可选项目 alias.
 * @param state 当前会话状态筛选.
 * @returns 可直接发送到微信的下一页或上一页命令.
 */
function buildSessionsPageCommand(
  page: number,
  projectAlias: string | undefined,
  state: "default" | "active" | "saved" | "pending" | "all",
): string {
  const arguments_: string[] = [];
  if (projectAlias) {
    arguments_.push(`--project ${projectAlias}`);
  }
  if (state !== "default") {
    arguments_.push(`--state ${state}`);
  }
  arguments_.push(`--page ${page}`);
  return `/sessions ${arguments_.join(" ")}`;
}

/**
 * 将 Gateway 生命周期状态转换为面向微信用户的中文说明.
 *
 * @param state Gateway 当前状态.
 * @returns 简短的中文状态说明.
 */
function formatGatewayState(state: string | undefined): string {
  switch (state) {
    case undefined:
      return "未启动";
    case "starting":
      return "启动中";
    case "online":
      return "在线";
    case "auth_required":
      return "需要重新登录";
    case "stopping":
      return "停止中";
    case "stopped":
      return "已停止";
    case "lease_lost":
      return "连接异常";
    default:
      return "状态未知";
  }
}

/**
 * 将 Pi worker 生命周期状态转换为面向微信用户的中文说明.
 *
 * @param state worker 当前状态.
 * @returns 简短的中文状态说明.
 */
function formatWorkerState(state: string): string {
  switch (state) {
    case "starting":
      return "启动中";
    case "idle":
      return "空闲";
    case "running":
      return "运行中";
    case "stopping":
      return "停止中";
    case "stale":
      return "断连待恢复";
    default:
      return "状态未知";
  }
}

/**
 * 解析 session 显示标题: 优先使用名称, 否则使用 Pi resume 列表采用的首条用户文本。
 *
 * @param session Hub session 索引。
 * @returns 已清理并截断的会话标题。
 */
async function resolveSessionTitle(session: SessionIndexRecord): Promise<string> {
  const name = session.name ? normalizeSessionTitle(session.name) : "";
  const firstMessage = name ? undefined : await readFirstUserMessage(session.sessionFile);
  return truncateSessionTitle(name || firstMessage || "（尚无用户消息）");
}

/**
 * 从 Pi JSONL session 文件中读取首条非空 user 文本。
 *
 * @param sessionFile Pi session 文件路径。
 * @returns 首条用户文本, 不存在或无法读取时返回 undefined。
 */
async function readFirstUserMessage(sessionFile: string): Promise<string | undefined> {
  let input: ReturnType<typeof createReadStream> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  try {
    input = createReadStream(sessionFile, { encoding: "utf8" });
    lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
        continue;
      }
      const message = entry.message;
      if (message.role !== "user") {
        continue;
      }
      const content = message.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
            .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
            .map((block) => (block as { text: string }).text)
            .join(" ")
          : "";
      const normalized = normalizeSessionTitle(text);
      if (normalized) {
        return normalized;
      }
    }
  } catch {
    return undefined;
  } finally {
    lines?.close();
    input?.destroy();
  }
  return undefined;
}

/**
 * 从 Pi JSONL session 文件读取最近一条 assistant 对外文本.
 *
 * @param sessionFile Pi transcript 文件路径.
 * @returns 最近一条非空 assistant 文本, 无法读取或不存在时返回 undefined.
 */
async function readLatestAssistantText(sessionFile: string): Promise<string | undefined> {
  let input: ReturnType<typeof createReadStream> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let latestText: string | undefined;
  try {
    input = createReadStream(sessionFile, { encoding: "utf8" });
    lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
        continue;
      }
      const message = entry.message;
      if (message.role !== "assistant") {
        continue;
      }
      const content = message.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
            .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
            .map((block) => (block as { type: "text"; text: string }).text)
            .join("")
          : "";
      const normalized = normalizeAssistantText(text);
      if (normalized) {
        latestText = normalized;
      }
    }
  } catch {
    return undefined;
  } finally {
    lines?.close();
    input?.destroy();
  }
  return latestText;
}

/**
 * 将 ISO 时间转换为本地时区的分钟精度文本。
 *
 * @param isoTimestamp registry 中记录的 ISO 时间。
 * @returns 形如 `2026-08-05 14:32` 的本地时间, 无法解析时返回原始文本。
 */
function formatLocalMinute(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return isoTimestamp;
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

/**
 * 将发往微信的最近一轮文本限制在固定长度内, 按 Unicode code point 截断。
 *
 * @param text 原始消息文本。
 * @returns 可安全发送的完整或截断文本。
 */
function truncateTurnText(text: string): { text: string; truncated: boolean } {
  const characters = Array.from(text);
  if (characters.length <= LAST_TURN_TEXT_LIMIT) {
    return { text, truncated: false };
  }
  return {
    text: characters.slice(0, LAST_TURN_TEXT_LIMIT).join(""),
    truncated: true,
  };
}

/**
 * 从 Pi transcript 尾部按需扩展窗口, 读取最近一轮 user 与 assistant 文本。
 *
 * 先读文件末尾固定字节区间, 按 LF 切分后从后向前定位最新的 user 与 assistant
 * 消息; 尾部首行可能是被截断的半行, 因此总是丢弃。如果窗口内找不到完整一轮
 * (常见于单条消息本身就超过初始窗口), 按倍数扩大窗口重试; 超过上限仍未命中时
 * 回退为流式全文件扫描, 保证结果正确。
 *
 * @param sessionFile Pi transcript 文件路径。
 * @returns 最近一轮 user 与 assistant 文本, 无可用记录时返回 undefined。
 */
async function readLatestTurn(sessionFile: string): Promise<LatestTurn | undefined> {
  const handle = await open(sessionFile, "r").catch(() => undefined);
  if (!handle) {
    return undefined;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return undefined;
    }
    let windowBytes = Math.min(size, TAIL_READ_BYTES);
    for (;;) {
      const start = size - windowBytes;
      const chunk = Buffer.alloc(windowBytes);
      await handle.read(chunk, 0, windowBytes, start);
      const text = chunk.toString("utf8");
      let buffer = text;
      if (start > 0) {
        const firstNewline = text.indexOf("\n");
        buffer = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
      }
      const turn = scanTurnLines(buffer);
      if (turn.assistantText !== undefined && turn.userText !== undefined) {
        return turn;
      }
      if (start === 0) {
        return turn.assistantText === undefined && turn.userText === undefined ? undefined : turn;
      }
      if (windowBytes >= TAIL_READ_MAX_BYTES) {
        const fallback = await fullScanLatestTurn(sessionFile);
        return fallback.assistantText === undefined && fallback.userText === undefined
          ? undefined
          : fallback;
      }
      windowBytes = Math.min(size, windowBytes * 2);
    }
  } finally {
    await handle.close();
  }
}

/**
 * 在一段 transcript 文本中从后向前定位最新的 user 与 assistant 文本。
 *
 * @param buffer 已剔除尾部半行的 transcript 文本片段。
 * @returns 已找到的 user 与 assistant 文本, 任意字段都可能缺失。
 */
function scanTurnLines(buffer: string): LatestTurn {
  const lines = buffer.split("\n");
  let assistantText: string | undefined;
  let userText: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractMessageText(entry.message.content);
    if (!text) {
      continue;
    }
    if (role === "assistant") {
      assistantText ??= text;
    } else if (userText === undefined) {
      userText = text;
    }
    if (assistantText !== undefined && userText !== undefined) {
      break;
    }
  }
  return { userText, assistantText };
}

/**
 * 流式扫描整个 transcript, 作为超大单条记录窗口读取失败后的兼容路径。
 *
 * @param sessionFile Pi transcript 文件路径。
 * @returns 整个文件中最后一组 user 与 assistant 文本。
 */
async function fullScanLatestTurn(sessionFile: string): Promise<LatestTurn> {
  let input: ReturnType<typeof createReadStream> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let assistantText: string | undefined;
  let userText: string | undefined;
  try {
    input = createReadStream(sessionFile, { encoding: "utf8" });
    lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
        continue;
      }
      const role = entry.message.role;
      if (role !== "user" && role !== "assistant") {
        continue;
      }
      const text = extractMessageText(entry.message.content);
      if (!text) {
        continue;
      }
      if (role === "assistant") {
        assistantText = text;
      } else {
        userText = text;
      }
    }
  } catch {
    return { userText, assistantText };
  } finally {
    lines?.close();
    input?.destroy();
  }
  return { userText, assistantText };
}

/**
 * 从 Pi message content 中提取纯文本片段, 忽略 thinking 等非对外内容。
 *
 * @param content message.content 原始值。
 * @returns 已清理的文本, 无文本时返回 undefined。
 */
function extractMessageText(content: unknown): string | undefined {
  const raw = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
        .map((block) => (block as { text: string }).text)
        .join("\n")
      : "";
  const normalized = normalizeAssistantText(raw);
  return normalized || undefined;
}

/**
 * 表示从 transcript 尾部提取出的最近一轮对话。
 */
interface LatestTurn {
  userText?: string;
  assistantText?: string;
}

/**
 * 清理 assistant 文本中的终端控制字符, 保留换行和制表符格式.
 *
 * @param text transcript 中的 assistant 文本.
 * @returns 清理并去除首尾空白后的文本.
 */
function normalizeAssistantText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
}

/**
 * 限制发往微信的恢复预览长度, 超长时保留开头内容.
 *
 * @param text 最近一次 assistant 文本.
 * @returns 可安全发送的完整或截断文本.
 */
function truncateResumeAssistantText(text: string): { text: string; truncated: boolean } {
  const characters = Array.from(text);
  if (characters.length <= RESUME_ASSISTANT_TEXT_LIMIT) {
    return { text, truncated: false };
  }
  return {
    text: characters.slice(0, RESUME_ASSISTANT_TEXT_LIMIT).join(""),
    truncated: true,
  };
}

/**
 * 清理标题中的控制字符并折叠空白, 保证每个会话只占一行。
 *
 * @param title 原始标题或用户文本。
 * @returns 去除控制字符并折叠空白后的文本。
 */
function normalizeSessionTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 将会话标题限制为 32 个 Unicode code point, 超出部分以三个点省略。
 *
 * @param title 已清理标题。
 * @returns 长度限制内的标题。
 */
function truncateSessionTitle(title: string): string {
  const characters = Array.from(title);
  if (characters.length <= SESSION_TITLE_LIMIT) {
    return title;
  }
  return `${characters.slice(0, SESSION_TITLE_LIMIT - 3).join("")}...`;
}

/**
 * 判断未知值是否为非数组对象。
 *
 * @param value 待检查的值。
 * @returns 值可安全读取字段时返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const GATEWAY_HELP_TEXT = [
  "微信命令帮助",
  "",
  "会话命令",
  "/new [--mode background|ui]",
  "  [--project <别名>] [--name <名称>]",
  "/sessions [筛选条件]",
  "  --project <别名> --state <状态> --page <页码>",
  "  状态：default / active / saved / pending / all",
  "/resume <索引或名称>",
  "/last [索引或名称]",
  "  只读查看最近一轮对话",
  "/stop [索引或名称]",
  "",
  "项目命令",
  "/projects",
  "/projects add <别名>",
  "  --name <名称> --path <绝对路径>",
  "/projects remove <别名>",
  "/projects default <别名>",
  "",
  "Hub 状态与队列",
  "/status",
  "/retry <message-id> --confirm",
  "  会重新执行原消息, 可能产生副作用。",
  "",
  "发送 /help 查看此帮助。",
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
