import { randomBytes, randomUUID } from "node:crypto";
import type { IlinkGetUpdatesResponse } from "../channel-types.ts";

/**
 * iLink bot 凭证, 由外部调用方显式注入且不会由客户端持久化。
 */
export interface IlinkCredentials {
  token: string;
  baseUrl: string;
}

export interface IlinkTypingConfig {
  typingTicket?: string;
}

export type IlinkTypingStatus = 1 | 2;

/**
 * iLink API client 的可选网络和协议配置。
 */
export interface IlinkApiClientOptions {
  credentials: IlinkCredentials;
  fetcher?: typeof fetch;
  channelVersion?: string;
  apiTimeoutMs?: number;
  longPollTimeoutMs?: number;
  allowCustomBaseUrl?: boolean;
}

/**
 * iLink API 错误代码, 不包含服务端原始响应正文。
 */
export type IlinkApiErrorCode =
  | "invalid_credentials"
  | "invalid_base_url"
  | "network_error"
  | "request_timeout"
  | "http_error"
  | "invalid_response"
  | "api_error"
  | "session_expired"
  | "context_token_missing"
  | "message_too_long";

/**
 * 表示 iLink API 请求或协议响应失败。
 */
export class IlinkApiError extends Error {
  /**
   * 创建 iLink API 错误, 不包含 token 或原始响应正文。
   *
   * @param code 稳定错误代码。
   * @param message 面向用户的中文说明。
   */
  constructor(
    readonly code: IlinkApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IlinkApiError";
  }
}

/**
 * 以注入的独立 Bot 凭证调用 iLink text/getUpdates API; QR 登录由独立登录服务处理。
 */
