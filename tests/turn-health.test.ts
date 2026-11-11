import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionIndexRecord, WorkerInstanceRecord } from "../src/registry/types.ts";
import {
  classifyFailure,
  evaluateHealth,
  extractResetTime,
  readLatestFailure,
} from "../src/gateway/turn-health.ts";

/**
 * 创建最小化 session 索引数据。
 *
 * @param overrides 需要覆盖的字段。
 * @returns 测试 session。
 */
function createSession(overrides: Partial<SessionIndexRecord> = {}): SessionIndexRecord {
  return {
    sessionId: "session-1",
    sessionFile: "session.jsonl",
    cwd: "C:/project",
    projectAlias: "demo",
    mode: "background",
    state: "active",
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * 创建最小化 worker 实例数据。
 *
 * @param overrides 需要覆盖的字段。
 * @returns 测试 worker。
 */
function createWorker(overrides: Partial<WorkerInstanceRecord> = {}): WorkerInstanceRecord {
  return {
    instanceId: "instance-1",
    pid: 1234,
    processBirthId: "1234:1",
    sessionId: "session-1",
    sessionFile: "session.jsonl",
    cwd: "C:/project",
    projectAlias: "demo",
    mode: "background",
    state: "idle",
    heartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

test("429 周额度错误提取分类、错误码与完整重置时间", () => {
  const failure = classifyFailure(
    '429: {"message":"You have exceeded the weekly usage quota. It will reset at 2026-11-16 00:00:00 +0800 CST.","type":"TooManyRequests","code":"AccountQuotaExceeded"}',
  );
  assert.equal(failure.kind, "weekly_quota");
  assert.equal(failure.summary, "周额度已耗尽");
  assert.equal(failure.resetAt, "2026-11-16 00:00:00 +0800 CST");
  assert.match(failure.raw, /AccountQuotaExceeded/);
});

test("分类 5 小时额度、月额度、TPM、网络和中断错误", () => {
  assert.equal(classifyFailure("429: You have exceeded the 5-hour usage quota").kind, "daily_quota");
  assert.equal(classifyFailure("You have exceeded the monthly usage quota").kind, "monthly_quota");
  assert.equal(classifyFailure("429 TPM (tokens per minute) limit").kind, "rate_limit");
  assert.equal(classifyFailure("stream error: stream disconnected").kind, "network");
  assert.equal(classifyFailure("Operation aborted").kind, "aborted");
  assert.equal(classifyFailure("OpenAI API error (503): overloaded").kind, "service_unavailable");
});

test("只从 transcript 最后一条 assistant 错误读取失败状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-turn-health-"));
  const sessionFile = join(directory, "session.jsonl");
  const entries = [
    {
      type: "message",
      id: "assistant-old",
      parentId: "user-old",
      timestamp: "2026-11-10T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "上一轮成功回复" }], stopReason: "stop" },
    },
    {
      type: "message",
      id: "user-new",
      parentId: "assistant-old",
      timestamp: "2026-11-11T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "新问题" }] },
    },
    {
      type: "message",
      id: "assistant-error",
      parentId: "user-new",
      timestamp: "2026-11-11T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: '429: {"message":"You have exceeded the weekly usage quota. It will reset at 2026-11-16 00:00:00 +0800 CST.","type":"TooManyRequests","code":"AccountQuotaExceeded"}',
      },
    },
  ];
  await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const failure = await readLatestFailure(sessionFile);
    assert.ok(failure);
    assert.equal(failure.kind, "weekly_quota");
    assert.equal(failure.resetAt, "2026-11-16 00:00:00 +0800 CST");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("成功的最新回复会清除旧失败状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-turn-health-"));
  const sessionFile = join(directory, "session.jsonl");
  const entries = [
    {
      type: "message",
      id: "assistant-error",
      parentId: "user-old",
      timestamp: "2026-11-10T00:00:01.000Z",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429: rate limit" },
    },
    {
      type: "message",
      id: "assistant-success",
      parentId: "user-new",
      timestamp: "2026-11-11T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "成功" }], stopReason: "stop" },
    },
  ];
  await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    assert.equal(await readLatestFailure(sessionFile), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("健康状态只使用真实 worker state, 不把旧 heartbeat 误报成卡住", () => {
  const oldWorker = createWorker({
    state: "running",
    heartbeatAt: "2020-01-01T00:00:00.000Z",
  });
  assert.deepEqual(evaluateHealth(createSession(), oldWorker, undefined), { state: "running" });
  assert.deepEqual(evaluateHealth(createSession(), createWorker({ state: "starting" }), undefined), {
    state: "starting",
  });
  assert.deepEqual(evaluateHealth(createSession(), createWorker({ state: "stale" }), undefined), {
    state: "disconnected",
  });
  assert.deepEqual(evaluateHealth(createSession(), undefined, undefined), { state: "disconnected" });
  assert.deepEqual(evaluateHealth(createSession({ state: "saved" }), undefined, undefined), { state: "idle" });
  assert.deepEqual(evaluateHealth(createSession(), createWorker({ state: "idle" }), classifyFailure("429 quota")), {
    state: "error",
  });
});

test("重置时间缺失时不误解析", () => {
  assert.equal(extractResetTime("429 TooManyRequests"), undefined);
});
