import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextTokenStore, ContextTokenStoreError } from "../src/gateway/notification/context-token-store.ts";
import {
  NotificationService,
  CONTEXT_TOKEN_FRESHNESS_MS,
  CONTEXT_TOKEN_HARD_EXPIRY_MS,
} from "../src/gateway/notification/notification-service.ts";
import type { ManagerConfiguration } from "../src/config/types.ts";

/**
 * 创建临时 manager 目录。
 *
 * @returns 临时目录路径。
 */
async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-wechat-notification-"));
}

/**
 * 创建带默认通知配置的配置 store 假实现。
 *
 * @param overflowPolicy 过期策略。
 * @returns 配置 store。
 */
function createFakeConfigStore(overflowPolicy: "queue" | "drop" = "queue") {
  const config = {
    notification: { overflowPolicy },
  } as unknown as ManagerConfiguration;
  return { load: async () => ({ config }) };
}

/**
 * 创建记录 sendText 调用的 iLink api 假实现。
 *
 * @param options 失败注入。
 * @returns api 假实现与调用记录。
 */
function createFakeApi(options: { failNext?: number } = {}) {
  const calls: Array<{ recipientId: string; text: string; contextToken: string; clientId?: string }> = [];
  let remainingFailures = options.failNext ?? 0;
  return {
    calls,
    async sendText(
      recipientId: string,
      text: string,
      contextToken: string,
      clientId?: string,
    ): Promise<{ clientId: string }> {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("fake transport failure");
      }
      calls.push({ recipientId, text, contextToken, clientId });
      return { clientId: clientId ?? "fake-client-id" };
    },
  };
}

