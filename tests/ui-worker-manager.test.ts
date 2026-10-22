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
import { UiWorkerManager } from "../src/runtime/ui-worker-manager.ts";

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
  });
  const backgroundManager = new BackgroundWorkerManager({
    projectService,
    registry,
    invocation: { command: process.execPath, args: [process.execPath] },
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
    const newResult = await router.receive({
      messageId: "ui-create-message",
      senderId: "wx-ui-route",
      text: "/new --mode ui --project demo --name \"Fake TUI session\"",
    });
    assert.equal(newResult.state, "completed");
    assert.equal(newResult.duplicate, false);
    const firstSnapshot = await registry.readSnapshot();
    const route = firstSnapshot.routes["wx-ui-route"];
    assert.ok(route);
    const created = firstSnapshot.sessions[route.sessionId];
    assert.equal(created.mode, "ui");
    assert.equal(created.sessionId, "fake-ui-session");
    assert.equal(created.state, "active");
    const firstOwner = firstSnapshot.instances[route.workerInstanceId];
    assert.ok(firstOwner);
    assert.match(replies[0].text, /可见 UI Pi session 已创建/);
    assert.equal(await workers[0].bridge.canSwitchSession(created.sessionFile), true);
    assert.equal(
      await workers[0].bridge.canSwitchSession(join(sessionsDirectory, "unregistered.jsonl")),
      false,
    );
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
    assert.equal(replies[1].text, "UI fake reply: hello");

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
    const switchedPrompt = await router.receive({
      messageId: "ui-switched-prompt",
      senderId: "wx-ui-route",
      text: "after switch",
    });
    assert.equal(switchedPrompt.state, "completed");
    assert.equal(replies[2].text, "UI fake reply: after switch");

    const stopResult = await router.receive({
      messageId: "ui-stop-message",
      senderId: "wx-ui-route",
      text: `/stop ${switchedSessionId}`,
    });
    assert.equal(stopResult.state, "completed");
    const stopped = await registry.readSnapshot();
    assert.equal(stopped.sessions[switchedSessionId].state, "saved");
    assert.equal(stopped.routes["wx-ui-route"], undefined);
    assert.equal(Object.values(stopped.instances).some((instance) => instance.sessionId === switchedSessionId), false);

    const resumeResult = await router.receive({
      messageId: "ui-resume-message",
      senderId: "wx-ui-route",
      text: `/resume ${switchedSessionId} --mode ui`,
    });
    assert.equal(resumeResult.state, "completed");
    const resumed = (await registry.readSnapshot()).sessions[switchedSessionId];
    assert.equal(resumed.sessionId, switchedSessionId);
    assert.equal(resumed.mode, "ui");
    assert.equal(resumed.state, "active");
    const stopResumedResult = await router.receive({
      messageId: "ui-stop-resumed-message",
      senderId: "wx-ui-route",
      text: `/stop ${switchedSessionId}`,
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
