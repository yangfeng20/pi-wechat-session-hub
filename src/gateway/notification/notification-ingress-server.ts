import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { NotificationService } from "./notification-service.ts";

/**
 * 通知入口鉴权 key 的字节长度 (hex 后 64 字符)。
 */
const NOTIFY_KEY_LENGTH = 32;

/**
 * 请求时间戳允许的偏差窗口, 防重放。
 */
export const NOTIFY_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/**
 * 单帧最大字节数。
 */
const MAX_FRAME_BYTES = 64 * 1024;

/**
 * 单连接处理超时。
 */
const CONNECTION_TIMEOUT_MS = 10000;

/**
 * 通知入口请求体。
 */
export interface NotificationIngressRequest {
  title?: string;
  text: string;
  source?: string;
  urgent?: boolean;
  requestId?: string;
}

/**
 * 通知入口响应体。
 */
export interface NotificationIngressResponse {
  ok: boolean;
  code:
    | "sent"
    | "queued"
    | "dropped_stale"
    | "dropped_no_context"
    | "notify_text_invalid"
    | "notify_deliver_failed"
    | "rate_limited"
    | "protocol_error"
    | "auth_failed";
  message?: string;
  position?: number;
  retryAfterMs?: number;
}

/**
 * 表示通知入口鉴权或协议失败。
 */
export class NotificationIngressError extends Error {
  /**
   * 创建入口错误, 不包含 key 或请求正文。
   *
   * @param code 稳定错误代码。
   * @param message 面向用户的中文说明。
   */
  constructor(
    readonly code: "key_unavailable" | "auth_failed" | "protocol_error",
    message: string,
  ) {
    super(message);
    this.name = "NotificationIngressError";
  }
}

/**
 * 通知入口的内存级滑动窗口限流器。
 */
export class NotificationRateLimiter {
  private readonly timestamps: number[] = [];

  /**
   * 创建限流器。
   *
   * @param maxPerMinute 每分钟最大通知数。
   * @param maxPerHour 每小时最大通知数。
   */
  constructor(
    private readonly maxPerMinute: number,
    private readonly maxPerHour: number,
  ) {}

  /**
   * 检查并记录一次发送; 超限时返回建议重试毫秒数。
   *
   * @returns 允许时返回 0, 超限时返回建议等待毫秒数。
   */
  tryAcquire(): number {
    const now = Date.now();
    while (this.timestamps.length > 0 && now - this.timestamps[0] >= 60 * 60 * 1000) {
      this.timestamps.shift();
    }
    const minuteWindow = this.timestamps.filter((ts) => now - ts < 60 * 1000);
    if (minuteWindow.length >= this.maxPerMinute) {
      return 60 * 1000 - (now - minuteWindow[0]);
    }
    if (this.timestamps.length >= this.maxPerHour) {
      return 60 * 60 * 1000 - (now - this.timestamps[0]);
    }
    this.timestamps.push(now);
    return 0;
  }
}

/**
 * 计算 named pipe / unix socket endpoint, 与 control IPC 同样的目录哈希模式。
 *
 * @param managerDirectory Hub 私有数据目录。
 * @param platform 目标平台。
 * @returns 本机 IPC endpoint。
 */
