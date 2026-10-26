import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, unlink, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isProcessAlive } from "../system/process-liveness.ts";
import { promisify } from "node:util";

interface GatewayLockMetadata {
  ownerId: string;
  pid: number;
  processBirthId: string;
  token: string;
  acquiredAt: string;
}

const PROCESS_BIRTH_ID_ENV = "PI_WECHAT_MANAGER_PROCESS_BIRTH_ID";
const PROCESS_BIRTH_ID = currentProcessBirthId();

export type GatewayLeaseErrorCode =
  | "gateway_already_running"
  | "gateway_lease_lost"
  | "gateway_acl_setup_failed";

/**
 * 表示 Gateway 租约被占用或已丢失。
 */
export class GatewayLeaseError extends Error {
  /**
   * 创建 Gateway 租约错误。
   *
   * @param code 稳定错误代码。
   * @param message 面向用户的中文错误信息。
   */
  constructor(
    readonly code: GatewayLeaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayLeaseError";
  }
}

/**
 * 通过原子创建 manager.lock 保证一个用户配置目录只有一个 Gateway owner。
 */
export class GatewayLease {
  readonly directory: string;
  readonly lockPath: string;
  readonly ownerId: string;
  readonly pid: number;
  readonly processBirthId: string;
  private readonly token: string;
  private released = false;

  /**
   * 创建已取得锁的 Gateway 租约对象。
   *
   * @param directory manager 数据目录。
   * @param lockPath 锁文件路径。
   * @param metadata 锁文件所有者信息。
   */
  private constructor(
    directory: string,
    lockPath: string,
    metadata: GatewayLockMetadata,
  ) {
    this.directory = directory;
    this.lockPath = lockPath;
    this.ownerId = metadata.ownerId;
    this.pid = metadata.pid;
    this.processBirthId = metadata.processBirthId;
    this.token = metadata.token;
  }

