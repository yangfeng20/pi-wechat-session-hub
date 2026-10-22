import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { BackgroundPiWorker } from "./background-pi-worker.ts";
import type { PiCliInvocation } from "./pi-cli.ts";
import { ManagerRegistry } from "../registry/manager-registry.ts";
import type {
  SessionIndexRecord,
  WorkerInstanceRecord,
  WorkerState,
} from "../registry/types.ts";
import { ProjectService } from "../projects/project-service.ts";

export type BackgroundWorkerManagerErrorCode =
  | "max_background_workers"
  | "session_not_found"
  | "session_not_saved"
  | "session_owned_by_other_process"
  | "worker_not_found"
  | "worker_stop_failed";

/**
 * 表示后台 worker 管理请求无法安全完成。
 */
export class BackgroundWorkerManagerError extends Error {
  /**
   * 创建后台 worker 管理错误。
   *
   * @param code 稳定错误代码。
   * @param message 面向用户的中文说明。
   */
  constructor(
    readonly code: BackgroundWorkerManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BackgroundWorkerManagerError";
  }
}

export interface BackgroundWorkerManagerOptions {
  projectService: ProjectService;
  registry: ManagerRegistry;
  invocation: PiCliInvocation;
  maxBackgroundWorkers?: number;
  sessionDirectory?: string;
  env?: NodeJS.ProcessEnv;
  disableDiscoveredResources?: boolean;
}

/**
 * 负责后台 Pi worker 创建、恢复、消息投递和优雅停止。
 */
export class BackgroundWorkerManager {
  private readonly projectService: ProjectService;
  private readonly registry: ManagerRegistry;
  private readonly invocation: PiCliInvocation;
  private readonly maxBackgroundWorkers: number;
  private readonly sessionDirectory?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly disableDiscoveredResources: boolean;
  private readonly workers = new Map<string, BackgroundPiWorker>();
  private readonly stoppingSessions = new Set<string>();
  private startQueue: Promise<void> = Promise.resolve();
  private readonly sessionQueues = new Map<string, Promise<void>>();

  /**
   * 创建后台 worker 管理器。
   *
   * @param options 项目服务、registry、Pi CLI 和 worker 限额。
   */
  constructor(options: BackgroundWorkerManagerOptions) {
    this.projectService = options.projectService;
    this.registry = options.registry;
    this.invocation = options.invocation;
    this.maxBackgroundWorkers = options.maxBackgroundWorkers ?? 4;
    this.sessionDirectory = options.sessionDirectory;
    this.env = options.env;
    this.disableDiscoveredResources = options.disableDiscoveredResources ?? false;
  }

  /**
   * 让 Pi CLI 自己创建新的后台 session。
   *
   * @param projectAlias 已登记项目 alias。
   * @param name 可选 session 显示名称。
   * @returns 已启动 worker 的 session 索引记录。
   * @throws {BackgroundWorkerManagerError} worker 数量达到上限时抛出。
   */
  async startNew(projectAlias: string, name?: string): Promise<SessionIndexRecord> {
    return this.withStartQueue(async () => {
      const project = await this.projectService.resolve(projectAlias);
      const snapshot = await this.registry.readSnapshot();
      const activeBackgroundCount = Object.values(snapshot.instances).filter((instance) =>
        instance.mode === "background" && instance.state !== "stale" && instance.state !== "stopping",
      ).length;
      if (activeBackgroundCount >= this.maxBackgroundWorkers) {
        throw new BackgroundWorkerManagerError(
          "max_background_workers",
          `后台 worker 数量已达到上限 ${this.maxBackgroundWorkers}。`,
        );
      }

      const worker = await BackgroundPiWorker.start({
        invocation: this.invocation,
        cwd: project.path,
        name,
        sessionDirectory: this.sessionDirectory,
        env: this.env,
        disableDiscoveredResources: this.disableDiscoveredResources,
      });
      const session: SessionIndexRecord = {
        sessionId: worker.info.sessionId,
        sessionFile: worker.info.sessionFile,
        cwd: project.path,
        projectAlias,
        ...(worker.info.name ? { name: worker.info.name } : name ? { name } : {}),
        mode: "background",
        state: await isPersistedSessionFile(worker.info.sessionFile) ? "active" : "pending",
        lastActivityAt: new Date().toISOString(),
      };

      try {
        await this.registerWorker(worker, session);
      } catch (error) {
        await worker.shutdown().catch(() => undefined);
        throw error;
      }
      return session;
    });
  }

