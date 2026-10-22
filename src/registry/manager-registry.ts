import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GatewayLease } from "./gateway-lease.ts";
import type {
  GatewayStatusRecord,
  ManagerEventRecord,
  RegistrySnapshot,
  RouteRecord,
  SessionIndexRecord,
  WorkerInstanceRecord,
} from "./types.ts";

/**
 * 表示 manager registry 文件损坏或版本不兼容。
 */
export class RegistryCorruptionError extends Error {
  /**
   * 创建 registry 读取错误。
   *
   * @param filePath 出错的 registry 文件。
   * @param message 不包含文件内容的中文说明。
   */
  constructor(filePath: string, message: string) {
    super(`${message} (${filePath})`);
    this.name = "RegistryCorruptionError";
  }
}

/**
 * 管理单写入 Gateway 的 JSON 快照与 append-only JSONL 事件日志。
 */
export class ManagerRegistry {
  readonly directory: string;
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * 创建 manager registry。
   *
   * @param directory manager 数据目录。
   * @param lease 当前 Gateway owner 租约。
   */
  constructor(
    directory: string,
    private readonly lease: GatewayLease,
  ) {
    this.directory = resolve(directory);
  }

  /**
   * 读取 gateway、instances、routes 和 session-index 四份快照。
   *
   * @returns registry 当前可读状态。
   */
  async readSnapshot(): Promise<RegistrySnapshot> {
    return this.withWriteQueue(async () => {
      const [gateway, instances, routes, sessions] = await Promise.all([
        this.readJson<GatewayStatusRecord | null>("gateway.json", null),
        this.readJson<Record<string, WorkerInstanceRecord>>("instances.json", {}),
        this.readJson<Record<string, RouteRecord>>("routes.json", {}),
        this.readJson<Record<string, SessionIndexRecord>>("session-index.json", {}),
      ]);
      return { gateway, instances, routes, sessions };
    });
  }

