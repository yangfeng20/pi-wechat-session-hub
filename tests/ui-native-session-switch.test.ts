import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { registerUiWorkerBridgeHooks } from "../src/gateway/ui-worker-extension-bridge.ts";
import type { ProjectService } from "../src/projects/project-service.ts";

test("Pi /tree 保持 session identity, 提取分支会创建新 session 文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-session-tree-"));
  const session = SessionManager.create(directory, directory);
  try {
    const rootUserId = session.appendMessage({
      role: "user",
      content: "root prompt",
      timestamp: Date.now(),
    });
    const rootAssistantId = session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "root answer" }],
      api: "openai-completions",
      provider: "test",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    session.appendMessage({ role: "user", content: "active branch", timestamp: Date.now() });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "active answer" }],
      api: "openai-completions",
      provider: "test",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const originalSessionId = session.getSessionId();
    const originalSessionFile = session.getSessionFile();
    session.branch(rootAssistantId);
    assert.equal(session.getSessionId(), originalSessionId);
    assert.equal(session.getSessionFile(), originalSessionFile);
    assert.equal(session.getLeafId(), rootAssistantId);
    assert.ok(session.getEntry(rootUserId));

    const extractedFile = session.createBranchedSession(rootAssistantId);
    assert.ok(extractedFile);
    const extractedSession = SessionManager.open(extractedFile);
    assert.notEqual(extractedSession.getSessionId(), originalSessionId);
    assert.equal(extractedSession.getHeader()?.parentSession, originalSessionFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Hub bridge 不注册 Pi session_before_switch 取消钩子", () => {
  const registeredEvents: string[] = [];
  const pi = {
    on(event: string) {
      registeredEvents.push(event);
    },
  } as unknown as ExtensionAPI;

  registerUiWorkerBridgeHooks(pi, {} as ProjectService, "C:/pi-wechat-test-manager");

  assert.equal(registeredEvents.includes("session_before_switch"), false);
});
