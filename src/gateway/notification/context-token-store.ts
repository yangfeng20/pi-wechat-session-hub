import { createHash } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IlinkReplyContext } from "../channel-types.ts";

/**
 * 持久化的最新活跃 context token 记录。
 */
export interface ContextTokenRecord {
  recipientId: string;
  contextToken: string;
  /** token 对应入站消息的 ISO 时间戳, 用于新鲜度判断。 */
  receivedAt: string;
}

/**
 * 表示 context token 存储不可信或读写失败。
 */
export class ContextTokenStoreError extends Error {
  /**
   * 创建存储错误, 不包含 token 内容。
   *
   * @param code 稳定错误代码。
   * @param message 面向用户的中文说明。
   */
  constructor(
    readonly code: "path_unsafe" | "format_invalid" | "write_failed",
    message: string,
  ) {
    super(message);
    this.name = "ContextTokenStoreError";
  }
}

/**
 * 保存单条通知的最大字符数。
 */
const MAX_NOTIFICATION_TEXT_LENGTH = 8000;

/**
 * 将授权微信用户的最新 context token 持久化到 ACL 保护目录。
 *
 * iLink 主动发送必须携带目标用户最近一条入站消息的 context_token,
 * 该 token 约 24 小时过期。本存储只保存一个用户的单条活跃记录,
 * daemon 重启后自动恢复, 补发与提醒功能都依赖它。
 */
export class ContextTokenStore {
  private readonly filePath: string;

  /**
   * 创建 context token 存储。
   *
   * @param managerDirectory Hub 私有数据目录。
   */
  constructor(managerDirectory: string) {
    this.filePath = join(managerDirectory, "ilink-context-token.json");
  }

  /**
   * 记录最新入站消息的回复上下文, 覆盖旧记录。
   *
   * @param replyContext 入站消息的回复上下文。
   * @param receivedAt 入站消息时间, 缺省为当前时间。
   * @returns 无返回值。
   * @throws {ContextTokenStoreError} 写入失败时抛出。
   */
  async record(replyContext: IlinkReplyContext, receivedAt = new Date().toISOString()): Promise<void> {
    if (!replyContext.recipientId.trim() || !replyContext.contextToken.trim()) {
      return;
    }
    const record: ContextTokenRecord = {
      recipientId: replyContext.recipientId,
      contextToken: replyContext.contextToken,
      receivedAt,
    };
    await this.writeFileAtomically(`${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * 读取最新记录, 文件不存在时返回 undefined。
   *
   * @returns 最新 context token 记录。
   * @throws {ContextTokenStoreError} 文件类型不可信或格式无效时抛出。
   */
  async load(): Promise<ContextTokenRecord | undefined> {
    let fileInfo;
    try {
      fileInfo = await lstat(this.filePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new ContextTokenStoreError("path_unsafe", "context token 文件类型不可信。");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ContextTokenStoreError("format_invalid", "context token 文件 JSON 无效。");
      }
      throw error;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new ContextTokenStoreError("format_invalid", "context token 文件根节点无效。");
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.recipientId !== "string" ||
      !record.recipientId.trim() ||
      typeof record.contextToken !== "string" ||
      !record.contextToken.trim() ||
      typeof record.receivedAt !== "string" ||
      Number.isNaN(new Date(record.receivedAt).getTime())
    ) {
      throw new ContextTokenStoreError("format_invalid", "context token 记录字段无效。");
    }
    return {
      recipientId: record.recipientId,
      contextToken: record.contextToken,
      receivedAt: record.receivedAt,
    };
  }

  /**
   * 原子写入记录文件, 0600 权限, 同目录临时文件。
   *
   * @param contents 文件内容。
   * @returns 无返回值。
   */
  private async writeFileAtomically(contents: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new ContextTokenStoreError("write_failed", "context token 文件写入失败。");
    }
  }
}

/**
 * 计算通知正文的稳定哈希, 用于幂等发送 ID。
 *
 * @param value 通知正文。
 * @returns SHA-256 十六进制摘要前 32 位。
 */
export function hashNotificationContent(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/**
 * 校验通知正文长度。
 *
 * @param text 待校验正文。
 * @returns 超限时返回 false。
 */
export function isNotificationTextValid(text: string): boolean {
  return text.trim().length > 0 && text.length <= MAX_NOTIFICATION_TEXT_LENGTH;
}

/**
 * 判断未知值是否为 Node.js 文件系统错误。
 *
 * @param error 待检查值。
 * @returns 值带有错误代码时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
