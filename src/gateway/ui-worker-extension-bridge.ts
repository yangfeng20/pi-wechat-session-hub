import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  FooterComponent,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isProcessAlive } from "../system/process-liveness.ts";
import { ProjectService, ProjectServiceError } from "../projects/project-service.ts";
import {
  createStableNamedPipe,
  readOrCreateUiWorkerAttachToken,
  readUiWorkerAttachToken,
  UiWorkerIpcClient,
  UiWorkerIpcError,
  readUiWorkerLaunchRecord,
} from "./ui-worker-ipc.ts";
import type { UiWorkerLaunchRecord, UiWorkerRegistration } from "./ui-worker-types.ts";

interface PendingUiPrompt {
  expectedText: string;
  remoteTurnStarted: boolean;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

type UiWorkerConnectionState = "connected" | "connecting" | "disconnected";

type UiWorkerStatusSink = (state: UiWorkerConnectionState) => void;

/**
 * 可供本机诊断展示的 UI worker bridge 状态快照。
 */
export interface UiWorkerBridgeDiagnostics {
  instanceId: string;
  sessionId: string | undefined;
  state: UiWorkerConnectionState;
  reconnectAttempts: number;
  lastConnectedAt: string | undefined;
  lastDisconnectReason: string | undefined;
}

interface UiWorkerBridgeProcessState extends NodeJS.Process {
  piWechatUiWorkerBridge?: UiWorkerExtensionBridge;
}

const bridgeProcess = process as UiWorkerBridgeProcessState;
const PROCESS_BIRTH_ID = `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`;
const RECOVERY_CHECK_INTERVAL_MS = 15000;

/**
 * 在一个 Pi TUI extension host 内运行 session owner named pipe bridge。
 */
export class UiWorkerExtensionBridge {
  private pi?: ExtensionAPI;
  private context?: ExtensionContext;
  private client?: UiWorkerIpcClient;
  private registration?: UiWorkerRegistration;
  private connectionTask?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectDelayMs = 500;
  private closing = false;
  private connectionState: UiWorkerConnectionState = "disconnected";
  private reconnectAttempts = 0;
  private lastConnectedAt: string | undefined;
  private lastDisconnectReason: string | undefined;
  private initialSessionId?: string;
  private latestAssistantText = "";
  private pendingPrompt?: PendingUiPrompt;
  private readonly idleWaiters = new Set<() => void>();
  private readonly launchId: string;
  private readonly instanceId: string;
  private readonly managerDirectory: string;
  private readonly launchRecord?: UiWorkerLaunchRecord;
  private statusSink?: UiWorkerStatusSink;

  /**
   * 创建可见 Pi session 的 Gateway bridge, 支持 Gateway 启动的 TUI 与普通 Pi TUI。
   *
   * @param launchRecord 可选的一次性 UI worker 启动记录。
   * @param projectService 用于重新解析当前 session cwd 与项目 alias。
   * @param managerDirectory 普通 Pi TUI 使用的 Hub 数据目录。
   */
  constructor(
    launchRecord: UiWorkerLaunchRecord | undefined,
    private readonly projectService: ProjectService,
    managerDirectory?: string,
  ) {
    this.launchRecord = launchRecord;
    this.managerDirectory = launchRecord?.managerDirectory ?? managerDirectory ?? "";
    if (!this.managerDirectory) {
      throw new UiWorkerIpcError("handshake_rejected", "普通 Pi TUI bridge 缺少 Hub manager directory。 ");
    }
    this.launchId = launchRecord?.launchId ?? randomUUID();
    this.instanceId = launchRecord?.instanceId ?? randomUUID();
  }

  /**
   * 设置当前 TUI footer 状态回调, 用于显示 Hub 是否已接入.
   *
   * @param sink 状态回调. 传入 undefined 时移除回调.
   * @returns 无返回值.
   */
  setStatusSink(sink: UiWorkerStatusSink | undefined): void {
    this.statusSink = sink;
    if (sink) {
      sink(this.client ? "connected" : "disconnected");
    }
  }

  /**
   * 向当前 TUI 通知 UI worker 连接状态.
   *
   * @param state 当前连接状态.
   * @returns 无返回值.
   */
  private notifyConnectionState(state: UiWorkerConnectionState): void {
    this.connectionState = state;
    this.statusSink?.(state);
  }

