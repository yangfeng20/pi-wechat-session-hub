import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ConfigurationBusyError,
  ConfigurationStore,
} from "../../config/store.ts";
import { GatewayLease, GatewayLeaseError } from "../../registry/gateway-lease.ts";
import {
  createIlinkCredentialFile,
  IlinkCredentialStoreError,
  verifyCredentialDirectoryPermissions,
  type IlinkCredentialStoreOptions,
} from "../credential-store.ts";

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = "1";
const QR_REQUEST_TIMEOUT_MS = 15000;
const QR_STATUS_TIMEOUT_MS = 45000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_QR_REFRESHES = 3;
const require = createRequire(import.meta.url);
const qrcodeTerminal = require("qrcode-terminal") as typeof import("qrcode-terminal");

type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QrStatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

export type IlinkQrLoginErrorCode =
  | "gateway_running"
  | "credential_exists"
  | "credential_path_unsafe"
  | "qr_api_unavailable"
  | "qr_response_invalid"
  | "qr_expired"
  | "account_already_bound"
  | "verification_required"
  | "verification_invalid"
  | "authorized_user_mismatch"
  | "login_timeout"
  | "login_cancelled";

/**
 * 表示独立 iLink QR 登录未能安全完成。
 */
export class IlinkQrLoginError extends Error {
  /**
   * 创建不包含二维码、token 或原始响应正文的登录错误。
   *
   * @param code 稳定错误代码。
   * @param message 可安全显示给本地用户的中文说明。
   */
  constructor(readonly code: IlinkQrLoginErrorCode, message: string) {
    super(message);
    this.name = "IlinkQrLoginError";
  }
}

/**
 * 描述独立 iLink 登录完成结果。
 */
export interface IlinkQrLoginResult {
  authorizedUserId: string;
  botId: string;
}

/**
 * 在终端 TUI 中以 ANSI 文本形式渲染 iLink 扫码链接。
 *
 * @param qrContent iLink QR 响应中的 qrcode_img_content。
 * @returns 可显示在 Pi TUI 的二维码文本。
 */
export function renderIlinkQrCode(qrContent: string): Promise<string> {
  return new Promise((resolveQr) => {
    qrcodeTerminal.generate(qrContent, { small: true }, resolveQr);
  });
}

/**
 * 通过微信扫码为 Pi Hub 创建独立 iLink 授权, 不读取其他客户端凭证。
 */
export class IlinkQrLoginService {
  /**
   * 创建独立 iLink QR 登录服务。
   *
   * @param options Hub 私有目录、配置存储及可注入测试传输。
   */
  constructor(private readonly options: {
    managerDirectory: string;
    configStore: ConfigurationStore;
    fetcher?: typeof fetch;
    credentialStoreOptions?: IlinkCredentialStoreOptions;
  }) {}