test("ContextTokenStore 记录并恢复最新 token, 覆盖旧记录", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const store = new ContextTokenStore(directory);
    assert.equal(await store.load(), undefined);
    await store.record({ recipientId: "wx-user-1", contextToken: "token-1" }, "2026-01-01T10:00:00.000Z");
    await store.record({ recipientId: "wx-user-1", contextToken: "token-2" }, "2026-01-02T10:00:00.000Z");
    const record = await store.load();
    assert.equal(record?.contextToken, "token-2");
    assert.equal(record?.receivedAt, "2026-01-02T10:00:00.000Z");
    const raw = JSON.parse(await readFile(join(directory, "ilink-context-token.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.contextToken, "token-2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ContextTokenStore 拒绝非普通文件和损坏 JSON", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const tokenPath = join(directory, "ilink-context-token.json");
    await writeFile(tokenPath, "not-json", "utf8");
    const store = new ContextTokenStore(directory);
    await assert.rejects(
      () => store.load(),
      (error: unknown) => error instanceof ContextTokenStoreError && error.code === "format_invalid",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("通知在 token 新鲜时直接发送, 正文带勿回复提示", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const store = new ContextTokenStore(directory);
    await store.record({ recipientId: "wx-user-1", contextToken: "token-live" });
    const api = createFakeApi();
    const service = new NotificationService(api as never, store, createFakeConfigStore());
    const result = await service.notify({ title: "构建完成", text: "耗时 2 分钟", source: "ci" });
    assert.equal(result.kind, "sent");
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].recipientId, "wx-user-1");
    assert.equal(api.calls[0].contextToken, "token-live");
    assert.match(api.calls[0].text, /构建完成/);
    assert.match(api.calls[0].text, /请勿直接回复/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("token 过期时按 queue 策略积压, drop 策略直接丢弃", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const store = new ContextTokenStore(directory);
    const staleTime = new Date(Date.now() - CONTEXT_TOKEN_HARD_EXPIRY_MS - 60_000).toISOString();
    await store.record({ recipientId: "wx-user-1", contextToken: "token-stale" }, staleTime);
    const queueApi = createFakeApi();
    const queueService = new NotificationService(queueApi as never, store, createFakeConfigStore("queue"));
    const queuedResult = await queueService.notify({ text: "过期后的通知" });
    assert.equal(queuedResult.kind, "queued");
    assert.equal(queueService.backlogCount, 1);
    assert.equal(queueApi.calls.length, 0);

    const dropApi = createFakeApi();
    const dropService = new NotificationService(dropApi as never, store, createFakeConfigStore("drop"));
    const droppedResult = await dropService.notify({ text: "过期后的通知" });
    assert.equal(droppedResult.kind, "dropped");
    assert.equal(dropService.backlogCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("从未收到过微信消息时无 token 可用, 按 queue 策略积压", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const store = new ContextTokenStore(directory);
    const api = createFakeApi();
    const service = new NotificationService(api as never, store, createFakeConfigStore());
    const result = await service.notify({ text: "没有任何上下文" });
    assert.equal(result.kind, "queued");
    assert.equal(api.calls.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("续命后补发积压通知并清空队列", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const store = new ContextTokenStore(directory);
    const staleTime = new Date(Date.now() - CONTEXT_TOKEN_HARD_EXPIRY_MS - 60_000).toISOString();
    await store.record({ recipientId: "wx-user-1", contextToken: "token-stale" }, staleTime);
    const api = createFakeApi();
    const service = new NotificationService(api as never, store, createFakeConfigStore());
    await service.notify({ text: "第一条" });
    await service.notify({ text: "第二条" });
    assert.equal(service.backlogCount, 2);

    // /renew 带来新 token, 窗口刷新。
    const reply = await service.renew({ recipientId: "wx-user-1", contextToken: "token-renewed" });
    assert.match(reply, /已续命/);
    assert.match(reply, /已补发 2 条积压通知/);
    assert.equal(service.backlogCount, 0);
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].contextToken, "token-renewed");
    assert.match(api.calls[0].text, /第一条/);
    assert.match(api.calls[0].text, /第二条/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("积压超过单条上限时补发合并为摘要", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const store = new ContextTokenStore(directory);
    const staleTime = new Date(Date.now() - CONTEXT_TOKEN_HARD_EXPIRY_MS - 60_000).toISOString();
    await store.record({ recipientId: "wx-user-1", contextToken: "token-stale" }, staleTime);
    const api = createFakeApi();
    const service = new NotificationService(api as never, store, createFakeConfigStore());
    for (let index = 0; index < 12; index += 1) {
      await service.notify({ title: `通知 ${index}`, text: `正文 ${index}` });
    }
    assert.equal(service.backlogCount, 12);
    await service.renew({ recipientId: "wx-user-1", contextToken: "token-renewed" });
    // 超过 10 条时合并为一条摘要, 剩余 2 条留待下次。
    assert.equal(api.calls.length, 1);
    assert.match(api.calls[0].text, /积压通知摘要/);
    assert.equal(service.backlogCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("续命提醒仅在临近过期时发送, 且一个周期最多一次", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const store = new ContextTokenStore(directory);
    const nearExpiryTime = new Date(
      Date.now() - (CONTEXT_TOKEN_HARD_EXPIRY_MS - 60 * 60 * 1000),
    ).toISOString();
    await store.record({ recipientId: "wx-user-1", contextToken: "token-near" }, nearExpiryTime);
    const api = createFakeApi();
    const service = new NotificationService(api as never, store, createFakeConfigStore());
    await service.maybeSendRenewalReminder();
    assert.equal(api.calls.length, 1);
    assert.match(api.calls[0].text, /\/renew/);
    // 同一周期内不重复提醒。
    await service.maybeSendRenewalReminder();
    assert.equal(api.calls.length, 1);

    // token 新鲜时不提醒。
    const freshStore = new ContextTokenStore(directory);
    await freshStore.record({ recipientId: "wx-user-1", contextToken: "token-fresh" });
    const freshApi = createFakeApi();
    const freshService = new NotificationService(freshApi as never, freshStore, createFakeConfigStore());
    await freshService.maybeSendRenewalReminder();
    assert.equal(freshApi.calls.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("投递失败返回 failed 而不积压", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const store = new ContextTokenStore(directory);
    await store.record({ recipientId: "wx-user-1", contextToken: "token-live" });
    const api = createFakeApi({ failNext: 1 });
    const service = new NotificationService(api as never, store, createFakeConfigStore());
    const result = await service.notify({ text: "会失败的通知" });
    assert.equal(result.kind, "failed");
    assert.equal(service.backlogCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("通知安全余量为 20 小时, 与硬过期相差 4 小时", () => {
  assert.equal(CONTEXT_TOKEN_HARD_EXPIRY_MS - CONTEXT_TOKEN_FRESHNESS_MS, 4 * 60 * 60 * 1000);
});

test("积压通知落盘: daemon 重启后 restoreBacklog 恢复并补发", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const backlogPath = join(directory, "notification-backlog.json");
    const store = new ContextTokenStore(directory);
    const staleTime = new Date(Date.now() - CONTEXT_TOKEN_HARD_EXPIRY_MS - 60_000).toISOString();
    await store.record({ recipientId: "wx-user-1", contextToken: "token-stale" }, staleTime);
    const api = createFakeApi();
    const service = new NotificationService(api as never, store, createFakeConfigStore(), backlogPath);
    await service.notify({ title: "重启前的通知", text: "不能丢" });
    assert.equal(service.backlogCount, 1);

    // 模拟 daemon 重启: 新实例从磁盘恢复。
    const revivedService = new NotificationService(api as never, store, createFakeConfigStore(), backlogPath);
    assert.equal(revivedService.backlogCount, 0);
    await revivedService.restoreBacklog();
    assert.equal(revivedService.backlogCount, 1);

    // 续命后补发, 磁盘文件同步清空。
    await revivedService.renew({ recipientId: "wx-user-1", contextToken: "token-renewed" });
    assert.equal(revivedService.backlogCount, 0);
    assert.equal(api.calls.length, 1);
    assert.match(api.calls[0].text, /重启前的通知/);
    const raw = JSON.parse(await readFile(backlogPath, "utf8")) as { items: unknown[] };
    assert.equal(raw.items.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
