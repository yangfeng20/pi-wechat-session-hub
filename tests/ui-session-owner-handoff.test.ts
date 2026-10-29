import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { ConfigurationStore } from "../src/config/store.ts";
import { GatewayCommandRouter } from "../src/gateway/command-router.ts";
import { DurableMessageQueue } from "../src/gateway/durable-message-queue.ts";
import { UiWorkerExtensionBridge } from "../src/gateway/ui-worker-extension-bridge.ts";
import { UiWorkerIpcServer, createStableNamedPipe } from "../src/gateway/ui-worker-ipc.ts";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import { ManagerRegistry } from "../src/registry/manager-registry.ts";
import { ProjectService } from "../src/projects/project-service.ts";
import { BackgroundWorkerManager } from "../src/runtime/background-worker-manager.ts";
import { GatewayWorkerManager } from "../src/runtime/gateway-worker-manager.ts";
import { UiWorkerManager } from "../src/runtime/ui-worker-manager.ts";

/**
 * 创建隔离的 session owner handoff 测试目录。
 *
 * @returns 临时目录绝对路径。
 */
async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-wechat-session-owner-"));
}

test("Pi TUI 接管后台微信会话后可回显, TUI 关闭后 route 回到后台", async () => {
  console.log("[ENTER] case 1");
  const root = await createTemporaryDirectory();
  const agentDirectory = join(root, "pi-agent");
  const managerDirectory = join(agentDirectory, "wechat-session-manager");
  const projectRoot = join(root, "projects");
  const projectPath = join(projectRoot, "demo");
  const unregisteredPath = join(projectRoot, "unregistered");
  const outsidePath = join(root, "outside-project");
  await mkdir(projectPath, { recursive: true });
  await mkdir(unregisteredPath, { recursive: true });
  await mkdir(outsidePath, { recursive: true });
  const configStore = new ConfigurationStore(join(agentDirectory, "wechat-session-manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    projects: { ...config.projects, demo: { displayName: "测试项目", path: projectPath } },
    wechat: { ...config.wechat, authorizedUserId: "wx-owner-test" },
  }));
  const projectService = new ProjectService(configStore);
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const endpoint = process.platform === "win32"
    ? createStableNamedPipe(managerDirectory)
    : join(root, "ui-owner.sock");
  const server = new UiWorkerIpcServer(managerDirectory, registry, lease, { endpoint });
  const fakePi = join(process.cwd(), "tests", "fixtures", "fake-pi-session-manager.mjs");
  const backgroundManager = new BackgroundWorkerManager({
    projectService,
    registry,
    invocation: { command: process.execPath, args: [fakePi] },
  });
  const uiManager = new UiWorkerManager({
    managerDirectory,
    projectService,
    registry,
    ipcServer: server,
    invocation: { command: process.execPath, args: [fakePi] },
    extensionPath: join(process.cwd(), "extensions", "wechat-session-hub.ts"),
    backgroundWorkerManager: backgroundManager,
    platform: "win32",
    probeCapability: async () => ({ supported: true, executable: "C:/WindowsApps/wt.exe" }),
  });
  const gatewayWorkerManager = new GatewayWorkerManager(backgroundManager, uiManager, registry);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const sessionListReplies: string[] = [];
  const router = new GatewayCommandRouter({
    configStore,
    projectService,
    workerManager: gatewayWorkerManager,
    registry,
    queue,
    lease,
    replySink: async (_routeId, _messageId, reply) => {
      sessionListReplies.push(reply);
    },
  });
  const uiState = {
    cwd: unregisteredPath,
    sessionId: "unregistered-ui-session",
    sessionFile: join(unregisteredPath, "unregistered-ui-session.jsonl"),
    name: undefined as string | undefined,
    idle: true,
  };
  let bridge: UiWorkerExtensionBridge | undefined;
  const pi = {
    sendUserMessage: (content: string) => {
      setImmediate(() => {
        uiState.idle = false;
        bridge?.onAgentStart();
        bridge?.onMessageEnd({ message: { role: "user", content: [{ type: "text", text: content }] } });
        bridge?.onMessageEnd({ message: { role: "assistant", content: [{ type: "text", text: `UI 回复: ${content}` }] } });
        uiState.idle = true;
        bridge?.onAgentSettled();
      });
    },
  } as unknown as ExtensionAPI;
  const context = {
    mode: "tui",
    cwd: projectPath,
    sessionManager: {
      getSessionId: () => uiState.sessionId,
      getSessionFile: () => uiState.sessionFile,
      getCwd: () => uiState.cwd,
      getSessionName: () => uiState.name,
    },
    isIdle: () => uiState.idle,
    abort: () => {
      uiState.idle = true;
      bridge?.onAgentSettled();
    },
    shutdown: () => undefined,
  } as unknown as ExtensionContext;

  try {
    await server.listen();
    const session = await backgroundManager.startNew("demo", "前后台切换测试");
    await backgroundManager.prompt(session.sessionId, "写入初始 transcript");
    const beforeAttach = await registry.readSnapshot();
    const previousOwner = Object.values(beforeAttach.instances).find((instance) =>
      instance.sessionId === session.sessionId,
    );
    assert.ok(previousOwner);
    await registry.setRoute("wx-owner-test", {
      sessionId: session.sessionId,
      workerInstanceId: previousOwner.instanceId,
      generation: 1,
      updatedAt: new Date().toISOString(),
    });

    bridge = new UiWorkerExtensionBridge(undefined, projectService, managerDirectory);
    const bridgeStates: string[] = [];
    bridge.setStatusSink((state) => {
      bridgeStates.push(state);
    });
    uiState.cwd = outsidePath;
    uiState.sessionFile = join(outsidePath, "outside-ui-session.jsonl");
    await assert.rejects(bridge.attach(pi, context), /\/wx roots add-current/);
    uiState.cwd = unregisteredPath;
    uiState.sessionFile = join(unregisteredPath, "unregistered-ui-session.jsonl");
    const autoRegistered = new Promise<void>((resolveRegistered) => {
      server.once("worker_registered", () => resolveRegistered());
    });
    await bridge.attach(pi, context);
    await autoRegistered;
    assert.equal(bridgeStates.at(-1), "connected");
    const autoSession = (await registry.readSnapshot()).sessions[uiState.sessionId];
    assert.ok(autoSession);
    assert.equal(autoSession.projectAlias, "unregistered");
    assert.equal((await projectService.list()).config.projects.unregistered.displayName, "unregistered");
    assert.equal(await bridge.canSwitchSession(session.sessionFile), true);
    await bridge.onSessionShutdown({ reason: "resume" });
    assert.equal(bridgeStates.at(-1), "disconnected");
    uiState.sessionId = session.sessionId;
    uiState.sessionFile = session.sessionFile;
    uiState.cwd = projectPath;
    uiState.name = session.name;
    const registered = new Promise<void>((resolveRegistered) => {
      server.once("worker_registered", () => resolveRegistered());
    });
    await bridge.attach(pi, context);
    await registered;
    assert.equal(bridgeStates.at(-1), "connected");

    const otherBackgroundSession = await backgroundManager.startNew("demo", "后台会话");
    assert.equal(
      (await registry.readSnapshot()).sessions[otherBackgroundSession.sessionId].publicIndex,
      3,
    );
    const foreground = await registry.readSnapshot();
    const foregroundOwnerId = foreground.routes["wx-owner-test"].workerInstanceId;
    assert.notEqual(foregroundOwnerId, previousOwner.instanceId);
    assert.equal(foreground.instances[foregroundOwnerId].mode, "ui");
    assert.equal(foreground.sessions[session.sessionId].mode, "ui");
    assert.equal(foreground.routes["wx-owner-test"].generation, 2);
    const firstList = await router.receive({
      messageId: "wx-sessions-foreground",
      senderId: "wx-owner-test",
      text: "/sessions --state active",
    });
    assert.equal(firstList.state, "completed");
    const foregroundListReply = sessionListReplies.at(-1) ?? "";
    assert.match(foregroundListReply, /【当前】#1 前后台切换测试/);
    assert.match(foregroundListReply, /项目：测试项目 · 前台 · 活跃/);
    assert.match(foregroundListReply, /#3 后台会话/);
    assert.match(foregroundListReply, /项目：测试项目 · 后台 · 等待首条记录/);
    assert.equal(await gatewayWorkerManager.prompt(session.sessionId, "桌面可见回复"), "UI 回复: 桌面可见回复");

    await bridge.onSessionShutdown({ reason: "quit" });
    assert.equal(bridgeStates.at(-1), "disconnected");
    const background = await registry.readSnapshot();
    const backgroundOwnerId = background.routes["wx-owner-test"].workerInstanceId;
    assert.notEqual(backgroundOwnerId, foregroundOwnerId);
    assert.equal(background.instances[backgroundOwnerId].mode, "background");
    assert.equal(background.sessions[session.sessionId].mode, "background");
    assert.equal(background.routes["wx-owner-test"].generation, 3);
    const secondList = await router.receive({
      messageId: "wx-sessions-background",
      senderId: "wx-owner-test",
      text: "/sessions --state active",
    });
    assert.equal(secondList.state, "completed");
    const backgroundListReply = sessionListReplies.at(-1) ?? "";
    assert.match(backgroundListReply, /【当前】#1 前后台切换测试/);
    assert.match(backgroundListReply, /项目：测试项目 · 后台 · 活跃/);
    assert.match(backgroundListReply, /#3 后台会话/);
    assert.match(backgroundListReply, /项目：测试项目 · 后台 · 等待首条记录/);
    assert.equal(await gatewayWorkerManager.prompt(session.sessionId, "微信仍可回复"), "测试回复: 微信仍可回复");
  } finally {
    await bridge?.onSessionShutdown({ reason: "quit" }).catch(() => undefined);
    await gatewayWorkerManager.stopAll().catch(() => undefined);
    await uiManager.detachGateway().catch(() => undefined);
    await lease.release().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * 轮询等待条件成立。
 *
 * @param predicate 条件函数。
 * @param timeoutMs 最长等待时间。
 * @returns 条件成立时的诊断快照。
 */
async function waitForDiagnostics(
  predicate: (diagnostics: ReturnType<UiWorkerExtensionBridge["getDiagnostics"]>) => boolean,
  timeoutMs = 5000,
): Promise<ReturnType<UiWorkerExtensionBridge["getDiagnostics"]>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const diagnostics = bridgeUnderTest!.getDiagnostics();
    if (predicate(diagnostics)) {
      return diagnostics;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 bridge 状态超时, 当前状态: ${JSON.stringify(diagnostics)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let bridgeUnderTest: UiWorkerExtensionBridge | undefined;

test("UI bridge 诊断快照暴露真实连接状态与断开原因", async () => {
  console.log("[ENTER] case 2");
  const root = await createTemporaryDirectory();
  const agentDirectory = join(root, "pi-agent");
  const managerDirectory = join(agentDirectory, "wechat-session-manager");
  const projectRoot = join(root, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  const configStore = new ConfigurationStore(join(agentDirectory, "wechat-session-manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    projects: { ...config.projects, demo: { displayName: "测试项目", path: projectPath } },
    wechat: { ...config.wechat, authorizedUserId: "wx-bridge-diag" },
  }));
  const projectService = new ProjectService(configStore);
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const endpoint = process.platform === "win32"
    ? createStableNamedPipe(managerDirectory)
    : join(root, "ui-diag.sock");
  const server = new UiWorkerIpcServer(managerDirectory, registry, lease, { endpoint });
  const fakePi = join(process.cwd(), "tests", "fixtures", "fake-pi-session-manager.mjs");
  const backgroundManager = new BackgroundWorkerManager({
    projectService,
    registry,
    invocation: { command: process.execPath, args: [fakePi] },
  });
  const uiManager = new UiWorkerManager({
    managerDirectory,
    projectService,
    registry,
    ipcServer: server,
    invocation: { command: process.execPath, args: [fakePi] },
    extensionPath: join(process.cwd(), "extensions", "wechat-session-hub.ts"),
    backgroundWorkerManager: backgroundManager,
    platform: "win32",
    probeCapability: async () => ({ supported: true, executable: "C:/WindowsApps/wt.exe" }),
  });
  const sessionFile = join(projectPath, "diag-session.jsonl");
  const pi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;
  const context = {
    mode: "tui",
    cwd: projectPath,
    sessionManager: {
      getSessionId: () => "diag-session",
      getSessionFile: () => sessionFile,
      getCwd: () => projectPath,
      getSessionName: () => "诊断会话",
    },
    isIdle: () => true,
    abort: () => undefined,
    shutdown: () => undefined,
  } as unknown as ExtensionContext;
  const bridge = new UiWorkerExtensionBridge(undefined, projectService, managerDirectory);
  bridgeUnderTest = bridge;

  try {
    const initial = bridge.getDiagnostics();
    assert.equal(initial.state, "disconnected");
    assert.equal(initial.reconnectAttempts, 0);
    assert.equal(initial.lastDisconnectReason, undefined);
    assert.equal(typeof initial.instanceId, "string");

    await server.listen();
    await bridge.attach(pi, context);
    const connected = await waitForDiagnostics(
      (diagnostics) => diagnostics.state === "connected",
    );
    assert.equal(connected.reconnectAttempts, 0);
    assert.equal(connected.sessionId, "diag-session");
    assert.equal(typeof connected.lastConnectedAt, "string");
    assert.equal(connected.lastDisconnectReason, undefined);
  } finally {
    bridgeUnderTest = undefined;
    await bridge.onSessionShutdown({ reason: "quit" }).catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("session 切换清空 registration 后 bridge 不静默放弃, 可重新 attach 恢复", async () => {
  console.log("[ENTER] case 3");
  const root = await createTemporaryDirectory();
  const agentDirectory = join(root, "pi-agent");
  const managerDirectory = join(agentDirectory, "wechat-session-manager");
  const projectRoot = join(root, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  const configStore = new ConfigurationStore(join(agentDirectory, "wechat-session-manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    projects: { ...config.projects, demo: { displayName: "测试项目", path: projectPath } },
    wechat: { ...config.wechat, authorizedUserId: "wx-bridge-recovery" },
  }));
  const projectService = new ProjectService(configStore);
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const endpoint = process.platform === "win32"
    ? createStableNamedPipe(managerDirectory)
    : join(root, "ui-recovery.sock");
  const server = new UiWorkerIpcServer(managerDirectory, registry, lease, { endpoint });
  const fakePi = join(process.cwd(), "tests", "fixtures", "fake-pi-session-manager.mjs");
  const backgroundManager = new BackgroundWorkerManager({
    projectService,
    registry,
    invocation: { command: process.execPath, args: [fakePi] },
  });
  const uiManager = new UiWorkerManager({
    managerDirectory,
    projectService,
    registry,
    ipcServer: server,
    invocation: { command: process.execPath, args: [fakePi] },
    extensionPath: join(process.cwd(), "extensions", "wechat-session-hub.ts"),
    backgroundWorkerManager: backgroundManager,
    platform: "win32",
    probeCapability: async () => ({ supported: true, executable: "C:/WindowsApps/wt.exe" }),
  });
  const sessionFile = join(projectPath, "recovery-session.jsonl");
  const pi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;
  const context = {
    mode: "tui",
    cwd: projectPath,
    sessionManager: {
      getSessionId: () => "recovery-session",
      getSessionFile: () => sessionFile,
      getCwd: () => projectPath,
      getSessionName: () => "恢复会话",
    },
    isIdle: () => true,
    abort: () => undefined,
    shutdown: () => undefined,
  } as unknown as ExtensionContext;
  const bridge = new UiWorkerExtensionBridge(undefined, projectService, managerDirectory);
  bridgeUnderTest = bridge;
  const states: string[] = [];
  bridge.setStatusSink((state) => {
    states.push(state);
  });

  try {
    await server.listen();
    await bridge.attach(pi, context);
    await waitForDiagnostics((diagnostics) => diagnostics.state === "connected");

    await bridge.onSessionShutdown({ reason: "resume" });
    const afterSwitch = bridge.getDiagnostics();
    assert.equal(afterSwitch.sessionId, undefined);
    assert.match(afterSwitch.lastDisconnectReason ?? "", /resume/);
    assert.ok(
      states.includes("disconnected"),
      "footer 必须显示未接入, 不能永久停在连接中",
    );

    await bridge.attach(pi, context);
    const recovered = await waitForDiagnostics(
      (diagnostics) => diagnostics.state === "connected",
    );
    assert.equal(recovered.sessionId, "recovery-session");
  } finally {
    bridgeUnderTest = undefined;
    await bridge.onSessionShutdown({ reason: "quit" }).catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("session 切换后无需显式 attach, bridge 也能自动重建 registration 并恢复接入", async () => {
  console.log("[ENTER] case 4");
  const root = await createTemporaryDirectory();
  const agentDirectory = join(root, "pi-agent");
  const managerDirectory = join(agentDirectory, "wechat-session-manager");
  const projectRoot = join(root, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  const configStore = new ConfigurationStore(join(agentDirectory, "wechat-session-manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    projects: { ...config.projects, demo: { displayName: "测试项目", path: projectPath } },
    wechat: { ...config.wechat, authorizedUserId: "wx-bridge-auto" },
  }));
  const projectService = new ProjectService(configStore);
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const endpoint = process.platform === "win32"
    ? createStableNamedPipe(managerDirectory)
    : join(root, "ui-auto.sock");
  const server = new UiWorkerIpcServer(managerDirectory, registry, lease, { endpoint });
  const fakePi = join(process.cwd(), "tests", "fixtures", "fake-pi-session-manager.mjs");
  const backgroundManager = new BackgroundWorkerManager({
    projectService,
    registry,
    invocation: { command: process.execPath, args: [fakePi] },
  });
  new UiWorkerManager({
    managerDirectory,
    projectService,
    registry,
    ipcServer: server,
    invocation: { command: process.execPath, args: [fakePi] },
    extensionPath: join(process.cwd(), "extensions", "wechat-session-hub.ts"),
    backgroundWorkerManager: backgroundManager,
    platform: "win32",
    probeCapability: async () => ({ supported: true, executable: "C:/WindowsApps/wt.exe" }),
  });
  const sessionFile = join(projectPath, "auto-session.jsonl");
  const pi = { sendUserMessage: () => undefined } as unknown as ExtensionAPI;
  const context = {
    mode: "tui",
    cwd: projectPath,
    sessionManager: {
      getSessionId: () => "auto-session",
      getSessionFile: () => sessionFile,
      getCwd: () => projectPath,
      getSessionName: () => "自动恢复会话",
    },
    isIdle: () => true,
    abort: () => undefined,
    shutdown: () => undefined,
  } as unknown as ExtensionContext;
  const bridge = new UiWorkerExtensionBridge(undefined, projectService, managerDirectory);
  bridgeUnderTest = bridge;

  try {
    await server.listen();
    await bridge.attach(pi, context);
    await waitForDiagnostics((diagnostics) => diagnostics.state === "connected");

    await bridge.onSessionShutdown({ reason: "resume" });
    assert.equal(bridge.getDiagnostics().sessionId, undefined);

    const recovered = await waitForDiagnostics(
      (diagnostics) => diagnostics.state === "connected" && diagnostics.sessionId === "auto-session",
      20000,
    );
    assert.equal(recovered.sessionId, "auto-session");
  } finally {
    bridgeUnderTest = undefined;
    await bridge.onSessionShutdown({ reason: "quit" }).catch(() => undefined);
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
