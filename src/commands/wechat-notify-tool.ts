import { createHmac, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getManagerDataDirectory } from "../config/paths.ts";

/**
 * 单次通知投递的连接超时。
 */
const NOTIFY_TIMEOUT_MS = 10000;

/**
 * 通知入口的 pipe endpoint, 与服务端同一推导逻辑。
 *
 * @param managerDirectory manager 数据目录。
 * @returns Windows named pipe 或 POSIX socket 路径。
 */
function createEndpoint(managerDirectory: string): string {
  const resolved = resolve(managerDirectory);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const scope = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-wechat-session-hub-${scope}-notify`
    : join(tmpdir(), `pi-wechat-session-hub-${scope}-notify.sock`);
}

/**
 * 计算与服务端一致的 HMAC proof。
 *
 * @param key hex 共享密钥。
 * @param requestId 请求 ID。
 * @param timestamp 毫秒时间戳。
 * @param payload 规范化 JSON 字符串。
 * @returns base64url proof。
 */
function computeProof(key: string, requestId: string, timestamp: number, payload: string): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`${requestId}\n${timestamp}\n`, "utf8")
    .update(payload, "utf8")
    .digest("base64url");
}

/**
 * 通过本机通知入口发送一条微信通知; 由 wx_notify 工具与测试共用。
 *
 * @param managerDirectory manager 数据目录。
 * @param options 标题与正文。
 * @returns 用户可读的结果说明。
 */
export async function sendNotificationViaIngress(
  managerDirectory: string,
  options: { title?: string; text: string; source?: string },
): Promise<string> {
  const keyPath = join(managerDirectory, "notify-shared.key");
  let key: string;
  try {
    key = (await readFile(keyPath, "utf8")).trim();
  } catch {
    return "微信通知发送失败: Hub 尚未初始化通知入口。请让用户在 Pi TUI 执行 /wx start 后重试。";
  }
  if (!/^[a-f0-9]{64}$/i.test(key)) {
    return "微信通知发送失败: 通知入口 key 无效。请让用户执行 /wx restart 重新生成。";
  }

  const requestId = randomUUID();
  const timestamp = Date.now();
  const payload = JSON.stringify({
    ...(options.title ? { title: options.title } : {}),
    text: options.text,
    ...(options.source ? { source: options.source } : {}),
  });
  const frame = {
    requestId,
    timestamp,
    payload,
    proof: computeProof(key, requestId, timestamp, payload),
  };

  const endpoint = createEndpoint(managerDirectory);
  return await new Promise<string>((resolvePromise) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    let settled = false;
    const finish = (message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(message);
    };
    const timer = setTimeout(() => finish("微信通知发送失败: 连接 Hub 通知入口超时。Hub 可能未启动, 请让用户执行 /wx start。"), NOTIFY_TIMEOUT_MS);
    timer.unref();
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(frame)}\n`, "utf8");
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      let response: Record<string, unknown>;
      try {
        response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      } catch {
        finish("微信通知发送失败: Hub 返回了无效响应。");
        return;
      }
      if (response.ok === true) {
        finish(response.code === "queued"
          ? `通知已进入积压队列 (第 ${String(response.position)} 条); 用户续命后自动补发到微信。`
          : "通知已发送到用户微信。");
        return;
      }
      const code = typeof response.code === "string" ? response.code : "unknown";
      const message = typeof response.message === "string" ? response.message : "未知原因";
      finish(`微信通知未能送达 (${code}): ${message}`);
    });
    socket.on("error", () => {
      finish("微信通知发送失败: 无法连接 Hub 通知入口。Hub 可能未启动, 请让用户执行 /wx start 后重试。");
    });
    socket.on("close", () => finish("微信通知发送失败: 连接在收到响应前关闭。"));
  });
}

/**
 * 注册 wx_notify 工具: 当前 Pi 会话内的 agent 可直接发微信通知。
 *
 * 工具随包自动注册, 无需用户配置; 失败信息引导用户操作而不是静默重试。
 *
 * @param pi Pi 扩展 API。
 * @returns 无返回值。
 */
export function registerWechatNotifyTool(pi: ExtensionAPI): void {
  // 旧版本 Pi 或测试 fake 可能不提供 registerTool; 工具是增强能力, 缺失时静默跳过。
  if (typeof pi.registerTool !== "function") {
    return;
  }
  pi.registerTool({
    name: "wx_notify",
    label: "微信通知",
    description: [
      "把一条通知直接发送到用户的微信 (与当前会话无关, 不进入对话上下文)。",
      "适用: 长任务完成、构建/测试结果、后台任务需要用户决策。",
      "不适用: 普通对话回复 (直接在会话里说即可)。正文请简洁, 一两句话。",
    ].join(" "),
    promptSnippet: "Send a WeChat notification to the user (wx_notify)",
    promptGuidelines: [
      "Use wx_notify when the user asks to be notified via 微信/WeChat (例如: 构建完微信通知我、发微信告诉我、结果发我微信), or when a long-running task finishes while the user is likely away.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "通知标题, 例如: 构建完成" }),
      text: Type.String({ description: "通知正文, 一两句话说明结果" }),
      source: Type.Optional(Type.String({ description: "调用方标识, 例如: ci、build-script" })),
    }),
    async execute(_toolCallId, params) {
      const managerDirectory = getManagerDataDirectory();
      const message = await sendNotificationViaIngress(managerDirectory, {
        title: params.title,
        text: params.text,
        ...(params.source ? { source: params.source } : {}),
      });
      return {
        content: [{ type: "text", text: message }],
        details: {},
      };
    },
  });
}

/**
 * 供测试使用的路径推导, 与 getManagerDataDirectory 一致。
 *
 * @param agentDirectory Pi agent 目录覆盖值。
 * @returns manager 数据目录。
 */
export function resolveNotifyManagerDirectory(agentDirectory?: string): string {
  const base = agentDirectory?.trim()
    ? (isAbsolute(agentDirectory) ? agentDirectory : join(homedir(), agentDirectory))
    : join(homedir(), ".pi", "agent");
  return join(base, "wechat-session-manager");
}
