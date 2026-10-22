import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import { DurableMessageQueue } from "../src/gateway/durable-message-queue.ts";

test("iLink reply context 仅与 pending payload 同存, 完成后从磁盘移除", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-context-"));
  const lease = await GatewayLease.acquire(directory);
  const queue = new DurableMessageQueue(directory, lease);
  const replyContext = {
    recipientId: "user@im.wechat",
    contextToken: "context-token-sensitive-value",
  };

  try {
    const enqueued = await queue.enqueue(
      "route-1",
      "message-1",
      "私人消息正文",
      5,
      replyContext,
    );
    const pending = await queue.list("route-1");
    assert.deepEqual(pending[0].replyContext, replyContext);

    const claim = await queue.claimNext("route-1");
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") {
      throw new Error("测试 queue 项未被 claim。");
    }
    await queue.complete("route-1", claim.item.id);

    assert.deepEqual(await queue.list("route-1"), []);
    const queueFiles = await readdir(join(directory, "queue"));
    assert.equal(queueFiles.some((fileName) => fileName.endsWith(".jsonl")), false);
    const dedupeContents = await readFile(
      join(directory, "queue", queueFiles.find((fileName) => fileName.endsWith(".dedupe.json"))!),
      "utf8",
    );
    assert.equal(dedupeContents.includes(replyContext.contextToken), false);
    assert.equal(dedupeContents.includes(enqueued.item.messageId), false);
  } finally {
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});
