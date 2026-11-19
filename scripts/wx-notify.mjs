#!/usr/bin/env node
/**
 * Pi 微信会话枢纽通知入口 CLI。
 *
 * 用法:
 *   node wx-notify.mjs "标题" "正文" [--source 标识] [--manager-dir <目录>] [--timeout <毫秒>]
 *
 * 通过本机 named pipe (Windows) 或 unix socket (POSIX) 向 Hub daemon
 * 投递一条通知, 由 daemon 复用最新 context_token 直发微信。
 * 零依赖, 可被任意程序 spawn。
 */

import { createHmac, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * 解析命令行参数。
 *
 * @param argv 原始参数数组。
 * @returns 解析结果, 非法时抛错。
 */
function parseArguments(argv) {
  const positional = [];
  let source;
  let managerDirectory;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source") {
      source = argv[index + 1];
      if (!source) {
        throw new Error("--source 需要一个值。");
      }
      index += 1;
      continue;
    }
    if (argument === "--manager-dir") {
      managerDirectory = argv[index + 1];
      if (!managerDirectory) {
        throw new Error("--manager-dir 需要一个值。");
      }
      index += 1;
      continue;
    }
    if (argument === "--timeout") {
      timeoutMs = Number(argv[index + 1]);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
        throw new Error("--timeout 必须是 1-60000 之间的毫秒数。");
      }
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printUsageAndExit(0);
    }
    positional.push(argument);
  }
  if (positional.length < 1 || positional.length > 2) {
    printUsageAndExit(1);
  }
  return {
    title: positional.length === 2 ? positional[0] : undefined,
    text: positional[positional.length - 1],
    source,
    managerDirectory,
    timeoutMs,
  };
}

/**
 * 打印用法并退出。
 *
 * @param code 退出码。
 * @returns 无返回值。
 */
function printUsageAndExit(code) {
  process.stdout.write([
    "用法: node wx-notify.mjs [标题] <正文> [--source 标识] [--manager-dir <目录>] [--timeout <毫秒>]",
    "",
    "示例:",
    '  node wx-notify.mjs "构建完成" "beacon 项目编译通过, 耗时 2 分钟"',
    '  node wx-notify.mjs "CI 失败" "main 分支测试挂了" --source github-actions',
    "",
    "退出码: 0 成功; 非 0 失败 (原因见 stderr)。",
  ].join("\n"));
  process.stdout.write("\n");
  process.exit(code);
}

/**
 * 推导 Hub manager 数据目录。
 *
 * @param override 显式指定值。
 * @returns 绝对路径。
 */
function resolveManagerDirectory(override) {
  if (override) {
    return resolve(override);
  }
  const agentDirectory = process.env.PI_CODING_AGENT_DIR;
  const base = agentDirectory?.trim()
    ? (isAbsolute(agentDirectory) ? agentDirectory : join(homedir(), agentDirectory))
    : join(homedir(), ".pi", "agent");
  return join(base, "wechat-session-manager");
}

/**
 * 计算 named pipe / unix socket endpoint, 与服务端同一逻辑。
 *
 * @param managerDirectory manager 数据目录。
 * @returns endpoint 文本。
 */
function createEndpoint(managerDirectory) {
  const resolved = resolve(managerDirectory);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const scope = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-wechat-session-hub-${scope}-notify`;
  }
  return join(tmpdir(), `pi-wechat-session-hub-${scope}-notify.sock`);
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
function computeProof(key, requestId, timestamp, payload) {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`${requestId}\n${timestamp}\n`, "utf8")
    .update(payload, "utf8")
    .digest("base64url");
}

/**
 * 连接 endpoint 并完成一次请求-响应。
 *
 * @param endpoint IPC endpoint。
 * @param frame JSON 帧。
 * @param timeoutMs 超时。
 * @returns 服务端响应对象。
 */
function requestOnce(endpoint, frame, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    let settled = false;
    const finish = (error, response) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise(response);
      }
    };
    const timer = setTimeout(() => finish(new Error("连接 Hub 通知入口超时。")), timeoutMs);
    timer.unref?.();
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(frame)}\n`, "utf8");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline);
      try {
        finish(undefined, JSON.parse(line));
      } catch {
        finish(new Error("Hub 返回了无效响应。"));
      }
    });
    socket.on("error", (error) => {
      finish(new Error(`无法连接 Hub 通知入口 (${error.code ?? error.message})。Hub 可能未启动。`));
    });
    socket.on("close", () => finish(new Error("连接在收到响应前关闭。")));
  });
}

/**
 * 主流程。
 *
 * @returns 无返回值。
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const managerDirectory = resolveManagerDirectory(options.managerDirectory);
  const keyPath = join(managerDirectory, "notify-shared.key");
  let key;
  try {
    key = (await readFile(keyPath, "utf8")).trim();
  } catch {
    process.stderr.write([
      `未找到通知入口 key: ${keyPath}`,
      "请先在 Pi TUI 启动 Hub (/wx start), 首次启动会自动生成 key。",
    ].join("\n"));
    process.stderr.write("\n");
    process.exit(2);
  }
  if (!/^[a-f0-9]{64}$/i.test(key)) {
    process.stderr.write("通知入口 key 内容无效, 请重新启动 Hub 生成。");
    process.stderr.write("\n");
    process.exit(2);
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
  let response;
  try {
    response = await requestOnce(endpoint, frame, options.timeoutMs);
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.stderr.write("\n");
    process.exit(3);
  }

  if (response.ok) {
    const detail = response.code === "queued"
      ? `通知已积压 (第 ${response.position} 条), 你续命后自动补发。`
      : "通知已发送到微信。";
    process.stdout.write(detail);
    process.stdout.write("\n");
    process.exit(0);
  }
  process.stderr.write(`发送失败 (${response.code}): ${response.message ?? "未知原因"}`);
  if (response.retryAfterMs) {
    process.stderr.write(`; 建议 ${Math.ceil(response.retryAfterMs / 1000)} 秒后重试。`);
  }
  process.stderr.write("\n");
  process.exit(4);
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.stderr.write("\n");
  process.exit(1);
});