  /**
   * 恢复 registry 中已保存且没有活跃 owner 的 session。
   *
   * @param sessionId Pi session ID。
   * @returns 恢复后的 session 索引记录。
   * @throws {BackgroundWorkerManagerError} session 不存在或已有其他 owner 时抛出。
   */
  async resume(sessionId: string, mode: "background" | "ui" = "background"): Promise<SessionIndexRecord> {
    return this.withStartQueue(() => this.withSessionQueue(sessionId, async () => {
      const existingWorker = this.workers.get(sessionId);
      if (existingWorker && existingWorker.state !== "stale") {
        return this.findSession(sessionId);
      }
      if (existingWorker?.state === "stale") {
        this.workers.delete(sessionId);
        await this.registry.removeInstance(existingWorker.info.instanceId);
        const staleSession = await this.findSession(sessionId);
        await this.registry.upsertSession({
          ...staleSession,
          mode,
          state: await isPersistedSessionFile(staleSession.sessionFile) ? "saved" : "pending",
        });
      }
      const snapshot = await this.registry.readSnapshot();
      const session = snapshot.sessions[sessionId];
      if (!session) {
        throw new BackgroundWorkerManagerError(
          "session_not_found",
          `未找到 session: ${sessionId}。`,
        );
      }
      const activeOwner = Object.values(snapshot.instances).find((instance) =>
        instance.sessionId === sessionId && instance.state !== "stale" && instance.state !== "stopping",
      );
      if (activeOwner || session.state === "active") {
        throw new BackgroundWorkerManagerError(
          "session_owned_by_other_process",
          activeOwner
            ? `session 已由另一个 Pi runtime 持有 (${activeOwner.mode}, PID ${activeOwner.pid}), 拒绝双开。`
            : `session ${sessionId} 在 registry 中仍标记为 active, owner 状态未核实, 拒绝恢复。`,
        );
      }
      if (!(await isPersistedSessionFile(session.sessionFile))) {
        throw new BackgroundWorkerManagerError(
          "session_not_saved",
          `session ${sessionId} 尚无 Pi session JSONL 文件; 先向活跃 worker 发送一条消息后才能恢复。`,
        );
      }
      const project = await this.projectService.resolveSession(session.projectAlias, session.cwd);
      const worker = await BackgroundPiWorker.start({
        invocation: this.invocation,
        cwd: project.path,
        sessionFile: session.sessionFile,
        name: session.name,
        sessionDirectory: this.sessionDirectory,
        env: this.env,
        disableDiscoveredResources: this.disableDiscoveredResources,
      });
      if (
        worker.info.sessionId !== sessionId ||
        !samePath(worker.info.sessionFile, session.sessionFile)
      ) {
        await worker.shutdown().catch(() => undefined);
        throw new BackgroundWorkerManagerError(
          "session_not_found",
          "Pi 恢复后返回了不同的 sessionId, 已停止新 worker。",
        );
      }

      const resumed: SessionIndexRecord = {
        ...session,
        sessionFile: worker.info.sessionFile,
        cwd: project.path,
        mode,
        state: "active",
        lastActivityAt: new Date().toISOString(),
      };
      try {
        await this.registerWorker(worker, resumed);
      } catch (error) {
        await worker.shutdown().catch(() => undefined);
        throw error;
      }
      return resumed;
    }));
  }

