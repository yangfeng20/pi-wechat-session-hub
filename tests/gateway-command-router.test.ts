import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigurationStore } from "../src/config/store.ts";
import { ProjectService } from "../src/projects/project-service.ts";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import { ManagerRegistry } from "../src/registry/manager-registry.ts";
import { BackgroundWorkerManager } from "../src/runtime/background-worker-manager.ts";
import { DurableMessageQueue } from "../src/gateway/durable-message-queue.ts";
import type { IlinkReplyContext } from "../src/gateway/channel-types.ts";
import {
  GatewayAuthorizationError,
  GatewayCommandRouter,
} from "../src/gateway/command-router.ts";

test("Gateway router 串行处理命令和 prompt, 并维护 route 与 session owner", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-router-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  const configPath = join(temporaryDirectory, "manager.json");
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const sessionDirectory = join(temporaryDirectory, "pi-sessions");
  const fakeCli = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi-session-manager.mjs");
  await mkdir(projectPath, { recursive: true });

  const configStore = new ConfigurationStore(configPath);
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    wechat: {
      ...config.wechat,
      authorizedUserId: "wx-user-1",
    },
  }));
  const projects = new ProjectService(configStore);
  await projects.add("demo", "测试项目", projectPath);
  await projects.setDefault("demo");

  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const workerManager = new BackgroundWorkerManager({
    projectService: projects,
    registry,
    invocation: {
      command: process.execPath,
      args: [fakeCli],
    },
    maxBackgroundWorkers: 2,
    sessionDirectory,
    disableDiscoveredResources: true,
  });
  const sentReplies: Array<{
    routeId: string;
    messageId: string;
    text: string;
    replyContext?: IlinkReplyContext;
  }> = [];
  const router = new GatewayCommandRouter({
    configStore,
    projectService: projects,
    workerManager,
    registry,
    queue,
    lease,
    replySink: async (routeId, messageId, text, replyContext) => {
      sentReplies.push({ routeId, messageId, text, replyContext });
    },
  });

  let sessionId: string | undefined;
  try {
    const created = await router.receive({
      messageId: "wx-new-1",
      senderId: "wx-user-1",
      text: "/new --mode background --name \"调查应用错误\"",
      replyContext: { recipientId: "wx-user-1", contextToken: "context-token-new" },
    });
    assert.equal(created.state, "completed");
    const afterNew = await registry.readSnapshot();
    const route = afterNew.routes["wx-user-1"];
    assert.ok(route);
    sessionId = route.sessionId;
    assert.equal(afterNew.sessions[sessionId].state, "pending");
    assert.match(sentReplies.at(-1)?.text ?? "", /后台 Pi session 已创建/);
    assert.equal(sentReplies.at(-1)?.replyContext?.contextToken, "context-token-new");

    const promptResult = await router.receive({
      messageId: "wx-prompt-1",
      senderId: "wx-user-1",
      text: "检查应用状态",
      replyContext: { recipientId: "wx-user-1", contextToken: "context-token-prompt" },
    });
    assert.equal(promptResult.state, "completed");
    assert.match(sentReplies.at(-1)?.text ?? "", /测试回复: 检查应用状态/);
    assert.equal(sentReplies.at(-1)?.replyContext?.contextToken, "context-token-prompt");
    assert.equal((await registry.readSnapshot()).sessions[sessionId].state, "active");

    const duplicate = await router.receive({
      messageId: "wx-prompt-1",
      senderId: "wx-user-1",
      text: "检查应用状态",
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(sentReplies.length, 2);

    await queue.enqueue("wx-user-1", "wx-failed-1", "重试这条普通 prompt", 20);
    const failedClaim = await queue.claimNext("wx-user-1");
    assert.equal(failedClaim.kind, "claimed");
    if (failedClaim.kind !== "claimed") {
      throw new Error("测试队列未能声明失败消息。");
    }
    await queue.fail("wx-user-1", failedClaim.item.id, "TestError");

    const unconfirmedRetry = await router.receive({
      messageId: "wx-retry-ask",
      senderId: "wx-user-1",
      text: "/retry wx-failed-1",
    });
    assert.equal(unconfirmedRetry.state, "confirmation_required");
    assert.equal((await queue.list("wx-user-1")).find((item) => item.messageId === "wx-failed-1")?.state, "failed");

    const confirmedRetry = await router.receive({
      messageId: "wx-retry-confirm",
      senderId: "wx-user-1",
      text: "/retry wx-failed-1 --confirm",
    });
    assert.equal(confirmedRetry.state, "completed");
    assert.ok(sentReplies.some((reply) => reply.messageId === "wx-retry-ask" && reply.text.includes("可能重复")));
    assert.ok(sentReplies.some((reply) => reply.messageId === "wx-failed-1" && reply.text.includes("测试回复")));

    const sessionList = await router.receive({
      messageId: "wx-sessions-1",
      senderId: "wx-user-1",
      text: "/sessions --project demo --state all",
    });
    assert.equal(sessionList.state, "completed");
    assert.match(sentReplies.at(-1)?.text ?? "", /调查应用错误/);

    const stopped = await router.receive({
      messageId: "wx-stop-1",
      senderId: "wx-user-1",
      text: "/stop",
    });
    assert.equal(stopped.state, "completed");
    assert.equal((await registry.readSnapshot()).routes["wx-user-1"], undefined);
    assert.equal((await registry.readSnapshot()).sessions[sessionId].state, "saved");

    const resumed = await router.receive({
      messageId: "wx-resume-1",
      senderId: "wx-user-1",
      text: `/resume ${sessionId.slice(0, 8)} --mode background`,
    });
    assert.equal(resumed.state, "completed");
    assert.equal((await registry.readSnapshot()).routes["wx-user-1"].sessionId, sessionId);
  } finally {
    if (sessionId) {
      await workerManager.stop(sessionId).catch(() => undefined);
    }
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("UI /new 的项目 alias 错误会回复微信并把 queue 标记 completed", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-router-ui-project-error-"));
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    wechat: { ...config.wechat, authorizedUserId: "wx-user-1" },
  }));
  const projectService = new ProjectService(configStore);
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const workerManager = new BackgroundWorkerManager({
    projectService,
    registry,
    invocation: { command: process.execPath, args: ["unused"] },
    disableDiscoveredResources: true,
  });
  const replies: string[] = [];
  const router = new GatewayCommandRouter({
    configStore,
    projectService,
    workerManager,
    registry,
    queue,
    lease,
    replySink: async (_routeId, _messageId, text) => {
      replies.push(text);
    },
  });

  try {
    const result = await router.receive({
      messageId: "wx-new-ui-missing-project",
      senderId: "wx-user-1",
      text: "/new --mode ui --project demo",
    });
    assert.equal(result.state, "completed");
    assert.equal(replies.length, 1);
    assert.match(replies[0], /未找到项目 alias: demo/);
    assert.deepEqual(await workerManager.listSessions(), []);
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
test("Gateway 在 allowlist 检查前不写 queue", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-auth-"));
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  const projectRoot = join(temporaryDirectory, "projects");
  await mkdir(projectRoot, { recursive: true });
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
  }));
  const projectService = new ProjectService(configStore);
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const router = new GatewayCommandRouter({
    configStore,
    projectService,
    workerManager: new BackgroundWorkerManager({
      projectService,
      registry,
      invocation: { command: process.execPath, args: ["unused"] },
      disableDiscoveredResources: true,
    }),
    registry,
    queue,
    lease,
  });

  try {
    await assert.rejects(
      router.receive({ messageId: "unauthorized-1", senderId: "someone-else", text: "不要入队" }),
      GatewayAuthorizationError,
    );
    assert.deepEqual(await queue.list("someone-else"), []);
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
