import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { GatewayLease } from "../../registry/gateway-lease.ts";

/**
 * 持久化格式, 仅保存不透明的同步游标。
 */
interface CursorRecord {
  schemaVersion: 1;
  getUpdatesBuf: string;
}

/**
 * 表示 iLink 同步游标文件无效。
 */
export class IlinkCursorError extends Error {
  /**
   * 创建游标文件错误。
   *
   * @param message 不包含游标内容的中文说明。
   */
  constructor(message: string) {
    super(message);
    this.name = "IlinkCursorError";
  }
}

/**
 * 在 manager 私有目录中原子保存 iLink get_updates_buf。
 */
export class IlinkCursorStore {
  /**
   * 创建 iLink 游标存储。
   *
   * @param filePath 独立游标文件路径。
   * @param lease 当前 Gateway owner 租约。
   */
  constructor(
    readonly filePath: string,
    private readonly lease: GatewayLease,
  ) {}

  /**
   * 读取已持久化的 get_updates_buf; 首次运行返回空字符串。
   *
   * @returns 不透明同步游标。
   * @throws {IlinkCursorError} 文件损坏或版本不兼容时抛出。
   */
  async load(): Promise<string> {
    try {
      const content = await readFile(this.filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content) as unknown;
      } catch {
        throw new IlinkCursorError("iLink cursor 文件不是有效 JSON, 已停止轮询。");
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        !("schemaVersion" in parsed) ||
        parsed.schemaVersion !== 1 ||
        !("getUpdatesBuf" in parsed) ||
        typeof parsed.getUpdatesBuf !== "string"
      ) {
        throw new IlinkCursorError("iLink cursor 文件格式不兼容, 已停止轮询。");
      }
      return parsed.getUpdatesBuf;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  /**
   * 在 Gateway lease 下原子保存同步游标。
   *
   * @param getUpdatesBuf iLink 返回的不透明游标。
   * @returns 无返回值。
   * @throws {IlinkCursorError} 游标无效时抛出。
   */
  async save(getUpdatesBuf: string): Promise<void> {
    if (typeof getUpdatesBuf !== "string" || getUpdatesBuf.length > 1024 * 1024) {
      throw new IlinkCursorError("iLink get_updates_buf 无效或超过大小限制。");
    }
    await this.lease.assertOwned();
    await mkdir(dirname(this.filePath), { recursive: true });
    const record: CursorRecord = {
      schemaVersion: 1,
      getUpdatesBuf,
    };
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      try {
        await unlink(temporaryPath);
      } catch {
        throw new IlinkCursorError("iLink cursor 写入失败且临时文件无法清理。");
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
 * @returns 值带有 Node.js 错误代码时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
