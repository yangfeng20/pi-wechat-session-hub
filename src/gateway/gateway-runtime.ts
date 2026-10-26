import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { ConfigurationStore } from "../config/store.ts";
import type { ManagerConfiguration } from "../config/types.ts";
import { ProjectService } from "../projects/project-service.ts";
import { GatewayCommandRouter } from "./command-router.ts";
import { DurableMessageQueue } from "./durable-message-queue.ts";
import { IlinkCredentialStore } from "./credential-store.ts";
import { IlinkApiClient } from "./wechat-ilink/api-client.ts";
import { IlinkChannelAdapter } from "./wechat-ilink/channel-adapter.ts";
import { IlinkTypingIndicator } from "./wechat-ilink/typing-indicator.ts";
import { IlinkCursorStore } from "./wechat-ilink/cursor-store.ts";
import { GatewayLease } from "../registry/gateway-lease.ts";
import { ManagerRegistry } from "../registry/manager-registry.ts";
import type { GatewayStatusRecord, RouteRecord, SessionIndexRecord, WorkerInstanceRecord } from "../registry/types.ts";
import { isProcessAlive } from "../system/process-liveness.ts";
import { BackgroundWorkerManager } from "../runtime/background-worker-manager.ts";
import { GatewayWorkerManager } from "../runtime/gateway-worker-manager.ts";
import { UiWorkerManager } from "../runtime/ui-worker-manager.ts";
import { resolveCurrentPiCli, type PiCliInvocation } from "../runtime/pi-cli.ts";
import { UiWorkerIpcServer } from "./ui-worker-ipc.ts";
import { WindowsTerminalLauncher } from "./windows-terminal-launcher.ts";

/**
 * Gateway runtime 在启动、在线、鉴权失效和停止过程中的状态。
 */
export type GatewayRuntimeState = "starting" | "online" | "auth_required" | "stopping" | "stopped" | "lease_lost";

/**
 * 表示 Gateway runtime 无法在维持单 writer 与凭证隔离的前提下启动或停止。
 */
export class GatewayRuntimeError extends Error {
  /**
   * 创建不包含 token 或消息正文的 Gateway runtime 错误。
   *
   * @param code 稳定错误代码。
   * @param message 可安全显示给用户的中文说明。
   */
  constructor(
    readonly code:
      | "configuration_incomplete"
      | "live_worker_detected"
      | "worker_capacity"
      | "registry_inconsistent"
      | "worker_shutdown_failed",
    message: string,
  ) {
    super(message);
    this.name = "GatewayRuntimeError";
  }
}

/**
 * 将 Gateway lease、registry、durable queue、background/UI worker 与 iLink poller 组合为显式启停的服务。
 */
export class GatewayRuntime extends EventEmitter {
  private heartbeatTimer?: NodeJS.Timeout;
  private stopTask?: Promise<void>;
  private currentState: GatewayRuntimeState = "starting";
  private readonly startedAt = new Date().toISOString();

  /**
   * 创建已经取得 Gateway lease 但尚未初始化完成的 runtime。
   *
   * @param options 已验证的运行配置和运行时依赖。
   */
  private constructor(
    private readonly config: ManagerConfiguration,
    private readonly lease: GatewayLease,
    private readonly registry: ManagerRegistry,
    private readonly queue: DurableMessageQueue,
    private readonly gatewayWorkerManager: GatewayWorkerManager,
    private readonly uiWorkerManager: UiWorkerManager,
    private readonly uiIpcServer: UiWorkerIpcServer,
    private readonly router: GatewayCommandRouter,
    private readonly channel: IlinkChannelAdapter,
  ) {
    super();
    this.channel.on("session_expired", () => {
      void this.markAuthRequired();
    });
    this.channel.on("poll_error", (event: { code: string }) => {
      this.emit("poll_error", event);
    });
  }

