import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import { DurableMessageQueue, DurableQueueError } from "../src/gateway/durable-message-queue.ts";

/**
 * 创建隔离的 manager 目录及 Gateway lease。
 *
 * @returns 临时目录、租约和 durable queue。
 */
async function createQueueFixture(): Promise<{
  directory: string;
  lease: GatewayLease;
  queue: DurableMessageQueue;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-queue-"));
  const lease = await GatewayLease.acquire(directory);
  return {
    directory,
    lease,
    queue: new DurableMessageQueue(directory, lease),
  };
}

test("durable queue 按入队顺序处理, 并按 messageId 去重", async () => {
  const { directory, lease, queue } = await createQueueFixture();
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolveGate) => {
    releaseFirst = resolveGate;
  });
  const firstStarted = new Promise<void>((resolveStarted) => {
    markFirstStarted = resolveStarted;
  });
  const processed: string[] = [];
  const processor = async (item: { messageId: string }): Promise<string> => {
    processed.push(item.messageId);
    if (item.messageId === "message-1") {
      markFirstStarted();
      await firstGate;
    }
    return `reply-${item.messageId}`;
  };

  try {
    await queue.enqueue("route-1", "message-1", "第一条", 5);
    await queue.enqueue("route-1", "message-2", "第二条", 5);
    const firstResult = queue.dispatch("route-1", "message-1", "第一条", 5, processor);
    await firstStarted;
    const secondResult = queue.dispatch("route-1", "message-2", "第二条", 5, processor);
    releaseFirst();

    const [first, second] = await Promise.all([firstResult, secondResult]);
    assert.equal(first.reply, "reply-message-1");
    assert.equal(second.reply, "reply-message-2");
    assert.deepEqual(processed, ["message-1", "message-2"]);
    assert.equal((await queue.list("route-1")).length, 0);
    const queueFiles = await readdir(join(directory, "queue"));
    assert.equal(queueFiles.some((fileName) => fileName.endsWith(".jsonl")), false);
    const dedupeIndex = await readFile(join(directory, "queue", queueFiles[0]), "utf8");
    assert.equal(dedupeIndex.includes("message-1"), false);

    const duplicate = await queue.dispatch("route-1", "message-1", "第一条", 5, processor);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.item.state, "completed");
    assert.deepEqual(processed, ["message-1", "message-2"]);
  } finally {
    releaseFirst();
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway stop 可等待所有 route queue drain 结束", async () => {
  const { directory, lease, queue } = await createQueueFixture();
  let releaseProcessor!: () => void;
  let notifyStarted!: () => void;
  const processorStarted = new Promise<void>((resolveStarted) => {
    notifyStarted = resolveStarted;
  });
  const processorGate = new Promise<void>((resolveGate) => {
    releaseProcessor = resolveGate;
  });
  let becameIdle = false;

  try {
    const dispatch = queue.dispatch(
      "route-idle",
      "message-idle",
      "等待处理",
      5,
      async () => {
        notifyStarted();
        await processorGate;
        return "完成";
      },
    );
    await processorStarted;
    const idle = queue.waitForIdle().then(() => {
      becameIdle = true;
    });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(becameIdle, false);
    releaseProcessor();
    await Promise.all([dispatch, idle]);
    assert.equal(becameIdle, true);
  } finally {
    releaseProcessor();
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("队列达到上限时拒绝新消息且不覆盖已有消息", async () => {
  const { directory, lease, queue } = await createQueueFixture();
  try {
    await queue.enqueue("route-1", "message-1", "第一条", 1);
    await assert.rejects(
      queue.enqueue("route-1", "message-2", "第二条", 1),
      (error: unknown) => error instanceof DurableQueueError && error.code === "queue_full",
    );
    assert.equal((await queue.list("route-1")).length, 1);
  } finally {
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("崩溃遗留 processing 会被自动跳过, 后续消息继续按原顺序处理", async () => {
  const { directory, lease, queue } = await createQueueFixture();
  try {
    await queue.enqueue("route-1", "message-1", "第一条", 5);
    await queue.enqueue("route-1", "message-2", "第二条", 5);
    const firstClaim = await queue.claimNext("route-1");
    assert.equal(firstClaim.kind, "claimed");

    const restartedQueue = new DurableMessageQueue(directory, lease);
    const skippedClaim = await restartedQueue.claimNext("route-1");
    assert.equal(skippedClaim.kind, "skipped");
    if (skippedClaim.kind === "skipped") {
      assert.equal(skippedClaim.item.state, "skipped");
      assert.equal(skippedClaim.item.messageId, "message-1");
    }
    assert.equal((await restartedQueue.listSkipped("route-1")).length, 1);

    const second = await restartedQueue.claimNext("route-1");
    assert.equal(second.kind, "claimed");
    if (second.kind === "claimed") {
      assert.equal(second.item.messageId, "message-2");
      await restartedQueue.complete("route-1", second.item.id);
    }

    assert.deepEqual(await restartedQueue.list("route-1"), []);
    assert.equal((await restartedQueue.listSkipped("route-1")).length, 1);
  } finally {
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("单条消息处理失败不会让后续消息一起卡死", async () => {
  const { directory, lease, queue } = await createQueueFixture();
  const processed: string[] = [];
  const processor = async (item: { messageId: string }): Promise<string> => {
    processed.push(item.messageId);
    if (item.messageId === "message-bad") {
      throw Object.assign(new Error("投递失败"), { name: "IlinkApiError", code: "api_error" });
    }
    return `reply-${item.messageId}`;
  };

  try {
    const badResult = queue.dispatch("route-1", "message-bad", "会失败的消息", 5, processor);
    const badRejected = assert.rejects(badResult);
    const goodResult = queue.dispatch("route-1", "message-good", "应当成功的消息", 5, processor);

    await badRejected;
    const good = await goodResult;
    assert.equal(good.reply, "reply-message-good");
    assert.deepEqual(processed, ["message-bad", "message-good"]);

    const skipped = await queue.listSkipped("route-1");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].messageId, "message-bad");
    assert.equal(skipped[0].errorCode, "api_error");
    assert.deepEqual(await queue.list("route-1"), []);
  } finally {
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("失败项被跳过时会通知用户, 通知失败也不影响后续消息", async () => {
  const { directory, lease, queue } = await createQueueFixture();
  const notices: Array<{ routeId: string; item: { messageId: string; state: string } }> = [];
  let notifierThrows = true;
  queue.setSkippedNotifier(async (routeId, item) => {
    if (notifierThrows) {
      notifierThrows = false;
      throw new Error("提示投递失败");
    }
    notices.push({ routeId, item });
  });

  try {
    await queue.enqueue("route-1", "message-failed", "失败的消息", 5);
    const claim = await queue.claimNext("route-1");
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") {
      throw new Error("测试队列未能声明消息。");
    }
    await queue.fail("route-1", claim.item.id, "api_error");

    const skippedClaim = await queue.claimNext("route-1");
    assert.equal(skippedClaim.kind, "skipped");

    await queue.setSkippedNotifier(undefined);
    assert.equal(notices.length, 0);

    const secondQueue = new DurableMessageQueue(directory, lease);
    secondQueue.setSkippedNotifier(async (routeId, item) => {
      notices.push({ routeId, item });
    });
    await secondQueue.enqueue("route-1", "message-next", "后续消息", 5);
    const processing = await secondQueue.dispatch(
      "route-1",
      "message-next",
      "后续消息",
      5,
      async () => "ok",
    );
    assert.equal(processing.reply, "ok");
  } finally {
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("被跳过的消息仍可通过 retry 重新执行", async () => {
  const { directory, lease, queue } = await createQueueFixture();
  try {
    await queue.enqueue("route-1", "message-retry", "需要重试的消息", 5);
    const claim = await queue.claimNext("route-1");
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") {
      throw new Error("测试队列未能声明消息。");
    }
    await queue.fail("route-1", claim.item.id, "api_error");

    const skippedClaim = await queue.claimNext("route-1");
    assert.equal(skippedClaim.kind, "skipped");

    const retried = await queue.retry("route-1", "message-retry");
    assert.equal(retried.state, "queued");

    const reclaimed = await queue.claimNext("route-1");
    assert.equal(reclaimed.kind, "claimed");
    if (reclaimed.kind === "claimed") {
      assert.equal(reclaimed.item.messageId, "message-retry");
      assert.equal(reclaimed.item.attempts, 2);
      await queue.complete("route-1", reclaimed.item.id);
    }
    assert.deepEqual(await queue.list("route-1"), []);
  } finally {
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});