  /**
   * 保存 Gateway 状态快照。
   *
   * @param status Gateway 当前状态。
   * @returns 无返回值。
   */
  async setGateway(status: GatewayStatusRecord | null): Promise<void> {
    if (status !== null) {
      await this.writeJson("gateway.json", status);
      return;
    }
    await this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      try {
        await unlink(join(this.directory, "gateway.json"));
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    });
  }

  /**
   * 新增或更新在线 worker 实例。
   *
   * @param instance worker 状态记录。
   * @returns 无返回值。
   */
  async upsertInstance(instance: WorkerInstanceRecord): Promise<void> {
    await this.updateRecord<WorkerInstanceRecord>(
      "instances.json",
      instance.instanceId,
      instance,
    );
  }

  /**
   * 移除已停止 worker 实例记录。
   *
   * @param instanceId worker 实例 ID。
   * @returns 无返回值。
   */
  async removeInstance(instanceId: string): Promise<void> {
    await this.deleteRecord("instances.json", instanceId);
  }

  /**
   * 新增或更新 Pi session 索引记录。
   *
   * @param session session 元数据。
   * @returns 无返回值。
   */
  async upsertSession(session: SessionIndexRecord): Promise<void> {
    await this.updateRecord<SessionIndexRecord>(
      "session-index.json",
      session.sessionId,
      session,
    );
  }

  /**
   * 新增、更新或移除微信 route 绑定。
   *
   * @param routeId 路由稳定 ID。
   * @param route 新绑定, 传 null 表示移除。
   * @returns 无返回值。
   */
  async setRoute(routeId: string, route: RouteRecord | null): Promise<void> {
    if (route === null) {
      await this.deleteRecord("routes.json", routeId);
      return;
    }
    await this.updateRecord<RouteRecord>("routes.json", routeId, route);
  }

  /**
   * 追加不包含凭证或消息正文的 registry 审计事件。
   *
   * @param type 事件类型。
   * @param data 经过筛选的事件元数据。
   * @returns 已追加的事件记录。
   */
  async appendEvent(
    type: string,
    data: Record<string, unknown> = {},
  ): Promise<ManagerEventRecord> {
    assertEventDataIsSafe(data);
    return this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      await mkdir(this.directory, { recursive: true });
      const event: ManagerEventRecord = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type,
        data,
      };
      const filePath = join(this.directory, "events.jsonl");
      const handle = await open(filePath, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return event;
    });
  }

  /**
   * 按 key 更新 JSON 快照并原子替换文件。
   *
   * @param fileName registry 文件名。
   * @param key 快照中的记录 ID。
   * @param value 要保存的记录。
   * @returns 无返回值。
   */
  private async updateRecord<T>(
    fileName: string,
    key: string,
    value: T,
  ): Promise<void> {
    await this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      const records = await this.readJson<Record<string, T>>(fileName, {});
      const updated = {
        ...records,
        [key]: value,
      };
      await this.writeJsonUnlocked(fileName, updated);
    });
  }

  /**
   * 从 JSON 快照删除指定记录。
   *
   * @param fileName registry 文件名。
   * @param key 快照中的记录 ID。
   * @returns 无返回值。
   */
  private async deleteRecord(fileName: string, key: string): Promise<void> {
    await this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      const records = await this.readJson<Record<string, unknown>>(fileName, {});
      const updated = { ...records };
      delete updated[key];
      await this.writeJsonUnlocked(fileName, updated);
    });
  }

  /**
   * 在 Gateway owner 租约下写入 JSON 快照。
   *
   * @param fileName registry 文件名。
   * @param value 要序列化的状态。
   * @returns 无返回值。
   */
  private async writeJson(fileName: string, value: unknown): Promise<void> {
    await this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      await this.writeJsonUnlocked(fileName, value);
    });
  }

  /**
   * 读取 JSON 快照; 文件不存在时返回传入默认值。
   *
   * @param fileName registry 文件名。
   * @param fallback 文件不存在时的默认值。
   * @returns 解码后的 JSON 状态。
   * @throws {RegistryCorruptionError} 文件 JSON 结构不可信时抛出。
   */
  private async readJson<T>(fileName: string, fallback: T): Promise<T> {
    const filePath = join(this.directory, fileName);
    try {
      const contents = await readFile(filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents) as unknown;
      } catch {
        throw new RegistryCorruptionError(filePath, "registry JSON 格式无效, 已拒绝继续写入");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new RegistryCorruptionError(filePath, "registry JSON 根节点必须是对象");
      }
      return parsed as T;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return fallback;
      }
      throw error;
    }
  }

  /**
   * 原子写入同目录临时文件并替换快照。
   *
   * @param fileName registry 文件名。
   * @param value 要序列化的状态。
   * @returns 无返回值。
   */
  private async writeJsonUnlocked(fileName: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const filePath = join(this.directory, fileName);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      try {
        await unlink(temporaryPath);
      } catch {
        throw new Error("registry 快照写入失败, 且无法清理临时文件。");
      }
      throw error;
    }
    await handle.close();
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") {
          throw cleanupError;
        }
      }
      throw error;
    }
  }

  /**
   * 串行执行本 registry 实例的写操作。
   *
   * @param operation 写操作。
   * @returns 写操作结果。
   */
  private async withWriteQueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release = (): void => undefined;
    this.writeQueue = new Promise<void>((resolveQueue) => {
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

const SENSITIVE_EVENT_FIELDS = new Set([
  "message",
  "prompt",
  "content",
  "token",
  "credential",
  "credentialfile",
  "apikey",
  "password",
  "secret",
  "output",
  "command",
]);

/**
 * 拒绝把消息正文、凭证或命令输出写入普通审计事件。
 *
 * @param value 待记录事件数据。
 * @param ancestors 当前递归路径上的对象集合。
 * @returns 无返回值。
 * @throws {Error} 发现敏感字段或循环对象时抛出。
 */
function assertEventDataIsSafe(
  value: unknown,
  ancestors = new Set<object>(),
): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (ancestors.has(value)) {
    throw new Error("registry 审计事件不能包含循环引用。");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertEventDataIsSafe(item, ancestors);
    }
  } else {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (SENSITIVE_EVENT_FIELDS.has(key.toLowerCase())) {
        throw new Error("registry 审计事件不能包含消息正文、凭证、命令或输出字段。");
      }
      assertEventDataIsSafe(nestedValue, ancestors);
    }
  }
  ancestors.delete(value);
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
