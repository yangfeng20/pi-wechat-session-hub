import { randomBytes, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { ProjectService, ProjectServiceError } from "../projects/project-service.ts";
import type { ProjectDefinition } from "../config/types.ts";
import { ManagerRegistry } from "../registry/manager-registry.ts";
import type { SessionIndexRecord, WorkerInstanceRecord, WorkerState } from "../registry/types.ts";
import {
  parseUiWorkerRegistration,
  UiWorkerIpcError,
  UiWorkerIpcServer,
  type UiWorkerIpcConnection,
} from "../gateway/ui-worker-ipc.ts";
import { isProcessAlive } from "../system/process-liveness.ts";
import type { UiWorkerLaunchRecord, UiWorkerRegistration } from "../gateway/ui-worker-types.ts";
import type { PiCliInvocation } from "./pi-cli.ts";
import type { BackgroundWorkerManager } from "./background-worker-manager.ts";
import { WindowsTerminalLaunchError, WindowsTerminalLauncher, probeWindowsTerminalCapability, type WindowsTerminalCapability } from "../gateway/windows-terminal-launcher.ts";

export type UiWorkerManagerErrorCode =
  | "unsupported_platform"
  | "wt_not_found"
  | "session_not_found"
  | "session_owned_by_other_process"
  | "worker_not_found"
  | "worker_busy"
  | "worker_launch_failed"
  | "worker_registration_timeout"
  | "worker_shutdown_timeout"
  | "registry_inconsistent";

/**
 * 表示可见 Pi UI worker 无法安全启动、路由或关闭。
 */
export class UiWorkerManagerError extends Error {
  /**
   * 创建可安全向 Gateway 用户显示的 UI worker 错误。
   *
   * @param code 稳定错误代码。
   * @param message 不包含凭证、正文或完整 launch ticket 的中文说明。
   */
  constructor(
    readonly code: UiWorkerManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UiWorkerManagerError";
  }
}

/**
 * 管理通过 Windows Terminal 启动的真实 Pi TUI worker。
 */
export class UiWorkerManager {
  private readonly connections = new Map<string, UiWorkerIpcConnection>();
  private readonly disconnectWaiters = new Map<string, Set<() => void>>();
  private readonly staleTimers = new Map<string, NodeJS.Timeout>();
  private readonly explicitStops = new Set<string>();
  private readonly maxStaleMs: number;
  private capabilityTask?: Promise<WindowsTerminalCapability>;

  /**
   * 创建 UI worker manager 并安装 IPC lifecycle handlers。
   *
   * @param options Windows Terminal、Pi CLI、项目服务和 registry 依赖。
   */
  constructor(private readonly options: {
    managerDirectory: string;
    projectService: ProjectService;
    registry: ManagerRegistry;
    ipcServer: UiWorkerIpcServer;
    launcher?: Pick<WindowsTerminalLauncher, "launch">;
    probeCapability?: () => Promise<WindowsTerminalCapability>;
    invocation: PiCliInvocation;
    extensionPath: string;
    backgroundWorkerManager?: BackgroundWorkerManager;
    staleAfterMs?: number;
    registrationTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    platform?: NodeJS.Platform;
  }) {
    this.maxStaleMs = options.staleAfterMs ?? 20000;
    options.ipcServer.setHandlers({
      onRegister: (registration, authHash, launchRecord, connection) =>
        this.registerWorker(registration, authHash, launchRecord, connection),
      onWorkerEvent: (connection, name, data) => this.handleWorkerEvent(connection, name, data),
      onRequest: (connection, method, params) => this.handleWorkerRequest(connection, method, params),
      onDisconnect: (connection, serverStopping) => this.handleDisconnect(connection, serverStopping),
    });
  }

  /**
   * 判断当前部署是否支持创建或恢复可见 Pi TUI。
   *
   * @returns Windows 或测试注入平台为 win32 时返回 true。
   */
  get isSupported(): boolean {
    return (this.options.platform ?? process.platform) === "win32";
  }

  /**
   * 为本机 Windows TUI workers 打开稳定 IPC endpoint。
   *
   * @returns pipe server 开始监听后正常结束。
   */
  async listen(): Promise<void> {
    if (this.isSupported) {
      await this.options.ipcServer.listen();
    }
  }

  /**
   * 在已登记项目中启动一个新的 Pi 原生 UI session。
   *
   * @param projectAlias 配置中的项目 alias。
   * @param name 可选 session display name。
   * @returns Pi extension 完成 launch handshake 后的 session 记录。
   * @throws {UiWorkerManagerError} Windows Terminal 不可用或 Pi worker 未注册时抛出。
   */
  async startNew(projectAlias: string, name?: string): Promise<SessionIndexRecord> {
    await this.assertUiModeAvailable();
    const project = await this.resolveProject(projectAlias);
    const launch = this.createLaunchRecord({
      mode: "new",
      projectAlias,
      projectPath: project.path,
      ...(name ? { sessionName: name } : {}),
    });
    return this.launchAndWait(launch);
  }

  /**
   * 在新 Windows Terminal tab 中恢复已保存的 UI session。
   *
   * @param sessionId Pi session ID。
   * @returns 已重新注册的 session 记录。
   * @throws {UiWorkerManagerError} session 无法安全恢复或 owner 仍活跃时抛出。
   */
  async resume(sessionId: string): Promise<SessionIndexRecord> {
    await this.assertUiModeAvailable();
    let snapshot = await this.options.registry.readSnapshot();
    let session = snapshot.sessions[sessionId];
    if (!session) {
      throw new UiWorkerManagerError("session_not_found", `未找到 session: ${sessionId}。`);
    }
    const priorOwner = Object.values(snapshot.instances).find((instance) => instance.sessionId === sessionId);
    if (priorOwner && priorOwner.state !== "stale" && priorOwner.state !== "stopping") {
      if (priorOwner.mode === "ui" && this.connections.has(priorOwner.instanceId)) {
        return session;
      }
      throw new UiWorkerManagerError(
        "session_owned_by_other_process",
        `session ${sessionId} 仍由 ${priorOwner.mode} owner PID ${priorOwner.pid} 持有; 拒绝双 writer。`,
      );
    }
    if (priorOwner) {
      if (isProcessAlive(priorOwner.pid)) {
        throw new UiWorkerManagerError(
          "session_owned_by_other_process",
          `session ${sessionId} 的旧 UI owner PID ${priorOwner.pid} 仍存活但 IPC 不可用; 拒绝双开。`,
        );
      }
      await this.markStopped(priorOwner.instanceId);
      snapshot = await this.options.registry.readSnapshot();
      session = snapshot.sessions[sessionId];
      if (!session) {
        throw new UiWorkerManagerError("session_not_found", `未找到 session: ${sessionId}。`);
      }
    }
    if (session.state === "active") {
      session = {
        ...session,
        state: await isPersistedSessionFile(session.sessionFile) ? "saved" : "pending",
      };
      await this.options.registry.upsertSession(session);
    }
    if (!(await isPersistedSessionFile(session.sessionFile))) {
      throw new UiWorkerManagerError(
        "session_not_found",
        `session ${sessionId} 尚无可恢复的 Pi transcript 文件。`,
      );
    }
    if (session.state !== "saved") {
      session = { ...session, state: "saved" };
      await this.options.registry.upsertSession(session);
    }
    let project;
    try {
      project = await this.options.projectService.resolveSession(session.projectAlias, session.cwd);
    } catch (error) {
      if (error instanceof ProjectServiceError) {
        throw error;
      }
      throw new UiWorkerManagerError("session_not_found", "恢复 session 的项目路径验证失败。 ");
    }
    const launch = this.createLaunchRecord({
      mode: "resume",
      projectAlias: session.projectAlias,
      projectPath: project.path,
      sessionId,
      sessionFile: session.sessionFile,
      ...(session.name ? { sessionName: session.name } : {}),
    });
    await this.launchAndWait(launch);
    const resumed = (await this.options.registry.readSnapshot()).sessions[sessionId];
    if (!resumed) {
      throw new UiWorkerManagerError("registry_inconsistent", "Pi UI worker 已启动, 但 session registry 未更新。 ");
    }
    return resumed;
  }

  /**
   * 向当前已认证的 UI worker 注入真实用户消息并等待 Pi agent_settled。
   *
   * @param sessionId Pi session ID。
   * @param message 用户消息正文。
   * @returns UI Pi agent 最终 assistant 文本。
   * @throws {UiWorkerManagerError} worker 断连、忙碌或回复结构无效时抛出。
   */
  async prompt(sessionId: string, message: string): Promise<string> {
    const snapshot = await this.options.registry.readSnapshot();
    const instance = Object.values(snapshot.instances).find((candidate) =>
      candidate.sessionId === sessionId && candidate.mode === "ui" &&
      candidate.state !== "stale" && candidate.state !== "stopping",
    );
    if (!instance) {
      throw new UiWorkerManagerError("worker_not_found", `session ${sessionId} 没有活跃 UI worker。`);
    }
    const connection = this.connections.get(instance.instanceId);
    if (!connection) {
      throw new UiWorkerManagerError("worker_not_found", "UI worker 尚未连接到 Gateway; 不会改用 background writer。 ");
    }
    try {
      const response = await connection.request("prompt", { message });
      if (!isRecord(response) || typeof response.reply !== "string") {
        throw new UiWorkerManagerError("registry_inconsistent", "UI worker 没有返回有效的最终 assistant 文本。 ");
      }
      return response.reply;
    } catch (error) {
      if (error instanceof UiWorkerIpcError) {
        if (error.code === "request_timeout") {
          throw new UiWorkerManagerError("worker_busy", "UI Pi turn 尚未结束; 消息保留在队列, 请检查该 tab 状态。 ");
        }
        throw new UiWorkerManagerError("worker_not_found", "UI worker IPC 已断开; route 消息会保留供显式恢复。 ");
      }
      throw error;
    }
  }

  /**
   * 优雅关闭指定 UI tab, 让 Pi 自己保存 session 并发出 shutdown lifecycle event。
   *
   * @param sessionId Pi session ID。
   * @param abortRunning 是否允许中止正在运行的 turn。
   * @returns worker 注销并持久化 session 状态后正常结束。
   * @throws {UiWorkerManagerError} 当前 turn 正忙或 worker 无法关闭时抛出。
   */
  async stop(sessionId: string, abortRunning = false): Promise<void> {
    const snapshot = await this.options.registry.readSnapshot();
    const instance = Object.values(snapshot.instances).find((candidate) =>
      candidate.sessionId === sessionId && candidate.mode === "ui" &&
      candidate.state !== "stale" && candidate.state !== "stopping",
    );
    if (!instance) {
      throw new UiWorkerManagerError("worker_not_found", `session ${sessionId} 没有活跃 UI worker。`);
    }
    const connection = this.connections.get(instance.instanceId);
    if (!connection) {
      throw new UiWorkerManagerError("worker_not_found", "UI worker IPC 已断开; 拒绝假设 session 已停止。 ");
    }
    if (instance.state === "running") {
      if (!abortRunning) {
        throw new UiWorkerManagerError(
          "worker_busy",
          "UI Pi turn 正在运行; 等待结束后再 /stop。为避免意外中断, 当前不会隐式 abort。",
        );
      }
      try {
        await connection.request("abort", {}, this.options.shutdownTimeoutMs ?? 10000);
      } catch {
        throw new UiWorkerManagerError("worker_shutdown_timeout", "UI worker 未确认 abort; session owner 仍保留。 ");
      }
    }
    this.explicitStops.add(sessionId);
    const stopped = new Promise<void>((resolveStopped, rejectStopped) => {
      const waiters = this.disconnectWaiters.get(instance.instanceId) ?? new Set<() => void>();
      const resolveOnce = (): void => {
        clearTimeout(timer);
        this.disconnectWaiters.get(instance.instanceId)?.delete(resolveOnce);
        resolveStopped();
      };
      waiters.add(resolveOnce);
      this.disconnectWaiters.set(instance.instanceId, waiters);
      const timer = setTimeout(() => {
        waiters.delete(resolveOnce);
        rejectStopped(new UiWorkerManagerError(
          "worker_shutdown_timeout",
          "UI worker 未在期限内完成 session shutdown; registry owner 保留以避免双 writer。",
        ));
      }, this.options.shutdownTimeoutMs ?? 10000);
      timer.unref();
    });
    void stopped.catch(() => undefined);
    try {
      await connection.request("shutdown", { abortRunning }, this.options.shutdownTimeoutMs ?? 10000);
      await stopped;
    } catch (error) {
      if (error instanceof UiWorkerManagerError) {
        throw error;
      }
      if (error instanceof UiWorkerIpcError && error.message.includes("UI Pi turn 正在运行")) {
        throw new UiWorkerManagerError(
          "worker_busy",
          "UI Pi turn 正在运行; 等待结束后再 /stop。",
        );
      }
      throw new UiWorkerManagerError("worker_shutdown_timeout", "UI worker shutdown request 未完成。 ");
    } finally {
      this.explicitStops.delete(sessionId);
    }
  }

  /**
   * 检查 registry owner 是否已拥有可用 IPC connection。
   *
   * @param instanceId UI worker instance ID。
   * @returns connection 存活时返回 true。
   */
  hasConnection(instanceId: string): boolean {
    return this.connections.has(instanceId);
  }

  /**
   * 列出 manager registry 中的 session 索引。
   *
   * @returns 按最近活动时间倒序排列的 session 记录。
   */
  async listSessions(): Promise<SessionIndexRecord[]> {
    const snapshot = await this.options.registry.readSnapshot();
    return Object.values(snapshot.sessions).sort((left, right) =>
      right.lastActivityAt.localeCompare(left.lastActivityAt),
    );
  }

  /**
   * Gateway shutdown 时断开 pipe, 保留仍运行的 Pi TUI owner 供下一 Gateway 重连。
   *
   * @returns IPC server 关闭后正常结束。
   */
  async detachGateway(): Promise<void> {
    await this.options.ipcServer.close();
    this.connections.clear();
    for (const timer of this.staleTimers.values()) {
      clearTimeout(timer);
    }
    this.staleTimers.clear();
  }

  /**
   * 按启动 ticket 或现有 process 身份验证并更新 session/instance registry。
   *
   * @param registration UI extension 声明。
   * @param authHash ticket SHA-256。
   * @param launchRecord 新启动时使用的一次性记录。
   * @param connection 已完成 HMAC 的 IPC 连接。
   * @returns registry 落盘后正常结束。
   */
  private async registerWorker(
    registration: UiWorkerRegistration,
    authHash: string,
    launchRecord: UiWorkerLaunchRecord | undefined,
    connection: UiWorkerIpcConnection,
    clearName = false,
  ): Promise<void> {
    let resolvedProject: ProjectDefinition;
    try {
      resolvedProject = await this.options.projectService.resolveSession(
        registration.projectAlias,
        registration.cwd,
      );
    } catch (error) {
      if (error instanceof ProjectServiceError) {
        throw error;
      }
      throw new UiWorkerManagerError("worker_launch_failed", "UI worker cwd 未通过 allowedProjectRoots 检查。 ");
    }
    if (launchRecord && !samePath(resolvedProject.path, launchRecord.projectPath)) {
      throw new UiWorkerManagerError("worker_launch_failed", "UI worker cwd 与受控 launch project 不匹配。 ");
    }
    const canonicalCwd = resolvedProject.path;
    let snapshot = await this.options.registry.readSnapshot();
    let otherOwner = Object.values(snapshot.instances).find((instance) =>
      instance.sessionId === registration.sessionId &&
      instance.instanceId !== registration.instanceId &&
      isProcessAlive(instance.pid),
    );
    if (
      otherOwner?.mode === "background" &&
      this.options.backgroundWorkerManager &&
      otherOwner.state !== "stale" &&
      otherOwner.state !== "stopping"
    ) {
      await this.options.backgroundWorkerManager.stop(registration.sessionId);
      snapshot = await this.options.registry.readSnapshot();
      otherOwner = Object.values(snapshot.instances).find((instance) =>
        instance.sessionId === registration.sessionId &&
        instance.instanceId !== registration.instanceId &&
        isProcessAlive(instance.pid),
      );
    }
    if (otherOwner) {
      throw new UiWorkerManagerError(
        "session_owned_by_other_process",
        `session ${registration.sessionId} 已由 ${otherOwner.mode} owner 持有; 拒绝双 writer。`,
      );
    }
    let previousInstance: WorkerInstanceRecord | undefined;
    let session: SessionIndexRecord;

    if (launchRecord) {
      const existing = snapshot.sessions[registration.sessionId];
      if (launchRecord.mode === "resume") {
        if (
          !existing ||
          existing.state === "active" ||
          !samePath(existing.sessionFile, registration.sessionFile) ||
          existing.sessionId !== registration.sessionId
        ) {
          throw new UiWorkerManagerError("session_owned_by_other_process", "保存的 UI session 状态已变化, 拒绝恢复。 ");
        }
        session = {
          ...existing,
          cwd: canonicalCwd,
          name: registration.name ?? launchRecord.sessionName ?? existing.name,
          mode: "ui",
          state: await isPersistedSessionFile(registration.sessionFile) ? "active" : "pending",
          lastActivityAt: new Date().toISOString(),
        };
      } else {
        if (existing) {
          throw new UiWorkerManagerError("registry_inconsistent", "Pi 为新 UI launch 返回了已登记 sessionId。 ");
        }
        session = {
          sessionId: registration.sessionId,
          sessionFile: registration.sessionFile,
          cwd: canonicalCwd,
          projectAlias: registration.projectAlias,
          ...(registration.name ?? launchRecord.sessionName
            ? { name: registration.name ?? launchRecord.sessionName }
            : {}),
          mode: "ui",
          state: await isPersistedSessionFile(registration.sessionFile) ? "active" : "pending",
          lastActivityAt: new Date().toISOString(),
        };
      }
    } else {
      previousInstance = snapshot.instances[registration.instanceId];
      if (!previousInstance) {
        const existing = snapshot.sessions[registration.sessionId];
        if (existing && !samePath(existing.sessionFile, registration.sessionFile)) {
          throw new UiWorkerManagerError("session_owned_by_other_process", "Pi UI session transcript 与已有 session 索引不匹配。 ");
        }
        const baseSession: SessionIndexRecord = existing
          ? {
              ...existing,
              sessionFile: registration.sessionFile,
              cwd: canonicalCwd,
              projectAlias: registration.projectAlias,
              mode: "ui",
              state: await isPersistedSessionFile(registration.sessionFile) ? "active" : "pending",
              lastActivityAt: new Date().toISOString(),
            }
          : {
              sessionId: registration.sessionId,
              sessionFile: registration.sessionFile,
              cwd: canonicalCwd,
              projectAlias: registration.projectAlias,
              mode: "ui",
              state: await isPersistedSessionFile(registration.sessionFile) ? "active" : "pending",
              lastActivityAt: new Date().toISOString(),
            };
        session = applySessionName(baseSession, registration.name, clearName);
      } else {
        if (
          previousInstance.mode !== "ui" ||
          previousInstance.launchId !== registration.launchId ||
          previousInstance.pid !== registration.pid ||
          previousInstance.processBirthId !== registration.processBirthId ||
          previousInstance.ipcAuthHash !== authHash
        ) {
          throw new UiWorkerManagerError("session_owned_by_other_process", "UI worker 重连身份不匹配。 ");
        }
        const previousSession = snapshot.sessions[previousInstance.sessionId];
        if (!previousSession) {
          throw new UiWorkerManagerError("registry_inconsistent", "UI worker owner 缺少 session registry。 ");
        }
        if (previousSession.sessionId !== registration.sessionId) {
          await this.options.registry.upsertSession({
            ...previousSession,
            state: await isPersistedSessionFile(previousSession.sessionFile) ? "saved" : "pending",
            lastActivityAt: new Date().toISOString(),
          });
          const nextExisting = snapshot.sessions[registration.sessionId];
          if (nextExisting) {
            session = applySessionName({
              ...nextExisting,
              sessionFile: registration.sessionFile,
              cwd: canonicalCwd,
              projectAlias: registration.projectAlias,
              mode: "ui",
              state: await isPersistedSessionFile(registration.sessionFile) ? "active" : "pending",
              lastActivityAt: new Date().toISOString(),
            }, registration.name, clearName);
          } else {
            session = {
              sessionId: registration.sessionId,
              sessionFile: registration.sessionFile,
              cwd: canonicalCwd,
              projectAlias: registration.projectAlias,
              ...(registration.name ? { name: registration.name } : {}),
              mode: "ui",
              state: await isPersistedSessionFile(registration.sessionFile) ? "active" : "pending",
              lastActivityAt: new Date().toISOString(),
            };
          }
          await this.rebindRoutes(previousInstance.instanceId, previousSession.sessionId, session.sessionId);
        } else {
          session = applySessionName({
            ...previousSession,
            sessionFile: registration.sessionFile,
            cwd: canonicalCwd,
            projectAlias: registration.projectAlias,
            mode: "ui",
            state: await isPersistedSessionFile(registration.sessionFile) ? "active" : "pending",
            lastActivityAt: new Date().toISOString(),
          }, registration.name, clearName);
        }
      }
    }

    const instance: WorkerInstanceRecord = {
      instanceId: registration.instanceId,
      pid: registration.pid,
      processBirthId: registration.processBirthId,
      sessionId: registration.sessionId,
      sessionFile: registration.sessionFile,
      cwd: canonicalCwd,
      projectAlias: registration.projectAlias,
      mode: "ui",
      state: registration.state,
      heartbeatAt: new Date().toISOString(),
      launchId: registration.launchId,
      ipcAuthHash: authHash,
    };
    await this.options.registry.upsertSession(session);
    await this.options.registry.upsertInstance(instance);
    const routeSnapshot = await this.options.registry.readSnapshot();
    const reboundRoutes = Object.entries(routeSnapshot.routes).filter(([, route]) =>
      route.sessionId === session.sessionId && route.workerInstanceId !== instance.instanceId,
    );
    await Promise.all(reboundRoutes.map(([routeId, route]) =>
      this.options.registry.setRoute(routeId, {
        ...route,
        workerInstanceId: instance.instanceId,
        generation: route.generation + 1,
        updatedAt: new Date().toISOString(),
      }),
    ));
    if (!previousInstance) {
      await this.options.registry.appendEvent("worker.ui_registered", {
        sessionId: session.sessionId,
        instanceId: instance.instanceId,
        projectAlias: session.projectAlias,
        pid: instance.pid,
      });
    } else if (previousInstance.sessionId !== session.sessionId) {
      await this.options.registry.appendEvent("worker.ui_session_changed", {
        previousSessionId: previousInstance.sessionId,
        sessionId: session.sessionId,
        instanceId: instance.instanceId,
      });
    }
    this.connections.set(instance.instanceId, connection);
    this.cancelStaleTimer(instance.instanceId);
  }

  /**
   * 更新 UI session 切换后的微信 route binding。
   *
   * @param instanceId 当前 TUI process owner。
   * @param oldSessionId 之前的 Pi session。
   * @param newSessionId 新的 Pi session。
   * @returns 无返回值。
   */
  private async rebindRoutes(instanceId: string, oldSessionId: string, newSessionId: string): Promise<void> {
    const snapshot = await this.options.registry.readSnapshot();
    const routes = Object.entries(snapshot.routes).filter(([, route]) =>
      route.workerInstanceId === instanceId && route.sessionId === oldSessionId,
    );
    await Promise.all(routes.map(([routeId, route]) => this.options.registry.setRoute(routeId, {
      ...route,
      sessionId: newSessionId,
      generation: route.generation + 1,
      updatedAt: new Date().toISOString(),
    })));
  }

  /**
   * 验证 TUI 是否可以切换到目标 Pi session 而不违反单 writer。
   *
   * @param connection 已认证 UI worker connection。
   * @param method 控制 request 方法名。
   * @param params 目标 sessionFile 等参数。
   * @returns 包含 allowed 与稳定理由代码的结果。
   */
  private async handleWorkerRequest(
    connection: UiWorkerIpcConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method !== "can_switch_session") {
      throw new UiWorkerManagerError("registry_inconsistent", "Gateway 收到未知 UI worker request。 ");
    }
    if (typeof params.sessionFile !== "string" || !isAbsolute(params.sessionFile)) {
      return { allowed: false, reason: "invalid_session_file" };
    }
    let snapshot = await this.options.registry.readSnapshot();
    const target = Object.values(snapshot.sessions).find((session) =>
      samePath(session.sessionFile, params.sessionFile as string),
    );
    if (!target) {
      const unindexedOwner = Object.values(snapshot.instances).find((instance) =>
        samePath(instance.sessionFile, params.sessionFile as string) &&
        instance.instanceId !== connection.registration.instanceId &&
        isProcessAlive(instance.pid),
      );
      return unindexedOwner
        ? { allowed: false, reason: "session_owned_by_other_process" }
        : { allowed: true, reason: "session_not_registered" };
    }
    try {
      await this.options.projectService.resolveSession(target.projectAlias, target.cwd);
    } catch {
      return { allowed: false, reason: "project_path_denied" };
    }
    let competingOwner = Object.values(snapshot.instances).find((instance) =>
      instance.sessionId === target.sessionId &&
      instance.instanceId !== connection.registration.instanceId &&
      isProcessAlive(instance.pid),
    );
    if (
      competingOwner?.mode === "background" &&
      competingOwner.state !== "stale" &&
      competingOwner.state !== "stopping" &&
      this.options.backgroundWorkerManager
    ) {
      try {
        await this.options.backgroundWorkerManager.stop(target.sessionId);
      } catch {
        return { allowed: false, reason: "background_handoff_failed" };
      }
      snapshot = await this.options.registry.readSnapshot();
      competingOwner = Object.values(snapshot.instances).find((instance) =>
        instance.sessionId === target.sessionId &&
        instance.instanceId !== connection.registration.instanceId &&
        isProcessAlive(instance.pid),
      );
    }
    if (competingOwner) {
      return { allowed: false, reason: "session_owned_by_other_process" };
    }
    return { allowed: true };
  }

  /**
   * 接收 UI worker heartbeat、session change 或 shutdown event。
   *
   * @param connection 已认证的 worker connection。
   * @param name IPC event name。
   * @param data event payload。
   * @returns 无返回值。
   */
  private async handleWorkerEvent(
    connection: UiWorkerIpcConnection,
    name: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const instanceId = connection.registration.instanceId;
    if (name === "heartbeat") {
      const snapshot = await this.options.registry.readSnapshot();
      const instance = snapshot.instances[instanceId];
      if (!instance) {
        return;
      }
      const state = isWorkerState(data.state) ? data.state : instance.state;
      await this.options.registry.upsertInstance({
        ...instance,
        state,
        heartbeatAt: new Date().toISOString(),
      });
      const session = snapshot.sessions[instance.sessionId];
      if (session) {
        const persistedState = await isPersistedSessionFile(session.sessionFile) ? "active" : "pending";
        if (session.state !== persistedState) {
          await this.options.registry.upsertSession({ ...session, state: persistedState });
        }
      }
      return;
    }
    if (name === "turn_settled") {
      const snapshot = await this.options.registry.readSnapshot();
      const instance = snapshot.instances[instanceId];
      const session = instance ? snapshot.sessions[instance.sessionId] : undefined;
      if (session) {
        await this.options.registry.upsertSession({
          ...session,
          state: await isPersistedSessionFile(session.sessionFile) ? "active" : "pending",
          lastActivityAt: new Date().toISOString(),
        });
        await this.options.registry.appendEvent("worker.ui_turn_settled", {
          sessionId: session.sessionId,
          instanceId,
        });
      }
      return;
    }
    if (name === "session_changed" || name === "session_info_changed") {
      const registration = parseUiWorkerRegistration(data.registration);
      const original = connection.registration;
      if (
        registration.instanceId !== original.instanceId ||
        registration.launchId !== original.launchId ||
        registration.pid !== original.pid ||
        registration.processBirthId !== original.processBirthId
      ) {
        throw new UiWorkerManagerError(
          "registry_inconsistent",
          "已认证的 UI worker 不得替换其他 instance 的身份信息。",
        );
      }
      const clearName = name === "session_info_changed" && data.clearName === true;
      await this.registerWorker(
        registration,
        await this.findInstanceAuthHash(instanceId),
        undefined,
        connection,
        clearName,
      );
      return;
    }
    if (name === "worker_shutdown") {
      await this.markStopped(instanceId);
    }
  }

  /**
   * 在非 Gateway shutdown 造成的断连时短暂标记 stale 并等待 bridge reconnect。
   *
   * @param connection 已关闭的 connection。
   * @param serverStopping 当前 Gateway 是否正在优雅退出。
   * @returns 无返回值。
   */
  private async handleDisconnect(connection: UiWorkerIpcConnection, serverStopping: boolean): Promise<void> {
    const instanceId = connection.registration.instanceId;
    if (this.connections.get(instanceId) === connection) {
      this.connections.delete(instanceId);
    }
    if (serverStopping) {
      return;
    }
    const snapshot = await this.options.registry.readSnapshot();
    const instance = snapshot.instances[instanceId];
    if (!instance || instance.mode !== "ui") {
      return;
    }
    if (!isProcessAlive(instance.pid)) {
      await this.markStopped(instanceId);
      return;
    }
    await this.options.registry.upsertInstance({
      ...instance,
      state: "stale",
      heartbeatAt: new Date().toISOString(),
    });
    this.scheduleStaleCleanup(instanceId);
  }

  /**
   * 将已退出 UI owner 的 session 保存, 并把关联 route 安全交给后台 RPC worker。
   *
   * @param instanceId UI worker instance ID。
   * @returns route 已交接或无须交接后正常结束。
   */
  private async markStopped(instanceId: string): Promise<void> {
    this.cancelStaleTimer(instanceId);
    this.connections.delete(instanceId);
    const snapshot = await this.options.registry.readSnapshot();
    const instance = snapshot.instances[instanceId];
    if (!instance) {
      this.resolveDisconnectWaiters(instanceId);
      return;
    }
    const session = snapshot.sessions[instance.sessionId];
    const routes = Object.entries(snapshot.routes).filter(([, route]) =>
      route.sessionId === instance.sessionId && route.workerInstanceId === instanceId,
    );
    const explicitStop = this.explicitStops.has(instance.sessionId);
    const transcriptExists = session ? await isPersistedSessionFile(session.sessionFile) : false;
    if (session) {
      await this.options.registry.upsertSession({
        ...session,
        mode: explicitStop ? session.mode : "background",
        state: transcriptExists ? "saved" : "pending",
        lastActivityAt: new Date().toISOString(),
      });
    }
    await this.options.registry.removeInstance(instanceId);

    if (explicitStop || routes.length === 0 || !session || !this.options.backgroundWorkerManager) {
      await Promise.all(routes.map(([routeId]) => this.options.registry.setRoute(routeId, null)));
    } else {
      try {
        const backgroundSession = transcriptExists
          ? await this.options.backgroundWorkerManager.resume(session.sessionId, "background")
          : await this.options.backgroundWorkerManager.startNew(session.projectAlias, session.name);
        const afterHandoff = await this.options.registry.readSnapshot();
        const backgroundOwner = Object.values(afterHandoff.instances).find((candidate) =>
          candidate.sessionId === backgroundSession.sessionId &&
          candidate.mode === "background" &&
          candidate.state !== "stale" &&
          candidate.state !== "stopping",
        );
        if (!backgroundOwner) {
          throw new UiWorkerManagerError("registry_inconsistent", "后台 owner 注册后未出现在 session registry。 ");
        }
        await Promise.all(routes.map(([routeId, route]) => this.options.registry.setRoute(routeId, {
          ...route,
          sessionId: backgroundSession.sessionId,
          workerInstanceId: backgroundOwner.instanceId,
          generation: route.generation + 1,
          updatedAt: new Date().toISOString(),
        })));
      } catch {
        await Promise.all(routes.map(([routeId]) => this.options.registry.setRoute(routeId, null)));
      }
    }

    await this.options.registry.appendEvent("worker.ui_stopped", {
      sessionId: instance.sessionId,
      instanceId,
      routeHandoff: !explicitStop && routes.length > 0,
    });
    this.resolveDisconnectWaiters(instanceId);
  }

  /**
   * 在 UI TUI 长期断连时保留 owner 记录并释放 stale timeout。
   *
   * @param instanceId worker instance ID。
   * @returns 无返回值。
   */
  private scheduleStaleCleanup(instanceId: string): void {
    this.cancelStaleTimer(instanceId);
    const timer = setTimeout(() => {
      this.staleTimers.delete(instanceId);
      void this.confirmStaleWorker(instanceId);
    }, this.maxStaleMs);
    timer.unref();
    this.staleTimers.set(instanceId, timer);
  }

  /**
   * stale 超时后只回收已退出的 Pi TUI; 存活或状态不明时保留 owner。
   *
   * @param instanceId worker instance ID。
   * @returns 无返回值。
   */
  private async confirmStaleWorker(instanceId: string): Promise<void> {
    const snapshot = await this.options.registry.readSnapshot();
    const instance = snapshot.instances[instanceId];
    if (!instance || instance.state !== "stale" || isProcessAlive(instance.pid)) {
      return;
    }
    await this.markStopped(instanceId);
  }

  /**
   * 清理指定 worker 的 stale timer。
   *
   * @param instanceId worker instance ID。
   * @returns 无返回值。
   */
  private cancelStaleTimer(instanceId: string): void {
    const timer = this.staleTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.staleTimers.delete(instanceId);
    }
  }

  /**
   * 获取现存 UI worker 的 registry 认证摘要。
   *
   * @param instanceId worker instance ID。
   * @returns ticket SHA-256 摘要。
   */
  private async findInstanceAuthHash(instanceId: string): Promise<string> {
    const snapshot = await this.options.registry.readSnapshot();
    const instance = snapshot.instances[instanceId];
    if (!instance?.ipcAuthHash) {
      throw new UiWorkerManagerError("registry_inconsistent", "UI worker registry 缺少 IPC auth hash。 ");
    }
    return instance.ipcAuthHash;
  }

  /**
   * 等待 UI worker shutdown lifecycle 完成。
   *
   * @param instanceId worker instance ID。
   * @returns 所有 stop waiter 正常结束。
   */
  private resolveDisconnectWaiters(instanceId: string): void {
    const waiters = this.disconnectWaiters.get(instanceId);
    if (!waiters) {
      return;
    }
    this.disconnectWaiters.delete(instanceId);
    for (const resolveWaiter of waiters) {
      resolveWaiter();
    }
  }

  /**
   * 在当前平台启动可见 Pi UI worker。
   *
   * @returns Windows 平台正常结束。
   * @throws {UiWorkerManagerError} 非 Windows 平台时抛出。
   */
  private assertSupportedPlatform(): void {
    if ((this.options.platform ?? process.platform) !== "win32") {
      throw new UiWorkerManagerError(
        "unsupported_platform",
        "可见 UI 模式依赖 Windows Terminal, 当前平台不支持, 已阻塞该操作; 请改用 background 模式。",
      );
    }
  }

  /**
   * 探测可见 UI 模式是否可用, 不可用时在启动前阻塞操作。
   *
   * 仅缓存成功结果; 失败结果不缓存, 以便用户安装 Windows Terminal 后无需重启 daemon 即可重试。
   *
   * @returns 可用时正常结束。
   * @throws {UiWorkerManagerError} 平台不受支持或 Windows Terminal 缺失时抛出。
   */
  private async assertUiModeAvailable(): Promise<void> {
    this.assertSupportedPlatform();
    const capability = await this.describeUiModeCapability();
    if (capability.supported) {
      return;
    }
    throw new UiWorkerManagerError(
      "wt_not_found",
      `${capability.reason}; 已阻塞可见 UI 会话创建与恢复, 请安装 Windows Terminal 或改用 background 模式。`,
    );
  }

  /**
   * 读取可见 UI 模式的能力探测结果, 供状态展示复用。
   *
   * 仅缓存成功结果; 平台不受支持或缺少 wt.exe 时每次重新探测。
   *
   * @returns 当前环境的 UI 模式能力。
   */
  async describeUiModeCapability(): Promise<WindowsTerminalCapability> {
    if ((this.options.platform ?? process.platform) !== "win32") {
      return {
        supported: false,
        reason: `当前系统为 ${this.options.platform ?? process.platform}, 可见 UI 模式依赖 Windows Terminal, 仅支持 Windows`,
      };
    }
    if (this.capabilityTask) {
      return this.capabilityTask;
    }
    const probe = this.options.probeCapability
      ? this.options.probeCapability
      : async (): Promise<WindowsTerminalCapability> =>
        probeWindowsTerminalCapability({ platform: this.options.platform ?? process.platform });
    const capability = await probe();
    if (capability.supported) {
      this.capabilityTask = Promise.resolve(capability);
    }
    return capability;
  }

  /**
   * 解析已登记项目并在启动前重新验证允许根目录。
   *
   * @param projectAlias 项目 alias。
   * @returns 已验证项目路径。
   */
  private async resolveProject(projectAlias: string): Promise<{ displayName: string; path: string }> {
    try {
      return await this.options.projectService.resolve(projectAlias);
    } catch (error) {
      if (error instanceof ProjectServiceError) {
        throw error;
      }
      throw new UiWorkerManagerError("worker_launch_failed", "UI worker 项目路径验证失败。 ");
    }
  }

  /**
   * 创建一次性 launch record。
   *
   * @param options 新建或恢复 session 参数。
   * @returns 带有随机 instanceId/ticket 的 record。
   */
  private createLaunchRecord(options: {
    mode: "new" | "resume";
    projectAlias: string;
    projectPath: string;
    sessionName?: string;
    sessionId?: string;
    sessionFile?: string;
  }): UiWorkerLaunchRecord {
    const piCliEntry = this.options.invocation.args[0];
    if (!piCliEntry || !isAbsolute(this.options.invocation.command) || !isAbsolute(piCliEntry)) {
      throw new UiWorkerManagerError("worker_launch_failed", "当前 Pi CLI argv 不适用于安全 UI worker 启动。 ");
    }
    const now = Date.now();
    return {
      schemaVersion: 1,
      launchId: randomUUID(),
      instanceId: randomUUID(),
      ticket: randomBytes(32).toString("hex"),
      mode: options.mode,
      projectAlias: options.projectAlias,
      projectPath: options.projectPath,
      ...(options.sessionName ? { sessionName: options.sessionName } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
      managerDirectory: resolve(this.options.managerDirectory),
      agentDirectory: dirname(resolve(this.options.managerDirectory)),
      pipeEndpoint: this.options.ipcServer.endpoint,
      nodeExecutable: this.options.invocation.command,
      piCliEntry: resolve(piCliEntry),
      extensionPath: resolve(this.options.extensionPath),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.options.registrationTimeoutMs ?? 30000)).toISOString(),
    };
  }

  /**
   * 调用 WT launcher 并等待 extension 完成注册。
   *
   * @param launch 已校验 launch record。
   * @returns 注册 session。
   */
  private async launchAndWait(launch: UiWorkerLaunchRecord): Promise<SessionIndexRecord> {
    const launcher = this.options.launcher ?? new WindowsTerminalLauncher();
    const registration = this.options.ipcServer.waitForLaunch(
      launch.launchId,
      this.options.registrationTimeoutMs ?? 30000,
    );
    void registration.catch(() => undefined);
    try {
      await this.options.ipcServer.registerLaunch(launch);
      await launcher.launch(this.options.managerDirectory, launch.projectPath, launch.launchId);
      await registration;
    } catch (error) {
      await this.options.ipcServer.removeLaunch(launch.launchId).catch(() => undefined);
      if (error instanceof WindowsTerminalLaunchError) {
        const code = error.code === "wt_not_found" ? "wt_not_found" :
          error.code === "unsupported_platform" ? "unsupported_platform" : "worker_launch_failed";
        throw new UiWorkerManagerError(code, error.message);
      }
      if (error instanceof UiWorkerIpcError && error.code === "request_timeout") {
        throw new UiWorkerManagerError("worker_registration_timeout", error.message);
      }
      if (error instanceof UiWorkerManagerError) {
        throw error;
      }
      throw new UiWorkerManagerError("worker_launch_failed", "UI worker 启动失败; 未绑定微信 route。 ");
    }
    const registeredSessionId = launch.mode === "resume"
      ? launch.sessionId
      : [...this.connections.values()].find((connection) => connection.registration.instanceId === launch.instanceId)
        ?.registration.sessionId;
    const session = registeredSessionId
      ? (await this.options.registry.readSnapshot()).sessions[registeredSessionId]
      : undefined;
    if (!session) {
      throw new UiWorkerManagerError("registry_inconsistent", "UI worker 注册成功, 但 session 索引未写入。 ");
    }
    return session;
  }
}

