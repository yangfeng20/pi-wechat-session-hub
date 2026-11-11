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
    assert.match(sentReplies.at(-1)?.text ?? "", /\*\*已创建会话\*\* 调查应用错误/);
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
    assert.match(sentReplies.at(-1)?.text ?? "", /\| 1 \| 调查应用错误（当前） \| 后台 \| 活跃 \|/);

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
    assert.match(helpText, /\/sessions \[--project <别名>\]/);
    assert.doesNotMatch(helpText, /--page/);

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
          content: [{ type: "thinking", thinking: "隐藏推理" }, { type: "text", text: `测试回复: 重试这条普通 prompt\n${"较长的回复内容。".repeat(4000)}\n末尾结论标记` }],
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
    assert.match(resumeReply, /最近一次回复（末段节选）/);
    assert.match(resumeReply, /末尾结论标记/, "应当保留回复结尾");
    assert.match(resumeReply, /完整回复仍保留在会话记录中/);
    assert.ok(
      Buffer.byteLength(resumeReply, "utf8") <= 16500,
      "恢复预览必须能装进单条 iLink 消息的字节预算",
    );
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
    assert.match(replies.at(-1) ?? "", /\*\*已创建会话\*\* UI 模式测试/);
    assert.equal((await registry.readSnapshot()).routes["wx-user-ui-mode"].sessionId, "ui-mode-session");
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("微信 /status 在 UI 模式不可用时明确标注原因", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-router-ui-capability-"));
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    wechat: { ...config.wechat, authorizedUserId: "wx-user-capability" },
  }));
  const projectService = new ProjectService(configStore);
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const replies: string[] = [];
  const router = new GatewayCommandRouter({
    configStore,
    projectService,
    workerManager: {
      startNew: async () => { throw new Error("此测试不创建会话"); },
      resume: async () => { throw new Error("此测试不恢复会话"); },
      prompt: async () => "",
      stop: async () => undefined,
      stopAll: async () => undefined,
      listSessions: async () => [],
    },
    registry,
    queue,
    lease,
    uiModeCapability: async () => ({
      supported: false,
      reason: "未找到 Windows Terminal (wt.exe), 请先安装 Windows Terminal 或将其加入应用执行别名",
    }),
    replySink: async (_routeId, _messageId, text) => {
      replies.push(text);
    },
  });

  try {
    const result = await router.receive({
      messageId: "wx-status-ui-capability",
      senderId: "wx-user-capability",
      text: "/status",
    });
    assert.equal(result.state, "completed");
    assert.match(replies[0], /\| 可见 UI 模式 \| 不可用/);
    assert.match(replies[0], /wt\.exe/);
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
test("/sessions 一页展示全部匹配会话并标记当前 route", async () => {
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
    assert.match(reply, /\*\*会话列表\*\* · 共 6 个/);
    // 微信 markdown 渲染支持表格 (2026-11-11 实测), 手机端无需横向滚动。
    assert.match(reply, /\| 索引 \| 标题 \| 模式 \| 状态 \|/);
    assert.match(reply, /\| --- \| --- \| --- \| --- \|/);
    assert.equal(reply.split("\n").filter((line) => /^\| \d+ \|/.test(line)).length, 6);
    assert.match(
      reply,
      new RegExp(`\\| ${indexedUnnamedSession.publicIndex} \\| ${firstUserMessage}（当前） \\| 后台 \\| 活跃 \\|`),
    );
    // 项目名不逐行重复, 改为汇总在表格下方。
    assert.match(reply, /项目：测试项目/);
    assert.ok(reply.includes(`${Array.from(longTitle).slice(0, 29).join("")}...`));
    assert.match(reply, /切换会话：`\/resume <索引或名称>`/);
    assert.doesNotMatch(reply, /第 \d+\/\d+ 页|下一页|上一页|--page/);

    const status = await router.receive({
      messageId: "wx-sessions-title-status",
      senderId: "wx-sessions-title",
      text: "/status",
    });
    assert.equal(status.state, "completed");
    const statusText = replies.at(-1) ?? "";
    assert.match(statusText, /\| 连接 \| 未启动 \|/);
    assert.match(statusText, new RegExp(`\\| 当前会话 \\| #${indexedUnnamedSession.publicIndex} ${firstUserMessage} \\|`));
    assert.match(statusText, /\| Pi \| 后台 · 空闲 \|/);
    assert.match(statusText, /\| 未完成消息 \| 0 条 \|/);
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
    assert.match(reply, new RegExp(`\\*\\*会话 #${indexed.publicIndex}\\*\\*`));
    const body = reply.slice(reply.indexOf("**你**"));
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
    assert.match(reply, /结尾标记/, "应当保留回复结尾而不是开头");
    assert.doesNotMatch(reply, /开头标记/, "超长回复的开头应被截断");
    assert.match(reply, /AI（末段节选）/);
    assert.match(reply, /以上为结尾 3800 字/);
    assert.ok(
      Buffer.byteLength(reply, "utf8") <= 16500,
      "回复必须能装进单条 iLink 消息的字节预算",
    );
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("失败消息被跳过时向微信回提示, 且后续消息照常处理", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-skip-notice-"));
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    wechat: { ...config.wechat, authorizedUserId: "wx-skip-route" },
  }));
  const projectService = new ProjectService(configStore);
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const sentReplies: Array<{ routeId: string; messageId: string; text: string }> = [];
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
    replySink: async (routeId, messageId, text) => {
      sentReplies.push({ routeId, messageId, text });
    },
  });

  try {
    await queue.enqueue(
      "wx-skip-route",
      "wx-broken-1",
      "这条回复会投递失败",
      20,
      { recipientId: "wx-skip-route", contextToken: "context-token-broken" },
    );
    const claim = await queue.claimNext("wx-skip-route");
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") {
      throw new Error("测试队列未能声明消息。");
    }
    await queue.fail("wx-skip-route", claim.item.id, "api_error");

    const statusResult = await router.receive({
      messageId: "wx-status-after-fail",
      senderId: "wx-skip-route",
      text: "/status",
      replyContext: { recipientId: "wx-skip-route", contextToken: "context-token-status" },
    });
    assert.equal(statusResult.state, "completed");

    const skipNotice = sentReplies.find((reply) => reply.messageId === "wx-broken-1:skipped");
    assert.ok(skipNotice, "应当向微信回一条跳过提示");
    assert.match(skipNotice!.text, /已自动跳过/);
    assert.match(skipNotice!.text, /wx-broken-1/);
    assert.match(skipNotice!.text, /api_error/);

    const statusReply = sentReplies.find((reply) => reply.messageId === "wx-status-after-fail");
    assert.ok(statusReply);
    assert.match(statusReply!.text, /\*\*已跳过\*\* · 1 条/);
    assert.match(statusReply!.text, /wx-broken-1/);
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("任何回复都必须压到单条 iLink 消息的安全长度内, 不触发多 item 切分", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-length-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    wechat: { ...config.wechat, authorizedUserId: "wx-length-route" },
  }));
  const projectService = new ProjectService(configStore);
  await projectService.add("demo", "测试项目", projectPath);
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const replies: string[] = [];
  const router = new GatewayCommandRouter({
    configStore,
    projectService,
    workerManager: {
      prompt: async () => `超长回复开头\n${"长内容。".repeat(2000)}\n超长回复结尾`,
      resume: async () => ({ sessionId: "huge-session" }),
    } as unknown as GatewayWorkerService,
    registry,
    queue,
    lease,
    replySink: async (_routeId, _messageId, text) => {
      replies.push(text);
    },
  });

  try {
    const sessionFile = join(temporaryDirectory, "huge-session.jsonl");
    await writeFile(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "huge-session", cwd: projectPath }),
      JSON.stringify({
        type: "message",
        id: "huge-user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "提".repeat(5000) }] },
      }),
      JSON.stringify({
        type: "message",
        id: "huge-assistant-1",
        parentId: "huge-user-1",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "回".repeat(20000) }] },
      }),
    ].join("\n") + "\n", "utf8");
    const indexed = await registry.upsertSession({
      sessionId: "huge-session",
      sessionFile,
      cwd: projectPath,
      projectAlias: "demo",
      name: "超长会话",
      mode: "background",
      state: "active",
      lastActivityAt: new Date().toISOString(),
    });
    await registry.upsertInstance({
      instanceId: "huge-owner",
      pid: process.pid,
      processBirthId: `${process.pid}:huge-length-test`,
      sessionId: indexed.sessionId,
      sessionFile,
      cwd: projectPath,
      projectAlias: "demo",
      mode: "background",
      state: "idle",
      heartbeatAt: new Date().toISOString(),
    });
    await registry.setRoute("wx-length-route", {
      sessionId: indexed.sessionId,
      workerInstanceId: "huge-owner",
      generation: 1,
      updatedAt: new Date().toISOString(),
    });

    const lastResult = await router.receive({
      messageId: "wx-length-last",
      senderId: "wx-length-route",
      text: "/last",
    });
    assert.equal(lastResult.state, "completed");

    const resumeResult = await router.receive({
      messageId: "wx-length-resume",
      senderId: "wx-length-route",
      text: "/resume 1",
    });
    assert.equal(resumeResult.state, "completed");

    const promptResult = await router.receive({
      messageId: "wx-length-prompt",
      senderId: "wx-length-route",
      text: "生成超长回复",
    });
    assert.equal(promptResult.state, "completed");

    assert.equal(replies.length, 3);
    for (const reply of replies) {
      // iLink 只接受单 text_item, 且请求体超过约 16800 字节会被服务端拒绝,
      // 所以每条回复都必须落在 16500 字节预算内 (留余量)。
      const bytes = Buffer.byteLength(reply, "utf8");
      assert.ok(
        bytes <= 16500,
        `回复 ${bytes} 字节超过单条 iLink 消息预算, 会被服务端以 ret=-2 拒绝`,
      );
    }
    assert.match(replies.at(-1) ?? "", /已截断/, "超长回复应明确提示已截断");
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("/sessions 输出使用 markdown 块级结构, 避免单换行被渲染器吞掉", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-md-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    wechat: { ...config.wechat, authorizedUserId: "wx-md-route" },
  }));
  const projectService = new ProjectService(configStore);
  await projectService.add("demo", "演示项目", projectPath);
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  for (let index = 0; index < 3; index += 1) {
    await registry.upsertSession({
      sessionId: `md-session-${index}`,
      sessionFile: join(temporaryDirectory, `md-session-${index}.jsonl`),
      cwd: projectPath,
      projectAlias: "demo",
      name: `会话标题 ${index + 1}`,
      mode: "background",
      state: "saved",
      lastActivityAt: new Date(Date.now() - index * 1000).toISOString(),
    });
  }
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
    await router.receive({
      messageId: "wx-md-sessions",
      senderId: "wx-md-route",
      text: "/sessions --state all",
    });
    const reply = replies.at(-1) ?? "";

    // 微信按 markdown 渲染, 表格行是块级元素, 每个会话独占一行。
    // 同时不能用普通列表项: 单换行会被渲染器当作空格合并。
    const dataRows = reply
      .split("\n")
      .filter((line) => /^\| \d+ \|/.test(line));
    assert.equal(dataRows.length, 3, "每个会话应各自成为一行表格数据");
    for (const line of dataRows) {
      assert.match(line, /^\| \d+ \| .+ \| (前台|后台) \| (活跃|等待首条记录|已保存) \|$/);
    }
    assert.match(reply, /\| 索引 \| 标题 \| 模式 \| 状态 \|/, "表头应固定为四列");
    assert.match(reply, /\| --- \| --- \| --- \| --- \|/, "表格需要分隔行");

    await router.receive({
      messageId: "wx-md-help",
      senderId: "wx-md-route",
      text: "/help",
    });
    const help = replies.at(-1) ?? "";
    assert.match(help, /\*\*微信命令帮助\*\*/, "帮助标题应使用加粗");
    const helpItems = help.split("\n").filter((line) => line.startsWith("- "));
    assert.ok(helpItems.length >= 5, "帮助内容应以列表项组织");
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("/watch 总览运行、错误与空闲会话, /last 显示真实 429 错误", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-watch-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  const configStore = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    wechat: { ...config.wechat, authorizedUserId: "wx-watch-route" },
  }));
  const projectService = new ProjectService(configStore);
  await projectService.add("demo", "演示项目", projectPath);
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const runningFile = join(temporaryDirectory, "running.jsonl");
  const errorFile = join(temporaryDirectory, "quota-error.jsonl");
  const idleFile = join(temporaryDirectory, "idle.jsonl");
  const errorMessage = '429: {"message":"You have exceeded the weekly usage quota. It will reset at 2026-11-16 00:00:00 +0800 CST.","type":"TooManyRequests","code":"AccountQuotaExceeded"}';
  await writeFile(runningFile, `${JSON.stringify({
    type: "message",
    id: "running-assistant",
    parentId: "running-user",
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "还在运行" }], stopReason: "stop" },
  })}\n`, "utf8");
  await writeFile(errorFile, [
    JSON.stringify({
      type: "message",
      id: "quota-user",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "检查额度" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "quota-assistant",
      parentId: "quota-user",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [], stopReason: "error", errorMessage },
    }),
  ].join("\n") + "\n", "utf8");
  await writeFile(idleFile, `${JSON.stringify({ type: "session", version: 3, id: "idle-session", cwd: projectPath })}\n`, "utf8");

  const runningSession = await registry.upsertSession({
    sessionId: "running-session",
    sessionFile: runningFile,
    cwd: projectPath,
    projectAlias: "demo",
    name: "运行会话",
    mode: "background",
    state: "active",
    lastActivityAt: new Date().toISOString(),
  });
  const errorSession = await registry.upsertSession({
    sessionId: "quota-session",
    sessionFile: errorFile,
    cwd: projectPath,
    projectAlias: "demo",
    name: "额度错误会话",
    mode: "background",
    state: "active",
    lastActivityAt: new Date().toISOString(),
  });
  const idleSession = await registry.upsertSession({
    sessionId: "idle-session",
    sessionFile: idleFile,
    cwd: projectPath,
    projectAlias: "demo",
    name: "空闲会话",
    mode: "background",
    state: "saved",
    lastActivityAt: new Date(Date.now() - 3600000).toISOString(),
  });
  const birth = `${process.pid}:watch-test`;
  for (const [instanceId, session, state, suffix] of [
    ["watch-running", runningSession, "running", "running"],
    ["watch-error", errorSession, "idle", "error"],
  ] as const) {
    await registry.upsertInstance({
      instanceId,
      pid: process.pid,
      processBirthId: `${birth}:${suffix}`,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      cwd: projectPath,
      projectAlias: "demo",
      mode: "background",
      state,
      heartbeatAt: "2020-01-01T00:00:00.000Z",
    });
  }
  await registry.setRoute("wx-watch-route", {
    sessionId: errorSession.sessionId,
    workerInstanceId: "watch-error",
    generation: 1,
    updatedAt: new Date().toISOString(),
  });

  const replies: string[] = [];
  const router = new GatewayCommandRouter({
    configStore,
    projectService,
    workerManager: { prompt: async () => "不应调用模型" } as unknown as GatewayWorkerService,
    registry,
    queue,
    lease,
    replySink: async (_routeId, _messageId, text) => {
      replies.push(text);
    },
  });

  try {
    const watchResult = await router.receive({
      messageId: "watch-default",
      senderId: "wx-watch-route",
      text: "/watch",
    });
    assert.equal(watchResult.state, "completed");
    const watchText = replies.at(-1) ?? "";
    assert.match(watchText, /总览/);
    assert.match(watchText, /运行会话/);
    assert.match(watchText, /🟢 运行中/);
    assert.match(watchText, /额度错误会话/);
    assert.match(watchText, /🔴 错误/);
    assert.match(watchText, /周额度已耗尽/);
    assert.match(watchText, /2026-11-16 00:00:00 \+0800 CST/);
    assert.doesNotMatch(watchText, /空闲会话/);

    const allResult = await router.receive({
      messageId: "watch-all",
      senderId: "wx-watch-route",
      text: "/watch --all",
    });
    assert.equal(allResult.state, "completed");
    assert.match(replies.at(-1) ?? "", /空闲会话/);

    const lastResult = await router.receive({
      messageId: "last-error",
      senderId: "wx-watch-route",
      text: "/last",
    });
    assert.equal(lastResult.state, "completed");
    const lastText = replies.at(-1) ?? "";
    assert.match(lastText, /\*\*AI（错误）\*\*/);
    assert.match(lastText, /周额度已耗尽/);
    assert.match(lastText, /2026-11-16 00:00:00 \+0800 CST/);
    assert.doesNotMatch(lastText, /尚未产生回复/);
    assert.ok(idleSession.publicIndex);
  } finally {
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
