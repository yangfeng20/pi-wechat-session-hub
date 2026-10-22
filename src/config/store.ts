import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getCredentialFilePath, getManagerConfigurationPath } from "./paths.ts";
import { createDefaultConfiguration } from "./defaults.ts";
import { ConfigurationValidationError, validateConfiguration } from "./validation.ts";
import type { ManagerConfiguration } from "./types.ts";

interface LockMetadata {
  pid: number;
  token: string;
}

/**
 * 表示配置文件当前被另一个进程占用, 或锁状态无法安全判定。
 */
export class ConfigurationBusyError extends Error {
  /**
   * 创建配置占用错误。
   *
   * @param message 面向用户的中文错误信息。
   */
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationBusyError";
  }
}

/**
 * 配置文件加载结果。
 */
export interface ConfigurationSnapshot {
  config: ManagerConfiguration;
  exists: boolean;
}

/**
 * 读写 Pi 微信会话枢纽 JSON 配置, 并以临时文件原子替换。
 */
export class ConfigurationStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly credentialFile: string;

  /**
   * 创建配置存储。
   *
   * @param filePath 配置 JSON 文件路径。
   * @param credentialFile 独立凭证文件路径, 缺省为 manager 数据目录中的文件。
   */
  constructor(
    readonly filePath: string,
    credentialFile = join(dirname(filePath), "wechat-session-manager", "credentials.json"),
  ) {
    this.filePath = resolve(filePath);
    this.credentialFile = isAbsolute(credentialFile)
      ? credentialFile
      : resolve(dirname(this.filePath), credentialFile);
  }

  /**
   * 读取并校验配置; 文件不存在时返回默认配置但不创建文件。
   *
   * @returns 配置内容及文件是否已存在。
   * @throws {ConfigurationValidationError} 文件 JSON 或 schema 非法时抛出。
   */
  async load(): Promise<ConfigurationSnapshot> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents) as unknown;
      } catch {
        throw new ConfigurationValidationError("配置文件不是有效 JSON, 请检查文件格式。");
      }
      return {
        config: validateConfiguration(parsed, this.credentialFile),
        exists: true,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          config: createDefaultConfiguration(this.credentialFile),
          exists: false,
        };
      }
      throw error;
    }
  }

  /**
   * 校验并原子保存完整配置。
   *
   * @param value 待保存配置。
   * @returns 实际保存的规范化配置。
   */
  async save(value: ManagerConfiguration): Promise<ManagerConfiguration> {
    return this.withWriteQueue(async () => this.withFileLock(async () => {
      const config = validateConfiguration(value, this.credentialFile);
      await this.writeUnlocked(config);
      return config;
    }));
  }

  /**
   * 在互斥区内读取、修改并保存配置, 防止多个 manager 丢失彼此更新。
   *
   * @param updater 根据当前配置生成新配置的函数。
   * @returns 更新并保存后的配置。
   */
  async update(
    updater: (current: ManagerConfiguration) => ManagerConfiguration | Promise<ManagerConfiguration>,
  ): Promise<ManagerConfiguration> {
    return this.withWriteQueue(async () => this.withFileLock(async () => {
      const snapshot = await this.load();
      const updated = validateConfiguration(
        await updater(snapshot.config),
        this.credentialFile,
      );
      await this.writeUnlocked(updated);
      return updated;
    }));
  }

  /**
   * 串行执行当前进程内对此 store 的写操作。
   *
   * @param operation 要执行的异步写操作。
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

  /**
   * 使用独占锁执行写操作; 遇到不确定的锁状态时 fail-closed。
   *
   * @param operation 获得锁后执行的异步操作。
   * @returns 写操作结果。
   */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const token = randomUUID();
    const lockHandle = await this.acquireFileLock(lockPath, token);
    try {
      return await operation();
    } finally {
      await lockHandle.close();
      await this.releaseFileLock(lockPath, token);
    }
  }

  /**
   * 创建或安全回收配置锁。
   *
   * @param lockPath 锁文件路径。
   * @param token 当前写入者随机令牌。
   * @returns 已持有锁文件的句柄。
   * @throws {ConfigurationBusyError} 锁由活动进程持有或锁数据损坏时抛出。
   */
  private async acquireFileLock(lockPath: string, token: string) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
        if (attempt > 0 || await this.lockOwnerIsAlive(lockPath)) {
          throw new ConfigurationBusyError(
            "配置正在被另一个 Pi 进程修改, 请稍后重试; 锁状态不明确时不会强行覆盖。",
          );
        }
        await unlink(lockPath);
        continue;
      }

      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token } satisfies LockMetadata),
          "utf8",
        );
        await handle.sync();
        return handle;
      } catch (error) {
        await handle.close();
        try {
          await this.releaseFileLock(lockPath, token);
        } catch {
          throw new ConfigurationBusyError(
            "配置锁写入失败且无法安全清理, 请检查配置目录后重试。",
          );
        }
        throw error;
      }
    }
    throw new ConfigurationBusyError("无法取得配置写入锁, 请稍后重试。");
  }

  /**
   * 检查锁记录中的进程是否仍可能存活。
   *
   * @param lockPath 锁文件路径。
   * @returns 进程存活或锁数据不完整时返回 true。
   */
  private async lockOwnerIsAlive(lockPath: string): Promise<boolean> {
    try {
      const lockContents = await readFile(lockPath, "utf8");
      const metadata = JSON.parse(lockContents) as Partial<LockMetadata>;
      const pid = metadata.pid;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !metadata.token) {
        return true;
      }
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return !isNodeError(error) || error.code !== "ESRCH";
      }
    } catch {
      return true;
    }
  }

  /**
   * 仅在锁令牌仍匹配时移除锁文件。
   *
   * @param lockPath 锁文件路径。
   * @param token 当前写入者随机令牌。
   * @returns 无返回值。
   */
  private async releaseFileLock(lockPath: string, token: string): Promise<void> {
    try {
      const lockContents = await readFile(lockPath, "utf8");
      const metadata = JSON.parse(lockContents) as Partial<LockMetadata>;
      if (metadata.token === token && metadata.pid === process.pid) {
        await unlink(lockPath);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  /**
   * 将配置写入同目录临时文件并原子替换目标文件。
   *
   * @param config 已校验配置。
   * @returns 无返回值。
   */
  private async writeUnlocked(config: ManagerConfiguration): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      try {
        await unlink(temporaryPath);
      } catch {
        throw new Error("配置写入失败, 且无法清理临时文件。");
      }
      throw error;
    }
    await handle.close();
    try {
      await rename(temporaryPath, this.filePath);
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

/**
 * 获取使用 Pi 配置目录约定的默认配置存储。
 *
 * @returns 配置存储实例。
 */
export function createDefaultConfigurationStore(): ConfigurationStore {
  return new ConfigurationStore(
    getManagerConfigurationPath(),
    getCredentialFilePath(),
  );
}
