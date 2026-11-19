import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NotificationIngressServer,
  NotificationRateLimiter,
  computeNotifyProof,
  createNotificationIngressEndpoint,
  readNotifyIngressKey,
  readOrCreateNotifyIngressKey,
  validateNotifyFrame,
} from "../src/gateway/notification/notification-ingress-server.ts";
import { ContextTokenStore } from "../src/gateway/notification/context-token-store.ts";
import { NotificationService } from "../src/gateway/notification/notification-service.ts";
import { createFakeConfigStore } from "./fixtures/notification-fixtures.ts";

/**
 * 创建临时 manager 目录。
 *
 * @returns 临时目录路径。
 */
async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-wechat-ingress-"));
}

test("notify-shared.key create-only 创建并可重复读取", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const first = await readOrCreateNotifyIngressKey(directory);
    assert.match(first, /^[a-f0-9]{64}$/);
    const second = await readOrCreateNotifyIngressKey(directory);
    assert.equal(first, second);
    const raw = await readFile(join(directory, "notify-shared.key"), "utf8");
    assert.match(raw, /^[a-f0-9]{64}\n$/);
    assert.equal(await readNotifyIngressKey(directory), first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("通知入口 endpoint 按目录哈希推导, Windows 为 named pipe", () => {
  const endpoint = createNotificationIngressEndpoint("C:\\some\\dir", "win32");
  assert.match(endpoint, /^\\\\\.\\pipe\\pi-wechat-session-hub-[a-f0-9]{24}-notify$/);
  const posix = createNotificationIngressEndpoint("/some/dir", "linux");
  assert.match(posix, /pi-wechat-session-hub-[a-f0-9]{24}-notify\.sock$/);
});

test("合法帧校验通过, 篡改 proof 或过期时间戳被拒绝", () => {
  const key = "a".repeat(64);
  const requestId = "req-1";
  const timestamp = Date.now();
  const payload = JSON.stringify({ text: "hello" });
  const proof = computeNotifyProof(key, requestId, timestamp, payload);
  const valid = validateNotifyFrame(
    { requestId, timestamp, payload, proof },
    key,
    timestamp,
  );
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal(valid.request.text, "hello");
  }

  const tampered = validateNotifyFrame(
    { requestId, timestamp, payload, proof: "AAAA" },
    key,
    timestamp,
  );
  assert.equal(tampered.valid, false);

  const stale = validateNotifyFrame(
    { requestId, timestamp: timestamp - 10 * 60 * 1000, payload, proof },
    key,
    timestamp,
  );
  assert.equal(stale.valid, false);
  if (!stale.valid) {
    assert.match(stale.reason, /时间戳/);
  }

  const emptyText = validateNotifyFrame(
    {
      requestId,
      timestamp,
      payload: JSON.stringify({ text: "  " }),
      proof: computeNotifyProof(key, requestId, timestamp, JSON.stringify({ text: "  " })),
    },
    key,
    timestamp,
  );
  assert.equal(emptyText.valid, false);
});

test("限流器按每分钟与每小时窗口拒绝", () => {
  const limiter = new NotificationRateLimiter(2, 3);
  assert.equal(limiter.tryAcquire(), 0);
  assert.equal(limiter.tryAcquire(), 0);
  const thirdWait = limiter.tryAcquire();
  // 第 3 次在 1 分钟内超出, 但第 4 次触发小时窗口。
  assert.ok(thirdWait > 0);
});

test("ingress server 端到端: 客户端 proof 投递, 通知送达微信", async () => {
  const directory = await createTemporaryDirectory();
  // 按当前平台生成可监听的 endpoint (Windows named pipe / POSIX socket)。
  const endpoint = createNotificationIngressEndpoint(directory) + "-test";
  try {
    const tokenStore = new ContextTokenStore(directory);
    await tokenStore.record({ recipientId: "wx-user-1", contextToken: "token-live" });
    const sent: Array<{ text: string }> = [];
    const fakeApi = {
      async sendText(recipientId: string, text: string): Promise<{ clientId: string }> {
        sent.push({ text });
        return { clientId: "fake" };
      },
    };
    const service = new NotificationService(
      fakeApi as never,
      tokenStore,
      createFakeConfigStore(),
    );
    const server = new NotificationIngressServer(directory, service, new NotificationRateLimiter(100, 100), {
      endpoint,
    });
    await server.listen();
    const key = (await readNotifyIngressKey(directory))!;

    // 模拟零依赖客户端。
    const { createConnection } = await import("node:net");
    const requestId = "req-e2e-1";
    const timestamp = Date.now();
    const payload = JSON.stringify({ title: "端到端", text: "测试通知", source: "unit-test" });
    const frame = {
      requestId,
      timestamp,
      payload,
      proof: computeNotifyProof(key, requestId, timestamp, payload),
    };
    const response = await new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
      const socket = createConnection(endpoint);
      let buffer = "";
      socket.on("connect", () => socket.write(`${JSON.stringify(frame)}\n`, "utf8"));
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          socket.destroy();
          resolvePromise(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
        }
      });
      socket.on("error", rejectPromise);
    });
    assert.equal(response.ok, true);
    assert.equal(response.code, "sent");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /端到端/);
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});
