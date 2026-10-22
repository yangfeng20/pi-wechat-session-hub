import type { IlinkReplyContext } from "../channel-types.ts";

export interface IlinkTypingApi {
  /**
   * 获取当前微信回复上下文的 typing_ticket。
   *
   * @param recipientId 微信 userId。
   * @param contextToken 当前入站消息的 context_token。
   * @returns 可用于 sendTyping 的 ticket。
   */
  getTypingConfig(recipientId: string, contextToken: string): Promise<{ typingTicket?: string }>;

  /**
   * 发出或取消微信端“正在输入”状态。
   *
   * @param recipientId 微信 userId。
   * @param typingTicket getTypingConfig 返回的 ticket。
   * @param status 1 开始, 2 取消。
   * @returns API 成功时完成。
   */
  sendTyping(recipientId: string, typingTicket: string, status: 1 | 2): Promise<void>;
}

interface ActiveTypingEntry {
  active: boolean;
  recipientId: string;
  contextToken: string;
  typingTicket?: string;
  typingStarted: boolean;
  keepalive?: NodeJS.Timeout;
}

/**
 * 在 route queue 处理期间维护微信原生“正在输入”状态。
 *
 * typing API 失败仅跳过状态提示, 不影响 Pi 生成和最终回复。
 */
export class IlinkTypingIndicator {
  private readonly activeEntries = new Map<string, ActiveTypingEntry>();
  private readonly keepaliveIntervalMs: number;

  /**
   * 创建 typing indicator manager。
   *
   * @param api iLink getconfig/sendtyping API 实现。
   * @param options typing 状态续期配置。
   */
  constructor(
    private readonly api: IlinkTypingApi,
    options: { keepaliveIntervalMs?: number } = {},
  ) {
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? 5000;
  }

  /**
   * 异步启动某条 queue 消息的微信 typing 状态, 不阻塞 worker。
   *
   * @param messageId durable queue 消息 ID。
   * @param replyContext 消息对应的微信回复上下文。
   * @returns 无返回值。
   */
  start(messageId: string, replyContext: IlinkReplyContext | undefined): void {
    if (!replyContext || this.activeEntries.has(messageId)) {
      return;
    }
    const entry: ActiveTypingEntry = {
      active: true,
      recipientId: replyContext.recipientId,
      contextToken: replyContext.contextToken,
      typingStarted: false,
    };
    this.activeEntries.set(messageId, entry);
    void this.startEntry(messageId, entry);
  }

  /**
   * 停止某条 queue 消息的 typing 状态并释放续期 timer。
   *
   * @param messageId durable queue 消息 ID。
   * @returns 无返回值。
   */
  stop(messageId: string): void {
    const entry = this.activeEntries.get(messageId);
    if (!entry) {
      return;
    }
    entry.active = false;
    if (entry.keepalive) {
      clearInterval(entry.keepalive);
      entry.keepalive = undefined;
    }
    this.activeEntries.delete(messageId);
    if (entry.typingStarted && entry.typingTicket) {
      void this.api.sendTyping(entry.recipientId, entry.typingTicket, 2).catch(() => undefined);
    }
  }

  /**
   * 获取 typing_ticket 后发送开始状态, 并定时续期。
   *
   * @param messageId durable queue 消息 ID。
   * @param entry 本次消息的临时状态。
   * @returns 无返回值。
   */
  private async startEntry(messageId: string, entry: ActiveTypingEntry): Promise<void> {
    try {
      const config = await this.api.getTypingConfig(entry.recipientId, entry.contextToken);
      if (!entry.active || !this.activeEntries.has(messageId) || !config.typingTicket) {
        this.activeEntries.delete(messageId);
        return;
      }
      entry.typingTicket = config.typingTicket;
      await this.api.sendTyping(entry.recipientId, entry.typingTicket, 1);
      entry.typingStarted = true;
      if (!entry.active || !this.activeEntries.has(messageId)) {
        await this.api.sendTyping(entry.recipientId, entry.typingTicket, 2).catch(() => undefined);
        return;
      }
      entry.keepalive = setInterval(() => {
        if (entry.active && entry.typingTicket) {
          void this.api.sendTyping(entry.recipientId, entry.typingTicket, 1).catch(() => undefined);
        }
      }, this.keepaliveIntervalMs);
      entry.keepalive.unref();
    } catch {
      entry.active = false;
      if (entry.keepalive) {
        clearInterval(entry.keepalive);
      }
      this.activeEntries.delete(messageId);
    }
  }
}