export function createNotificationIngressEndpoint(
  managerDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = resolve(managerDirectory);
  const normalized = platform === "win32" ? resolved.toLowerCase() : resolved;
  const scope = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-wechat-session-hub-${scope}-notify`;
  }
  return join(tmpdir(), `pi-wechat-session-hub-${scope}-notify.sock`);
}

/**
 * 读取或 create-only 创建通知入口共享密钥, 存于 manager 目录 (ACL 保护)。
 *
 * @param managerDirectory Hub 私有数据目录。
 * @returns hex 编码的 64 字符 key。
 * @throws {NotificationIngressError} key 文件不可信或写入失败时抛出。
 */
export async function readOrCreateNotifyIngressKey(managerDirectory: string): Promise<string> {
  const keyPath = join(managerDirectory, "notify-shared.key");
  const { randomBytes } = await import("node:crypto");
  let handle;
  try {
    handle = await open(keyPath, "wx", 0o600);
    const newToken = randomBytes(NOTIFY_KEY_LENGTH).toString("hex");
    await handle.writeFile(`${newToken}\n`, "utf8");
    await handle.sync();
    await handle.close();
    return newToken;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isNodeError(error) && error.code === "EEXIST") {
      const existing = await readNotifyIngressKey(managerDirectory);
      if (existing) {
        return existing;
      }
      throw new NotificationIngressError("key_unavailable", "通知入口 key 文件不可读取。");
    }
    throw new NotificationIngressError("key_unavailable", "无法创建通知入口 key。");
  }
}

/**
 * 读取通知入口共享密钥。
 *
 * @param managerDirectory Hub 私有数据目录。
 * @returns hex key, 文件不存在时返回 undefined。
 * @throws {NotificationIngressError} 文件类型不可信或内容无效时抛出。
 */
export async function readNotifyIngressKey(managerDirectory: string): Promise<string | undefined> {
  const keyPath = join(managerDirectory, "notify-shared.key");
  let keyInfo;
  try {
    keyInfo = await lstat(keyPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink()) {
    throw new NotificationIngressError("key_unavailable", "通知入口 key 文件类型不可信。");
  }
  const token = await readFile(keyPath, "utf8");
  if (!/^[a-f0-9]{64}\r?\n?$/i.test(token)) {
    throw new NotificationIngressError("key_unavailable", "通知入口 key 内容无效。");
  }
  return token.trim();
}

/**
 * 计算通知请求的 HMAC-SHA256 proof。
 *
 * proof 绑定 key、requestId、时间戳与 payload 哈希; 客户端与服务端用同一算法。
 *
 * @param key hex 共享密钥。
 * @param requestId 请求 ID。
 * @param timestamp 毫秒时间戳。
 * @param payload 规范化 JSON 请求体字符串。
 * @returns base64url proof。
 */
export function computeNotifyProof(
  key: string,
  requestId: string,
  timestamp: number,
  payload: string,
): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`${requestId}\n${timestamp}\n`, "utf8")
    .update(payload, "utf8")
    .digest("base64url");
}

/**
 * 服务端帧校验结果。
 */
export type NotifyFrameValidation =
  | { valid: true; request: NotificationIngressRequest }
  | { valid: false; reason: string };

/**
 * 校验客户端发来的鉴权帧。
 *
 * @param frame 解析后的 JSON 帧。
 * @param key hex 共享密钥。
 * @param now 当前毫秒时间戳, 测试可注入。
 * @returns 校验结果。
 */
export function validateNotifyFrame(
  frame: unknown,
  key: string,
  now = Date.now(),
): NotifyFrameValidation {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return { valid: false, reason: "frame 根节点必须是对象。" };
  }
  const record = frame as Record<string, unknown>;
  const requestId = typeof record.requestId === "string" ? record.requestId : "";
  const timestamp = typeof record.timestamp === "number" ? record.timestamp : NaN;
  const proof = typeof record.proof === "string" ? record.proof : "";
  const payload = typeof record.payload === "string" ? record.payload : "";
  if (!requestId || !payload || !proof || Number.isNaN(timestamp)) {
    return { valid: false, reason: "缺少 requestId、timestamp、payload 或 proof。" };
  }
  if (Math.abs(now - timestamp) > NOTIFY_TIMESTAMP_WINDOW_MS) {
    return { valid: false, reason: "时间戳超出允许偏差, 请检查系统时钟。" };
  }
  const expected = computeNotifyProof(key, requestId, timestamp, payload);
  const expectedBuf = Buffer.from(expected, "base64url");
  const actualBuf = Buffer.from(proof, "base64url");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: "鉴权失败。" };
  }
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payload) as unknown;
  } catch {
    return { valid: false, reason: "payload JSON 无效。" };
  }
  if (typeof parsedPayload !== "object" || parsedPayload === null || Array.isArray(parsedPayload)) {
    return { valid: false, reason: "payload 根节点必须是对象。" };
  }
  const request = parsedPayload as Record<string, unknown>;
  if (typeof request.text !== "string" || !request.text.trim()) {
    return { valid: false, reason: "payload.text 必须是非空字符串。" };
  }
  return {
    valid: true,
    request: {
      text: request.text,
      ...(typeof request.title === "string" && request.title.trim() ? { title: request.title } : {}),
      ...(typeof request.source === "string" && request.source.trim() ? { source: request.source } : {}),
      requestId,
    },
  };
}

/**
 * 基于 named pipe 的本机通知入口服务。
 *
 * 其他程序/会话通过零依赖客户端连接本 endpoint, 用 notify-shared.key
 * 的 HMAC proof 投递通知; 服务端调用 NotificationService 直发微信。
 * 不监听 TCP, 不暴露网络面。
 */
export class NotificationIngressServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();

  /**
   * 创建通知入口服务。
   *
   * @param managerDirectory Hub 私有数据目录。
   * @param notificationService 通知发送服务。
   * @param rateLimiter 限流器。
   * @param options 平台与 endpoint 覆盖值, 测试用。
   */
  constructor(
    private readonly managerDirectory: string,
    private readonly notificationService: NotificationService,
    private readonly rateLimiter: NotificationRateLimiter = new NotificationRateLimiter(10, 60),
    private readonly options: { endpoint?: string; platform?: NodeJS.Platform } = {},
  ) {}

  /**
   * 开始监听通知入口。
   *
   * @returns 监听就绪后正常结束。
   * @throws {NotificationIngressError} key 不可用或 endpoint 占用时抛出。
   */
  async listen(): Promise<void> {
    if (this.server) {
      return;
    }
    const key = await readOrCreateNotifyIngressKey(this.managerDirectory);
    const endpoint = this.options.endpoint
      ?? createNotificationIngressEndpoint(this.managerDirectory, this.options.platform ?? process.platform);
    const server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      void this.handleConnection(socket, key).catch(() => socket.destroy());
    });
    this.server = server;
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (): void => {
        server.off("listening", onListening);
        this.server = undefined;
        rejectListen(new NotificationIngressError("protocol_error", "通知入口无法监听本机 endpoint。"));
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(endpoint);
    });
  }

  /**
   * 关闭入口服务并断开所有连接。
   *
   * @returns 关闭完成后正常结束。
   */
  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }

  /**
   * 返回当前 endpoint, 未监听时为 undefined。
   *
   * @returns endpoint 文本。
   */
  get listeningEndpoint(): string | undefined {
    return this.server ? (this.options.endpoint ?? createNotificationIngressEndpoint(this.managerDirectory)) : undefined;
  }

  /**
   * 完成单连接的读帧、鉴权、限流与投递。
   *
   * @param socket 客户端连接。
   * @param key hex 共享密钥。
   * @returns 处理完成后正常结束。
   */
  private async handleConnection(socket: Socket, key: string): Promise<void> {
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (response: NotificationIngressResponse): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.end(`${JSON.stringify(response)}\n`, "utf8");
    };
    const timeout = setTimeout(() => {
      finish({ ok: false, code: "protocol_error", message: "请求超时。" });
      socket.destroy();
    }, CONNECTION_TIMEOUT_MS);
    timeout.unref();

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        finish({ ok: false, code: "protocol_error", message: "请求超出大小限制。" });
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline);
      let frame: unknown;
      try {
        frame = JSON.parse(line) as unknown;
      } catch {
        finish({ ok: false, code: "protocol_error", message: "请求 JSON 无效。" });
        return;
      }
      const validation = validateNotifyFrame(frame, key);
      if (!validation.valid) {
        finish({ ok: false, code: "auth_failed", message: validation.reason });
        return;
      }
      const retryAfterMs = this.rateLimiter.tryAcquire();
      if (retryAfterMs > 0) {
        finish({
          ok: false,
          code: "rate_limited",
          message: "通知发送频率超限, 请稍后重试。",
          retryAfterMs,
        });
        return;
      }
      void this.notificationService.notify({
        title: validation.request.title,
        text: validation.request.text,
        source: validation.request.source,
      }).then((result) => {
        if (result.kind === "sent") {
          finish({ ok: true, code: "sent" });
          return;
        }
        if (result.kind === "queued") {
          finish({ ok: true, code: "queued", position: result.position });
          return;
        }
        if (result.kind === "dropped") {
          finish({
            ok: false,
            code: result.code === "notify_stale" ? "dropped_stale" : "dropped_no_context",
            message: result.code === "notify_stale"
              ? "通知通道已超过 24 小时未互动, 通知被丢弃 (当前策略为 drop)。请先在微信与 Bot 互发一条消息。"
              : "从未收到过你的微信消息, 无法主动发送。请先在微信与 Bot 互发一条消息。",
          });
          return;
        }
        finish({
          ok: false,
          code: result.code === "notify_text_invalid" ? "notify_text_invalid" : "notify_deliver_failed",
          message: result.code === "notify_text_invalid"
            ? "通知正文为空或超过长度上限。"
            : "微信投递失败, 通知未送达。",
        });
      }).catch(() => {
        finish({ ok: false, code: "notify_deliver_failed", message: "通知投递出现意外错误。" });
      });
    });
    socket.on("error", () => socket.destroy());
  }
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

/**
 * 生成请求 ID 的兜底实现, 供客户端脚本复用。
 *
 * @returns UUID 字符串。
 */
export function newNotificationRequestId(): string {
  return randomUUID();
}

/**
 * 为客户端导出 dirname 的最小替代, 避免脚本额外 import。
 *
 * @param path 任意路径。
 * @returns 目录部分。
 */
export function notificationKeyPath(managerDirectory: string): string {
  return dirname(join(managerDirectory, "notify-shared.key"));
}