  /**
   * 获取当前 bridge 连接诊断快照, 供 `/wx status` 展示真实连接状态。
   *
   * @returns 不包含凭证与消息正文的诊断信息。
   */
  getDiagnostics(): UiWorkerBridgeDiagnostics {
    return {
      instanceId: this.instanceId,
      sessionId: this.registration?.sessionId,
      state: this.connectionState,
      reconnectAttempts: this.reconnectAttempts,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectReason: this.lastDisconnectReason,
    };
  }

  /**
   * 绑定 Pi 当前 session context 并注册或更新 Gateway session owner。
   *
   * @param pi 当前 Pi extension API。
   * @param context 当前 session 的只读 context。
   * @returns 注册和重连任务开始后正常结束。
   */
  async attach(pi: ExtensionAPI, context: ExtensionContext): Promise<void> {
    const isFirstSession = this.initialSessionId === undefined;
    if (isFirstSession && this.launchRecord?.sessionName) {
      pi.setSessionName(this.launchRecord.sessionName);
    }
    const registration = await this.createRegistration(context, isFirstSession);
    const previous = this.registration;
    this.pi = pi;
    this.context = context;
    this.registration = registration;
    if (!this.initialSessionId) {
      this.initialSessionId = registration.sessionId;
    }
    if (this.client) {
      if (previous && previous.sessionId !== registration.sessionId) {
        this.client.notify("session_changed", { registration });
      } else if (previous && previous.name !== registration.name) {
        this.client.notify("session_info_changed", {
          registration,
          clearName: registration.name === undefined,
        });
      }
      this.notifyConnectionState("connected");
      return;
    }
    this.reconnectDelayMs = 500;
    this.notifyConnectionState("connecting");
    this.scheduleConnect(0);
  }

  /**
   * 在 Pi session switch 前向 Gateway 检查目标 session owner。
   *
   * @param sessionFile 用户选择的 Pi session transcript 文件。
   * @returns Gateway 确认无 writer 冲突时返回 true。
   */
  async canSwitchSession(sessionFile: string): Promise<boolean> {
    if (!isAbsolute(sessionFile)) {
      return false;
    }
    if (this.client) {
      try {
        const result = await this.client.request("can_switch_session", { sessionFile }, 10000);
        return isRecord(result) && result.allowed === true;
      } catch {
        return !(await this.hasLiveSessionOwner(sessionFile));
      }
    }

    let controlClient: UiWorkerIpcClient | undefined;
    try {
      const managerToken = await readUiWorkerAttachToken(this.managerDirectory);
      if (!managerToken) {
        return !(await this.hasLiveSessionOwner(sessionFile));
      }
      controlClient = await UiWorkerIpcClient.connectControl(
        createStableNamedPipe(this.managerDirectory),
        this.managerDirectory,
        managerToken,
        { timeoutMs: 3000 },
      );
      const result = await controlClient.request("can_switch_session", { sessionFile }, 5000);
      return isRecord(result) && result.allowed === true;
    } catch {
      return !(await this.hasLiveSessionOwner(sessionFile));
    } finally {
      controlClient?.close();
    }
  }

