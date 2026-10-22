import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = join(
  projectDirectory,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const packageManifest = JSON.parse(
  await readFile(join(packageDirectory, "package.json"), "utf8"),
);
const cliRelativePath = packageManifest.bin?.pi;
assert.equal(typeof cliRelativePath, "string", "Pi package 未声明 pi CLI 入口。");

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-runtime-smoke-"));
const extensionPath = join(projectDirectory, "extensions", "wechat-session-hub.ts");
const cliPath = join(packageDirectory, cliRelativePath);

try {
  const output = await runRpcSmoke(cliPath, extensionPath, temporaryDirectory);
  const records = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const statusNotices = records.filter((record) =>
    record.type === "extension_ui_request" &&
    record.method === "notify" &&
    record.message?.includes("Gateway: 当前扩展实例未启动"),
  );
  const promptResponses = records.filter((record) =>
    record.type === "response" &&
    record.command === "prompt" &&
    record.success === true &&
    ["compat-status-smoke", "compat-manager-smoke"].includes(record.id),
  );

  assert.equal(statusNotices.length, 2, `Pi RPC 未收到两个扩展状态通知: ${JSON.stringify(records)}`);
  assert.equal(promptResponses.length, 2, "Pi RPC 未接受 /status 和 /wechat-manager status 命令。");
  process.stdout.write(`Pi ${packageManifest.version} 扩展 RPC smoke test 通过。\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

/**
 * 启动隔离的 Pi RPC 进程并发送不触发模型调用的扩展状态命令。
 *
 * @param cliPath Pi CLI JavaScript 入口路径。
 * @param extensionPath 本项目扩展入口路径。
 * @param temporaryDirectory 隔离配置目录。
 * @returns Pi stdout 中的 JSONL 数据。
 */
function runRpcSmoke(cliPath, extensionPath, temporaryDirectory) {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--extension",
        extensionPath,
        "--no-context-files",
      ],
      {
        cwd: projectDirectory,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: temporaryDirectory,
          PI_CODING_AGENT_SESSION_DIR: join(temporaryDirectory, "sessions"),
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectOutput(new Error("Pi RPC smoke test 超时。"));
    }, 15000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectOutput(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectOutput(new Error(`Pi RPC 退出码为 ${code}: ${stderr}`));
        return;
      }
      resolveOutput(stdout);
    });
    child.stdin.end([
      { id: "compat-status-smoke", type: "prompt", message: "/status" },
      { id: "compat-manager-smoke", type: "prompt", message: "/wechat-manager status" },
    ].map((request) => JSON.stringify(request)).join("\n") + "\n");
  });
}
