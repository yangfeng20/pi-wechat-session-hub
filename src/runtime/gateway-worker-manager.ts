import type { RuntimeMode } from "../config/types.ts";
import { ManagerRegistry } from "../registry/manager-registry.ts";
import type { SessionIndexRecord, WorkerInstanceRecord } from "../registry/types.ts";
import { BackgroundWorkerManager, BackgroundWorkerManagerError } from "./background-worker-manager.ts";
import { UiWorkerManager } from "./ui-worker-manager.ts";

/**
 * Gateway router 所需的统一 Pi worker 生命周期接口。
 */
export interface GatewayWorkerService {
  startNew(projectAlias: string, name?: string, mode?: RuntimeMode): Promise<SessionIndexRecord>;
  resume(sessionId: string, mode?: RuntimeMode): Promise<SessionIndexRecord>;
  prompt(sessionId: string, message: string): Promise<string>;
  stop(sessionId: string, abortRunning?: boolean): Promise<void>;
  stopAll(): Promise<void>;
  listSessions(): Promise<SessionIndexRecord[]>;
}

/**
 * 根据 registry owner mode 将 route 操作分发给 background 或 UI worker manager。
 */
export class GatewayWorkerManager implements GatewayWorkerService {
  /**
   * 创建跨模式的 worker manager facade。
   *
   * @param background 后台 Pi RPC worker manager。
   * @param ui 可见 Pi TUI worker manager。
   * @param registry session owner registry。
   */
  constructor(
    private readonly background: BackgroundWorkerManager,
    private readonly ui: UiWorkerManager,
    private readonly registry: ManagerRegistry,
  ) {}

  /**
   * 按请求模式创建一个 Pi session。
   *
   * @param projectAlias 已登记项目 alias。
   * @param name 可选显示名称。
   * @param mode background 或 ui, 缺省按配置选择。
   * @returns 新创建 session 索引。
   */
  async startNew(
    projectAlias: string,
    name?: string,
    mode: RuntimeMode = "background",
  ): Promise<SessionIndexRecord> {
    if (mode === "ui") {
      return this.ui.startNew(projectAlias, name);
    }
    return this.background.startNew(projectAlias, name);
  }

  /**
   * 按显式 mode 或保存记录的原 mode 恢复 Pi session。
   *
   * @param sessionId Pi session ID。
   * @param mode 可选强制恢复模式。
   * @returns 已恢复或已绑定的 session。
   */
  async resume(sessionId: string, mode?: RuntimeMode): Promise<SessionIndexRecord> {
    const snapshot = await this.registry.readSnapshot();
    const session = snapshot.sessions[sessionId];
    if (!session) {
      return this.background.resume(sessionId);
    }
    const requestedMode = mode ?? session.mode;
    const owner = findOwner(snapshot, sessionId);
    if (owner) {
      if (owner.mode === requestedMode && this.hasAvailableOwner(owner)) {
        return session;
      }
      throw new BackgroundWorkerManagerError(
        "session_owned_by_other_process",
        `session ${sessionId} 当前由 ${owner.mode} runtime 持有; 先停止 owner 后再切换模式。`,
      );
    }
    if (requestedMode === "ui") {
      return this.ui.resume(sessionId);
    }
    return this.background.resume(sessionId);
  }

  /**
   * 根据 registry owner 模式向 Pi session 投递消息。
   *
   * @param sessionId Pi session ID。
   * @param message 用户消息正文。
   * @returns 最终 assistant 回复文本。
   */
  async prompt(sessionId: string, message: string): Promise<string> {
    const snapshot = await this.registry.readSnapshot();
    const owner = findOwner(snapshot, sessionId);
    if (!owner) {
      throw new BackgroundWorkerManagerError(
        "worker_not_found",
        `session ${sessionId} 当前没有活跃 Pi worker owner。`,
      );
    }
    if (owner.mode === "ui") {
      return this.ui.prompt(sessionId, message);
    }
    return this.background.prompt(sessionId, message);
  }

  /**
   * 停止一个 session 当前的 runtime owner。
   *
   * @param sessionId Pi session ID。
   * @param abortRunning 是否明确允许 abort 正在运行的 turn。
   * @returns 无返回值。
   */
  async stop(sessionId: string, abortRunning = false): Promise<void> {
    const snapshot = await this.registry.readSnapshot();
    const owner = findOwner(snapshot, sessionId);
    if (!owner) {
      throw new BackgroundWorkerManagerError(
        "worker_not_found",
        `session ${sessionId} 当前没有活跃 Pi worker owner。`,
      );
    }
    if (owner.mode === "ui") {
      await this.ui.stop(sessionId, abortRunning);
      return;
    }
    await this.background.stop(sessionId, abortRunning);
  }

  /**
   * 只停止由 Gateway 管理的 background 子进程, UI tab 在 Gateway 停止时可断线后重连。
   *
   * @returns background worker 全部停止时正常结束。
   */
  async stopAll(): Promise<void> {
    await this.background.stopAll();
  }

  /**
   * 列出 registry 中的全部 Pi session。
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
   * 判断 registry owner 是否由当前 Gateway manager 持有可用连接。
   *
   * @param instance worker owner 记录。
   * @returns 运行态且当前 manager 可向其投递时返回 true。
   */
  hasAvailableOwner(instance: WorkerInstanceRecord): boolean {
    if (instance.state === "stale" || instance.state === "stopping") {
      return false;
    }
    return instance.mode === "background"
      ? this.background.hasWorker(instance.sessionId)
      : this.ui.hasConnection(instance.instanceId);
  }
}

/**
 * 查找 session 当前唯一的活跃 registry owner。
 *
 * @param snapshot registry 快照。
 * @param sessionId Pi session ID。
 * @returns 非 stale/stopping owner 或 undefined。
 */
function findOwner(
  snapshot: Awaited<ReturnType<ManagerRegistry["readSnapshot"]>>,
  sessionId: string,
): WorkerInstanceRecord | undefined {
  return Object.values(snapshot.instances).find((instance) =>
    instance.sessionId === sessionId && instance.state !== "stale" && instance.state !== "stopping",
  );
}