  /**
   * 读取专属凭证、取得单实例租约、恢复安全 session 并启动 iLink poller。
   *
   * @param options Gateway data directory、配置与 Pi worker 运行参数。
   * @returns 已经在线或正在等待 iLink 首次响应的 runtime。
   * @throws {GatewayRuntimeError} allowlist 未配置或旧 worker 仍存活时抛出。
   */
  static async start(options: {
    dataDirectory: string;
    configStore: ConfigurationStore;
    projectService: ProjectService;
    invocation?: PiCliInvocation;
    extensionPath?: string;
    sessionDirectory?: string;
    env?: NodeJS.ProcessEnv;
    disableDiscoveredResources?: boolean;
    lease?: GatewayLease;
    onControlReady?: (lease: GatewayLease, registry: ManagerRegistry) => Promise<void>;
    fetcher?: typeof fetch;
    uiWorkerLauncher?: Pick<WindowsTerminalLauncher, "launch">;
    uiIpcEndpoint?: string;
    uiPlatform?: NodeJS.Platform;
    credentialStoreOptions?: ConstructorParameters<typeof IlinkCredentialStore>[2];
  }): Promise<GatewayRuntime> {
    let config: ManagerConfiguration;
    try {
      const snapshot = await options.configStore.load();
      config = snapshot.config;
      if (!config.wechat.authorizedUserId.trim()) {
        throw new GatewayRuntimeError(
          "configuration_incomplete",
          "启动 Gateway 前必须配置唯一授权微信 userId。",
        );
      }
    } catch (error) {
      await options.lease?.release().catch(() => undefined);
      throw error;
    }

    const dataDirectory = resolve(options.dataDirectory);
    if (options.lease && resolve(options.lease.directory) !== dataDirectory) {
      await options.lease.release().catch(() => undefined);
      throw new GatewayRuntimeError(
        "registry_inconsistent",
        "预先取得的 Gateway lease 与 dataDirectory 不匹配。",
      );
    }
    const lease = options.lease ?? await GatewayLease.acquire(dataDirectory);
    let registry: ManagerRegistry | undefined;
    let queue: DurableMessageQueue | undefined;
    let workerManager: BackgroundWorkerManager | undefined;
    let gatewayWorkerManager: GatewayWorkerManager | undefined;
    let uiWorkerManager: UiWorkerManager | undefined;
    let uiIpcServer: UiWorkerIpcServer | undefined;
    let channel: IlinkChannelAdapter | undefined;
    try {
      const credentials = await new IlinkCredentialStore(
        dataDirectory,
        config.wechat.credentialFile,
        options.credentialStoreOptions,
      ).load(config.wechat.authorizedUserId);
      registry = new ManagerRegistry(dataDirectory, lease);
      queue = new DurableMessageQueue(dataDirectory, lease);
      const invocation = options.invocation ?? resolveCurrentPiCli();
      workerManager = new BackgroundWorkerManager({
        projectService: options.projectService,
        registry,
        invocation,
        maxBackgroundWorkers: config.runtime.maxBackgroundWorkers,
        sessionDirectory: options.sessionDirectory,
        env: options.env,
        disableDiscoveredResources: options.disableDiscoveredResources,
      });
      uiIpcServer = new UiWorkerIpcServer(dataDirectory, registry, lease, {
        ...(options.uiIpcEndpoint ? { endpoint: options.uiIpcEndpoint } : {}),
      });
      uiWorkerManager = new UiWorkerManager({
        managerDirectory: dataDirectory,
        projectService: options.projectService,
        registry,
        ipcServer: uiIpcServer,
        backgroundWorkerManager: workerManager,
        invocation,
        extensionPath: options.extensionPath ?? fileURLToPath(new URL("../../extensions/wechat-session-hub.ts", import.meta.url)),
        staleAfterMs: config.runtime.staleAfterMs,
        registrationTimeoutMs: 60000,
        ...(options.uiWorkerLauncher ? { launcher: options.uiWorkerLauncher } : {}),
        ...(options.uiPlatform ? { platform: options.uiPlatform } : {}),
      });
      gatewayWorkerManager = new GatewayWorkerManager(workerManager, uiWorkerManager, registry);
      const api = new IlinkApiClient({
        credentials,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      });
      const typingIndicator = new IlinkTypingIndicator(api);
      channel = new IlinkChannelAdapter(
        api,
        new IlinkCursorStore(join(dataDirectory, "ilink-sync.json"), lease),
        { authorizedUserId: config.wechat.authorizedUserId },
      );
      const router = new GatewayCommandRouter({
        configStore: options.configStore,
        projectService: options.projectService,
        workerManager: gatewayWorkerManager,
        registry,
        queue,
        lease,
        processingIndicator: typingIndicator,
        replySink: (routeId, messageId, reply, replyContext) =>
          channel!.sendReply(routeId, messageId, reply, replyContext),
      });
      const runtime = new GatewayRuntime(
        config,
        lease,
        registry,
        queue,
        gatewayWorkerManager,
        uiWorkerManager,
        uiIpcServer,
        router,
        channel,
      );
      await runtime.initialize(options.onControlReady);
      return runtime;
    } catch (error) {
      let cleanupFailed = false;
      try {
        await channel?.stop();
      } catch {
        cleanupFailed = true;
      }
      try {
        await queue?.waitForIdle();
      } catch {
        cleanupFailed = true;
      }
      try {
        await gatewayWorkerManager?.stopAll();
      } catch {
        cleanupFailed = true;
      }
      try {
        await uiWorkerManager?.detachGateway();
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        if (registry) {
          await registry.setGateway({
            ownerId: lease.ownerId,
            pid: lease.pid,
            processBirthId: lease.processBirthId,
            startedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            state: "stopping",
          }).catch(() => undefined);
        }
        throw new GatewayRuntimeError(
          "worker_shutdown_failed",
          "Gateway 初始化失败且后台资源未能全部停止; 为避免双 writer, manager.lock 已保留。",
        );
      }
      await registry?.setGateway(null).catch(() => undefined);
      await lease.release().catch(() => undefined);
      throw error;
    }
  }