  /**
   * 执行本地 QR 授权, 并只创建 Hub 自有的 credentials.json。
   *
   * @param callbacks 二维码、状态、取消和可选验证码回调。
   * @returns 新授权的 userId 和 botId。
   * @throws {IlinkQrLoginError} 授权失败、现有凭证冲突或超时时抛出。
   */
  async login(callbacks: {
    signal: AbortSignal;
    onQrCode: (content: string, terminalQr: string) => void;
    onStatus: (status: string) => void;
    requestVerificationCode?: () => Promise<string | undefined>;
  }): Promise<IlinkQrLoginResult> {
    const managerDirectory = resolve(this.options.managerDirectory);
    let lease: GatewayLease;
    try {
      lease = await GatewayLease.acquire(managerDirectory);
    } catch (error) {
      if (error instanceof GatewayLeaseError && error.code === "gateway_already_running") {
        throw new IlinkQrLoginError(
          "gateway_running",
          "请先停止 Pi Hub Gateway, 再进行扫码授权。",
        );
      }
      throw error;
    }

    try {
      await verifyCredentialDirectoryPermissions(
        managerDirectory,
        this.options.credentialStoreOptions,
      );
      const credentialFile = join(managerDirectory, "credentials.json");
      if (await pathExists(credentialFile)) {
        throw new IlinkQrLoginError(
          "credential_exists",
          "Pi Hub 已有 credentials.json, 为避免覆盖任何凭证, 扫码授权已停止。",
        );
      }

      const { config } = await this.options.configStore.load();
      const existingAuthorizedUserId = config.wechat.authorizedUserId.trim();
      callbacks.onStatus("正在连接微信 iLink 授权服务...");
      const login = await this.performLogin(callbacks);
      if (existingAuthorizedUserId && existingAuthorizedUserId !== login.userId) {
        throw new IlinkQrLoginError(
          "authorized_user_mismatch",
          "扫码账号与配置中的 authorizedUserId 不一致, 未写入凭证。",
        );
      }

      await lease.assertOwned();
      await this.options.configStore.update((current) => {
        const configuredUserId = current.wechat.authorizedUserId.trim();
        if (configuredUserId && configuredUserId !== login.userId) {
          throw new IlinkQrLoginError(
            "authorized_user_mismatch",
            "配置中的微信授权用户已改变, 未更新配置。",
          );
        }
        return {
          ...current,
          wechat: {
            ...current.wechat,
            authorizedUserId: login.userId,
            credentialFile,
          },
        };
      });
      await lease.assertOwned();
      await createIlinkCredentialFile(
        managerDirectory,
        {
          schemaVersion: 1,
          authorizedUserId: login.userId,
          token: login.token,
          baseUrl: login.baseUrl,
        },
        this.options.credentialStoreOptions,
      );
      callbacks.onStatus("Pi Hub 专属 iLink 凭证已安全保存。");
      return { authorizedUserId: login.userId, botId: login.botId };
    } catch (error) {
      if (callbacks.signal.aborted) {
        throw new IlinkQrLoginError("login_cancelled", "扫码授权已取消, 没有启动微信轮询。");
      }
      if (
        error instanceof IlinkQrLoginError ||
        error instanceof IlinkCredentialStoreError ||
        error instanceof ConfigurationBusyError ||
        error instanceof GatewayLeaseError
      ) {
        throw error;
      }
      throw new IlinkQrLoginError(
        "qr_api_unavailable",
        "扫码授权未完成; Pi Hub 未启动微信轮询, 请稍后重试。",
      );
    } finally {
      await lease.release();
    }
  }

  /**
   * 轮询 iLink QR 状态并返回服务端签发的独立凭证。
   *
   * @param callbacks 状态和验证码交互回调。
   * @returns 服务端确认的用户、bot、token 和 baseUrl。
   */
  private async performLogin(callbacks: {
    signal: AbortSignal;
    onQrCode: (content: string, terminalQr: string) => void;
    onStatus: (status: string) => void;
    requestVerificationCode?: () => Promise<string | undefined>;
  }): Promise<{ userId: string; botId: string; token: string; baseUrl: string }> {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let qrRefreshes = 0;
    let currentBaseUrl = ILINK_BASE_URL;
    let verifyCode: string | undefined;
    let qr = await this.fetchQrCode(callbacks.signal);
    await this.publishQr(qr, callbacks);

    while (Date.now() < deadline) {
      if (callbacks.signal.aborted) {
        throw new IlinkQrLoginError("login_cancelled", "扫码授权已取消。 ");
      }
      let response: QrStatusResponse;
      try {
        response = await this.fetchQrStatus(currentBaseUrl, qr.qrcode, verifyCode, callbacks.signal);
      } catch (error) {
        if (error instanceof IlinkQrLoginError || callbacks.signal.aborted) {
          throw error;
        }
        callbacks.onStatus("iLink 暂时无响应, 正在安全重试...");
        await delay(1500, callbacks.signal);
        continue;
      }

      switch (response.status) {
        case "wait":
          callbacks.onStatus("请用微信扫描二维码, 等待确认...");
          break;
        case "scaned":
          verifyCode = undefined;
          callbacks.onStatus("已扫码, 请在微信中确认授权...");
          break;
        case "scaned_but_redirect":
          if (response.redirect_host) {
            currentBaseUrl = validateRedirectHost(response.redirect_host);
            callbacks.onStatus("微信已扫码, 正在切换到授权服务节点...");
          } else {
            callbacks.onStatus("微信已扫码, 正在等待授权服务确认...");
          }
          break;
        case "need_verifycode": {
          if (!callbacks.requestVerificationCode) {
            throw new IlinkQrLoginError(
              "verification_required",
              "微信要求输入配对验证码; 当前 Pi TUI 无可用输入界面, 授权未完成。",
            );
          }
          const code = await callbacks.requestVerificationCode();
          if (!code) {
            throw new IlinkQrLoginError("login_cancelled", "验证码输入已取消, 未写入凭证。");
          }
          if (!/^\d{1,16}$/.test(code.trim())) {
            throw new IlinkQrLoginError("verification_invalid", "验证码必须是 1 至 16 位数字。");
          }
          verifyCode = code.trim();
          callbacks.onStatus("正在验证配对码...");
          continue;
        }
        case "verify_code_blocked":
        case "expired":
          qrRefreshes += 1;
          if (qrRefreshes >= MAX_QR_REFRESHES) {
            throw new IlinkQrLoginError(
              "qr_expired",
              "二维码已多次过期或验证码失败, 授权已停止, 请重新开始。",
            );
          }
          callbacks.onStatus("二维码已过期, 正在申请新的二维码...");
          qr = await this.fetchQrCode(callbacks.signal);
          currentBaseUrl = ILINK_BASE_URL;
          verifyCode = undefined;
          await this.publishQr(qr, callbacks);
          continue;
        case "binded_redirect":
          throw new IlinkQrLoginError(
            "account_already_bound",
            "iLink 未签发新的 Pi 凭证, 该账号仍报告已有绑定. 请按服务官方方式处理已有绑定; 本流程不会停止其他客户端或修改其本地数据。",
          );
        case "confirmed": {
          const token = response.bot_token?.trim();
          const userId = response.ilink_user_id?.trim();
          const botId = response.ilink_bot_id?.trim();
          const baseUrl = validateBaseUrl(response.baseurl ?? currentBaseUrl);
          if (!token || !userId || !botId) {
            throw new IlinkQrLoginError(
              "qr_response_invalid",
              "微信确认成功但没有返回完整 iLink 凭证; 未写入任何凭证。",
            );
          }
          callbacks.onStatus("微信授权已确认, 正在安全保存 Pi Hub 专属凭证...");
          return { token, userId, botId, baseUrl };
        }
        default:
          throw new IlinkQrLoginError("qr_response_invalid", "iLink 返回了不支持的扫码状态。");
      }
    }
    throw new IlinkQrLoginError("login_timeout", "扫码授权超时, 没有写入凭证或启动轮询。");
  }