export class IlinkApiClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly channelVersion: string;
  private readonly apiTimeoutMs: number;
  private readonly longPollTimeoutMs: number;

  /**
   * 创建 iLink API 客户端。
   *
   * @param options 独立凭证、endpoint 和网络实现。
   * @throws {IlinkApiError} 凭证或 baseUrl 非法时抛出。
   */
  constructor(options: IlinkApiClientOptions) {
    if (!options.credentials.token.trim()) {
      throw new IlinkApiError("invalid_credentials", "iLink bot token 不能为空。");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(options.credentials.baseUrl);
    } catch {
      throw new IlinkApiError("invalid_base_url", "iLink baseUrl 不是有效 URL。");
    }
    const loopbackHttp = endpoint.protocol === "http:" &&
      (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "::1");
    const knownIlinkHost = endpoint.hostname === "ilinkai.weixin.qq.com" ||
      endpoint.hostname.endsWith(".ilinkai.weixin.qq.com");
    if (
      (endpoint.protocol !== "https:" && !loopbackHttp) ||
      (endpoint.protocol === "https:" && !knownIlinkHost && !options.allowCustomBaseUrl) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new IlinkApiError(
        "invalid_base_url",
        "iLink baseUrl 必须是受支持的 HTTPS endpoint, 且不能包含用户信息或 query。",
      );
    }

    this.token = options.credentials.token;
    this.baseUrl = options.credentials.baseUrl.replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.channelVersion = options.channelVersion ?? "pi-wechat-session-hub/0.1.0";
    this.apiTimeoutMs = options.apiTimeoutMs ?? 15000;
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? 35000;
  }

  /**
   * 读取指定微信用户的 typing_ticket。
   *
   * @param recipientId 微信用户 ID。
   * @param contextToken 当前入站消息的 context_token。
   * @returns typing_ticket, 服务端未提供时为空。
   * @throws {IlinkApiError} iLink 请求或业务响应失败时抛出。
   */
  async getTypingConfig(recipientId: string, contextToken: string): Promise<IlinkTypingConfig> {
    if (!recipientId.trim() || !contextToken.trim()) {
      throw new IlinkApiError("context_token_missing", "获取 typing_ticket 必须提供微信用户和 context_token。");
    }
    const response = await this.post<Record<string, unknown>>(
      "getconfig",
      {
        ilink_user_id: recipientId,
        context_token: contextToken,
        base_info: { channel_version: this.channelVersion },
      },
      this.apiTimeoutMs,
    );
    this.assertApiSuccess(
      typeof response.ret === "number" ? response.ret : undefined,
      typeof response.errcode === "number" ? response.errcode : undefined,
      typeof response.errmsg === "string" ? response.errmsg : undefined,
    );
    if (response.typing_ticket !== undefined && typeof response.typing_ticket !== "string") {
      throw new IlinkApiError("invalid_response", "iLink getconfig 返回了无效 typing_ticket。");
    }
    return typeof response.typing_ticket === "string" && response.typing_ticket.trim()
      ? { typingTicket: response.typing_ticket }
      : {};
  }

  /**
   * 开始或取消微信端的原生“正在输入”状态。
   *
   * @param recipientId 微信用户 ID。
   * @param typingTicket getconfig 返回的 typing_ticket。
   * @param status 1 表示正在输入, 2 表示取消。
   * @returns 业务成功时正常结束。
   * @throws {IlinkApiError} typing_ticket 无效或 API 请求失败时抛出。
   */
  async sendTyping(
    recipientId: string,
    typingTicket: string,
    status: IlinkTypingStatus,
  ): Promise<void> {
    if (!recipientId.trim() || !typingTicket.trim()) {
      throw new IlinkApiError("invalid_credentials", "sendtyping 必须提供微信用户和 typing_ticket。");
    }
    const response = await this.post<Record<string, unknown>>(
      "sendtyping",
      {
        ilink_user_id: recipientId,
        typing_ticket: typingTicket,
        status,
        base_info: { channel_version: this.channelVersion },
      },
      this.apiTimeoutMs,
    );
    this.assertApiSuccess(
      typeof response.ret === "number" ? response.ret : undefined,
      typeof response.errcode === "number" ? response.errcode : undefined,
      typeof response.errmsg === "string" ? response.errmsg : undefined,
    );
  }

  /**
   * 发起一次 iLink getupdates 长轮询。
   *
   * @param cursor 上次服务端返回的 get_updates_buf; 首次传空字符串。
   * @param signal 用于 Gateway 优雅停止的 AbortSignal。
   * @returns 更新响应, 包含新游标和消息批次。
   * @throws {IlinkApiError} 网络、协议或 session 过期时抛出。
   */
  async getUpdates(
    cursor: string,
    signal?: AbortSignal,
    longPollTimeoutMs = this.longPollTimeoutMs,
  ): Promise<IlinkGetUpdatesResponse> {
    const response = await this.post<IlinkGetUpdatesResponse>(
      "getupdates",
      {
        get_updates_buf: cursor,
        base_info: { channel_version: this.channelVersion },
      },
      longPollTimeoutMs + 10000,
      signal,
    );
    this.assertApiSuccess(response.ret, response.errcode, response.errmsg);
    if (response.msgs !== undefined && !Array.isArray(response.msgs)) {
      throw new IlinkApiError("invalid_response", "iLink getupdates 返回了无效 msgs 字段。");
    }
    if (response.get_updates_buf !== undefined && typeof response.get_updates_buf !== "string") {
      throw new IlinkApiError("invalid_response", "iLink getupdates 返回了无效同步游标。");
    }
    return response;
  }

  /**
   * 在指定微信会话上下文中发送一条文本回复。
   *
   * @param recipientId 微信用户 ID。
   * @param text 回复正文, 每条 text item 最多 2000 个 Unicode 字符。
   * @param contextToken 对应入站消息的 context_token。
   * @param clientId 可选幂等发送 ID。
   * @returns 用于排查的 clientId。
   * @throws {IlinkApiError} context、正文或 API 请求不合法时抛出。
   */
  async sendText(
    recipientId: string,
    text: string,
    contextToken: string,
    clientId: string = randomUUID(),
  ): Promise<{ clientId: string }> {
    if (!recipientId.trim() || !contextToken.trim()) {
      throw new IlinkApiError(
        "context_token_missing",
        "发送 iLink 回复必须提供 recipientId 和对应的 context_token。",
      );
    }
    if (!text.trim()) {
      throw new IlinkApiError("invalid_response", "不能发送空的 iLink 文本消息。");
    }
    if (Array.from(text).length > 32000) {
      throw new IlinkApiError(
        "message_too_long",
        "iLink 回复超过单次 sendmessage 的 32000 字符上限。",
      );
    }
    const textItems = splitTextItems(text, 2000);

    const response = await this.post<Record<string, unknown>>(
      "sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: recipientId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: textItems.map((textItem) => ({ type: 1, text_item: { text: textItem } })),
        },
        base_info: { channel_version: this.channelVersion },
      },
      this.apiTimeoutMs,
    );
    this.assertApiSuccess(
      typeof response.ret === "number" ? response.ret : undefined,
      typeof response.errcode === "number" ? response.errcode : undefined,
      typeof response.errmsg === "string" ? response.errmsg : undefined,
    );
    return { clientId };
  }

  /**
   * 发送一个 iLink POST 请求并校验 JSON 响应。
   *
   * @param endpoint iLink bot API 端点名。
   * @param body JSON 请求体。
   * @param timeoutMs 请求超时。
   * @param signal 可选外部取消信号。
   * @returns 解码后的 JSON 响应。
   */
  private async post<T extends object>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    const abortFromCaller = (): void => controller.abort();
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    try {
      const response = await this.fetcher(`${this.baseUrl}/ilink/bot/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${this.token}`,
          "X-WECHAT-UIN": randomWechatUin(),
          "iLink-App-Id": "bot",
          "iLink-App-ClientVersion": "1",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new IlinkApiError("http_error", `iLink API HTTP ${response.status}。`);
      }
      let parsed: unknown;
      try {
        parsed = await response.json() as unknown;
      } catch {
        throw new IlinkApiError("invalid_response", "iLink API 返回了无效 JSON。");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new IlinkApiError("invalid_response", "iLink API 响应根节点必须是对象。");
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof IlinkApiError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new IlinkApiError("request_timeout", "iLink API 请求超时或已取消。");
      }
      throw new IlinkApiError("network_error", "iLink API 网络请求失败。");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  /**
   * 校验 iLink 业务响应状态。
   *
   * @param ret 响应 ret。
   * @param errorCode 响应 errcode。
   * @param errorMessage 响应 errmsg, 不会原样输出。
   * @returns 无返回值。
   * @throws {IlinkApiError} iLink 返回业务错误时抛出。
   */
  private assertApiSuccess(
    ret: number | undefined,
    errorCode: number | undefined,
    errorMessage: string | undefined,
  ): void {
    const code = [errorCode, ret].find((value) => typeof value === "number" && value !== 0);
    if (code === undefined) {
      return;
    }
    if (code === -14) {
      throw new IlinkApiError("session_expired", "iLink session 已过期; 不会自动重新登录或修改凭证。");
    }
    const suffix = typeof errorMessage === "string" && errorMessage.trim() ? " 服务端返回业务错误。" : "";
    throw new IlinkApiError("api_error", `iLink API 业务请求失败 (${code}).${suffix}`);
  }
}

/**
 * 将回复文本切分为多个 text item, 由单次 sendmessage 顺序提交。
 *
 * @param text 回复正文。
 * @param maxChars 每个 text item 的最大 Unicode 字符数。
 * @returns 有序文本片段列表。
 */
function splitTextItems(text: string, maxChars: number): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += maxChars) {
    chunks.push(characters.slice(offset, offset + maxChars).join(""));
  }
  return chunks;
}

/**
 * 为每次 iLink 请求生成随机 X-WECHAT-UIN。
 *
 * @returns 随机 uint32 十进制文本的 Base64 编码。
 */
function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}