/**
 * 按 session_info_changed 事件更新或清除 session display name。
 *
 * @param session 现有 session 索引。
 * @param name 新名称。
 * @param clearName 是否明确清除名称。
 * @returns 更新后的 session record。
 */
function applySessionName(
  session: SessionIndexRecord,
  name: string | undefined,
  clearName: boolean,
): SessionIndexRecord {
  const updated = { ...session };
  if (clearName) {
    delete updated.name;
  } else if (name !== undefined) {
    updated.name = name;
  }
  return updated;
}

/**
 * 比较两个已解析项目路径, Windows 上忽略大小写。
 *
 * @param left 路径一。
 * @param right 路径二。
 * @returns 规范路径一致时返回 true。
 */
function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

/**
 * 校验 UI bridge 发来的 worker state。
 *
 * @param value 任意事件字段。
 * @returns WorkerState union 成员时返回 true。
 */
function isWorkerState(value: unknown): value is WorkerState {
  return value === "starting" ||
    value === "idle" ||
    value === "running" ||
    value === "stopping" ||
    value === "stale";
}

/**
 * 验证一个值是否是普通 JSON object。
 *
 * @param value 任意值。
 * @returns 非数组对象时返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 检查 UI session transcript 是否已由 Pi 写入磁盘。
 *
 * @param sessionFile Pi session 文件路径。
 * @returns 普通文件存在时返回 true。
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
 * 判断值是否为 Node.js 文件系统错误。
 *
 * @param error 任意错误。
 * @returns 包含 Node.js 错误代码时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
