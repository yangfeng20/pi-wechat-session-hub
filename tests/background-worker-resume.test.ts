import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigurationStore } from "../src/config/store.ts";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import { ManagerRegistry } from "../src/registry/manager-registry.ts";
import { ProjectService } from "../src/projects/project-service.ts";
import { BackgroundWorkerManager } from "../src/runtime/background-worker-manager.ts";

test("持久化后的后台 session 可通过 Pi RPC 恢复到同一 sessionId", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-resume-"));
  const projectRoot = join(temporaryDirectory, "projects");
  const projectPath = join(projectRoot, "demo");
  const configPath = join(temporaryDirectory, "manager.json");
  const managerDirectory = join(temporaryDirectory, "manager-data");
  const sessionDirectory = join(temporaryDirectory, "pi-sessions");
  const fakeCli = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi-session-manager.mjs");
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
  const workerManager = new BackgroundWorkerManager({
    projectService,
    registry,
    invocation: {
      command: process.execPath,
      args: [fakeCli],
    },
    maxBackgroundWorkers: 2,
    sessionDirectory,
    disableDiscoveredResources: true,
  });

  let sessionId: string | undefined;
  try {
    const pending = await workerManager.startNew("demo", "可恢复 session");
    sessionId = pending.sessionId;
    assert.equal(pending.state, "pending");
    assert.equal(await workerManager.prompt(sessionId, "写入 transcript"), "测试回复: 写入 transcript");
    assert.equal((await stat(pending.sessionFile)).isFile(), true);
    assert.equal((await registry.readSnapshot()).sessions[sessionId].state, "active");

    await workerManager.stop(sessionId);
    assert.equal((await registry.readSnapshot()).sessions[sessionId].state, "saved");
    await projectService.remove("demo");

    const resumed = await workerManager.resume(sessionId);
    assert.equal(resumed.sessionId, sessionId);
    assert.equal(resumed.sessionFile, pending.sessionFile);
    assert.equal((await registry.readSnapshot()).sessions[sessionId].state, "active");
    await workerManager.stop(sessionId);
    assert.equal((await registry.readSnapshot()).sessions[sessionId].state, "saved");

    const transcript = await readFile(pending.sessionFile, "utf8");
    assert.ok(transcript.includes(sessionId));
  } finally {
    if (sessionId) {
      await workerManager.stop(sessionId).catch(() => undefined);
    }
    await lease.release();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
