import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { ConfigurationStore } from "../src/config/store.ts";
import { GatewayCommandRouter } from "../src/gateway/command-router.ts";
import { DurableMessageQueue } from "../src/gateway/durable-message-queue.ts";
import { UiWorkerExtensionBridge } from "../src/gateway/ui-worker-extension-bridge.ts";
import { createStableNamedPipe, readUiWorkerLaunchRecord, UiWorkerIpcServer } from "../src/gateway/ui-worker-ipc.ts";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import { ManagerRegistry } from "../src/registry/manager-registry.ts";
import { ProjectService } from "../src/projects/project-service.ts";
import { BackgroundWorkerManager } from "../src/runtime/background-worker-manager.ts";
import { GatewayWorkerManager } from "../src/runtime/gateway-worker-manager.ts";
import { UiWorkerManager, UiWorkerManagerError } from "../src/runtime/ui-worker-manager.ts";

interface FakeUiWorker {
  instanceId: string;
  state: {
    sessionId: string;
    sessionFile: string;
    cwd: string;
    idle: boolean;
    sessionName?: string;
  };
  pi: ExtensionAPI;
  context: ExtensionContext;
  bridge: UiWorkerExtensionBridge;
}

/**
 * 创建使用真实 IPC bridge 但不启动 Pi CLI 的 fake UI worker。
 *
 * @param launch 经 IPC server 认证的 launch record。
 * @param cwd 已授权项目目录。
 * @param sessionId Pi session ID。
 * @param sessionFile Pi transcript 路径。
 * @param projectService 项目路径校验服务。
 * @returns 可在测试中模拟 agent_start/message_end/agent_settled 的 worker。
 */
function createFakeUiWorker(
  launch: Awaited<ReturnType<typeof readUiWorkerLaunchRecord>>,
  cwd: string,
  sessionId: string,
  sessionFile: string,
  projectService: ProjectService,
): FakeUiWorker {
  const state: FakeUiWorker["state"] = {
    sessionId,
    sessionFile,
    cwd,
    idle: true,
    sessionName: launch.sessionName,
  };
  let bridge: UiWorkerExtensionBridge;
  const pi = {
    setSessionName(name: string) {
      state.sessionName = name;
    },
    sendUserMessage(content: string) {
      setImmediate(() => {
        state.idle = false;
        bridge.onAgentStart();
        bridge.onMessageEnd({
          message: { role: "user", content: [{ type: "text", text: content }] },
        });
        bridge.onMessageEnd({
          message: { role: "assistant", content: [{ type: "text", text: `UI fake reply: ${content}` }] },
        });
        state.idle = true;
        bridge.onAgentSettled();
      });
    },
  } as unknown as ExtensionAPI;
  const context = {
    mode: "tui",
    cwd,
    sessionManager: {
      getSessionId: () => state.sessionId,
      getSessionFile: () => state.sessionFile,
      getCwd: () => state.cwd,
      getSessionName: () => state.sessionName,
    },
    isIdle: () => state.idle,
    abort: () => {
      state.idle = true;
      bridge.onAgentSettled();
    },
    shutdown: () => {
      void bridge.onSessionShutdown({ reason: "quit" });
    },
  } as unknown as ExtensionContext;
  bridge = new UiWorkerExtensionBridge(launch, projectService);
  return { instanceId: launch.instanceId, state, pi, context, bridge };
}

