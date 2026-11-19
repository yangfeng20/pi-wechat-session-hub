import type { ManagerConfiguration } from "../../config/types.ts";
import type { IlinkReplyContext } from "../channel-types.ts";
import { IlinkApiClient } from "../wechat-ilink/api-client.ts";
import {
  ContextTokenStore,
  ContextTokenStoreError,
  hashNotificationContent,
  isNotificationTextValid,
  type ContextTokenRecord,
} from "./context-token-store.ts";

/**
 * 微信平台 context_token 约 24 小时过期, 发送前保留 4 小时安全余量。
 */
export const CONTEXT_TOKEN_FRESHNESS_MS = 20 * 60 * 60 * 1000;

/**
 * token 完全过期阈值, 与微信平台实测限制一致。
 */
export const CONTEXT_TOKEN_HARD_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * 续命提醒的重复间隔: 一个过期周期内最多提醒一次。
 */
export const RENEWAL_REMINDER_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * 续命提醒的提前量: 距离过期不足 4 小时时开始提醒。
 */
export const RENEWAL_REMINDER_LEAD_MS = 4 * 60 * 60 * 1000;

/**
 * 积压补发时单次最多补发的条数, 防止微信侧风控。
 */
export const MAX_BACKLOG_REPLAY_COUNT = 10;

/**
 * 积压通知的最大保留条数, 超出后丢弃最旧的。
 */
export const MAX_BACKLOG_ITEMS = 100;

/**
 * 续命提醒的固定正文。
 */
const RENEWAL_REMINDER_TEXT = [
  "🔔 **通知通道快休眠了**",
  "",
  "微信要求 24 小时内有过对话 Bot 才能主动推送。回复 **/renew** 续命, 否则后续通知会按策略积压或丢弃。",
].join("\n");

/**
 * 通知发送失败原因。
 */
export type NotificationFailureCode =
  | "notify_no_context"
  | "notify_stale"
  | "notify_deliver_failed"
  | "notify_text_invalid"
  | "notify_store_error";

/**
 * 通知发送结果。
 */
export type NotificationSendResult =
  | { kind: "sent"; clientId: string }
  | { kind: "queued"; position: number }
  | { kind: "dropped"; code: "notify_stale" | "notify_no_context" }
  | { kind: "failed"; code: NotificationFailureCode };

/**
 * 一条积压中的通知。
 */
export interface BackloggedNotification {
  title?: string;
  text: string;
  source?: string;
  enqueuedAt: string;
}

/**
 * ConfigurationStore 的最小结构, 便于测试注入。
 */
export interface NotificationConfigStore {
  load(): Promise<{ config: ManagerConfiguration }>;
}

/**
 * 把通知直接投递到微信, 不经过会话队列与模型。
 *
 * 复用入站消息捕获的 context_token; token 过期时按配置积压或丢弃,
 * 用户 /renew 续命后自动补发。所有正文末尾都带"勿直接回复"提示。
 */
export class NotificationService {
  private backlog: BackloggedNotification[] = [];
  private lastRenewalReminderAt?: number;
  private replayTask?: Promise<number>;

  /**
   * 创建通知服务。
   *
   * @param api iLink API client。
   * @param tokenStore context token 存储。
   * @param configStore 配置存储, 读取 overflowPolicy。
   */
  constructor(
    private readonly api: IlinkApiClient,
    private readonly tokenStore: ContextTokenStore,
    private readonly configStore: NotificationConfigStore,
  ) {}

  /**
   * 返回当前积压的通知条数。
   *
   * @returns 积压条数。
   */
  get backlogCount(): number {
    return this.backlog.length;
  }

  /**
   * 返回积压通知的只读副本, 供 /status 与测试使用。
   *
   * @returns 积压通知数组。
   */
  getBacklog(): BackloggedNotification[] {
    return [...this.backlog];
  }

  /**
   * 发送一条系统通知到授权用户的微信。
   *
   * @param options 标题、正文与调用方标识。
   * @returns 发送结果; 不可送达时按 overflowPolicy 积压或丢弃。
   */
  async notify(options: { title?: string; text: string; source?: string }): Promise<NotificationSendResult> {
    const body = composeNotificationBody(options);
    if (!isNotificationTextValid(body)) {
      return { kind: "failed", code: "notify_text_invalid" };
    }
    const record = await this.loadTokenRecord();
    if (!record) {
      return this.handleUnavailable(options);
    }
    if (!isTokenFresh(record.receivedAt)) {
      return this.handleStale(options);
    }
    try {
      return await this.deliver(record, body);
    } catch {
      return { kind: "failed", code: "notify_deliver_failed" };
    }
  }