  /**
   * 在 Gateway IPC 不可用时检查目标 transcript 是否仍有存活 registry owner。
   *
   * @param sessionFile 用户选择的 Pi session transcript 文件。
   * @returns 存在活跃/状态不明 owner 时返回 true。
   */
  private async hasLiveSessionOwner(sessionFile: string): Promise<boolean> {
    let managerInfo;
    try {
      managerInfo = await lstat(this.managerDirectory);
    } catch (error) {
      return !(error instanceof Error && "code" in error && error.code === "ENOENT");
    }
    if (!managerInfo.isDirectory() || managerInfo.isSymbolicLink()) {
      return true;
    }
    const instanceFile = join(this.managerDirectory, "instances.json");
    let instanceFileInfo;
    try {
      instanceFileInfo = await lstat(instanceFile);
    } catch (error) {
      return !(error instanceof Error && "code" in error && error.code === "ENOENT");
    }
    if (!instanceFileInfo.isFile() || instanceFileInfo.isSymbolicLink()) {
      return true;
    }
    let records: unknown;
    try {
      records = JSON.parse(await readFile(instanceFile, "utf8")) as unknown;
    } catch {
      return true;
    }
    if (!isRecord(records)) {
      return true;
    }
    for (const value of Object.values(records)) {
      if (!isRecord(value) || typeof value.sessionFile !== "string" || !samePath(value.sessionFile, sessionFile)) {
        continue;
      }
      if (value.instanceId === this.instanceId) {
        continue;
      }
      if (
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        isProcessAlive(value.pid)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 通知 Gateway 当前 UI worker 已开始 agent turn。
   *
   * @returns 无返回值。
   */
  onAgentStart(): void {
    if (this.pendingPrompt?.remoteTurnStarted) {
      this.latestAssistantText = "";
    }
    this.sendState("running");
  }

  /**
   * 收集当前 turn 的最终 assistant 普通文本, 不转发 thinking 或工具参数。
   *
   * @param event Pi message end event。
   * @returns 无返回值。
   */
  onMessageEnd(event: { message: unknown }): void {
    if (!isRecord(event.message)) {
      return;
    }
    if (
      event.message.role === "user" &&
      this.pendingPrompt &&
      !this.pendingPrompt.remoteTurnStarted &&
      extractMessageText(event.message).trim() === this.pendingPrompt.expectedText.trim()
    ) {
      this.pendingPrompt.remoteTurnStarted = true;
      this.latestAssistantText = "";
      return;
    }
    const text = extractAssistantText(event.message);
    if (this.pendingPrompt?.remoteTurnStarted && event.message.role === "assistant" && text) {
      this.latestAssistantText = text;
    }
  }

  /**
   * 在 Pi 完成自动重试、compaction 和 follow-up 后回传 UI worker 状态与最终回复。
   *
   * @param _event Pi agent settled event。
   * @returns 无返回值。
   */
  onAgentSettled(): void {
    const pending = this.pendingPrompt;
    if (pending?.remoteTurnStarted) {
      this.pendingPrompt = undefined;
      if (this.latestAssistantText) {
        pending.resolve({ reply: this.latestAssistantText });
      } else {
        pending.reject(new UiWorkerIpcError("worker_disconnected", "Pi turn settled, 但没有最终 assistant 文本。 "));
      }
    }
    for (const resolveIdle of this.idleWaiters) {
      resolveIdle();
    }
    this.idleWaiters.clear();
    this.sendState("idle");
    this.client?.notify("turn_settled", { state: "idle" });
    this.latestAssistantText = "";
  }

  /**
   * 处理 Pi session 名称变化。
   *
   * @param event Session info changed event。
   * @param context 当前 Pi context。
   * @returns 无返回值。
   */
  async onSessionInfoChanged(event: { name: string | undefined }, context: ExtensionContext): Promise<void> {
    if (!this.registration) {
      return;
    }
    const registration: UiWorkerRegistration = {
      ...this.registration,
      name: event.name,
    };
    this.registration = registration;
    this.client?.notify("session_info_changed", {
      registration,
      cwd: context.sessionManager.getCwd(),
      clearName: event.name === undefined,
    });
  }

  /**
   * 关闭当前 TUI owner 时通知 Gateway 并释放 pipe reconnect timer。
   *
   * @param event Pi session shutdown 事件。
   * @returns Gateway 仍在线时等待 worker owner unregister。
   */
  async onSessionShutdown(event: { reason: "quit" | "reload" | "new" | "resume" | "fork" }): Promise<void> {
    const pending = this.pendingPrompt;
    this.pendingPrompt = undefined;
    pending?.reject(new UiWorkerIpcError("worker_disconnected", "Pi session 正在关闭或切换, remote prompt 未完成。 "));
    if (event.reason !== "quit") {
      this.registration = undefined;
      this.stopHeartbeat();
      const previousClient = this.client;
      this.client = undefined;
      previousClient?.close();
      this.lastDisconnectReason = `session ${event.reason} 切换中`;
      this.notifyConnectionState("disconnected");
      this.scheduleRecoveryCheck();
      return;
    }
    this.pi = undefined;
    this.context = undefined;
    this.closing = true;
    this.clearTimers();
    const client = this.client;
    this.client = undefined;
    if (client) {
      await client.request("worker_shutdown", {
        registration: this.registration,
      }, 5000).catch(() => undefined);
      client.close();
    }
    if (bridgeProcess.piWechatUiWorkerBridge === this) {
      delete bridgeProcess.piWechatUiWorkerBridge;
    }
    this.notifyConnectionState("disconnected");
  }

  /**
   * 生成最新的 Pi session registration 并检查 launch cwd/project。
   *
   * @param context 当前 Pi context。
   * @param isFirstSession 是否为初次 launch handshake。
   * @returns UI worker registration。
   */
  private async createRegistration(
    context: ExtensionContext,
    isFirstSession: boolean,
  ): Promise<UiWorkerRegistration> {
    const sessionId = context.sessionManager.getSessionId();
    const sessionFile = context.sessionManager.getSessionFile();
    const cwd = context.sessionManager.getCwd();
    if (!sessionId || !sessionFile || !isAbsolute(sessionFile) || !isAbsolute(cwd)) {
      throw new UiWorkerIpcError("handshake_rejected", "Pi UI session 缺少 sessionId、sessionFile 或绝对 cwd。 ");
    }
    const projectAlias = await this.resolveProjectAlias(cwd, isFirstSession);
    const sessionName = isFirstSession
      ? this.launchRecord?.sessionName ?? context.sessionManager.getSessionName()
      : context.sessionManager.getSessionName();
    return {
      launchId: this.launchId,
      instanceId: this.instanceId,
      pid: process.pid,
      processBirthId: PROCESS_BIRTH_ID,
      sessionId,
      sessionFile,
      cwd,
      projectAlias,
      state: context.isIdle() ? "idle" : "running",
      ...(sessionName ? { name: sessionName } : {}),
    };
  }

  /**
   * 从已登记项目中解析当前 TUI cwd, 不允许把任意路径登记为 route。
   *
   * @param cwd Pi session cwd。
   * @param isFirstSession 是否验证 launch 中的预期项目。
   * @returns 唯一匹配项目 alias。
   */
  private async resolveProjectAlias(cwd: string, isFirstSession: boolean): Promise<string> {
    let canonicalCwd: string;
    try {
      canonicalCwd = await realpath(cwd);
    } catch {
      if (this.launchRecord) {
        throw new UiWorkerIpcError("handshake_rejected", "UI worker 项目目录不可用。 ");
      }
      throw new UiWorkerIpcError(
        "project_not_registered",
        "当前 Pi TUI 工作目录不可用, 本机会话保持可用, 但未接入 Hub。",
      );
    }
    if (
      this.launchRecord &&
      isFirstSession &&
      samePath(canonicalCwd, this.launchRecord.projectPath)
    ) {
      await this.projectService.resolveSession(this.launchRecord.projectAlias, canonicalCwd);
      return this.launchRecord.projectAlias;
    }
    try {
      return (await this.projectService.ensureProjectForCwd(canonicalCwd)).alias;
    } catch (error) {
      if (this.launchRecord || !(error instanceof ProjectServiceError)) {
        throw error;
      }
      if (error.code !== "project_path_denied") {
        throw new UiWorkerIpcError("project_not_registered", error.message);
      }
      const { config } = await this.projectService.list();
      const notice = config.allowedProjectRoots.length === 0
        ? "尚未初始化 Hub 项目授权. 执行 /wx start 可将当前目录设为授权根, 或执行 /wx roots add-current 手动授权。"
        : "当前目录不在 Hub 授权根内. 本机会话保持可用, 但未接入 Hub. 执行 /wx roots add-current 可授权当前目录及其子目录。";
      throw new UiWorkerIpcError("project_not_registered", notice);
    }
  }

  /**
   * 处理 Gateway 通过 named pipe 发来的受控请求。
   *
   * @param method 方法名称。
   * @param params 参数对象。
   * @returns Pi 最终输出或 shutdown acknowledgement。
   */
  private async handleGatewayRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "prompt") {
      return this.handlePrompt(params);
    }
    if (method === "abort") {
      this.context?.abort();
      return { accepted: true };
    }
    if (method === "shutdown") {
      if (!this.context) {
        throw new UiWorkerIpcError("worker_disconnected", "UI worker session context 不可用。 ");
      }
      if (!this.context.isIdle()) {
        if (params.abortRunning !== true) {
          throw new UiWorkerIpcError("worker_disconnected", "UI Pi turn 正在运行; 未经显式授权不执行 abort。 ");
        }
        this.context.abort();
        await this.waitForIdle(60000);
      }
      const context = this.context;
      setImmediate(() => context.shutdown());
      return { accepted: true };
    }
    throw new UiWorkerIpcError("invalid_frame", "Gateway 调用了未知 UI worker 方法。 ");
  }

  /**
   * 将微信 prompt 作为 Pi 原生 user message 注入当前 TUI session。
   *
   * @param params Gateway prompt 参数。
   * @returns Pi agent settled 后的最终 assistant 文本。
   */
  private async handlePrompt(params: Record<string, unknown>): Promise<unknown> {
    if (!this.context || !this.pi || typeof params.message !== "string" || !params.message.trim()) {
      throw new UiWorkerIpcError("invalid_frame", "Gateway prompt 参数缺少文本正文。 ");
    }
    if (this.pendingPrompt) {
      throw new UiWorkerIpcError("worker_disconnected", "UI worker 已有一条尚未结算的 Gateway prompt。 ");
    }
    const pi = this.pi;
    const agentWasIdle = this.context.isIdle();
    this.latestAssistantText = "";
    const response = new Promise<unknown>((resolveResponse, rejectResponse) => {
      this.pendingPrompt = {
        expectedText: params.message as string,
        remoteTurnStarted: agentWasIdle,
        resolve: resolveResponse,
        reject: rejectResponse,
      };
    });
    try {
      pi.sendUserMessage(
        params.message,
        agentWasIdle ? undefined : { deliverAs: "followUp" },
      );
    } catch (error) {
      const pending = this.pendingPrompt as PendingUiPrompt | undefined;
      this.pendingPrompt = undefined;
      pending?.reject(error instanceof Error ? error : new Error("pi.sendUserMessage failed"));
    }
    return response;
  }

  /**
   * 断线后以稳定 pipe endpoint 进行限速重连。
   *
   * @param delayMs 首次延迟。
   * @returns 无返回值。
   */
  private scheduleConnect(delayMs: number): void {
    if (this.closing || this.client || this.connectionTask || this.reconnectTimer) {
      return;
    }
    if (!this.registration) {
      this.lastDisconnectReason ??= "缺少 session registration, 等待 session 重新 attach";
      this.notifyConnectionState("disconnected");
      this.scheduleRecoveryCheck();
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectionTask = this.connectOnce().finally(() => {
        this.connectionTask = undefined;
        if (!this.client && !this.closing) {
          this.scheduleConnect(this.reconnectDelayMs);
        }
      });
      void this.connectionTask;
    }, delayMs);
    this.reconnectTimer.unref();
  }

