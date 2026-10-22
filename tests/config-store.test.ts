import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultConfiguration } from "../src/config/defaults.ts";
import { ConfigurationBusyError, ConfigurationStore } from "../src/config/store.ts";
import { validateConfiguration, ConfigurationValidationError } from "../src/config/validation.ts";

/**
 * 创建隔离的临时配置目录。
 *
 * @returns 临时目录绝对路径。
 */
async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-wechat-session-hub-"));
}

test("配置文件不存在时返回默认配置且不落盘", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const configPath = join(temporaryDirectory, "manager.json");
    const store = new ConfigurationStore(configPath);
    const snapshot = await store.load();

    assert.equal(snapshot.exists, false);
    assert.deepEqual(snapshot.config.projects, {});
    assert.deepEqual(snapshot.config.allowedProjectRoots, []);
    assert.equal(snapshot.config.autoStartOnWindowsLogon, false);
    await assert.rejects(readFile(configPath), { code: "ENOENT" });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("配置写入后可重新读取并保留未知字段", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const configPath = join(temporaryDirectory, "manager.json");
    const store = new ConfigurationStore(configPath);
    const config = createDefaultConfiguration(join(temporaryDirectory, "secret", "credentials.json"));
    const extendedConfiguration = {
      ...config,
      futureFeature: { enabled: true },
      wechat: {
        ...config.wechat,
        futureField: "preserved",
      },
    };

    await store.save(extendedConfiguration);
    const snapshot = await store.load();

    assert.equal(snapshot.exists, true);
    assert.deepEqual(snapshot.config.futureFeature, { enabled: true });
    assert.equal(snapshot.config.wechat.futureField, "preserved");
    const fileContents = await readFile(configPath, "utf8");
    assert.ok(fileContents.endsWith("\n"));
    assert.equal(fileContents.includes("credentials"), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("同一配置存储的并发更新按序合并", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const store = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
    const initial = createDefaultConfiguration(join(temporaryDirectory, "credentials.json"));
    await store.save(initial);

    await Promise.all([
      store.update((current) => ({ ...current, markerA: "a" })),
      store.update((current) => ({ ...current, markerB: "b" })),
    ]);

    const { config } = await store.load();
    assert.equal(config.markerA, "a");
    assert.equal(config.markerB, "b");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("活动配置锁会阻止写入, 不强行覆盖锁文件", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const configPath = join(temporaryDirectory, "manager.json");
    const lockPath = `${configPath}.lock`;
    const store = new ConfigurationStore(configPath);
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "external-owner" }));

    await assert.rejects(
      store.save(createDefaultConfiguration(join(temporaryDirectory, "credentials.json"))),
      ConfigurationBusyError,
    );
    assert.equal(await readFile(lockPath, "utf8"), JSON.stringify({ pid: process.pid, token: "external-owner" }));
    await assert.rejects(readFile(configPath), { code: "ENOENT" });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
test("拒绝未知 schema 版本和不安全的配置值", () => {
  assert.throws(
    () => validateConfiguration({ schemaVersion: 2 }),
    ConfigurationValidationError,
  );
  assert.throws(
    () => validateConfiguration({ schemaVersion: 1, autoStartOnWindowsLogon: "true" }),
    ConfigurationValidationError,
  );
  assert.throws(
    () => validateConfiguration({ allowedProjectRoots: ["relative/path"] }),
    ConfigurationValidationError,
  );
  assert.throws(
    () => validateConfiguration({
      wechat: { authorizedUserId: "", credentialFile: "relative/credentials.json" },
    }),
    ConfigurationValidationError,
  );
  const specialProjects = Object.fromEntries([
    ["constructor", { displayName: "特殊 alias", path: join(tmpdir(), "special-project") }],
  ]);
  const safeConfig = validateConfiguration(
    JSON.parse(JSON.stringify({ projects: specialProjects })) as unknown,
    join(tmpdir(), "credentials.json"),
  );
  assert.equal(Object.hasOwn(safeConfig.projects, "constructor"), true);
  assert.equal(safeConfig.projects["constructor"].displayName, "特殊 alias");
  assert.equal(Object.hasOwn({}, "polluted"), false);
});
