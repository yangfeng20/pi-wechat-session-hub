import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNotificationIngressEndpoint,
  readOrCreateNotifyIngressKey,
  NotificationIngressServer,
  NotificationRateLimiter,
} from "../src/gateway/notification/notification-ingress-server.ts";
import { ContextTokenStore } from "../src/gateway/notification/context-token-store.ts";
import { NotificationService } from "../src/gateway/notification/notification-service.ts";
import { createFakeConfigStore } from "./fixtures/notification-fixtures.ts";
import { resolveNotifyManagerDirectory, sendNotificationViaIngress } from "../src/commands/wechat-notify-tool.ts";

/**
 * 创建临时 manager 目录并预置有效 key 与新鲜 token。
 *
 * @returns 临时目录路径。
 */
async function createReadyManagerDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-notify-tool-"));
  await readOrCreateNotifyIngressKey(directory);
  const tokenStore = new ContextTokenStore(directory);
  await tokenStore.record({ recipientId: "wx-user-1", contextToken: "token-live" });
  return directory;
}

test("wx_notify 工具端到端: 会话内工具调用送达微信", async () => {
  const directory = await createReadyManagerDirectory();
  // server 与客户端都使用默认派生 endpoint, 走真实的工具调用路径。
  const sent: Array<{ text: string }> = [];
  const fakeApi = {
    async sendText(_recipientId: string, text: string): Promise<{ clientId: string }> {
      sent.push({ text });
      return { clientId: "fake" };
    },
  };
  const service = new NotificationService(fakeApi as never, new ContextTokenStore(directory), createFakeConfigStore());
  const server = new NotificationIngressServer(directory, service, new NotificationRateLimiter(100, 100));
  await server.listen();
  try {
    const message = await sendNotificationViaIngress(directory, {
      title: "工具测试",
      text: "从 Pi 会话发出",
      source: "unit-test",
    });
    assert.equal(message, "通知已发送到用户微信。");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /工具测试/);
    assert.match(sent[0].text, /从 Pi 会话发出/);
    assert.match(sent[0].text, /请勿直接回复/);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("wx_notify 工具在 Hub 未启动时返回可读失败说明", async () => {
  const directory = await createReadyManagerDirectory();
  try {
    const message = await sendNotificationViaIngress(directory, { title: "x", text: "y" });
    assert.match(message, /无法连接 Hub 通知入口/);
    assert.match(message, /\/wx start/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wx_notify 工具在 key 缺失时提示先启动 Hub", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-notify-nokey-"));
  try {
    const message = await sendNotificationViaIngress(directory, { title: "x", text: "y" });
    assert.match(message, /Hub 尚未初始化通知入口/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wx_notify 工具在通道积压时返回积压说明", async () => {
  const directory = await createReadyManagerDirectory();
  // 重新生成 key 后 token 被覆盖为过期值, 并让 server 监听客户端可发现的默认 endpoint。
  // 注意: 客户端始终连接默认派生 endpoint, 因此 server 也必须监听默认 endpoint。
  const endpoint = createNotificationIngressEndpoint(directory);
  const tokenStore = new ContextTokenStore(directory);
  const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await tokenStore.record({ recipientId: "wx-user-1", contextToken: "token-stale" }, staleTime);
  const fakeApi = {
    async sendText(): Promise<{ clientId: string }> {
      throw new Error("should not be called");
    },
  };
  const service = new NotificationService(fakeApi as never, tokenStore, createFakeConfigStore("queue"));
  const server = new NotificationIngressServer(directory, service, new NotificationRateLimiter(100, 100), { endpoint });
  await server.listen();
  try {
    const message = await sendNotificationViaIngress(directory, { title: "x", text: "y" });
    assert.match(message, /积压队列/);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolveNotifyManagerDirectory 与 getManagerDataDirectory 一致", async () => {
  const { getManagerDataDirectory } = await import("../src/config/paths.ts");
  const customDir = join(await mkdtemp(join(tmpdir(), "pi-agent-dir-")), "agent");
  await mkdir(customDir, { recursive: true });
  assert.equal(resolveNotifyManagerDirectory(customDir), getManagerDataDirectory(customDir));
});