  /**
   * 向活跃后台 session 发送消息并等待 Pi 最终文本。
   *
   * @param sessionId Pi session ID。
   * @param message 用户消息正文。
   * @returns Pi 最终 assistant 文本。
   * @throws {BackgroundWorkerManagerError} session 没有本 manager 的活跃 worker 时抛出。
   */
  async prompt(sessionId: string, message: string): Promise<string> {
    return this.withSessionQueue(sessionId, async () => {
      const worker = this.workers.get(sessionId);
      if (!worker) {
        throw new BackgroundWorkerManagerError(
          "worker_not_found",
          `session ${sessionId} 没有由当前 Gateway 管理的后台 worker。`,
        );
      }
      try {
        const text = await worker.prompt(message);
        const session = await this.findSession(sessionId);
        await this.registry.upsertSession({
          ...session,
          state: await isPersistedSessionFile(session.sessionFile) ? "active" : "pending",
          lastActivityAt: new Date().toISOString(),
        });
        if (worker.state !== "stale") {
          await this.updateWorkerState(worker);
        }
        await this.registry.appendEvent("worker.turn_settled", {
          sessionId,
          instanceId: worker.info.instanceId,
        });
        return text;
      } catch (error) {
        const session = await this.findSession(sessionId);
        await this.registry.upsertSession({
          ...session,
          state: await isPersistedSessionFile(session.sessionFile) ? "active" : "pending",
          lastActivityAt: new Date().toISOString(),
        });
        if (worker.state !== "stale") {
          await this.updateWorkerState(worker);
        }
        await this.registry.appendEvent("worker.turn_failed", {
          sessionId,
          instanceId: worker.info.instanceId,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      }
    });
  }

  /**
   * 优雅停止后台 worker, 保留 Pi session 文件与索引。
   *
   * @param sessionId Pi session ID。
   * @param abortRunning 是否明确允许中止当前 turn。
   * @returns 无返回值。
   * @throws {BackgroundWorkerManagerError} session 没有由当前 manager 管理的 worker 时抛出。
   */
  async stop(sessionId: string, abortRunning = false): Promise<void> {
    const runningWorker = this.workers.get(sessionId);
    if (abortRunning && runningWorker?.state === "running") {
      this.stoppingSessions.add(sessionId);
      try {
        await runningWorker.shutdown({ abortRunning: true });
      } catch (error) {
        this.stoppingSessions.delete(sessionId);
        throw error;
      }
    }

    return this.withSessionQueue(sessionId, async () => {
      const worker = this.workers.get(sessionId);
      if (!worker) {
        throw new BackgroundWorkerManagerError(
          "worker_not_found",
          `session ${sessionId} 没有由当前 Gateway 管理的后台 worker。`,
        );
      }
      this.stoppingSessions.add(sessionId);
      try {
        if (worker.state !== "stale") {
          await worker.shutdown({ abortRunning });
        }
        this.workers.delete(sessionId);
        await this.registry.removeInstance(worker.info.instanceId);
        const session = await this.findSession(sessionId);
        await this.registry.upsertSession({
          ...session,
          state: await isPersistedSessionFile(session.sessionFile) ? "saved" : "pending",
          lastActivityAt: new Date().toISOString(),
        });
        await this.registry.appendEvent("worker.stopped", {
          sessionId,
          instanceId: worker.info.instanceId,
        });
      } finally {
        this.stoppingSessions.delete(sessionId);
      }
    });
  }

  /**
   * 优雅停止本管理器启动或恢复的全部后台 worker。
   *
   * @returns 无返回值。
   * @throws {BackgroundWorkerManagerError} 任一 worker 未能安全停止时抛出。
   */
  async stopAll(): Promise<void> {
    const outcomes = await Promise.allSettled(
      [...this.workers.keys()].map((sessionId) => this.stop(sessionId)),
    );
    if (outcomes.some((outcome) => outcome.status === "rejected")) {
      throw new BackgroundWorkerManagerError(
        "worker_stop_failed",
        "至少一个后台 Pi worker 未能优雅停止; Gateway 租约将保留, 请检查后重试。",
      );
    }
  }

  /**
   * 检查当前进程是否持有该 session 的可用后台 worker。
   *
   * @param sessionId Pi session ID。
   * @returns worker 已启动且未 stale 时返回 true。
   */
  hasWorker(sessionId: string): boolean {
    const worker = this.workers.get(sessionId);
    return Boolean(worker && worker.state !== "stale" && worker.state !== "stopping");
  }

  /**
   * 列出 registry 中保存的所有 session。
   *
   * @returns 按最近活动时间倒序排列的 session。
   */
  async listSessions(): Promise<SessionIndexRecord[]> {
    const snapshot = await this.registry.readSnapshot();
    return Object.values(snapshot.sessions).sort((left, right) =>
      right.lastActivityAt.localeCompare(left.lastActivityAt),
    );
  }

  /**
   * 注册已启动 worker, session 和审计事件。
   *
   * @param worker Pi RPC worker。
   * @param session session 索引记录。
   * @returns 无返回值。
   */
  private async registerWorker(
    worker: BackgroundPiWorker,
    session: SessionIndexRecord,
  ): Promise<void> {
    const instance = this.toInstanceRecord(worker, session);
    try {
      if (worker.state === "stale") {
        throw new BackgroundWorkerManagerError(
          "worker_not_found",
          "Pi RPC worker 在 registry 注册前已退出。",
        );
      }
      const current = await this.registry.readSnapshot();
      const competingOwner = Object.values(current.instances).find((candidate) =>
        candidate.sessionId === session.sessionId &&
        candidate.instanceId !== instance.instanceId &&
        candidate.state !== "stale" &&
        candidate.state !== "stopping",
      );
      if (competingOwner) {
        throw new BackgroundWorkerManagerError(
          "session_owned_by_other_process",
          `session ${session.sessionId} 已由 PID ${competingOwner.pid} 持有, 拒绝双 writer。`,
        );
      }
      await this.registry.upsertInstance(instance);
      await this.registry.upsertSession(session);
      await this.registry.appendEvent("worker.started", {
        sessionId: session.sessionId,
        instanceId: instance.instanceId,
        projectAlias: session.projectAlias,
        mode: "background",
        pid: instance.pid,
      });
      this.workers.set(session.sessionId, worker);
      worker.on("state_change", (state: WorkerState) => {
        void this.handleWorkerStateChange(worker, state).catch(() => undefined);
      });
    } catch (error) {
      await this.registry.removeInstance(instance.instanceId).catch(() => undefined);
      await this.registry.upsertSession({
        ...session,
        state: await isPersistedSessionFile(session.sessionFile) ? "saved" : "pending",
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 将 worker 信息规范化为 registry instance 记录。
   *
   * @param worker Pi RPC worker。
   * @param session 对应 session 索引。
   * @returns worker instance 记录。
   */
  private toInstanceRecord(
    worker: BackgroundPiWorker,
    session: SessionIndexRecord,
  ): WorkerInstanceRecord {
    return {
      instanceId: worker.info.instanceId,
      pid: worker.info.pid,
      processBirthId: worker.info.processBirthId,
      sessionId: worker.info.sessionId,
      sessionFile: worker.info.sessionFile,
      cwd: session.cwd,
      projectAlias: session.projectAlias,
      mode: "background",
      state: worker.state,
      heartbeatAt: new Date().toISOString(),
    };
  }

  /**
   * 从 registry 读取 session 索引记录。
   *
   * @param sessionId Pi session ID。
   * @returns session 索引记录。
   * @throws {BackgroundWorkerManagerError} session 不存在时抛出。
   */
  private async findSession(sessionId: string): Promise<SessionIndexRecord> {
    const snapshot = await this.registry.readSnapshot();
    const session = snapshot.sessions[sessionId];
    if (!session) {
      throw new BackgroundWorkerManagerError(
        "session_not_found",
        `未找到 session: ${sessionId}。`,
      );
    }
    return session;
  }

  /**
   * 将 worker 当前状态写回 instance registry。
   *
   * @param worker Pi RPC worker。
   * @returns 无返回值。
   */
  private async updateWorkerState(worker: BackgroundPiWorker): Promise<void> {
    const session = await this.findSession(worker.info.sessionId);
    await this.registry.upsertInstance(this.toInstanceRecord(worker, session));
  }

  /**
   * 处理 worker 状态变化; 意外退出后保留已持久化 session。
   *
   * @param worker 发生状态变化的 Pi worker。
   * @param state 新状态。
   * @returns 无返回值。
   */
  private async handleWorkerStateChange(
    worker: BackgroundPiWorker,
    state: WorkerState,
  ): Promise<void> {
    const sessionId = worker.info.sessionId;
    if (this.workers.get(sessionId) !== worker || this.stoppingSessions.has(sessionId)) {
      return;
    }
    if (state !== "stale") {
      await this.updateWorkerState(worker);
      return;
    }
    this.workers.delete(sessionId);
    await this.registry.removeInstance(worker.info.instanceId);
    const session = await this.findSession(sessionId);
    await this.registry.upsertSession({
      ...session,
      state: await isPersistedSessionFile(session.sessionFile) ? "saved" : "pending",
      lastActivityAt: new Date().toISOString(),
    });
    await this.registry.appendEvent("worker.exited", {
      sessionId,
      instanceId: worker.info.instanceId,
    });
  }

  /**
   * 串行执行 session 内的消息、恢复和停止操作。
   *
   * @param sessionId Pi session ID。
   * @param operation 需要串行执行的操作。
   * @returns 操作结果。
   */
  private async withSessionQueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = previous.then(() => gate);
    this.sessionQueues.set(sessionId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionQueues.get(sessionId) === queued) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }

  /**
   * 串行执行 startNew 操作, 避免并发创建绕过 worker 限额。
   *
   * @param operation 创建操作。
   * @returns 创建结果。
   */
  private async withStartQueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.startQueue;
    let release = (): void => undefined;
    this.startQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/**
 * 判断两个 session 文件路径是否指向同一位置。
 *
 * @param left Pi 返回的路径。
 * @param right registry 保存的路径。
 * @returns 路径一致时返回 true。
 */
function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

/**
 * 判断 Pi session JSONL 是否已由 Pi 持久化。
 *
 * @param sessionFile Pi 返回的 session 文件路径。
 * @returns 文件存在且为普通文件时返回 true。
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
 * @param error 待检查值。
 * @returns 值带有 Node.js 错误代码时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