  /**
   * 获取当前 runtime 生命周期状态。
   *
   * @returns 本进程内的 Gateway 状态。
   */
  get status(): GatewayRuntimeState {
    return this.currentState;
  }

  /**
   * 停止 poller 与后台 Pi worker, detach 可见 UI pipe, 成功后删除 Gateway 状态并释放 lease。
   *
   * 正在执行的模型 turn 会自然结束, 不会被隐式 abort。任一 worker 无法安全停止时保留 lease。
   *
   * @returns 无返回值。
   * @throws {GatewayRuntimeError} worker 未能安全停止时抛出。
   */
  async stop(): Promise<void> {
    if (this.currentState === "stopped") {
      return;
    }
    if (!this.stopTask) {
      this.stopTask = this.stopInternal();
    }
    try {
      await this.stopTask;
    } finally {
      if (!this.isStopped()) {
        this.stopTask = undefined;
      }
    }
  }

  /**
   * 判断当前 Gateway 是否已完成停止。
   *
   * @returns 已释放租约且状态记录已清理时返回 true。
   */
  private isStopped(): boolean {
    return this.currentState === "stopped";
  }

  /**
   * 持有租约期间定期更新 Gateway 状态并恢复已保存 route。
   *
   * @returns 无返回值。
   */
  private async initialize(
    onControlReady?: (lease: GatewayLease, registry: ManagerRegistry) => Promise<void>,
  ): Promise<void> {
    await this.registry.setGateway(this.toGatewayRecord("starting"));
    await this.uiWorkerManager.listen();
    await onControlReady?.(this.lease, this.registry);
    await this.recoverRoutes();
    await this.channel.start((message) => this.router.acceptInbound(message));
    if (this.currentState === "starting") {
      await this.setState("online");
    }
    this.heartbeatTimer = setInterval(() => {
      void this.refreshHeartbeat();
    }, this.config.runtime.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  /**
   * 清理遗留 owner 并恢复可安全重开的 background/UI route。
   *
   * @returns 无返回值。
   * @throws {GatewayRuntimeError} 活跃 owner 或 registry 关系不一致时抛出。
   */
  private async recoverRoutes(): Promise<void> {
    const initial = await this.registry.readSnapshot();
    for (const session of Object.values(initial.sessions)) {
      if (!isValidSession(session, session.sessionId)) {
        throw new GatewayRuntimeError(
          "registry_inconsistent",
          "session registry 字段不完整或状态不受支持; 保留原始数据并拒绝启动。",
        );
      }
    }

    const deadInstances: WorkerInstanceRecord[] = [];
    const liveUiInstances: WorkerInstanceRecord[] = [];
    const staleUiInstances: WorkerInstanceRecord[] = [];
    for (const instance of Object.values(initial.instances)) {
      if (!initial.sessions[instance.sessionId]) {
        throw new GatewayRuntimeError(
          "registry_inconsistent",
          `worker ${instance.instanceId} 引用了不存在的 session 索引; 保留 registry 并拒绝启动。`,
        );
      }
      if (!isProcessAlive(instance.pid)) {
        deadInstances.push(instance);
      } else if (instance.mode === "ui" && this.uiWorkerManager.isSupported) {
        if (instance.state === "stale" || instance.state === "stopping") {
          staleUiInstances.push(instance);
        } else {
          liveUiInstances.push(instance);
        }
      } else {
        throw new GatewayRuntimeError(
          "live_worker_detected",
          `发现仍存活的 Pi worker PID ${instance.pid} (session ${instance.sessionId}); 为避免双 writer, Gateway 未启动。`,
        );
      }
    }
    const reattachResults = await Promise.allSettled(liveUiInstances.map((instance) =>
      this.uiIpcServer.waitForReattach(instance.instanceId, this.config.runtime.staleAfterMs),
    ));
    const failedReattach = reattachResults.find((result) => result.status === "rejected");
    if (failedReattach?.status === "rejected") {
      throw failedReattach.reason instanceof Error
        ? failedReattach.reason
        : new GatewayRuntimeError("live_worker_detected", "活跃 UI worker 未能安全重连, Gateway 拒绝启动。");
    }
    await Promise.all(deadInstances.map((instance) =>
      this.registry.removeInstance(instance.instanceId),
    ));

    let snapshot = await this.registry.readSnapshot();
    const activeOwnerSessionIds = new Set(
      Object.values(snapshot.instances)
        .filter((instance) => instance.state !== "stale" && instance.state !== "stopping")
        .map((instance) => instance.sessionId),
    );
    const orphanedActiveSessions = Object.values(snapshot.sessions).filter((session) =>
      session.state === "active" && !activeOwnerSessionIds.has(session.sessionId),
    );
    const normalizedSessions = await Promise.all(orphanedActiveSessions.map(async (session) => ({
      ...session,
      state: await isPersistedSessionFile(session.sessionFile) ? "saved" as const : "pending" as const,
    })));
    await Promise.all(normalizedSessions.map((session) => this.registry.upsertSession(session)));

    snapshot = await this.registry.readSnapshot();
    const liveUiSessionIds = new Set(
      Object.values(snapshot.instances)
        .filter((instance) => instance.mode === "ui" && instance.state !== "stale" && instance.state !== "stopping")
        .map((instance) => instance.sessionId),
    );
    const staleUiSessionIds = new Set(staleUiInstances.map((instance) => instance.sessionId));
    const unownedUiSessions = Object.values(snapshot.sessions).filter((session) =>
      session.mode === "ui" &&
      !staleUiSessionIds.has(session.sessionId) &&
      !liveUiSessionIds.has(session.sessionId),
    );
    await Promise.all(unownedUiSessions.map(async (session) =>
      this.registry.upsertSession({
        ...session,
        mode: "background",
        state: await isPersistedSessionFile(session.sessionFile) ? "saved" : "pending",
      }),
    ));

    snapshot = await this.registry.readSnapshot();
    const routeAnalyses = await Promise.all(Object.entries(snapshot.routes).map(async ([routeId, route]) => {
      const session = snapshot.sessions[route.sessionId];
      if (!session || !isValidRoute(route) || !isValidSession(session, route.sessionId)) {
        throw new GatewayRuntimeError(
          "registry_inconsistent",
          `route ${routeId} 与 session registry 不一致; 保留绑定并拒绝启动。`,
        );
      }
      const owner = snapshot.instances[route.workerInstanceId];
      const ownerIsActive = Boolean(
        owner &&
        owner.sessionId === route.sessionId &&
        owner.state !== "stale" &&
        owner.state !== "stopping" &&
        this.gatewayWorkerManager.hasAvailableOwner(owner),
      );
      const sessionFileExists = await isPersistedSessionFile(session.sessionFile);
      return { routeId, route, session, ownerIsActive, sessionFileExists };
    }));

    const restorableRoutes = routeAnalyses.filter(({ session, ownerIsActive, sessionFileExists }) =>
      !ownerIsActive &&
      !staleUiSessionIds.has(session.sessionId) &&
      sessionFileExists &&
      (session.mode === "background" || this.uiWorkerManager.isSupported),
    );
    const unboundRoutes = routeAnalyses.filter(({ ownerIsActive, sessionFileExists, session }) =>
      !ownerIsActive &&
      !staleUiSessionIds.has(session.sessionId) &&
      (!sessionFileExists || (session.mode === "ui" && !this.uiWorkerManager.isSupported)),
    );
    const missingTranscriptSessions = new Map(
      unboundRoutes
        .filter(({ session, sessionFileExists }) => !sessionFileExists && session.state !== "pending")
        .map(({ session }) => [session.sessionId, { ...session, state: "pending" as const }]),
    );
    await Promise.all([
      ...[...missingTranscriptSessions.values()].map((session) => this.registry.upsertSession(session)),
      ...unboundRoutes.map(({ routeId }) => this.registry.setRoute(routeId, null)),
    ]);

    const restorableBackgroundCount = restorableRoutes.filter(({ session }) =>
      session.mode === "background",
    ).length;
    if (restorableBackgroundCount > this.config.runtime.maxBackgroundWorkers) {
      throw new GatewayRuntimeError(
        "worker_capacity",
        `可恢复 background route 数量超过 worker 上限 ${this.config.runtime.maxBackgroundWorkers}; Gateway 未启动。`,
      );
    }
    const restoreOutcomes = await Promise.allSettled(
      restorableRoutes.map((candidate) => this.restoreRoute(candidate)),
    );
    const failedRestore = restoreOutcomes.find((outcome) => outcome.status === "rejected");
    if (failedRestore?.status === "rejected") {
      if (failedRestore.reason instanceof Error) {
        throw failedRestore.reason;
      }
      throw new GatewayRuntimeError(
        "registry_inconsistent",
        "至少一个已保存 route 无法安全恢复; Gateway 未启动。",
      );
    }
    await this.registry.appendEvent("gateway.recovered", {
      staleWorkerCount: deadInstances.length,
      staleUiWorkerCount: staleUiInstances.length,
      reattachedUiWorkerCount: liveUiInstances.length,
      resumedRouteCount: restorableRoutes.length,
      unboundRouteCount: unboundRoutes.length,
    });
  }

  /**
   * 恢复一个已验证的 Pi session 并更新 route owner generation。
   *
   * @param candidate 已验证 session 文件存在的 route 候选项。
   * @returns 无返回值。
   * @throws {GatewayRuntimeError} Pi worker owner 无法写回 registry 时抛出。
   */
  private async restoreRoute(candidate: {
    routeId: string;
    route: RouteRecord;
    session: SessionIndexRecord;
  }): Promise<void> {
    const { routeId, route, session } = candidate;
    if (session.state !== "saved") {
      await this.registry.upsertSession({ ...session, state: "saved" });
    }
    const resumed = await this.gatewayWorkerManager.resume(session.sessionId, session.mode);
    const afterResume = await this.registry.readSnapshot();
    const owner = Object.values(afterResume.instances).find((instance) =>
      instance.sessionId === resumed.sessionId,
    );
    if (!owner) {
      throw new GatewayRuntimeError(
        "registry_inconsistent",
        `恢复 session ${resumed.sessionId} 后 registry 未记录 owner。`,
      );
    }
    await this.registry.setRoute(routeId, {
      ...route,
      workerInstanceId: owner.instanceId,
      generation: route.generation + 1,
      updatedAt: new Date().toISOString(),
    });
    await this.router.drainPending(routeId);
  }

  /**
   * 停止轮询与 worker 并尽可能完成 registry 清理。
   *
   * @returns 无返回值。
   * @throws {GatewayRuntimeError} 任一后台 worker 仍可能存活时抛出。
   */
  private async stopInternal(): Promise<void> {
    this.currentState = "stopping";
    this.emit("status_change", this.currentState);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    let statusWriteFailed = false;
    try {
      await this.registry.setGateway(this.toGatewayRecord("stopping"));
    } catch {
      statusWriteFailed = true;
    }
    await this.channel.stop();
    await this.queue.waitForIdle();
    await this.uiWorkerManager.detachGateway();
    try {
      await this.gatewayWorkerManager.stopAll();
    } catch {
      throw new GatewayRuntimeError(
        "worker_shutdown_failed",
        "至少一个后台 Pi worker 未能优雅停止; Gateway lease 仍保留, 可重试 /wx stop。",
      );
    }

    let registryCleanupError: unknown = statusWriteFailed ? new Error("status_write_failed") : undefined;
    try {
      await this.registry.appendEvent("gateway.stopped");
      await this.registry.setGateway(null);
    } catch (error) {
      registryCleanupError = error;
    }
    await this.lease.release();
    this.currentState = "stopped";
    this.emit("status_change", this.currentState);
    if (registryCleanupError) {
      throw new GatewayRuntimeError(
        "registry_inconsistent",
        "Gateway 已停止并释放租约, 但状态文件清理未完成; 下次启动会重新校准。",
      );
    }
  }

  /**
   * 更新 runtime 和 registry 的 Gateway 状态。
   *
   * @param state 新状态。
   * @returns 无返回值。
   */
  private async setState(state: GatewayRuntimeState): Promise<void> {
    this.currentState = state;
    this.emit("status_change", state);
    if (state !== "stopped" && state !== "lease_lost") {
      await this.registry.setGateway(this.toGatewayRecord(state));
    }
  }

  /**
   * 处理 iLink 返回 session expired, 停止继续轮询且保留 lease 供显式关闭。
   *
   * @returns 无返回值。
   */
  private async markAuthRequired(): Promise<void> {
    if (this.currentState !== "online" && this.currentState !== "starting") {
      return;
    }
    try {
      await this.setState("auth_required");
      await this.registry.appendEvent("channel.session_expired");
    } catch {
      await this.handleLeaseLoss();
    }
  }

  /**
   * 更新 Gateway owner 心跳。
   *
   * @returns 无返回值。
   */
  private async refreshHeartbeat(): Promise<void> {
    if (this.currentState !== "online" && this.currentState !== "auth_required") {
      return;
    }
    try {
      const heartbeatAt = await this.lease.heartbeat();
      await this.registry.setGateway({
        ...this.toGatewayRecord(this.currentState),
        heartbeatAt,
      });
    } catch {
      await this.handleLeaseLoss();
    }
  }

  /**
   * 失去 owner 租约后停止所有外部处理, 不触碰被替换的新 owner 锁。
   *
   * @returns 无返回值。
   */
  private async handleLeaseLoss(): Promise<void> {
    if (this.currentState === "lease_lost" || this.currentState === "stopped") {
      return;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.currentState = "lease_lost";
    this.emit("status_change", this.currentState);
    await this.channel.stop().catch(() => undefined);
    await this.queue.waitForIdle().catch(() => undefined);
    await this.gatewayWorkerManager.stopAll().catch(() => undefined);
    await this.uiWorkerManager.detachGateway().catch(() => undefined);
    await this.lease.release().catch(() => undefined);
  }

  /**
   * 将当前状态组装为 registry Gateway 记录。
   *
   * @param state 要写入的状态。
   * @returns 含 owner 和心跳信息的 Gateway 记录。
   */
  private toGatewayRecord(state: Exclude<GatewayRuntimeState, "stopped" | "lease_lost">): GatewayStatusRecord {
    const heartbeatAt = new Date().toISOString();
    return {
      ownerId: this.lease.ownerId,
      pid: this.lease.pid,
      processBirthId: this.lease.processBirthId,
      startedAt: this.startedAt,
      heartbeatAt,
      state,
    };
  }
}

/**
 * 判断 Pi session transcript 文件是否存在且为普通文件。
 *
 * @param sessionFile Pi 返回的 JSONL 文件路径。
 * @returns 文件可恢复时返回 true。
 */
async function isPersistedSessionFile(sessionFile: string): Promise<boolean> {
  try {
    return (await stat(sessionFile)).isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * 验证 session registry 的关键恢复字段。
 *
 * @param session 待校验 session 记录。
 * @param expectedSessionId 当前 route 或 worker 声明的 session ID。
 * @returns 记录完整且状态值受支持时返回 true。
 */
function isValidSession(session: SessionIndexRecord, expectedSessionId: string): boolean {
  return typeof expectedSessionId === "string" &&
    expectedSessionId.length > 0 &&
    session.sessionId === expectedSessionId &&
    typeof session.sessionFile === "string" &&
    session.sessionFile.length > 0 &&
    typeof session.cwd === "string" &&
    session.cwd.length > 0 &&
    typeof session.projectAlias === "string" &&
    session.projectAlias.length > 0 &&
    (session.mode === "background" || session.mode === "ui") &&
    (session.state === "active" || session.state === "saved" || session.state === "pending") &&
    typeof session.lastActivityAt === "string";
}

/**
 * 验证 route registry 中的 session ID、worker ID 与 generation。
 *
 * @param route route 状态记录。
 * @returns 字段满足恢复约束时返回 true。
 */
function isValidRoute(route: RouteRecord): boolean {
  return typeof route.sessionId === "string" &&
    route.sessionId.length > 0 &&
    typeof route.workerInstanceId === "string" &&
    route.workerInstanceId.length > 0 &&
    Number.isInteger(route.generation) &&
    route.generation >= 0;
}

/**
 * 判断值是否为 Node.js 文件系统错误。
 *
 * @param error 待检查值。
 * @returns 值包含 Node.js 错误代码时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