  /**
   * 记录入站消息的 context token; 由 router 在授权通过后调用。
   *
   * @param replyContext 入站消息回复上下文。
   * @returns 无返回值。
   * @throws {ContextTokenStoreError} 存储写入失败时抛出。
   */
  async recordInboundContext(replyContext: IlinkReplyContext): Promise<void> {
    await this.tokenStore.record(replyContext);
  }

  /**
   * 处理 /renew 命令: 确认续命并补发积压通知。
   *
   * 续命效果由入站路径的 token 捕获自动完成, 这里只负责确认与补发。
   *
   * @param replyContext 当前 /renew 消息的回复上下文。
   * @returns 回给用户的确认文本。
   */
  async renew(replyContext?: IlinkReplyContext): Promise<string> {
    if (replyContext) {
      await this.safeRecordToken(replyContext);
    }
    const record = await this.loadTokenRecord();
    const replayed = await this.replayBacklog();
    const lines = [
      "✅ **通知通道已续命**",
      "",
      `当前窗口约 24 小时 (自 ${formatClock(record?.receivedAt)} 起)。`,
    ];
    if (this.backlogCount > 0) {
      lines.push(`仍有 ${this.backlogCount} 条积压未补发, 下次续命时继续。`);
    } else if (replayed > 0) {
      lines.push(`已补发 ${replayed} 条积压通知。`);
    }
    return lines.join("\n");
  }

  /**
   * 按需发送续命提醒; 由 Gateway 定时器周期调用。
   *
   * @returns 无返回值。
   */
  async maybeSendRenewalReminder(): Promise<void> {
    const record = await this.loadTokenRecord();
    if (!record) {
      return;
    }
    const ageMs = Date.now() - new Date(record.receivedAt).getTime();
    const remainingMs = CONTEXT_TOKEN_HARD_EXPIRY_MS - ageMs;
    if (remainingMs > RENEWAL_REMINDER_LEAD_MS) {
      return;
    }
    const now = Date.now();
    if (
      this.lastRenewalReminderAt !== undefined &&
      now - this.lastRenewalReminderAt < RENEWAL_REMINDER_INTERVAL_MS
    ) {
      return;
    }
    try {
      await this.deliver(record, RENEWAL_REMINDER_TEXT);
      this.lastRenewalReminderAt = now;
    } catch {
      // 提醒是 best-effort: token 可能刚好失效, 等下个周期重试。
    }
  }

  /**
   * token 新鲜时补发积压通知; 由入站消息路径触发, 不抛出。
   *
   * @returns 补发条数, 无法补发时为 0。
   */
  async replayBacklogIfFresh(): Promise<number> {
    try {
      const record = await this.loadTokenRecord();
      if (!record || !isTokenFresh(record.receivedAt) || this.backlogCount === 0) {
        return 0;
      }
      return await this.replayBacklog();
    } catch {
      return 0;
    }
  }

  /**
   * 补发积压通知; 已有补发进行中时等待其完成。
   *
   * @returns 本轮实际补发条数。
   */
  async replayBacklog(): Promise<number> {
    if (this.replayTask) {
      return this.replayTask.then(() => 0);
    }
    this.replayTask = this.replayBacklogInternal().finally(() => {
      this.replayTask = undefined;
    });
    return this.replayTask;
  }

  /**
   * 补发内部实现: 积压超过阈值时合并为一条摘要, 否则逐条发送。
   *
   * @returns 本轮实际补发条数。
   */
  private async replayBacklogInternal(): Promise<number> {
    let replayed = 0;
    while (this.backlog.length > 0) {
      const record = await this.loadTokenRecord();
      if (!record || !isTokenFresh(record.receivedAt)) {
        break;
      }
      const summaryMode = this.backlog.length > MAX_BACKLOG_REPLAY_COUNT;
      const batch = this.backlog.slice(0, MAX_BACKLOG_REPLAY_COUNT);
      const body = summaryMode
        ? composeBacklogSummary(batch, this.backlog.length)
        : batch.map((item) => composeNotificationBody(item)).join("\n\n---\n\n");
      try {
        await this.deliver(record, body);
      } catch {
        break;
      }
      replayed += batch.length;
      this.backlog = this.backlog.slice(batch.length);
      if (summaryMode) {
        break;
      }
    }
    return replayed;
  }

  /**
   * 投递正文到微信。
   *
   * @param record 最新 token 记录。
   * @param body 已拼装的正文。
   * @returns 发送成功结果。
   * @throws {IlinkApiError} iLink 发送失败时抛出。
   */
  private async deliver(record: ContextTokenRecord, body: string): Promise<{ kind: "sent"; clientId: string }> {
    const clientId = `piw-notify-${hashNotificationContent(body)}-${Date.now().toString(36)}`;
    await this.api.sendText(record.recipientId, body, record.contextToken, clientId);
    return { kind: "sent", clientId };
  }