  /**
   * 在缺少 registration 时定期重试恢复, 避免 footer 永久停在“连接中”。
   *
   * @returns 无返回值。
   */
  private scheduleRecoveryCheck(): void {
    if (this.closing || this.client || this.recoveryTimer) {
      return;
    }
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.recoverRegistration();
    }, RECOVERY_CHECK_INTERVAL_MS);
    this.recoveryTimer.unref();
  }

  /**
   * 尝试用当前 Pi context 重建 registration 并恢复 IPC 连接。
   *
   * @returns 无返回值。
   */
  private async recoverRegistration(): Promise<void> {
    if (this.closing || this.client) {
      return;
    }
    if (!this.registration && this.pi && this.context) {
      try {
        this.registration = await this.createRegistration(this.context, false);
      } catch (error) {
        this.lastDisconnectReason = error instanceof Error ? error.message : "重建 registration 失败";
      }
    }
    if (this.registration) {
      this.reconnectDelayMs = 500;
      this.notifyConnectionState("connecting");
      this.scheduleConnect(0);
      return;
    }
    this.notifyConnectionState("disconnected");
    this.scheduleRecoveryCheck();
  }

  /**
   * 建立一次 authenticated pipe connection。
   *
   * @returns 握手成功后开始 heartbeat。
   */
  private async connectOnce(): Promise<void> {
    const registration = this.registration;
    if (!registration || this.closing) {
      return;
    }
    try {
      const managerToken = this.launchRecord
        ? undefined
        : await readOrCreateUiWorkerAttachToken(this.managerDirectory);
      const client = await UiWorkerIpcClient.connect(
        this.launchRecord?.pipeEndpoint ?? createStableNamedPipe(this.managerDirectory),
        this.launchRecord?.ticket ?? "",
        registration,
        {
          ...(managerToken ? { managerToken } : {}),
          requestHandler: (method, params) => this.handleGatewayRequest(method, params),
        },
      );
      if (
        this.closing ||
        !this.registration ||
        this.registration.instanceId !== registration.instanceId ||
        this.registration.sessionId !== registration.sessionId
      ) {
        client.close();
        return;
      }
      this.client = client;
      this.reconnectAttempts = 0;
      this.lastConnectedAt = new Date().toISOString();
      this.lastDisconnectReason = undefined;
      this.notifyConnectionState("connected");
      if (this.registration !== registration) {
        client.notify("session_changed", { registration: this.registration });
      }
      this.reconnectDelayMs = 500;
      client.on("close", () => {
        if (this.client === client) {
          this.client = undefined;
          this.stopHeartbeat();
          this.lastDisconnectReason = "IPC 连接已关闭";
          this.notifyConnectionState("connecting");
          this.scheduleConnect(this.reconnectDelayMs);
          this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 15000);
        }
      });
      client.on("transport_error", (error: Error) => {
        if (this.client === client) {
          this.client = undefined;
          this.stopHeartbeat();
          this.lastDisconnectReason = `IPC 传输错误: ${error.message}`;
          this.notifyConnectionState("connecting");
          this.scheduleConnect(this.reconnectDelayMs);
          this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 15000);
        }
      });
      this.startHeartbeat();
      client.notify("heartbeat", { state: registration.state });
    } catch (error) {
      this.reconnectAttempts += 1;
      this.lastDisconnectReason = error instanceof Error ? error.message : "UI worker IPC 连接失败";
      this.notifyConnectionState("connecting");
      this.scheduleConnect(this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 15000);
    }
  }

  /**
   * 定期向 Gateway 发送不含消息正文的 worker heartbeat。
   *
   * @returns 无返回值。
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.client && this.registration) {
        const state = this.context?.isIdle() ? "idle" : "running";
        this.client.notify("heartbeat", { state });
      }
    }, 5000);
    this.heartbeatTimer.unref();
  }

  /**
   * 清除重连/心跳定时器并唤醒所有等待中的 idle waiter。
   *
   * @returns 无返回值。
   */
  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    this.stopHeartbeat();
    for (const resolveIdle of this.idleWaiters) {
      resolveIdle();
    }
    this.idleWaiters.clear();
  }

  /**
   * 停止 heartbeat timer。
   *
   * @returns 无返回值。
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * 将 UI session 名称和当前 agent state 写回 registration event。
   *
   * @param state worker 当前状态。
   * @returns 无返回值。
   */
  private sendState(state: "idle" | "running"): void {
    if (this.client) {
      this.client.notify("heartbeat", { state });
    }
  }

  /**
   * 等待当前 agent turn settled。
   *
   * @param timeoutMs 最大等待时长。
   * @returns agent_settled event 到达时结束。
   */
  private waitForIdle(timeoutMs: number): Promise<void> {
    if (this.context?.isIdle()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolveIdle, rejectIdle) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.idleWaiters.delete(wake);
        resolveIdle();
      };
      const timer = setTimeout(() => {
        this.idleWaiters.delete(wake);
        rejectIdle(new UiWorkerIpcError("request_timeout", "等待 UI Pi turn 结束超时。 "));
      }, timeoutMs);
      timer.unref();
      this.idleWaiters.add(wake);
    });
  }
}

