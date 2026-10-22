import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigurationStore } from "../src/config/store.ts";
import { GatewayRuntime, GatewayRuntimeError } from "../src/gateway/gateway-runtime.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UiWorkerExtensionBridge } from "../src/gateway/ui-worker-extension-bridge.ts";
import { createStableNamedPipe, readUiWorkerLaunchRecord } from "../src/gateway/ui-worker-ipc.ts";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import { ManagerRegistry } from "../src/registry/manager-registry.ts";
import type { SessionIndexRecord, WorkerInstanceRecord } from "../src/registry/types.ts";
import { ProjectService } from "../src/projects/project-service.ts";
import type { PiCliInvocation } from "../src/runtime/pi-cli.ts";

const AUTHORIZED_USER_ID = "wx-runtime-test-user";

interface RuntimeFixture {
  root: string;
  managerDirectory: string;
  configStore: ConfigurationStore;
  projectService: ProjectService;
}

/**
 * 创建带有 fake iLink credentials 的隔离 Gateway runtime 测试目录。
 *
 * @returns 目录、配置存储和项目服务。
 */
async function createRuntimeFixture(): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-wechat-runtime-"));
  const agentDirectory = join(root, "pi-agent");
  const managerDirectory = join(agentDirectory, "wechat-session-manager");
  await mkdir(managerDirectory, { recursive: true, mode: 0o700 });
  const configStore = new ConfigurationStore(join(agentDirectory, "wechat-session-manager.json"));
  const projectRoot = join(root, "projects");
  const projectPath = join(projectRoot, "demo");
  await mkdir(projectPath, { recursive: true });
  await configStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
    projects: {
      ...config.projects,
      demo: { displayName: "测试项目", path: projectPath },
    },
    defaultProject: "demo",
    wechat: {
      ...config.wechat,
      authorizedUserId: AUTHORIZED_USER_ID,
    },
  }));
  await writeFile(
    join(managerDirectory, "credentials.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      authorizedUserId: AUTHORIZED_USER_ID,
      token: "fake-runtime-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    root,
    managerDirectory,
    configStore,
    projectService: new ProjectService(configStore),
  };
}