  /**
   * 无任何 context token 时的处理。
   *
   * @param options 原始通知选项。
   * @returns 按策略积压或丢弃的结果。
   */
  private handleUnavailable(options: { title?: string; text: string; source?: string }): Promise<NotificationSendResult> {
    return this.enqueueOrDrop(options, { kind: "dropped", code: "notify_no_context" });
  }

  /**
   * token 过期时的处理。
   *
   * @param options 原始通知选项。
   * @returns 按策略积压或丢弃的结果。
   */
  private handleStale(options: { title?: string; text: string; source?: string }): Promise<NotificationSendResult> {
    return this.enqueueOrDrop(options, { kind: "dropped", code: "notify_stale" });
  }

  /**
   * 按 overflowPolicy 处理不可即时送达的通知。
   *
   * @param options 原始通知选项。
   * @param droppedResult drop 模式返回的结果。
   * @returns queue 模式返回积压位置, drop 模式返回丢弃结果。
   */
  private async enqueueOrDrop(
    options: { title?: string; text: string; source?: string },
    droppedResult: NotificationSendResult,
  ): Promise<NotificationSendResult> {
    const { config } = await this.configStore.load();
    if (config.notification.overflowPolicy !== "queue") {
      return droppedResult;
    }
    this.backlog.push({ ...options, enqueuedAt: new Date().toISOString() });
    if (this.backlog.length > MAX_BACKLOG_ITEMS) {
      this.backlog = this.backlog.slice(-MAX_BACKLOG_ITEMS);
    }
    return { kind: "queued", position: this.backlog.length };
  }

  /**
   * 读取 token 记录, 存储损坏时按无上下文处理。
   *
   * @returns 最新记录或 undefined。
   */
  private async loadTokenRecord(): Promise<ContextTokenRecord | undefined> {
    try {
      return await this.tokenStore.load();
    } catch (error) {
      if (error instanceof ContextTokenStoreError) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * best-effort 记录入站 token, 失败不阻断 /renew 确认。
   *
   * @param replyContext 入站回复上下文。
   * @returns 无返回值。
   */
  private async safeRecordToken(replyContext: IlinkReplyContext): Promise<void> {
    try {
      await this.tokenStore.record(replyContext);
    } catch {
      // 续命效果主要由入站路径的 token 捕获完成; 此处失败不阻断确认回复。
    }
  }
}

/**
 * 拼装通知正文: 标题 + 正文 + 固定的"勿直接回复"提示。
 *
 * @param options 通知选项。
 * @returns 多行 markdown 正文。
 */
function composeNotificationBody(options: { title?: string; text: string; source?: string }): string {
  const header = options.title
    ? `🔔 **${options.title}**${options.source ? ` (${options.source})` : ""}`
    : "🔔 **系统通知**";
  return [
    header,
    "",
    options.text,
    "",
    "〔系统通知, 与会话无关, 请勿直接回复〕",
  ].join("\n");
}

/**
 * 拼装积压摘要, 只保留各条标题行, 避免超长。
 *
 * @param batch 摘要覆盖的积压项。
 * @param total 当前积压总数。
 * @returns 摘要正文。
 */
function composeBacklogSummary(batch: BackloggedNotification[], total: number): string {
  const lines = batch.map((item) => {
    const titleLine = item.text.split("\n").find((line) => line.startsWith("🔔"))
      ?? item.title
      ?? "(无标题通知)";
    return `- ${titleLine.replace("🔔 **", "").replace("**", "")}`;
  });
  return composeNotificationBody({
    title: `积压通知摘要 (本轮 ${batch.length} 条, 积压共 ${total} 条)`,
    text: [
      "以下为各通知标题, 详情已省略:",
      "",
      ...lines,
    ].join("\n"),
  });
}

/**
 * 判断 token 记录是否仍在安全新鲜度窗口内。
 *
 * @param receivedAt token 对应入站消息时间。
 * @returns 距上次入站消息不足 20 小时时返回 true。
 */
function isTokenFresh(receivedAt: string): boolean {
  const ageMs = Date.now() - new Date(receivedAt).getTime();
  return ageMs >= 0 && ageMs < CONTEXT_TOKEN_FRESHNESS_MS;
}

/**
 * 将 ISO 时间格式化为 MM-DD HH:mm 本地时间。
 *
 * @param isoTimestamp ISO 时间字符串。
 * @returns 可读时间文本, 无效时返回"未知"。
 */
function formatClock(isoTimestamp: string | undefined): string {
  if (!isoTimestamp) {
    return "未知";
  }
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "未知";
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}
