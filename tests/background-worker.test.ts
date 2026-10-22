import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigurationStore } from "../src/config/store.ts";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import { ManagerRegistry } from "../src/registry/manager-registry.ts";
import { ProjectService } from "../src/projects/project-service.ts";
import {
  BackgroundWorkerManager,
  BackgroundWorkerManagerError,
} from "../src/runtime/background-worker-manager.ts";
import type { PiCliInvocation } from "../src/runtime/pi-cli.ts";

/**
 * 创建 Pi CLI 调用描述, 指向当前 matrix 安装的 npm 包版本。
 *
 * @returns 当前 Pi package 的 Node CLI 调用参数。
 */
async function resolveLocalPiInvocation(): Promise<PiCliInvocation> {
  const packageDirectory = join(
    process.cwd(),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const packageManifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  ) as { bin?: { pi?: string } };
  const cliEntry = packageManifest.bin?.pi;
  if (typeof cliEntry !== "string") {
    throw new Error("Pi package 未声明 CLI 入口。");
  }
  return {
    command: process.execPath,
    args: [join(packageDirectory, cliEntry)],
  };
}

test("后台 worker 创建、复用和停止原生 session, 空 session 不伪装成可恢复历史", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-worker-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  const configPath = join(temporaryDirectory, "manager.json");
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const sessionDirectory = join(temporaryDirectory, "pi-sessions");
  const agentDirectory = join(temporaryDirectory, "pi-agent");
  await mkdir(projectPath, { recursive: true });

  const configurationStore = new ConfigurationStore(configPath);
  await configurationStore.update((config) => ({
    ...config,
    allowedProjectRoots: [projectRoot],
  }));
  const projectService = new ProjectService(configurationStore);
  await projectService.add("demo", "测试项目", projectPath);
  const lease = await GatewayLease.acquire(managerDirectory);
  const registry = new ManagerRegistry(managerDirectory, lease);
  const invocation = await resolveLocalPiInvocation();
  const workerManager = new BackgroundWorkerManager({
    projectService,
    registry,
    invocation,
    maxBackgroundWorkers: 2,
    sessionDirectory,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
    disableDiscoveredResources: true,
  });

  let sessionId: string | undefined;
  try {
    const created = await workerManager.startNew("demo", "兼容性测试 session");
    sessionId = created.sessionId;
    assert.ok(sessionId);
    assert.equal(created.state, "pending");
    assert.equal(created.projectAlias, "demo");
    await assert.rejects(stat(created.sessionFile), { code: "ENOENT" });

    const reused = await workerManager.resume(sessionId);
    assert.equal(reused.sessionId, sessionId);
    assert.equal(Object.keys((await registry.readSnapshot()).instances).length, 1);

    await workerManager.stop(sessionId);
    const saved = await registry.readSnapshot();
    assert.equal(saved.sessions[sessionId].state, "pending");
    assert.equal(Object.keys(saved.instances).length, 0);
    await assert.rejects(
      workerManager.resume(sessionId),
      (error: unknown) => error instanceof BackgroundWorkerManagerError && error.code === "session_not_saved",
    );
  } finally {
    if (sessionId) {
      await workerManager.stop(sessionId).catch(() => undefined);
    }
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