function createFakeUiBridge(
  launch: Awaited<ReturnType<typeof readUiWorkerLaunchRecord>>,
  projectService: ProjectService,
): { bridge: UiWorkerExtensionBridge; pi: ExtensionAPI; context: ExtensionContext } {
  const state = {
    sessionId: launch.sessionId ?? "fake-runtime-ui-session",
    sessionFile: launch.sessionFile ?? join(launch.projectPath, "fake-runtime-ui-session.jsonl"),
    cwd: launch.projectPath,
    name: launch.sessionName,
    idle: true,
  };
  let bridge: UiWorkerExtensionBridge;
  const pi = {
    setSessionName: (name: string) => {
      state.name = name;
    },
    sendUserMessage: (content: string) => {
      setImmediate(() => {
        state.idle = false;
        bridge.onAgentStart();
        bridge.onMessageEnd({ message: { role: "user", content: [{ type: "text", text: content }] } });
        bridge.onMessageEnd({ message: { role: "assistant", content: [{ type: "text", text: `UI reply: ${content}` }] } });
        state.idle = true;
        bridge.onAgentSettled();
      });
    },
  } as unknown as ExtensionAPI;
  const context = {
    mode: "tui",
    cwd: state.cwd,
    sessionManager: {
      getSessionId: () => state.sessionId,
      getSessionFile: () => state.sessionFile,
      getCwd: () => state.cwd,
      getSessionName: () => state.name,
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
  return { bridge, pi, context };
}

function runtimeOptions(
  fixture: RuntimeFixture,
  fetcher: typeof fetch,
  invocation: PiCliInvocation = { command: process.execPath, args: [] },
  extra: Partial<Pick<Parameters<typeof GatewayRuntime.start>[0], "uiWorkerLauncher" | "uiIpcEndpoint" | "uiPlatform">> = {},
) {
  return {
    dataDirectory: fixture.managerDirectory,
    configStore: fixture.configStore,
    projectService: fixture.projectService,
    invocation,
    fetcher,
    credentialStoreOptions: {
      platform: "win32" as NodeJS.Platform,
      verifyWindowsAcl: async () => undefined,
    },
    ...extra,
  };
}

test("Gateway runtime 启停 poller, 持久化状态并释放 lease", async () => {
  const fixture = await createRuntimeFixture();
  let notifyPollStarted!: () => void;
  const pollStarted = new Promise<void>((resolveStarted) => {
    notifyPollStarted = resolveStarted;
  });
  const fetcher: typeof fetch = async (_input, init) => {
    notifyPollStarted();
    const signal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolveResponse, rejectResponse) => {
      const rejectOnAbort = (): void => rejectResponse(new DOMException("已取消", "AbortError"));
      if (signal.aborted) {
        rejectOnAbort();
        return;
      }
      signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
  };

  try {
    const runtime = await GatewayRuntime.start(runtimeOptions(fixture, fetcher));
    await pollStarted;
    assert.equal(runtime.status, "online");
    await runtime.stop();
    assert.equal(runtime.status, "stopped");
    await assert.rejects(readFile(join(fixture.managerDirectory, "manager.lock")), { code: "ENOENT" });
    await assert.rejects(readFile(join(fixture.managerDirectory, "gateway.json")), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Gateway runtime 恢复已保存 route 到同一 Pi session 并更新 owner generation", async () => {
  const fixture = await createRuntimeFixture();
  const sessionDirectory = join(fixture.root, "sessions");
  const sessionFile = join(sessionDirectory, "saved-session.jsonl");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify({ id: "saved-runtime-session", name: "恢复测试" })}\n`, "utf8");
  const lease = await GatewayLease.acquire(fixture.managerDirectory);
  const registry = new ManagerRegistry(fixture.managerDirectory, lease);
  const now = new Date().toISOString();
  await registry.upsertSession({
    sessionId: "saved-runtime-session",
    sessionFile,
    cwd: join(fixture.root, "projects", "demo"),
    projectAlias: "demo",
    name: "恢复测试",
    mode: "background",
    state: "saved",
    lastActivityAt: now,
  });
  await registry.setRoute("wx-saved-route", {
    sessionId: "saved-runtime-session",
    workerInstanceId: "previous-instance",
    generation: 4,
    updatedAt: now,
  });
  await lease.release();

  const fakeCli = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi-session-manager.mjs");
  let notifyPollStarted!: () => void;
  const pollStarted = new Promise<void>((resolveStarted) => {
    notifyPollStarted = resolveStarted;
  });
  const fetcher: typeof fetch = async (_input, init) => {
    notifyPollStarted();
    const signal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolveResponse, rejectResponse) => {
      const rejectOnAbort = (): void => rejectResponse(new DOMException("已取消", "AbortError"));
      if (signal.aborted) {
        rejectOnAbort();
        return;
      }
      signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
  };
  let runtime: GatewayRuntime | undefined;

  try {
    runtime = await GatewayRuntime.start(runtimeOptions(fixture, fetcher, {
      command: process.execPath,
      args: [fakeCli],
    }));
    await pollStarted;
    const recovered = await registry.readSnapshot();
    const owner = Object.values(recovered.instances).find((instance) =>
      instance.sessionId === "saved-runtime-session",
    );
    assert.ok(owner);
    assert.equal(recovered.sessions["saved-runtime-session"].state, "active");
    assert.equal(recovered.routes["wx-saved-route"].workerInstanceId, owner.instanceId);
    assert.equal(recovered.routes["wx-saved-route"].generation, 5);

    await runtime.stop();
    const stopped = await registry.readSnapshot();
    assert.equal(stopped.instances[owner.instanceId], undefined);
    assert.equal(stopped.sessions["saved-runtime-session"].state, "saved");
  } finally {
    await runtime?.stop().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Gateway runtime 恢复 saved UI route 并更新 owner generation", { timeout: 15000 }, async () => {
  const fixture = await createRuntimeFixture();
  const sessionId = "saved-ui-runtime-session";
  const sessionDirectory = join(fixture.root, "ui-sessions");
  const sessionFile = join(sessionDirectory, `${sessionId}.jsonl`);
  const projectPath = join(fixture.root, "projects", "demo");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify({ id: sessionId, name: "已保存 UI" })}\n`, "utf8");
  const priorLease = await GatewayLease.acquire(fixture.managerDirectory);
  const registry = new ManagerRegistry(fixture.managerDirectory, priorLease);
  const now = new Date().toISOString();
  await registry.upsertSession({
    sessionId,
    sessionFile,
    cwd: projectPath,
    projectAlias: "demo",
    name: "已保存 UI",
    mode: "ui",
    state: "saved",
    lastActivityAt: now,
  });
  await registry.setRoute(AUTHORIZED_USER_ID, {
    sessionId,
    workerInstanceId: "previous-ui-owner",
    generation: 7,
    updatedAt: now,
  });
  await priorLease.release();

  const uiEndpoint = process.platform === "win32"
    ? createStableNamedPipe(fixture.managerDirectory)
    : join(fixture.root, "gateway-ui-runtime.sock");
  let resolvePollStarted!: () => void;
  const pollStarted = new Promise<void>((resolveStarted) => {
    resolvePollStarted = resolveStarted;
  });
  const sentUiMessages: Array<{
    context_token: string;
    to_user_id: string;
    item_list: Array<{ text_item: { text: string } }>;
  }> = [];
  let resolveUiReply!: () => void;
  const uiReplySent = new Promise<void>((resolveSent) => {
    resolveUiReply = resolveSent;
  });
  let updateBatchReturned = false;
  const typingStatuses: number[] = [];
  let resolveTypingCancelled!: () => void;
  const typingCancelled = new Promise<void>((resolveCancelled) => {
    resolveTypingCancelled = resolveCancelled;
  });
  const fetcher: typeof fetch = async (input, init) => {
    const requestUrl = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (requestUrl.endsWith("/getconfig")) {
      return new Response(JSON.stringify({ ret: 0, typing_ticket: "fake-typing-ticket" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (requestUrl.endsWith("/sendtyping")) {
      const status = body.status;
      if (status === 1 || status === 2) {
        typingStatuses.push(status);
      }
      if (status === 2) {
        resolveTypingCancelled();
      }
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (requestUrl.endsWith("/sendmessage")) {
      const message = (body as {
        msg: {
          context_token: string;
          to_user_id: string;
          item_list: Array<{ text_item: { text: string } }>;
        };
      }).msg;
      sentUiMessages.push(message);
      resolveUiReply();
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    resolvePollStarted();
    if (!updateBatchReturned && body.get_updates_buf === "") {
      updateBatchReturned = true;
      return new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: "ui-runtime-cursor",
        msgs: [{
          message_id: 501,
          from_user_id: AUTHORIZED_USER_ID,
          context_token: "ui-runtime-reply-context",
          message_type: 1,
          item_list: [{ type: 1, text_item: { text: "从微信发到可见 Pi TUI" } }],
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const signal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolveResponse, rejectResponse) => {
      const rejectOnAbort = (): void => rejectResponse(new DOMException("已取消", "AbortError"));
      if (signal.aborted) {
        rejectOnAbort();
        return;
      }
      signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
  };
  const bridges: UiWorkerExtensionBridge[] = [];
  const uiWorkerLauncher = {
    launch: async (managerDirectory: string, _cwd: string, launchId: string): Promise<void> => {
      const launch = await readUiWorkerLaunchRecord(managerDirectory, launchId);
      const bridge = createFakeUiBridge(launch, fixture.projectService);
      bridges.push(bridge.bridge);
      await bridge.bridge.attach(bridge.pi, bridge.context);
    },
  };
  let runtime: GatewayRuntime | undefined;

  try {
    runtime = await GatewayRuntime.start(runtimeOptions(
      fixture,
      fetcher,
      { command: process.execPath, args: [process.execPath] },
      {
        uiPlatform: "win32",
        uiIpcEndpoint: uiEndpoint,
        uiWorkerLauncher,
      },
    ));
    await pollStarted;
    await uiReplySent;
    await typingCancelled;
    assert.deepEqual(typingStatuses, [1, 2]);
    assert.equal(sentUiMessages.length, 1);
    assert.equal(sentUiMessages[0].context_token, "ui-runtime-reply-context");
    assert.equal(sentUiMessages[0].to_user_id, AUTHORIZED_USER_ID);
    assert.match(sentUiMessages[0].item_list[0].text_item.text, /UI reply: 从微信发到可见 Pi TUI/);
    const recovered = await registry.readSnapshot();
    const route = recovered.routes[AUTHORIZED_USER_ID];
    const owner = route ? recovered.instances[route.workerInstanceId] : undefined;
    assert.ok(owner);
    assert.equal(owner.mode, "ui");
    assert.equal(route.sessionId, sessionId);
    assert.equal(route.generation, 8);
    assert.equal(recovered.sessions[sessionId].state, "active");

    await runtime.stop();
    runtime = undefined;
    const detached = await registry.readSnapshot();
    assert.equal(detached.instances[owner.instanceId].state, "idle");
    assert.equal(detached.routes[AUTHORIZED_USER_ID].sessionId, sessionId);

    runtime = await GatewayRuntime.start(runtimeOptions(
      fixture,
      fetcher,
      { command: process.execPath, args: [process.execPath] },
      {
        uiPlatform: "win32",
        uiIpcEndpoint: uiEndpoint,
        uiWorkerLauncher,
      },
    ));
    await pollStarted;
    const reattached = await registry.readSnapshot();
    assert.equal(reattached.instances[owner.instanceId].pid, owner.pid);
    assert.equal(reattached.instances[owner.instanceId].mode, "ui");
    assert.equal(reattached.routes[AUTHORIZED_USER_ID].generation, 8);
    await runtime.stop();
    runtime = undefined;
  } finally {
    await runtime?.stop().catch(() => undefined);
    for (const bridge of bridges) {
      await bridge.onSessionShutdown({ reason: "quit" }).catch(() => undefined);
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Gateway runtime 通过 fake iLink 端到端路由并按入站 context 回复", { timeout: 15000 }, async () => {
  const fixture = await createRuntimeFixture();
  const fakeCli = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi-session-manager.mjs");
  const sentMessages: Array<{
    context_token: string;
    to_user_id: string;
    item_list: Array<{ text_item: { text: string } }>;
  }> = [];
  let resolveReplies!: () => void;
  const repliesSent = new Promise<void>((resolveSent) => {
    resolveReplies = resolveSent;
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith("/getconfig")) {
      return new Response(JSON.stringify({ ret: 0, typing_ticket: "fake-background-typing-ticket" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/sendtyping")) {
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/sendmessage")) {
      const message = (body as {
        msg: {
          context_token: string;
          to_user_id: string;
          item_list: Array<{ text_item: { text: string } }>;
        };
      }).msg;
      sentMessages.push(message);
      if (sentMessages.length === 2) {
        resolveReplies();
      }
      return new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (body.get_updates_buf === "") {
      return new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: "runtime-e2e-cursor",
        msgs: [
          {
            message_id: 100,
            from_user_id: AUTHORIZED_USER_ID,
            context_token: "runtime-context-new",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "/new --project demo --name E2E" } }],
          },
          {
            message_id: 101,
            from_user_id: AUTHORIZED_USER_ID,
            context_token: "runtime-context-prompt",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "请检查 E2E 路由" } }],
          },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const signal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolveResponse, rejectResponse) => {
      const rejectOnAbort = (): void => rejectResponse(new DOMException("已取消", "AbortError"));
      if (signal.aborted) {
        rejectOnAbort();
        return;
      }
      signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
  };
  let runtime: GatewayRuntime | undefined;

  try {
    runtime = await GatewayRuntime.start(runtimeOptions(fixture, fetcher, {
      command: process.execPath,
      args: [fakeCli],
    }));
    await repliesSent;
    assert.equal(sentMessages.length, 2);
    assert.equal(sentMessages[0].context_token, "runtime-context-new");
    assert.match(sentMessages[0].item_list[0].text_item.text, /后台 Pi session 已创建/);
    assert.equal(sentMessages[1].context_token, "runtime-context-prompt");
    assert.match(sentMessages[1].item_list[0].text_item.text, /测试回复: 请检查 E2E 路由/);
    assert.ok(sentMessages.every((message) => message.to_user_id === AUTHORIZED_USER_ID));

    await runtime.stop();
    runtime = undefined;
    const routes = JSON.parse(await readFile(join(fixture.managerDirectory, "routes.json"), "utf8")) as Record<string, {
      sessionId: string;
      workerInstanceId: string;
    }>;
    const sessions = JSON.parse(await readFile(join(fixture.managerDirectory, "session-index.json"), "utf8")) as Record<string, {
      state: string;
    }>;
    assert.ok(routes[AUTHORIZED_USER_ID]);
    assert.equal(sessions[routes[AUTHORIZED_USER_ID].sessionId].state, "saved");
    const queueDirectory = join(fixture.managerDirectory, "queue");
    const queueContents = await Promise.all((await readdir(queueDirectory)).map((fileName) =>
      readFile(join(queueDirectory, fileName), "utf8"),
    ));
    assert.equal(queueContents.join("\n").includes("runtime-context-"), false);
    assert.equal((await readFile(join(fixture.managerDirectory, "events.jsonl"), "utf8"))
      .includes("runtime-context-"), false);
  } finally {
    await runtime?.stop().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Gateway runtime 拒绝活跃旧 worker 且不清除 owner/route 记录", async () => {
  const fixture = await createRuntimeFixture();
  const lease = await GatewayLease.acquire(fixture.managerDirectory);
  const registry = new ManagerRegistry(fixture.managerDirectory, lease);
  const sessionFile = join(fixture.root, "live-session.jsonl");
  await writeFile(sessionFile, "{}\n", "utf8");
  const now = new Date().toISOString();
  const instance: WorkerInstanceRecord = {
    instanceId: "live-worker",
    pid: process.pid,
    processBirthId: `${process.pid}:still-alive`,
    sessionId: "live-session",
    sessionFile,
    cwd: fixture.root,
    projectAlias: "demo",
    mode: "background",
    state: "idle",
    heartbeatAt: now,
  };
  const session: SessionIndexRecord = {
    sessionId: instance.sessionId,
    sessionFile,
    cwd: fixture.root,
    projectAlias: "demo",
    mode: "background",
    state: "active",
    lastActivityAt: now,
  };
  await registry.upsertInstance(instance);
  await registry.upsertSession(session);
  await registry.setRoute("wechat-user-route", {
    sessionId: session.sessionId,
    workerInstanceId: instance.instanceId,
    generation: 3,
    updatedAt: now,
  });
  await lease.release();

  let networkTouched = false;
  try {
    await assert.rejects(
      GatewayRuntime.start(runtimeOptions(fixture, async () => {
        networkTouched = true;
        return new Response("{}", { status: 200 });
      })),
      (error: unknown) => error instanceof GatewayRuntimeError && error.code === "live_worker_detected",
    );
    assert.equal(networkTouched, false);

    const verifyLease = await GatewayLease.acquire(fixture.managerDirectory);
    const unchanged = await new ManagerRegistry(fixture.managerDirectory, verifyLease).readSnapshot();
    assert.equal(unchanged.instances[instance.instanceId].pid, process.pid);
    assert.equal(unchanged.routes["wechat-user-route"].generation, 3);
    await verifyLease.release();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Gateway runtime 在授权凭证不匹配时不联网并释放 lease", async () => {
  const fixture = await createRuntimeFixture();
  await writeFile(
    join(fixture.managerDirectory, "credentials.json"),
    JSON.stringify({
      schemaVersion: 1,
      authorizedUserId: "another-user",
      token: "fake-runtime-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  let networkTouched = false;

  try {
    await assert.rejects(
      GatewayRuntime.start(runtimeOptions(fixture, async () => {
        networkTouched = true;
        return new Response("{}", { status: 200 });
      })),
      (error: unknown) => error instanceof Error && error.name === "IlinkCredentialStoreError",
    );
    assert.equal(networkTouched, false);
    await assert.rejects(readFile(join(fixture.managerDirectory, "manager.lock")), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
