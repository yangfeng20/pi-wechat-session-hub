import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayLease, GatewayLeaseError } from "../src/registry/gateway-lease.ts";
import { ManagerRegistry } from "../src/registry/manager-registry.ts";
import type { GatewayStatusRecord, SessionIndexRecord, WorkerInstanceRecord } from "../src/registry/types.ts";

/**
 * 创建隔离的 manager 数据目录。
 *
 * @returns 临时目录绝对路径。
 */
async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-wechat-registry-"));
}

test("Gateway lease 阻止第二个 owner, 并在显式释放后允许重新取得", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const firstLease = await GatewayLease.acquire(directory);
    await assert.rejects(
      GatewayLease.acquire(directory),
      (error: unknown) => error instanceof GatewayLeaseError && error.code === "gateway_already_running",
    );
    await firstLease.assertOwned();
    assert.equal(typeof await firstLease.heartbeat(), "string");
    await firstLease.release();

    const secondLease = await GatewayLease.acquire(directory);
    await secondLease.assertOwned();
    await secondLease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway lease 使用 PID birth identity 识别当前 PID 被复用", async () => {
  const directory = await createTemporaryDirectory();
  try {
    await writeFile(
      join(directory, "manager.lock"),
      JSON.stringify({
        ownerId: "旧 owner",
        pid: process.pid,
        processBirthId: "旧进程启动标识",
        token: "旧令牌",
        acquiredAt: new Date(0).toISOString(),
      }),
    );
    const lease = await GatewayLease.acquire(directory);
    await lease.assertOwned();
    await lease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("损坏的 manager.lock fail-closed, 不擅自覆盖", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const lockPath = join(directory, "manager.lock");
    await writeFile(lockPath, "not-json");
    await assert.rejects(
      GatewayLease.acquire(directory),
      (error: unknown) => error instanceof GatewayLeaseError && error.code === "gateway_already_running",
    );
    assert.equal(await readFile(lockPath, "utf8"), "not-json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry 原子管理 gateway、instance、session、route 和审计事件", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const lease = await GatewayLease.acquire(directory);
    const registry = new ManagerRegistry(directory, lease);
    const now = new Date().toISOString();
    const gateway: GatewayStatusRecord = {
      ownerId: lease.ownerId,
      pid: process.pid,
      processBirthId: lease.processBirthId,
      startedAt: now,
      heartbeatAt: now,
      state: "online",
    };
    const instance: WorkerInstanceRecord = {
      instanceId: "worker-1",
      pid: 12345,
      processBirthId: "12345:birth",
      sessionId: "session-1",
      sessionFile: join(directory, "session.jsonl"),
      cwd: directory,
      projectAlias: "demo",
      mode: "background",
      state: "idle",
      heartbeatAt: now,
    };
    const session: SessionIndexRecord = {
      sessionId: instance.sessionId,
      sessionFile: instance.sessionFile,
      cwd: directory,
      projectAlias: "demo",
      name: "测试 session",
      mode: "background",
      state: "active",
      lastActivityAt: now,
    };

    await registry.setGateway(gateway);
    await registry.upsertInstance(instance);
    await registry.upsertSession(session);
    await registry.setRoute("wechat-user", {
      sessionId: session.sessionId,
      workerInstanceId: instance.instanceId,
      generation: 1,
      updatedAt: now,
    });
    await registry.appendEvent("worker.started", {
      sessionId: session.sessionId,
      projectAlias: session.projectAlias,
    });

    await assert.rejects(
      registry.appendEvent("unsafe", { nested: { prompt: "敏感内容" } }),
      /不能包含消息正文/,
    );
    const snapshot = await registry.readSnapshot();
    assert.equal(snapshot.gateway?.ownerId, lease.ownerId);
    assert.equal(snapshot.instances[instance.instanceId].sessionId, session.sessionId);
    assert.equal(snapshot.sessions[session.sessionId].name, "测试 session");
    assert.equal(snapshot.routes["wechat-user"].generation, 1);
    const events = (await readFile(join(directory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; data: { sessionId: string } });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "worker.started");
    assert.equal(events[0].data.sessionId, session.sessionId);

    await registry.setGateway(null);
    assert.equal((await registry.readSnapshot()).gateway, null);
    await lease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("失去 Gateway lease 后拒绝写 registry", async () => {
  const directory = await createTemporaryDirectory();
  try {
    const lease = await GatewayLease.acquire(directory);
    const registry = new ManagerRegistry(directory, lease);
    await writeFile(
      join(directory, "manager.lock"),
      JSON.stringify({ ownerId: "other", pid: process.pid, processBirthId: "other", token: "other" }),
    );
    await assert.rejects(
      registry.setGateway(null),
      (error: unknown) => error instanceof GatewayLeaseError && error.code === "gateway_lease_lost",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