/**
 * 判断当前 Pi extension host 是否已经为可见 TUI session 创建了 Hub bridge。
 *
 * @returns 当前进程持有可见 TUI bridge 时返回 true。
 */
export function isUiWorkerBridgeActive(): boolean {
  return bridgeProcess.piWechatUiWorkerBridge !== undefined;
}

/**
 * 在 Pi 本机命令修改授权配置后, 重新尝试接入当前可见 session.
 *
 * @param pi 当前 Pi extension API.
 * @param context 当前本机 session context.
 * @returns session 已通过授权验证并开始注册时正常结束.
 * @throws {UiWorkerIpcError} 当前进程尚未建立 UI worker bridge 时抛出.
 */
export async function attachCurrentUiWorkerSession(
  pi: ExtensionAPI,
  context: ExtensionContext,
): Promise<void> {
  const bridge = bridgeProcess.piWechatUiWorkerBridge;
  if (!bridge) {
    throw new UiWorkerIpcError("worker_disconnected", "当前 Pi TUI 尚未建立 Hub session bridge, 请重新打开 session 后重试。");
  }
  await bridge.attach(pi, context);
}

/**
 * 安装保留 Pi 默认 footer 布局的 Hub 状态渲染器.
 *
 * @param context 当前 TUI session context.
 * @param statusKey Hub footer 状态 key.
 * @returns 无返回值.
 */
