import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayControlServer } from "../src/gateway/gateway-control-ipc.ts";
import { GatewayServiceController, launchDetachedGatewayDaemon } from "../src/runtime/gateway-service-controller.ts";
import { GatewayLease } from "../src/registry/gateway-lease.ts";

/**
 * 创建独立临时 manager 目录。
 *
 * @returns 临时目录绝对路径。
 */
async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-wechat-service-controller-"));
}

test("detached daemon 在授权未完成时通过启动 IPC fail-closed", { timeout: 15000 }, async () => {
  const directory = await createTemporaryDirectory();
  const packageDirectory = process.cwd();
  await assert.rejects(
    launchDetachedGatewayDaemon({
      managerDirectory: join(directory, "agent", "wechat-session-manager"),
      extensionPath: join(packageDirectory, "extensions", "wechat-session-hub.ts"),
      daemonEntry: join(packageDirectory, "src", "runtime", "gateway-daemon.ts"),
      piInvocation: { command: process.execPath, args: [join(packageDirectory, "fake-pi.js")] },
    }),
    /尚未具备有效微信授权/,
  );
  await rm(directory, { recursive: true, force: true });
});

test("后台服务已运行时 start 不会再启动第二个 daemon", async () => {
  const directory = await createTemporaryDirectory();
  const lease = await GatewayLease.acquire(directory);
  const server = new GatewayControlServer(directory, lease, {
    handleAction: async () => ({ state: "online" }),
  });
  let launches = 0;
  try {
    await server.listen();
    const controller = new GatewayServiceController(directory, {
      managerDirectory: directory,
      extensionPath: join(directory, "extension.ts"),
      daemonEntry: join(directory, "daemon.ts"),
      piInvocation: { command: process.execPath, args: ["pi.js"] },
    }, {
      launchDaemon: async () => {
        launches += 1;
      },
    });
    const result = await controller.start();
    assert.equal(result.state, "online");
    assert.equal(launches, 0);
  } finally {
    await server.close();
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway 离线时 start 只启动一次并等待控制通道 ready", async () => {
  const directory = await createTemporaryDirectory();
  let lease: GatewayLease | undefined;
  let server: GatewayControlServer | undefined;
  let launches = 0;
  try {
    const controller = new GatewayServiceController(directory, {
      managerDirectory: directory,
      extensionPath: join(directory, "extension.ts"),
      daemonEntry: join(directory, "daemon.ts"),
      piInvocation: { command: process.execPath, args: ["pi.js"] },
    }, {
      launchDaemon: async () => {
        launches += 1;
        lease = await GatewayLease.acquire(directory);
        server = new GatewayControlServer(directory, lease, {
          handleAction: async (action) => ({ state: action === "stop" ? "stopping" : "online" }),
        });
        await server.listen();
      },
    });
    const result = await controller.start();
    assert.equal(result.state, "online");
    assert.equal(launches, 1);
  } finally {
    await server?.close();
    await lease?.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop 和 restart 通过共享 Gateway 控制通道转发", async () => {
  const directory = await createTemporaryDirectory();
  const lease = await GatewayLease.acquire(directory);
  const server = new GatewayControlServer(directory, lease, {
    handleAction: async (action) => ({ action, state: action === "stop" ? "stopping" : "starting" }),
  });
  try {
    await server.listen();
    const controller = new GatewayServiceController(directory, {
      managerDirectory: directory,
      extensionPath: join(directory, "extension.ts"),
      daemonEntry: join(directory, "daemon.ts"),
      piInvocation: { command: process.execPath, args: ["pi.js"] },
    });
    assert.deepEqual(await controller.stop(), { action: "stop", state: "stopping" });
    assert.deepEqual(await controller.restart(), { action: "restart", state: "starting" });
  } finally {
    await server.close();
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});
