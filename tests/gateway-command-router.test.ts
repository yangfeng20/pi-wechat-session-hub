import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigurationStore } from "../src/config/store.ts";
import type { RuntimeMode } from "../src/config/types.ts";
import { ProjectService } from "../src/projects/project-service.ts";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import { ManagerRegistry } from "../src/registry/manager-registry.ts";
import type { SessionIndexRecord } from "../src/registry/types.ts";
import { BackgroundWorkerManager } from "../src/runtime/background-worker-manager.ts";
import type { GatewayWorkerService } from "../src/runtime/gateway-worker-manager.ts";
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
      text: "/new --name \"调查应用错误\"",
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
    assert.match(sentReplies.at(-1)?.text ?? "", /#1 调查应用错误/);
    assert.match(sentReplies.at(-1)?.text ?? "", /后台/);

    const help = await router.receive({
      messageId: "wx-help-1",
      senderId: "wx-user-1",
      text: "/help",
    });
    assert.equal(help.state, "completed");
    const helpText = sentReplies.at(-1)?.text ?? "";
    assert.match(helpText, /会话命令/);
    assert.match(helpText, /项目命令/);
    assert.match(helpText, /Hub 状态/);
    assert.match(helpText, /\/sessions \[筛选条件\]/);

    const transcriptSession = (await registry.readSnapshot()).sessions[sessionId!];
    await appendFile(transcriptSession.sessionFile, `${[
      {
        type: "message",
        id: "cafe0000",
        parentId: null,
        timestamp: new Date(Date.now() - 1000).toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "这是更早的回复" }] },
      },
      {
        type: "message",
        id: "cafe0001",
        parentId: "cafe0000",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "隐藏推理" }, { type: "text", text: `测试回复: 重试这条普通 prompt\n${"较长的回复内容。".repeat(100)}` }],
          timestamp: Date.now(),
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
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
      text: "/resume 1",
    });
    assert.equal(resumed.state, "completed");
    assert.equal((await registry.readSnapshot()).routes["wx-user-1"].sessionId, sessionId);
    const resumeReply = sentReplies.at(-1)?.text ?? "";
    assert.match(resumeReply, /最近一次回复（节选）/);
    assert.match(resumeReply, /测试回复: 重试这条普通 prompt/);
    assert.match(resumeReply, /完整回复仍保留在会话记录中/);
    assert.ok(Array.from(resumeReply).length < 1000);
    assert.doesNotMatch(resumeReply, /这是更早的回复|隐藏推理/);
  } finally {
    if (sessionId) {
      await workerManager.stop(sessionId).catch(() => undefined);
    }
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("恢复目标的 agent 正在运行时只确认切换, 不回传旧回复", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-resume-running-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  const sessionFile = join(projectPath, "running-session.jsonl");
  await mkdir(projectPath, { recursive: true });
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "running-session", cwd: projectPath }),
    JSON.stringify({
      type: "message",
      id: "babe0001",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "这是先前的回复" }] },
    }),
  ].join("\n") + "\n", "utf8");
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    wechat: { ...config.wechat, authorizedUserId: "wx-running-resume" },
  }));
  const projectService = new ProjectService(configStore);
  await projectService.add("demo", "测试项目", projectPath);
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const now = new Date().toISOString();
  const session = await registry.upsertSession({
    sessionId: "running-session",
    sessionFile,
    cwd: projectPath,
    projectAlias: "demo",
    name: "运行中的会话",
    mode: "background",
    state: "active",
    lastActivityAt: now,
  });
  await registry.upsertInstance({
    instanceId: "running-session-owner",
    pid: process.pid,
    processBirthId: `${process.pid}:running-resume-test`,
    sessionId: session.sessionId,
    sessionFile,
    cwd: projectPath,
    projectAlias: "demo",
    mode: "background",
    state: "running",
    heartbeatAt: now,
  });
  const workerManager: GatewayWorkerService = {
    startNew: async () => { throw new Error("测试不应创建会话"); },
    resume: async () => session,
    prompt: async () => "unused",
    stop: async () => undefined,
    stopAll: async () => undefined,
    listSessions: async () => [session],
  };
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
      messageId: "wx-running-resume-1",
      senderId: "wx-running-resume",
      text: "/resume 1",
    });
    assert.equal(result.state, "completed");
    assert.equal((await registry.readSnapshot()).routes["wx-running-resume"].sessionId, session.sessionId);
    assert.match(replies.at(-1) ?? "", /已恢复会话/);
    assert.doesNotMatch(replies.at(-1) ?? "", /最近一次回复|这是先前的回复/);
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("微信 /new --mode ui 将显式 UI 模式交给 worker manager", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-router-ui-mode-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    wechat: { ...config.wechat, authorizedUserId: "wx-user-ui-mode" },
  }));
  const projectService = new ProjectService(configStore);
  await projectService.add("demo", "测试项目", projectPath);
  await projectService.setDefault("demo");
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const sessionFile = join(projectPath, "ui-mode-session.jsonl");
  let requestedMode: RuntimeMode | undefined;
  const workerManager: GatewayWorkerService = {
    startNew: async (projectAlias, name, mode) => {
      requestedMode = mode;
      const session = await registry.upsertSession({
        sessionId: "ui-mode-session",
        sessionFile,
        cwd: projectPath,
        projectAlias,
        ...(name ? { name } : {}),
        mode: mode ?? "background",
        state: "pending",
        lastActivityAt: new Date().toISOString(),
      });
      await registry.upsertInstance({
        instanceId: "ui-mode-owner",
        pid: process.pid,
        processBirthId: `${process.pid}:ui-mode-test`,
        sessionId: session.sessionId,
        sessionFile,
        cwd: projectPath,
        projectAlias,
        mode: mode ?? "background",
        state: "idle",
        heartbeatAt: new Date().toISOString(),
      });
      return session;
    },
    resume: async () => { throw new Error("此测试不调用 resume"); },
    prompt: async () => "",
    stop: async () => undefined,
    stopAll: async () => undefined,
    listSessions: async () => [],
  };
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
      messageId: "wx-new-ui-mode",
      senderId: "wx-user-ui-mode",
      text: "/new --mode ui --name \"UI 模式测试\"",
    });
    assert.equal(result.state, "completed");
    assert.equal(requestedMode, "ui");
    assert.match(replies.at(-1) ?? "", /可见 UI Pi session 已创建: UI 模式测试/);
    assert.equal((await registry.readSnapshot()).routes["wx-user-ui-mode"].sessionId, "ui-mode-session");
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("微信 /new 的项目 alias 错误会回复微信并把 queue 标记 completed", async () => {
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
      text: "/new --project demo",
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
test("/sessions 使用窄屏会话卡片、分页和当前 route 标记", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-sessions-title-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    wechat: { ...config.wechat, authorizedUserId: "wx-sessions-title" },
  }));
  const projectService = new ProjectService(configStore);
  await projectService.add("demo", "测试项目", projectPath);
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const unnamedSessionId = "session-with-first-message";
  const unnamedSessionFile = join(temporaryDirectory, `${unnamedSessionId}.jsonl`);
  const firstUserMessage = "请帮我排查登录页面无法提交表单的问题";
  await writeFile(unnamedSessionFile, [
    JSON.stringify({
      type: "session",
      version: 3,
      id: unnamedSessionId,
      timestamp: new Date().toISOString(),
      cwd: projectPath,
    }),
    JSON.stringify({
      type: "message",
      id: "user-entry-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: firstUserMessage }],
      },
    }),
  ].join("\n"), "utf8");
  const indexedUnnamedSession = await registry.upsertSession({
    sessionId: unnamedSessionId,
    sessionFile: unnamedSessionFile,
    cwd: projectPath,
    projectAlias: "demo",
    mode: "background",
    state: "active",
    lastActivityAt: new Date().toISOString(),
  });
  await registry.upsertInstance({
    instanceId: "current-wechat-owner",
    pid: process.pid,
    processBirthId: `${process.pid}:sessions-title-test`,
    sessionId: indexedUnnamedSession.sessionId,
    sessionFile: unnamedSessionFile,
    cwd: projectPath,
    projectAlias: "demo",
    mode: "background",
    state: "idle",
    heartbeatAt: new Date().toISOString(),
  });
  await registry.setRoute("wx-sessions-title", {
    sessionId: indexedUnnamedSession.sessionId,
    workerInstanceId: "current-wechat-owner",
    generation: 1,
    updatedAt: new Date().toISOString(),
  });
  const longTitle = "较长会话标题".repeat(8);
  await registry.upsertSession({
    sessionId: "session-with-long-name",
    sessionFile: join(temporaryDirectory, "session-with-long-name.jsonl"),
    cwd: projectPath,
    projectAlias: "demo",
    name: longTitle,
    mode: "background",
    state: "saved",
    lastActivityAt: new Date(Date.now() - 1000).toISOString(),
  });
  for (let index = 0; index < 4; index += 1) {
    await registry.upsertSession({
      sessionId: `older-session-${index}`,
      sessionFile: join(temporaryDirectory, `older-session-${index}.jsonl`),
      cwd: projectPath,
      projectAlias: "demo",
      name: `归档会话 ${index + 1}`,
      mode: "background",
      state: "saved",
      lastActivityAt: new Date(Date.now() - 5000 - index * 1000).toISOString(),
    });
  }
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
      messageId: "wx-sessions-title",
      senderId: "wx-sessions-title",
      text: "/sessions --state all",
    });
    assert.equal(result.state, "completed");
    const reply = replies.at(-1) ?? "";
    assert.match(reply, /会话列表 · 第 1\/2 页 · 共 6 个/);
    assert.match(reply, new RegExp(`【当前】#${indexedUnnamedSession.publicIndex} ${firstUserMessage}`));
    assert.match(reply, /项目：测试项目 · 后台 · 活跃/);
    assert.ok(reply.includes(`${Array.from(longTitle).slice(0, 29).join("")}...`));
    assert.doesNotMatch(reply, /\|/);
    assert.match(reply, /切换会话：\/resume <索引或名称>/);
    assert.match(reply, /下一页：\/sessions --state all --page 2/);

    const secondPage = await router.receive({
      messageId: "wx-sessions-title-page-2",
      senderId: "wx-sessions-title",
      text: "/sessions --state all --page 2",
    });
    assert.equal(secondPage.state, "completed");
    assert.match(replies.at(-1) ?? "", /会话列表 · 第 2\/2 页 · 共 6 个/);
    assert.match(replies.at(-1) ?? "", /上一页：\/sessions --state all --page 1/);

    const status = await router.receive({
      messageId: "wx-sessions-title-status",
      senderId: "wx-sessions-title",
      text: "/status",
    });
    assert.equal(status.state, "completed");
    const statusText = replies.at(-1) ?? "";
    assert.match(statusText, /Hub 状态：未启动/);
    assert.match(statusText, new RegExp(`当前微信会话：#${indexedUnnamedSession.publicIndex} ${firstUserMessage}`));
    assert.match(statusText, /Pi：后台 · 空闲/);
    assert.match(statusText, /未完成消息：0 条/);
    assert.doesNotMatch(statusText, /PID|Gateway:|Worker:|Queue:/);
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

test("/last 只读展示当前会话最近一轮对话, 不切换 route 也不投递 prompt", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-last-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    wechat: { ...config.wechat, authorizedUserId: "wx-last-route" },
  }));
  const projectService = new ProjectService(configStore);
  await projectService.add("demo", "测试项目", projectPath);
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const sessionFile = join(temporaryDirectory, "last-session.jsonl");
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "last-session", cwd: projectPath }),
    JSON.stringify({
      type: "message",
      id: "user-entry-old",
      parentId: null,
      timestamp: new Date(Date.now() - 60000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "这是更早的提问" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "assistant-entry-old",
      parentId: "user-entry-old",
      timestamp: new Date(Date.now() - 59000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "这是更早的回复" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "user-entry-new",
      parentId: "assistant-entry-old",
      timestamp: new Date(Date.now() - 2000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "把 tokenizer 里的 execCommand 改成 runCommand" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "tool-entry-new",
      parentId: "user-entry-new",
      timestamp: new Date(Date.now() - 1500).toISOString(),
      message: { role: "toolResult", content: [{ type: "text", text: "工具输出不应出现在摘要中" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "assistant-entry-new",
      parentId: "tool-entry-new",
      timestamp: new Date(Date.now() - 1000).toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "隐藏推理不应出现" },
          { type: "text", text: "已把 3 处调用点改为 runCommand, 并补齐测试。" },
        ],
      },
    }),
  ].join("\n") + "\n", "utf8");
  const indexed = await registry.upsertSession({
    sessionId: "last-session",
    sessionFile,
    cwd: projectPath,
    projectAlias: "demo",
    mode: "background",
    state: "active",
    lastActivityAt: new Date().toISOString(),
  });
  await registry.upsertInstance({
    instanceId: "last-owner",
    pid: process.pid,
    processBirthId: `${process.pid}:last-test`,
    sessionId: indexed.sessionId,
    sessionFile,
    cwd: projectPath,
    projectAlias: "demo",
    mode: "background",
    state: "idle",
    heartbeatAt: new Date().toISOString(),
  });
  await registry.setRoute("wx-last-route", {
    sessionId: indexed.sessionId,
    workerInstanceId: "last-owner",
    generation: 1,
    updatedAt: new Date().toISOString(),
  });
  const prompts: string[] = [];
  const replies: string[] = [];
  const router = new GatewayCommandRouter({
    configStore,
    projectService,
    workerManager: {
      prompt: async (_sessionId: string, text: string) => {
        prompts.push(text);
        return "不应被调用";
      },
    } as unknown as GatewayWorkerService,
    registry,
    queue,
    lease,
    replySink: async (_routeId, _messageId, text) => {
      replies.push(text);
    },
  });

  try {
    const result = await router.receive({
      messageId: "wx-last-1",
      senderId: "wx-last-route",
      text: "/last",
    });
    assert.equal(result.state, "completed");
    const reply = replies.at(-1) ?? "";
    assert.match(reply, new RegExp(`会话 #${indexed.publicIndex}`));
    assert.match(reply, /最近一轮对话/);
    const body = reply.slice(reply.indexOf("最近一轮对话"));
    assert.match(body, /把 tokenizer 里的 execCommand 改成 runCommand/);
    assert.match(body, /已把 3 处调用点改为 runCommand/);
    assert.doesNotMatch(body, /这是更早的提问|这是更早的回复|工具输出不应出现|隐藏推理不应出现/);
    assert.match(reply, /发送任意内容可继续对话/);
    assert.deepEqual(prompts, []);
    const afterSnapshot = await registry.readSnapshot();
    assert.equal(afterSnapshot.routes["wx-last-route"].sessionId, indexed.sessionId);
    assert.equal(afterSnapshot.routes["wx-last-route"].generation, 1);
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("/last 支持指定会话索引、运行中提示与无记录会话", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-last-selector-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    wechat: { ...config.wechat, authorizedUserId: "wx-last-selector" },
  }));
  const projectService = new ProjectService(configStore);
  await projectService.add("demo", "测试项目", projectPath);
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const runningSessionFile = join(temporaryDirectory, "running-last.jsonl");
  await writeFile(runningSessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "running-last", cwd: projectPath }),
    JSON.stringify({
      type: "message",
      id: "assistant-running",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "当前已完成的中间结论" }] },
    }),
  ].join("\n") + "\n", "utf8");
  const runningSession = await registry.upsertSession({
    sessionId: "running-last",
    sessionFile: runningSessionFile,
    cwd: projectPath,
    projectAlias: "demo",
    name: "运行中的会话",
    mode: "background",
    state: "active",
    lastActivityAt: new Date().toISOString(),
  });
  await registry.upsertInstance({
    instanceId: "running-owner",
    pid: process.pid,
    processBirthId: `${process.pid}:running-last-test`,
    sessionId: runningSession.sessionId,
    sessionFile: runningSessionFile,
    cwd: projectPath,
    projectAlias: "demo",
    mode: "background",
    state: "running",
    heartbeatAt: new Date().toISOString(),
  });
  const pendingSession = await registry.upsertSession({
    sessionId: "pending-last",
    sessionFile: join(temporaryDirectory, "pending-last.jsonl"),
    cwd: projectPath,
    projectAlias: "demo",
    name: "未开始的会话",
    mode: "background",
    state: "pending",
    lastActivityAt: new Date().toISOString(),
  });
  const replies: string[] = [];
  const router = new GatewayCommandRouter({
    configStore,
    projectService,
    workerManager: { prompt: async () => "不应被调用" } as unknown as GatewayWorkerService,
    registry,
    queue,
    lease,
    replySink: async (_routeId, _messageId, text) => {
      replies.push(text);
    },
  });

  try {
    const withoutRoute = await router.receive({
      messageId: "wx-last-no-route",
      senderId: "wx-last-selector",
      text: "/last",
    });
    assert.equal(withoutRoute.state, "completed");
    assert.match(replies.at(-1) ?? "", /当前微信路由没有绑定会话/);

    const runningResult = await router.receive({
      messageId: "wx-last-running",
      senderId: "wx-last-selector",
      text: `/last ${runningSession.publicIndex}`,
    });
    assert.equal(runningResult.state, "completed");
    const runningReply = replies.at(-1) ?? "";
    assert.match(runningReply, /运行中的会话/);
    assert.match(runningReply, /当前已完成的中间结论/);
    assert.match(runningReply, /该会话正在运行/);
    assert.match(runningReply, new RegExp(`/resume ${runningSession.publicIndex}`));
    assert.equal((await registry.readSnapshot()).routes["wx-last-selector"], undefined);

    const pendingResult = await router.receive({
      messageId: "wx-last-pending",
      senderId: "wx-last-selector",
      text: `/last ${pendingSession.publicIndex}`,
    });
    assert.equal(pendingResult.state, "completed");
    assert.match(replies.at(-1) ?? "", /尚未写入任何对话记录/);

    const missing = await router.receive({
      messageId: "wx-last-missing",
      senderId: "wx-last-selector",
      text: "/last 999",
    });
    assert.equal(missing.state, "completed");
    assert.match(replies.at(-1) ?? "", /未找到会话索引或名称/);
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("/last 在单条消息超过尾部窗口时仍能取到最近一轮", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-last-big-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    wechat: { ...config.wechat, authorizedUserId: "wx-last-big" },
  }));
  const projectService = new ProjectService(configStore);
  await projectService.add("demo", "测试项目", projectPath);
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const sessionFile = join(temporaryDirectory, "big-last.jsonl");
  const hugeReply = `开头标记${"超长回复内容。".repeat(40000)}结尾标记`;
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "big-last", cwd: projectPath }),
    JSON.stringify({
      type: "message",
      id: "big-user",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "请阅读这段超大内容" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "big-assistant",
      parentId: "big-user",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: hugeReply }] },
    }),
  ].join("\n") + "\n", "utf8");
  const indexed = await registry.upsertSession({
    sessionId: "big-last",
    sessionFile,
    cwd: projectPath,
    projectAlias: "demo",
    name: "超大记录会话",
    mode: "background",
    state: "active",
    lastActivityAt: new Date().toISOString(),
  });
  await registry.upsertInstance({
    instanceId: "big-owner",
    pid: process.pid,
    processBirthId: `${process.pid}:big-last-test`,
    sessionId: indexed.sessionId,
    sessionFile,
    cwd: projectPath,
    projectAlias: "demo",
    mode: "background",
    state: "idle",
    heartbeatAt: new Date().toISOString(),
  });
  await registry.setRoute("wx-last-big", {
    sessionId: indexed.sessionId,
    workerInstanceId: "big-owner",
    generation: 1,
    updatedAt: new Date().toISOString(),
  });
  const replies: string[] = [];
  const router = new GatewayCommandRouter({
    configStore,
    projectService,
    workerManager: { prompt: async () => "不应被调用" } as unknown as GatewayWorkerService,
    registry,
    queue,
    lease,
    replySink: async (_routeId, _messageId, text) => {
      replies.push(text);
    },
  });

  try {
    const result = await router.receive({
      messageId: "wx-last-big-1",
      senderId: "wx-last-big",
      text: "/last",
    });
    assert.equal(result.state, "completed");
    const reply = replies.at(-1) ?? "";
    assert.match(reply, /超大记录会话/);
    assert.match(reply, /请阅读这段超大内容/);
    assert.match(reply, /开头标记/);
    assert.match(reply, /AI（节选）/);
    assert.match(reply, /完整内容仍在会话记录中/);
    assert.ok(Array.from(reply).length < 2000, "回复必须能装进单条 iLink 文本");
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