  /**
   * 请求新的 iLink QR, 不提交或读取任何已有 bot token。
   *
   * @param signal 本地取消信号。
   * @returns iLink QR 标识及供手机扫描的内容。
   */
  private async fetchQrCode(signal: AbortSignal): Promise<QrCodeResponse> {
    const response = await requestJson(
      this.options.fetcher ?? fetch,
      `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
      "POST",
      signal,
      QR_REQUEST_TIMEOUT_MS,
      JSON.stringify({ local_token_list: [] }),
    );
    if (
      typeof response.qrcode !== "string" || !response.qrcode.trim() || response.qrcode.length > 4096 ||
      typeof response.qrcode_img_content !== "string" || !response.qrcode_img_content.trim() ||
      response.qrcode_img_content.length > 8192
    ) {
      throw new IlinkQrLoginError("qr_response_invalid", "iLink QR 响应字段无效, 未显示二维码。");
    }
    const qrContent = validateQrContent(response.qrcode_img_content);
    return { qrcode: response.qrcode, qrcode_img_content: qrContent };
  }

  /**
   * 长轮询 QR 状态并校验服务端字段。
   *
   * @param baseUrl 当前受信任 iLink 服务地址。
   * @param qrcode 服务端 QR id, 不写入日志。
   * @param verifyCode 可选的微信配对验证码。
   * @param signal 本地取消信号。
   * @returns 状态响应。
   */
  private async fetchQrStatus(
    baseUrl: string,
    qrcode: string,
    verifyCode: string | undefined,
    signal: AbortSignal,
  ): Promise<QrStatusResponse> {
    const query = new URLSearchParams({ qrcode });
    if (verifyCode) {
      query.set("verify_code", verifyCode);
    }
    const response = await requestJson(
      this.options.fetcher ?? fetch,
      `${baseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`,
      "GET",
      signal,
      QR_STATUS_TIMEOUT_MS,
    );
    const allowedStatuses = new Set<QrStatus>([
      "wait",
      "scaned",
      "confirmed",
      "expired",
      "scaned_but_redirect",
      "need_verifycode",
      "verify_code_blocked",
      "binded_redirect",
    ]);
    if (typeof response.status !== "string" || !allowedStatuses.has(response.status as QrStatus)) {
      throw new IlinkQrLoginError("qr_response_invalid", "iLink 扫码状态响应无效。");
    }
    return response as unknown as QrStatusResponse;
  }

  /**
   * 将新二维码和 ANSI 终端渲染结果交给 Pi 本地 UI。
   *
   * @param qr iLink QR 响应。
   * @param callbacks 本地 UI 回调。
   * @returns 二维码内容发送到本地 UI 后结束。
   */
  private async publishQr(
    qr: QrCodeResponse,
    callbacks: {
      onQrCode: (content: string, terminalQr: string) => void;
      onStatus: (status: string) => void;
    },
  ): Promise<void> {
    const terminalQr = await renderIlinkQrCode(qr.qrcode_img_content);
    callbacks.onQrCode(qr.qrcode_img_content, terminalQr);
    callbacks.onStatus("请用微信扫描二维码; 如账号正在被其他客户端轮询, 请先停止冲突轮询器。");
  }
}

/**
 * 构造 iLink 公共请求头, 不包含 Authorization token。
 *
 * @param method HTTP method。
 * @returns 可供 fetch 使用的头字段。
 */
function buildQrHeaders(method: "GET" | "POST"): HeadersInit {
  return {
    ...(method === "POST" ? {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
    } : {}),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
}

/**
 * 执行超时和取消受控的 iLink QR HTTP 请求。
 *
 * @param fetcher 注入的 fetch 实现。
 * @param url iLink 登录 endpoint。
 * @param method HTTP method。
 * @param parentSignal 上层取消信号。
 * @param timeoutMs 本次请求超时。
 * @param body 可选 JSON body。
 * @returns JSON object 响应。
 */
async function requestJson(
  fetcher: typeof fetch,
  url: string,
  method: "GET" | "POST",
  parentSignal: AbortSignal,
  timeoutMs: number,
  body?: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  const abortFromParent = (): void => controller.abort();
  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetcher(url, {
      method,
      headers: buildQrHeaders(method),
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error("http_error");
    }
    const payload = await response.json() as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new IlinkQrLoginError("qr_response_invalid", "iLink QR API 返回了无效 JSON 对象。");
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof IlinkQrLoginError) {
      throw error;
    }
    if (parentSignal.aborted) {
      throw new IlinkQrLoginError("login_cancelled", "扫码授权已取消。");
    }
    throw new Error("ilink_qr_request_failed");
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

/**
 * 延迟到下一轮长轮询, 并支持 Escape 取消。
 *
 * @param delayMs 延迟时长。
 * @param signal 本地取消信号。
 * @returns 延迟结束后完成。
 */
function delay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal.aborted) {
      rejectDelay(new IlinkQrLoginError("login_cancelled", "扫码授权已取消。"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolveDelay();
    }, delayMs);
    timer.unref();
    const abort = (): void => {
      clearTimeout(timer);
      rejectDelay(new IlinkQrLoginError("login_cancelled", "扫码授权已取消。"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * 验证 QR 扫描目标为微信官方 HTTPS 域名。
 *
 * @param value iLink 返回的二维码内容。
 * @returns 可安全展示给用户的 URL。
 */
function validateQrContent(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IlinkQrLoginError("qr_response_invalid", "iLink 返回了无效二维码内容。");
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "weixin.qq.com" && !url.hostname.endsWith(".weixin.qq.com")) ||
    url.username || url.password || url.port
  ) {
    throw new IlinkQrLoginError("qr_response_invalid", "二维码扫描目标不属于微信官方 HTTPS 域名。");
  }
  return url.toString();
}

/**
 * 校验二维码确认返回的 iLink baseUrl。
 *
 * @param value 服务端 baseUrl。
 * @returns 受信任的 HTTPS endpoint。
 */
function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IlinkQrLoginError("qr_response_invalid", "iLink 返回了无效 baseUrl。");
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "ilinkai.weixin.qq.com" && !url.hostname.endsWith(".ilinkai.weixin.qq.com")) ||
    url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/"
  ) {
    throw new IlinkQrLoginError("qr_response_invalid", "iLink baseUrl 不属于受信任的官方 endpoint。");
  }
  return url.origin;
}

/**
 * 将服务端 redirect_host 限制在 iLink 官方域名下。
 *
 * @param host 服务端返回的 redirect host。
 * @returns HTTPS baseUrl。
 */
function validateRedirectHost(host: string): string {
  const candidate = `https://${host}`;
  return validateBaseUrl(candidate);
}

/**
 * 生成 iLink 要求的随机 X-WECHAT-UIN。
 *
 * @returns 随机 uint32 的十进制文本 Base64。
 */
function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

/**
 * 检查路径是否存在, 不读取文件内容。
 *
 * @param filePath 待检查路径。
 * @returns lstat 成功时返回 true。
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * 判断值是否带有 Node.js error code。
 *
 * @param error 待判断值。
 * @returns Node.js 错误对象时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