function installHubFooter(context: ExtensionContext, statusKey: string): void {
  if (context.mode !== "tui") {
    return;
  }
  const sessionLike = {
    get state() {
      return {
        model: context.model,
        thinkingLevel: context.thinkingLevel ?? "off",
      };
    },
    sessionManager: context.sessionManager,
    getContextUsage: () => context.getContextUsage(),
    modelRuntime: {
      isUsingSubscription: (): boolean => false,
    },
  } as unknown as AgentSession;

  context.ui.setFooter((_tui, theme, footerData) => {
    const defaultFooter = new FooterComponent(sessionLike, footerData);
    return {
      render(width: number): string[] {
        const lines = defaultFooter.render(width);
        const statusText = footerData.getExtensionStatuses().get(statusKey);
        const lastLine = lines.at(-1);
        if (statusText && lastLine) {
          const color = statusText.startsWith("🟢") ? "success" : "warning";
          lines[lines.length - 1] = lastLine.replace(statusText, theme.fg(color, statusText));
        }
        return lines;
      },
      invalidate(): void {
        defaultFooter.invalidate();
      },
      dispose(): void {
        defaultFooter.dispose();
      },
    };
  });
}

/**
 * 注册所有可见 Pi TUI 的 Hub session owner bridge。
 *
 * @param pi Pi extension API。
 * @param projectService 已登记项目路径校验服务。
 * @param managerDirectory manager 私有数据目录。
 * @returns 无返回值。
 */
