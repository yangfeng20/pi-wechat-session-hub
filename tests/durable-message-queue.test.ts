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

test("崩溃遗留 processing 会阻断 FIFO, 显式 retry 后按原顺序恢复", async () => {
  const { directory, lease, queue } = await createQueueFixture();
  try {
    await queue.enqueue("route-1", "message-1", "第一条", 5);
    await queue.enqueue("route-1", "message-2", "第二条", 5);
    const firstClaim = await queue.claimNext("route-1");
    assert.equal(firstClaim.kind, "claimed");

    const restartedQueue = new DurableMessageQueue(directory, lease);
    const blockedClaim = await restartedQueue.claimNext("route-1");
    assert.equal(blockedClaim.kind, "blocked");
    if (blockedClaim.kind === "blocked") {
      assert.equal(blockedClaim.item.state, "interrupted");
    }

    await restartedQueue.retry("route-1", "message-1");
    const retriedFirst = await restartedQueue.claimNext("route-1");
    assert.equal(retriedFirst.kind, "claimed");
    if (retriedFirst.kind !== "claimed") {
      throw new Error("第一条 queue 消息未按预期恢复。");
    }
    await restartedQueue.complete("route-1", retriedFirst.item.id);
    const second = await restartedQueue.claimNext("route-1");
    assert.equal(second.kind, "claimed");
    if (second.kind === "claimed") {
      assert.equal(second.item.messageId, "message-2");
    }
  } finally {
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});
