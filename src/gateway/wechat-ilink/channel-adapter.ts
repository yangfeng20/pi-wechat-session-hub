import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { GatewayInboundMessage, IlinkGetUpdatesResponse, IlinkTextMessage } from "../channel-types.ts";
import { GatewayAuthorizationError } from "../command-router.ts";
import { IlinkApiClient, IlinkApiError } from "./api-client.ts";
import { IlinkCursorStore } from "./cursor-store.ts";

/**
 * Gateway 入站消息处理函数。
 *
 * @param message 规范化后的入站消息。
 * @returns 处理结果。
 */
export type IlinkInboundHandler = (message: GatewayInboundMessage) => Promise<unknown>;

/**
 * iLink adapter 向调用方返回的无敏感信息 poll 统计。
 */
export interface IlinkPollSummary {
  receivedCount: number;
  acceptedCount: number;
  ignoredCount: number;
  nextLongPollTimeoutMs: number;
}

/**
 * iLink 长轮询配置, 必须绑定唯一授权微信 userId。
 */
export interface IlinkChannelAdapterOptions {
  authorizedUserId: string;
  initialLongPollTimeoutMs?: number;
  maxBackoffMs?: number;
}

/**
 * 将 iLink getupdates 批次适配到 Gateway normalized message, 并处理 poll 生命周期。
 *
 * 本适配器不会执行 QR 登录或自动修改账号凭证。
 */
export class IlinkChannelAdapter extends EventEmitter {
  private running = false;
  private handler?: IlinkInboundHandler;
  private abortController?: AbortController;
  private pollTask?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private backoffMs = 1000;
  private longPollTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly authorizedUserId: string;

  /**
   * 创建 iLink channel adapter。
   *
   * @param api iLink API client, 凭证由调用方显式注入。
   * @param cursorStore 持久化 get_updates_buf 的存储。
   * @param options 长轮询和退避参数。
   */
  constructor(
    private readonly api: IlinkApiClient,
    private readonly cursorStore: IlinkCursorStore,
    options: IlinkChannelAdapterOptions,
  ) {
    super();
    if (!options.authorizedUserId.trim()) {
      throw new IlinkApiError("invalid_credentials", "iLink poller 必须配置单一授权 userId。");
    }
    this.authorizedUserId = options.authorizedUserId;
    this.longPollTimeoutMs = options.initialLongPollTimeoutMs ?? 35000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
  }

  /**
   * 开始持续长轮询; 方法在首轮 poll 启动后返回。
   *
   * @param handler 已授权 Gateway 入站处理函数。
   * @returns 无返回值。
   * @throws {Error} adapter 已经运行时抛出。
   */
  async start(handler: IlinkInboundHandler): Promise<void> {
    if (this.running) {
      throw new Error("iLink channel adapter 已经运行。");
    }
    this.running = true;
    this.handler = handler;
    this.abortController = new AbortController();
    this.pollTask = this.pollCycle();
    await Promise.resolve();
  }

  /**
   * 请求停止轮询并等待当前长轮询退出。
   *
   * @returns 无返回值。
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.abortController?.abort();
    await this.pollTask?.catch(() => undefined);
    this.pollTask = undefined;
    this.handler = undefined;
  }

  /**
   * 将一批 iLink 消息持久入队并在处理完毕后提交同步游标。
   *
   * @param handler Gateway normalized message handler。
   * @param signal 可选取消信号。
   * @returns poll 摘要, 不包含 message body 或 context token。
   * @throws {IlinkApiError} getupdates 或游标持久化失败时抛出。
   */
  async pollOnce(
    handler: IlinkInboundHandler,
    signal?: AbortSignal,
  ): Promise<IlinkPollSummary> {
    const cursor = await this.cursorStore.load();
    const updates = await this.api.getUpdates(cursor, signal, this.longPollTimeoutMs);
    this.updateLongPollTimeout(updates);
    const messages = updates.msgs ?? [];
    const unsupported: Array<{ message: IlinkTextMessage; context: { recipientId: string; contextToken: string } }> = [];
    let acceptedCount = 0;
    let ignoredCount = 0;

    for (const message of messages) {
      if (message.message_type !== 1) {
        ignoredCount += 1;
        continue;
      }
      const recipientId = message.from_user_id;
      if (recipientId !== this.authorizedUserId) {
        ignoredCount += 1;
        continue;
      }
      const contextToken = message.context_token;
      const messageId = message.message_id === undefined
        ? message.client_id
        : String(message.message_id);
      if (!recipientId || !contextToken || !messageId) {
        ignoredCount += 1;
        continue;
      }

      const text = extractText(message);
      const hasUnsupportedMedia = (message.item_list ?? []).some((item) =>
        item.type !== undefined && item.type !== 1,
      );
      if (!text.trim()) {
        if (hasUnsupportedMedia) {
          unsupported.push({
            message,
            context: { recipientId, contextToken },
          });
          ignoredCount += 1;
        } else {
          ignoredCount += 1;
        }
        continue;
      }
      const normalized: GatewayInboundMessage = {
        messageId,
        senderId: recipientId,
        text: hasUnsupportedMedia
          ? `${text}\n[此消息包含附件, 当前版本尚未读取附件内容。]`
          : text,
        replyContext: { recipientId, contextToken },
      };
      try {
        await handler(normalized);
        acceptedCount += 1;
      } catch (error) {
        if (error instanceof GatewayAuthorizationError) {
          ignoredCount += 1;
          continue;
        }
        throw error;
      }
    }

    await Promise.all(unsupported.map(({ message, context }) =>
      this.api.sendText(
        context.recipientId,
        "当前版本只处理文本消息, 暂不读取该附件。",
        context.contextToken,
        stableUnsupportedReplyId(message),
      ),
    ));

    if (typeof updates.get_updates_buf === "string") {
      await this.cursorStore.save(updates.get_updates_buf);
    }
    return {
      receivedCount: messages.length,
      acceptedCount,
      ignoredCount,
      nextLongPollTimeoutMs: this.longPollTimeoutMs,
    };
  }