test("UI worker 握手、TUI session switch、prompt、stop 和 resume 维持单 writer", { timeout: 20000 }, async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-ui-worker-"));
  const agentDirectory = join(temporaryDirectory, "pi-agent");
  const managerDirectory = join(agentDirectory, "wechat-session-manager");
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "ui-demo");
  const sessionsDirectory = join(temporaryDirectory, "pi-sessions");
  await mkdir(projectPath, { recursive: true });
  await mkdir(sessionsDirectory, { recursive: true });
  const configStore = new ConfigurationStore(join(agentDirectory, "wechat-session-manager.json"));
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    projects: {
      ...config.projects,
      demo: { displayName: "UI 测试项目", path: projectPath },
    },
    wechat: {
      ...config.wechat,
      authorizedUserId: "wx-ui-route",
    },
  }));
  const projectService = new ProjectService(configStore);
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const endpoint = process.platform === "win32"
    ? createStableNamedPipe(managerDirectory)
    : join(temporaryDirectory, `ui-worker-${randomUUID()}.sock`);
  const server = new UiWorkerIpcServer(managerDirectory, registry, lease, { endpoint });
  const workers: FakeUiWorker[] = [];
  const launcher = {
    launch: async (directory: string, cwd: string, launchId: string): Promise<void> => {
      const launch = await readUiWorkerLaunchRecord(directory, launchId);
      const sessionId = launch.mode === "resume" ? launch.sessionId! : "fake-ui-session";
      const sessionFile = launch.mode === "resume"
        ? launch.sessionFile!
        : join(sessionsDirectory, `${sessionId}.jsonl`);
      if (launch.mode === "new") {
        await writeFile(sessionFile, `${JSON.stringify({ id: sessionId })}\n`, "utf8");
      }
      const worker = createFakeUiWorker(launch, cwd, sessionId, sessionFile, projectService);
      workers.push(worker);
      await worker.bridge.attach(worker.pi, worker.context);
    },
  };
  const uiManager = new UiWorkerManager({
    managerDirectory,
    projectService,
    registry,
    ipcServer: server,
    launcher,
    invocation: { command: process.execPath, args: [process.execPath] },
    extensionPath: join(process.cwd(), "extensions", "wechat-session-hub.ts"),
    registrationTimeoutMs: 5000,
    shutdownTimeoutMs: 5000,
    platform: "win32",
    probeCapability: async () => ({ supported: true, executable: "C:/WindowsApps/wt.exe" }),
  });
  const backgroundManager = new BackgroundWorkerManager({
    projectService,
    registry,
    invocation: {
      command: process.execPath,
      args: [join(process.cwd(), "tests", "fixtures", "fake-pi-session-manager.mjs")],
    },
  });
  const gatewayWorkerManager = new GatewayWorkerManager(backgroundManager, uiManager, registry);
  const queue = new DurableMessageQueue(managerDirectory, lease);
  const replies: Array<{ messageId: string; text: string }> = [];
  const router = new GatewayCommandRouter({
    configStore,
    projectService,
    workerManager: gatewayWorkerManager,
    registry,
    queue,
    lease,
    replySink: async (_routeId, messageId, text) => {
      replies.push({ messageId, text });
    },
  });

  try {
    await server.listen();
    await uiManager.startNew("demo", "Fake TUI session");
    const firstSnapshot = await registry.readSnapshot();
    const created = firstSnapshot.sessions["fake-ui-session"];
    assert.ok(created);
    const firstOwner = Object.values(firstSnapshot.instances).find((instance) =>
      instance.sessionId === created.sessionId,
    );
    assert.ok(firstOwner);
    await registry.setRoute("wx-ui-route", {
      sessionId: created.sessionId,
      workerInstanceId: firstOwner.instanceId,
      generation: 1,
      updatedAt: new Date().toISOString(),
    });
    assert.equal(created.mode, "ui");
    assert.equal(created.state, "active");
    assert.equal(replies.length, 0);
    assert.equal(await workers[0].bridge.canSwitchSession(created.sessionFile), true);
    const unregisteredSessionFile = join(sessionsDirectory, "unregistered.jsonl");
    assert.equal(await workers[0].bridge.canSwitchSession(unregisteredSessionFile), true);
    await registry.upsertInstance({
      instanceId: "orphaned-unregistered-owner",
      pid: process.pid,
      processBirthId: `${process.pid}:orphaned-owner`,
      sessionId: "orphaned-unregistered-session",
      sessionFile: unregisteredSessionFile,
      cwd: projectPath,
      projectAlias: "demo",
      mode: "ui",
      state: "idle",
      heartbeatAt: new Date().toISOString(),
    });
    assert.equal(await workers[0].bridge.canSwitchSession(unregisteredSessionFile), false);
    await registry.removeInstance("orphaned-unregistered-owner");
    const backgroundSessionId = "busy-background-session";
    const backgroundSessionFile = join(sessionsDirectory, `${backgroundSessionId}.jsonl`);
    await writeFile(backgroundSessionFile, `${JSON.stringify({ id: backgroundSessionId })}\n`, "utf8");
    const now = new Date().toISOString();
    await registry.upsertSession({
      sessionId: backgroundSessionId,
      sessionFile: backgroundSessionFile,
      cwd: projectPath,
      projectAlias: "demo",
      mode: "background",
      state: "active",
      lastActivityAt: now,
    });
    await registry.upsertInstance({
      instanceId: "busy-background-owner",
      pid: process.pid,
      processBirthId: `${process.pid}:busy-ui-test`,
      sessionId: backgroundSessionId,
      sessionFile: backgroundSessionFile,
      cwd: projectPath,
      projectAlias: "demo",
      mode: "background",
      state: "idle",
      heartbeatAt: now,
    });
    assert.equal(await workers[0].bridge.canSwitchSession(backgroundSessionFile), false);
    await registry.removeInstance("busy-background-owner");
    await registry.upsertSession({
      ...((await registry.readSnapshot()).sessions[backgroundSessionId]),
      state: "saved",
    });
    const promptResult = await router.receive({
      messageId: "ui-prompt-message",
      senderId: "wx-ui-route",
      text: "hello",
    });
    assert.equal(promptResult.state, "completed");
    assert.equal(replies[0].text, "UI fake reply: hello");

    const switchedSessionId = "fake-ui-session-switched";
    const switchedSessionFile = join(sessionsDirectory, `${switchedSessionId}.jsonl`);
    await writeFile(switchedSessionFile, `${JSON.stringify({ id: switchedSessionId })}\n`, "utf8");
    let notifyReattached!: () => void;
    const reattached = new Promise<void>((resolveReattached) => {
      notifyReattached = resolveReattached;
    });
    const onRegistered = (connection: { registration: { instanceId: string; sessionId: string } }): void => {
      if (
        connection.registration.instanceId === firstOwner.instanceId &&
        connection.registration.sessionId === switchedSessionId
      ) {
        server.off("worker_registered", onRegistered);
        notifyReattached();
      }
    };
    server.on("worker_registered", onRegistered);
    const workerState = workers[0].state;
    await workers[0].bridge.onSessionShutdown({ reason: "new" });
    workerState.sessionId = switchedSessionId;
    workerState.sessionFile = switchedSessionFile;
    workerState.sessionName = "切换后的 session";
    await workers[0].bridge.attach(workers[0].pi, workers[0].context);
    await reattached;

    const switched = await registry.readSnapshot();
    assert.equal(switched.sessions[created.sessionId].state, "saved");
    assert.equal(switched.sessions[switchedSessionId].state, "active");
    assert.equal(switched.routes["wx-ui-route"].sessionId, switchedSessionId);
    assert.equal(switched.routes["wx-ui-route"].generation, 2);
    const switchedIndex = switched.sessions[switchedSessionId].publicIndex;
    assert.ok(switchedIndex);
    const switchedPrompt = await router.receive({
      messageId: "ui-switched-prompt",
      senderId: "wx-ui-route",
      text: "after switch",
    });
    assert.equal(switchedPrompt.state, "completed");
    assert.equal(replies[1].text, "UI fake reply: after switch");

    const stopResult = await router.receive({
      messageId: "ui-stop-message",
      senderId: "wx-ui-route",
      text: `/stop ${switchedIndex}`,
    });
    assert.equal(stopResult.state, "completed");
    const stopped = await registry.readSnapshot();
    assert.equal(stopped.sessions[switchedSessionId].state, "saved");
    assert.equal(stopped.routes["wx-ui-route"], undefined);
    assert.equal(Object.values(stopped.instances).some((instance) => instance.sessionId === switchedSessionId), false);

    const resumeResult = await router.receive({
      messageId: "ui-resume-message",
      senderId: "wx-ui-route",
      text: `/resume ${switchedIndex}`,
    });
    assert.equal(resumeResult.state, "completed");
    const resumed = (await registry.readSnapshot()).sessions[switchedSessionId];
    assert.equal(resumed.sessionId, switchedSessionId);
    assert.equal(resumed.mode, "background");
    assert.equal(resumed.state, "active");
    const stopResumedResult = await router.receive({
      messageId: "ui-stop-resumed-message",
      senderId: "wx-ui-route",
      text: `/stop ${switchedIndex}`,
    });
    assert.equal(stopResumedResult.state, "completed");
    assert.equal((await registry.readSnapshot()).sessions[switchedSessionId].state, "saved");
  } finally {
    for (const worker of workers) {
      await worker.bridge.onSessionShutdown({ reason: "quit" }).catch(() => undefined);
    }
    await uiManager.detachGateway().catch(() => undefined);
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("非 Windows 平台在创建或恢复可见 UI 会话前阻塞并给出平台原因", async () => {
  const manager = createBlockingManager({ platform: "darwin" });
  const blockedError = (error: unknown): boolean =>
    error instanceof UiWorkerManagerError &&
    error.code === "unsupported_platform" &&
    /仅支持 Windows|依赖 Windows Terminal/.test(error.message);

  await assert.rejects(manager.startNew("demo"), blockedError);
  await assert.rejects(manager.resume("any-session"), blockedError);
});

test("缺少 Windows Terminal 时阻塞可见 UI 会话并在提示中说明 wt.exe 缺失", async () => {
  const manager = createBlockingManager({
    platform: "win32",
    probeCapability: async () => ({
      supported: false,
      reason: "未找到 Windows Terminal (wt.exe), 请先安装 Windows Terminal 或将其加入应用执行别名",
    }),
  });
  await assert.rejects(
    manager.startNew("demo"),
    (error: unknown) =>
      error instanceof UiWorkerManagerError &&
      error.code === "wt_not_found" &&
      /wt\.exe/.test(error.message) &&
      /background/.test(error.message),
  );
});

test("可见 UI 能力失败结果不缓存 安装 Windows Terminal 后无需重启即可恢复", async () => {
  let probeCount = 0;
  const manager = createBlockingManager({
    platform: "win32",
    probeCapability: async () => {
      probeCount += 1;
      return probeCount === 1
        ? { supported: false, reason: "未找到 Windows Terminal (wt.exe)" }
        : { supported: true, executable: "C:/WindowsApps/wt.exe" };
    },
  });
  await assert.rejects(manager.startNew("demo"), (error: unknown) =>
    error instanceof UiWorkerManagerError && error.code === "wt_not_found");
  const capability = await manager.describeUiModeCapability();
  assert.equal(capability.supported, true);
  assert.equal(probeCount, 2);
});

/**
 * 创建只验证 UI 模式前置阻塞的 UiWorkerManager。
 *
 * @param options 平台和可选能力探测器。
 * @returns 依赖被最小化替身填充的 manager。
 */
function createBlockingManager(options: {
  platform: NodeJS.Platform;
  probeCapability?: () => Promise<import("../src/gateway/windows-terminal-launcher.ts").WindowsTerminalCapability>;
}): UiWorkerManager {
  const ipcServer = {
    setHandlers: () => undefined,
    listen: async () => undefined,
  } as unknown as UiWorkerIpcServer;
  return new UiWorkerManager({
    managerDirectory: join(tmpdir(), "pi-wechat-blocking-manager"),
    projectService: {
      resolve: async () => {
        throw new Error("不应在阻塞校验通过前解析项目");
      },
    } as unknown as ProjectService,
    registry: {
      readSnapshot: async () => {
        throw new Error("不应在阻塞校验通过前读取 registry");
      },
    } as unknown as ManagerRegistry,
    ipcServer,
    invocation: { command: process.execPath, args: [process.execPath] },
    extensionPath: join(process.cwd(), "extensions", "wechat-session-hub.ts"),
    platform: options.platform,
    ...(options.probeCapability ? { probeCapability: options.probeCapability } : {}),
  });
}