export function registerUiWorkerBridgeHooks(
  pi: ExtensionAPI,
  projectService: ProjectService,
  managerDirectory: string,
): void {
  let bridge = bridgeProcess.piWechatUiWorkerBridge;
  let statusContext: ExtensionContext | undefined;
  const statusKey = "wechat-session-hub";
  const updateStatus = (state: UiWorkerConnectionState): void => {
    const ui = statusContext?.ui;
    if (!ui) {
      return;
    }
    const text = state === "connected"
      ? "🟢 微信: 已接入"
      : state === "connecting"
        ? "🟡 微信: 连接中"
        : undefined;
    ui.setStatus(statusKey, text);
  };

  pi.on("session_start", async (event, sessionContext) => {
    if (sessionContext.mode !== "tui") {
      return;
    }
    if (bridge && typeof bridge.setStatusSink !== "function") {
      if (bridgeProcess.piWechatUiWorkerBridge === bridge) {
        delete bridgeProcess.piWechatUiWorkerBridge;
      }
      bridge = undefined;
    }
    if (event.reason === "reload" && bridge) {
      bridge.setStatusSink(undefined);
      if (bridgeProcess.piWechatUiWorkerBridge === bridge) {
        delete bridgeProcess.piWechatUiWorkerBridge;
      }
      bridge = undefined;
    }
    statusContext = sessionContext;
    sessionContext.ui.setStatus(statusKey, undefined);
    installHubFooter(sessionContext, statusKey);
    const configuredManagerDirectory = process.env.PI_WECHAT_MANAGER_DIR;
    if (configuredManagerDirectory && !samePath(configuredManagerDirectory, managerDirectory)) {
      sessionContext.ui.notify("UI worker managerDirectory 与当前 Pi agent 配置不一致, 已拒绝注册。", "error");
      return;
    }
    if (!bridge) {
      const launchId = process.env.PI_WECHAT_MANAGER_LAUNCH_ID;
      try {
        if (launchId) {
          const launchRecord = await readUiWorkerLaunchRecord(managerDirectory, launchId);
          const endpoint = process.env.PI_WECHAT_MANAGER_PIPE;
          if (endpoint && endpoint !== launchRecord.pipeEndpoint) {
            throw new UiWorkerIpcError("launch_record_invalid", "UI worker pipe endpoint 与 launch record 不一致。 ");
          }
          bridge = new UiWorkerExtensionBridge(launchRecord, projectService);
        } else {
          bridge = new UiWorkerExtensionBridge(undefined, projectService, managerDirectory);
        }
        bridgeProcess.piWechatUiWorkerBridge = bridge;
      } catch (error) {
        sessionContext.ui.notify(
          error instanceof UiWorkerIpcError ? error.message : "UI worker launch record 验证失败。",
          "error",
        );
        return;
      }
    }
    bridge.setStatusSink(updateStatus);
    try {
      await bridge.attach(pi, sessionContext);
    } catch (error) {
      if (error instanceof UiWorkerIpcError && error.code === "project_not_registered") {
        sessionContext.ui.notify(error.message, "warning");
        return;
      }
      sessionContext.ui.notify(
        `无法准备当前 Pi TUI session registration; Hub route 未建立. ${error instanceof Error ? error.message : "原因未知."}`,
        "error",
      );
    }
  });

  pi.on("session_before_switch", async (event, sessionContext) => {
    if (!bridge) {
      return;
    }
    if (!event.targetSessionFile) {
      if (event.reason === "resume") {
        sessionContext.ui.notify("Gateway 无法确认目标 session, 已拒绝恢复以避免双 writer。", "warning");
        return { cancel: true };
      }
      return;
    }
    const allowed = await bridge.canSwitchSession(event.targetSessionFile);
    if (!allowed) {
      sessionContext.ui.notify(
        "Gateway 检测到目标 session 仍由其他 Pi runtime 持有或 owner 状态不明, 为避免双 writer 已拒绝恢复。",
        "warning",
      );
      return { cancel: true };
    }
  });
  pi.on("session_info_changed", async (event, sessionContext) => {
    await bridge?.onSessionInfoChanged(event, sessionContext);
  });
  pi.on("agent_start", () => bridge?.onAgentStart());
  pi.on("message_end", (event) => bridge?.onMessageEnd(event));
  pi.on("agent_settled", () => bridge?.onAgentSettled());
  pi.on("session_shutdown", async (event) => {
    if (!bridge) {
      statusContext?.ui.setStatus(statusKey, undefined);
      if (event.reason === "quit") {
        statusContext = undefined;
      }
      return;
    }
    await bridge.onSessionShutdown(event);
    if (event.reason === "quit" && bridgeProcess.piWechatUiWorkerBridge === bridge) {
      if (typeof bridge.setStatusSink === "function") {
        bridge.setStatusSink(undefined);
      }
      delete bridgeProcess.piWechatUiWorkerBridge;
      bridge = undefined;
      statusContext?.ui.setStatus(statusKey, undefined);
      statusContext = undefined;
    }
  });
}