  /**
   * 尝试取得 Gateway owner 租约。
   *
   * @param directory manager 数据目录。
   * @returns 已持有的租约。
   * @throws {GatewayLeaseError} 另一个活跃 owner 持有锁或锁信息不可信时抛出。
   */
  static async acquire(directory: string): Promise<GatewayLease> {
    const canonicalDirectory = resolve(directory);
    try {
      const directoryStat = await lstat(canonicalDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new GatewayLeaseError(
          "gateway_acl_setup_failed",
          "manager 数据路径不是普通目录; 为避免写入非枢纽位置, Gateway 未启动。",
        );
      }
    } catch (error) {
      if (error instanceof GatewayLeaseError) {
        throw error;
      }
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    await mkdir(canonicalDirectory, { recursive: true, mode: 0o700 });
    if (process.platform === "win32" && (await readdir(canonicalDirectory)).length === 0) {
      await secureEmptyWindowsDirectory(canonicalDirectory);
    }
    const lockPath = join(canonicalDirectory, "manager.lock");
    const metadata: GatewayLockMetadata = {
      ownerId: randomUUID(),
      pid: process.pid,
      processBirthId: currentProcessBirthId(),
      token: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
        const stale = await isStaleLock(lockPath, metadata);
        if (!stale || attempt > 0) {
          throw new GatewayLeaseError(
            "gateway_already_running",
            "Pi 微信会话枢纽 Gateway 已运行, 或 manager.lock 状态不明确; 不会强行启动第二个 poller。",
          );
        }
        try {
          await unlink(lockPath);
        } catch (unlinkError) {
          if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") {
            throw new GatewayLeaseError(
              "gateway_already_running",
              "无法安全回收旧 manager.lock, 请确认没有 Gateway 进程后再处理。",
            );
          }
        }
        continue;
      }

      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close();
        try {
          await unlink(lockPath);
        } catch {
          throw new GatewayLeaseError(
            "gateway_lease_lost",
            "Gateway 锁创建失败且临时锁无法清理。",
          );
        }
        throw error;
      }
      await handle.close();
      return new GatewayLease(canonicalDirectory, lockPath, metadata);
    }

    throw new GatewayLeaseError(
      "gateway_already_running",
      "无法取得 Gateway owner 租约。",
    );
  }

  /**
   * 验证当前进程仍持有 manager.lock。
   *
   * @returns 无返回值。
   * @throws {GatewayLeaseError} 锁文件丢失、被替换或租约已释放时抛出。
   */
  async assertOwned(): Promise<void> {
    if (this.released) {
      throw new GatewayLeaseError("gateway_lease_lost", "Gateway owner 租约已释放。");
    }
    try {
      const metadata = JSON.parse(await readFile(this.lockPath, "utf8")) as Partial<GatewayLockMetadata>;
      if (
        metadata.token !== this.token ||
        metadata.ownerId !== this.ownerId ||
        metadata.pid !== this.pid ||
        metadata.processBirthId !== this.processBirthId
      ) {
        throw new GatewayLeaseError(
          "gateway_lease_lost",
          "manager.lock 所有者已改变, 当前进程停止写入 registry。",
        );
      }
    } catch (error) {
      if (error instanceof GatewayLeaseError) {
        throw error;
      }
      throw new GatewayLeaseError(
        "gateway_lease_lost",
        "manager.lock 不可读取, 当前进程停止写入 registry。",
      );
    }
  }

  /**
   * 更新锁文件 mtime 作为存活心跳, 并先验证 owner token。
   *
   * @returns 心跳时间 ISO 字符串。
   * @throws {GatewayLeaseError} 租约丢失时抛出。
   */
  async heartbeat(): Promise<string> {
    await this.assertOwned();
    const heartbeatAt = new Date();
    try {
      await utimes(this.lockPath, heartbeatAt, heartbeatAt);
    } catch {
      throw new GatewayLeaseError(
        "gateway_lease_lost",
        "manager.lock 心跳写入失败, 当前进程停止写入 registry。",
      );
    }
    return heartbeatAt.toISOString();
  }

  /**
   * 仅当锁令牌仍匹配时释放 Gateway 租约。
   *
   * @returns 无返回值。
   */
  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    try {
      const metadata = JSON.parse(await readFile(this.lockPath, "utf8")) as Partial<GatewayLockMetadata>;
      if (
        metadata.token === this.token &&
        metadata.ownerId === this.ownerId &&
        metadata.pid === this.pid
      ) {
        await unlink(this.lockPath);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

/**
 * 为新建或空的 manager 目录移除继承 ACL, 仅授予当前用户、SYSTEM 和 Administrators。
 *
 * @param directory 枢纽专属 manager 数据目录。
 * @returns ACL 设置成功时正常结束。
 * @throws {GatewayLeaseError} 无法解析当前 SID 或写入 ACL 时抛出。
 */
async function secureEmptyWindowsDirectory(directory: string): Promise<void> {
  const execFileAsync = promisify(execFile);
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const systemDirectory = join(systemRoot, "System32");
  try {
    const identity = await execFileAsync(
      join(systemDirectory, "whoami.exe"),
      ["/user", "/fo", "csv", "/nh"],
      { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 },
    );
    const userSid = identity.stdout.match(/S-\d(?:-\d+)+/)?.[0];
    if (!userSid) {
      throw new Error("windows_user_sid_unavailable");
    }
    await execFileAsync(
      join(systemDirectory, "icacls.exe"),
      [
        directory,
        "/inheritance:r",
        "/grant:r",
        `*${userSid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
      ],
      { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 },
    );
  } catch (error) {
    const failureCode = isNodeError(error) ? String(error.code) : error instanceof Error ? error.name : typeof error;
    throw new GatewayLeaseError(
      "gateway_acl_setup_failed",
      `无法为新的 manager 数据目录设置 Windows ACL (${failureCode}); Gateway 未启动, 未创建 manager.lock。`,
    );
  }
}

/**
 * 计算当前 Node 进程的启动标识, 用于识别 PID 被当前进程重用的情况。
 *
 * @returns 包含 PID 和近似启动时间的稳定字符串。
 */
function currentProcessBirthId(): string {
  const inherited = process.env[PROCESS_BIRTH_ID_ENV];
  if (inherited?.startsWith(`${process.pid}:`)) {
    return inherited;
  }
  const startedAt = Math.floor(Date.now() - process.uptime() * 1000);
  const birthId = `${process.pid}:${startedAt}`;
  process.env[PROCESS_BIRTH_ID_ENV] = birthId;
  return birthId;
}

/**
 * 判断已有锁是否可以安全回收。
 *
 * @param lockPath 锁文件路径。
 * @param current 当前进程的锁信息。
 * @returns 旧 owner 已退出或当前 PID 已被重用时返回 true。
 */
async function isStaleLock(
  lockPath: string,
  current: GatewayLockMetadata,
): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const existing = JSON.parse(raw) as Partial<GatewayLockMetadata>;
    if (
      typeof existing.pid !== "number" ||
      !Number.isInteger(existing.pid) ||
      existing.pid <= 0 ||
      typeof existing.processBirthId !== "string" ||
      typeof existing.token !== "string" ||
      typeof existing.ownerId !== "string"
    ) {
      return false;
    }

    if (existing.pid === current.pid) {
      return existing.processBirthId !== current.processBirthId;
    }

    return !isProcessAlive(existing.pid);
  } catch {
    return false;
  }
}

/**
 * 判断值是否为 Node.js 文件系统或进程错误。
 *
 * @param error 待检查值。
 * @returns 值带有 Node.js 错误代码时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
