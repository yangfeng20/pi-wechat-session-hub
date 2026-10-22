import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PiRpcClient, PiRpcError } from "../src/runtime/pi-rpc-client.ts";
import { BackgroundPiWorker } from "../src/runtime/background-pi-worker.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi-rpc.mjs");

test("RPC 客户端按 LF 分帧, 并等待 agent_settled 后交付文本", async () => {
  const client = await PiRpcClient.start({
    invocation: {
      command: process.execPath,
      args: [fixturePath],
    },
    cwd: process.cwd(),
    requestTimeoutMs: 2000,
  });

  try {
    const state = await client.request({ type: "get_state" });
    assert.equal(state.success, true);
    const messageEnd = client.waitForEvent<{ type: string; message: { content: Array<{ text: string }> } }>(
      "message_end",
      2000,
    );
    const agentSettled = client.waitForEvent<{ type: string }>("agent_settled", 2000);
    await client.request({ type: "prompt", message: "测试输入" });

    const message = await messageEnd;
    await agentSettled;
    assert.equal(message.message.content[0].text, "第一段\u2028第二段");
    await assert.rejects(
      client.request({ type: "unknown_test_command" }),
      PiRpcError,
    );
  } finally {
    await client.shutdown();
  }
});

test("后台 worker 只提取最终 assistant 文本, 不包含 thinking", async () => {
  const worker = await BackgroundPiWorker.start({
    invocation: {
      command: process.execPath,
      args: [fixturePath],
    },
    cwd: process.cwd(),
  });
  try {
    const response = await worker.prompt("测试输入");
    assert.equal(response, "第一段\u2028第二段");
    assert.equal(worker.state, "idle");
  } finally {
    await worker.shutdown();
  }
});

test("后台 RPC 对未处理的 confirm dialog 自动拒绝", async () => {
  const client = await PiRpcClient.start({
    invocation: {
      command: process.execPath,
      args: [fixturePath],
    },
    cwd: process.cwd(),
    requestTimeoutMs: 2000,
  });

  try {
    const uiResponse = client.waitForEvent<{ type: string; confirmed: boolean }>(
      "ui_response_received",
      2000,
    );
    const command = await client.request({ type: "test_ui" });
    const response = await uiResponse;
    assert.equal(command.success, true);
    assert.equal(response.confirmed, false);
  } finally {
    await client.shutdown();
  }
});