  /**
   * 通过入站消息上下文发送文本回复。
   *
   * @param routeId route ID, 用于生成稳定发送幂等键。
   * @param messageId channel 入站消息 ID。
   * @param text 回复正文。
   * @param replyContext 需要原样回传的 iLink context。
   * @returns 无返回值。
   * @throws {IlinkApiError} 缺少 context 时抛出。
   */
  async sendReply(
    routeId: string,
    messageId: string,
    text: string,
    replyContext?: { recipientId: string; contextToken: string },
  ): Promise<void> {
    if (!replyContext) {
      throw new IlinkApiError(
        "context_token_missing",
        "iLink replySink 缺少入站 replyContext; 为避免错发, 已拒绝发送。",
      );
    }
    const clientId = stableReplyId(routeId, messageId, text);
    await this.api.sendText(
      replyContext.recipientId,
      text,
      replyContext.contextToken,
      clientId,
    );
  }

  /**
   * 执行一次 poll 并安排下一轮; session 过期时停止, 绝不自动重登。
   *
   * @returns 无返回值。
   */
  private async pollCycle(): Promise<void> {
    if (!this.running || !this.handler || !this.abortController) {
      return;
    }
    let delayMs = 0;
    try {
      await this.pollOnce(this.handler, this.abortController.signal);
      this.backoffMs = 1000;
    } catch (error) {
      if (!this.running || this.abortController.signal.aborted) {
        return;
      }
      if (error instanceof IlinkApiError && error.code === "session_expired") {
        this.running = false;
        this.emit("session_expired");
        return;
      }
      const errorCode = error instanceof IlinkApiError ? error.code : "unexpected_error";
      this.emit("poll_error", { code: errorCode });
      delayMs = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    }

    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pollTask = this.pollCycle();
    }, delayMs);
  }

  /**
   * 更新服务端建议的下一轮长轮询超时。
   *
   * @param updates iLink getupdates 响应。
   * @returns 无返回值。
   */
  private updateLongPollTimeout(updates: IlinkGetUpdatesResponse): void {
    const timeout = updates.longpolling_timeout_ms;
    if (typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 1000 && timeout <= 120000) {
      this.longPollTimeoutMs = timeout;
    }
  }
}

/**
 * 从 iLink 入站消息提取所有文本片段。
 *
 * @param message iLink 消息。
 * @returns 以换行分隔的文本内容。
 */
function extractText(message: IlinkTextMessage): string {
  return (message.item_list ?? [])
    .filter((item) => item.type === 1 && typeof item.text_item?.text === "string")
    .map((item) => item.text_item?.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * 为不支持的媒体提示生成重试稳定的 iLink client_id。
 *
 * @param message iLink 消息。
 * @returns 确定性发送 ID。
 */
function stableUnsupportedReplyId(message: IlinkTextMessage): string {
  const messageId = String(message.message_id ?? message.client_id ?? "unknown");
  return `piw-unsupported-${createHash("sha256").update(messageId).digest("hex").slice(0, 32)}`;
}

/**
 * 为普通回复生成确定性 iLink client_id, 以便发送端重试时被服务端去重。
 *
 * @param routeId route ID。
 * @param messageId 入站消息 ID。
 * @param text 回复文本。
 * @returns 确定性发送 ID。
 */
function stableReplyId(routeId: string, messageId: string, text: string): string {
  const contentHash = createHash("sha256").update(`${routeId}\n${messageId}\n${text}`).digest("hex");
  return `piw-reply-${contentHash.slice(0, 32)}`;
}
