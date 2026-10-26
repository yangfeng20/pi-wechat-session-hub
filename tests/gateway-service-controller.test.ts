import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayControlServer } from "../src/gateway/gateway-control-ipc.ts";
import { GatewayServiceController, launchDetachedGatewayDaemon } from "../src/runtime/gateway-service-controller.ts";
import {
  completePendingGatewayLifecycleOperations,
  watchGatewayLifecycleOperation,
  writeGatewayLifecycleOperationReceipt,
} from "../src/runtime/gateway-lifecycle-operation.ts";
import { GatewayLease } from "../src/registry/gateway-lease.ts";

/**
 * 创建独立临时 manager 目录。
 *
 * @returns 临时目录绝对路径。
 */
async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-wechat-service-controller-"));
}

test("Gateway ready 事件完成 pending 重启通知, watcher 不轮询", async () => {
  const directory = await createTemporaryDirectory();
  const operationId = randomUUID();
  const watcher = await watchGatewayLifecycleOperation(directory, operationId);
  let completion: ReturnType<typeof watcher.wait> | undefined;

  try {
    await writeGatewayLifecycleOperationReceipt(directory, {
      action: "restart",
      operationId,
      state: "pending",
    });
    completion = watcher.wait(5000);
    await completePendingGatewayLifecycleOperations(directory, { state: "online", pid: process.pid });
    const receipt = await completion;
    assert.equal(receipt.operationId, operationId);
    assert.equal(receipt.state, "completed");
    assert.ok(receipt.serviceStatus);
    assert.equal(receipt.serviceStatus.state, "online");
  } finally {
    watcher.close();
    await completion?.catch(() => undefined);
    await watcher.removeReceipt();
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("stop 和 restart 等待 Gateway 返回生命周期终态", { timeout: 15000 }, async () => {
  const directory = await createTemporaryDirectory();
  const lease = await GatewayLease.acquire(directory);
  let notifyRestartStarted!: () => void;
  let finishRestart!: () => void;
  const restartStarted = new Promise<void>((resolveStarted) => {
    notifyRestartStarted = resolveStarted;
  });
  const restartGate = new Promise<void>((resolveRestart) => {
    finishRestart = resolveRestart;
  });
  let server!: GatewayControlServer;
  server = new GatewayControlServer(directory, lease, {
    handleAction: async (action, operationId) => {
      if (action === "restart") {
        notifyRestartStarted();
        return { state: "stopping", operationId };
      }
      return { state: action === "stop" ? "offline" : "online" };
    },
    afterActionResponse: async (action, operationId) => {
      if (action === "restart" && operationId) {
        await restartGate;
        await writeGatewayLifecycleOperationReceipt(directory, {
          action: "restart",
          operationId,
          state: "completed",
          serviceStatus: { state: "online" },
        });
      }
      if (action === "stop") {
        await server.close();
      }
    },
  });
  try {
    await server.listen();
    const controller = new GatewayServiceController(directory, {
      managerDirectory: directory,
      extensionPath: join(directory, "extension.ts"),
      daemonEntry: join(directory, "daemon.ts"),
      piInvocation: { command: process.execPath, args: ["pi.js"] },
    });
    let restartFinished = false;
    const restartTask = controller.restart().then((status) => {
      restartFinished = true;
      return status;
    });
    await restartStarted;
    assert.equal(restartFinished, false);
    finishRestart();
    assert.deepEqual(await restartTask, { state: "online" });
    assert.deepEqual(await controller.stop(), { state: "offline" });
    assert.equal((await controller.status()).state, "offline");
  } finally {
    await server.close();
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});