/**
 * 获取当前进程内 UI worker bridge 的诊断快照。
 *
 * @returns 当前 TUI 的连接诊断信息; 本进程未建立 bridge 时返回 undefined。
 */
export function getCurrentUiWorkerBridgeDiagnostics(): UiWorkerBridgeDiagnostics | undefined {
  return bridgeProcess.piWechatUiWorkerBridge?.getDiagnostics();
}

/**
 * 从 Pi user message 中提取普通文本块。
 *
 * @param message Pi message。
 * @returns 拼接后的文本。
 */
function extractMessageText(message: unknown): string {
  if (!isRecord(message)) {
    return typeof message === "string" ? message : "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => (item as { text: string }).text)
    .join("");
}

/**
 * 将 Pi message content 中的普通文本块拼接为可回传回复。
 *
 * @param message Pi agent message。
 * @returns 普通文本, 不包含 thinking 或 tool call 参数。
 */
function extractAssistantText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant") {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => (item as { text: string }).text)
    .join("");
}

/**
 * 判断未知值是否为非数组 object。
 *
 * @param value 待检查的值。
 * @returns 值可安全作为记录对象读取时返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 比较两个项目 cwd 路径, Windows 上忽略大小写。
 *
 * @param left 路径一。
 * @param right 路径二。
 * @returns 路径相同时返回 true。
 */
function samePath(left: string, right: string): boolean {
  const resolvedLeft = normalizeComparablePath(left);
  const resolvedRight = normalizeComparablePath(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

/**
 * 将路径归一化为可比较形式, 尽量消解 Windows 8.3 短名与符号链接差异。
 *
 * GitHub Windows runner 的临时目录会是 `RUNNER~1`, 而 `realpath` 返回
 * `runneradmin`。两侧若一侧已规范化、另一侧未规范化, 纯字符串比较会
 * 误判为不同路径。这里尽力对两侧同时做 `realpathSync.native`; 任一侧
 * 无法解析(例如文件尚未创建)时回退到 `resolve` 结果。
 *
 * @param value 待归一化路径。
 * @returns 用于相等比较的路径字符串。
 */
function normalizeComparablePath(value: string): string {
  const resolved = resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

