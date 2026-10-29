import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigurationStore } from "../src/config/store.ts";
import { ProjectService, ProjectServiceError } from "../src/projects/project-service.ts";

/**
 * 创建项目服务测试用目录结构。
 *
 * @returns 临时目录及其授权项目根目录。
 */
async function createProjectFixture(): Promise<{ temporaryDirectory: string; allowedRoot: string }> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-projects-"));
  const allowedRoot = join(temporaryDirectory, "allowed");
  await mkdir(allowedRoot, { recursive: true });
  return { temporaryDirectory, allowedRoot };
}

test("首次初始化自动授权当前目录, 并按文件夹名称登记项目", async () => {
  const { temporaryDirectory, allowedRoot } = await createProjectFixture();
  try {
    const projectPath = join(allowedRoot, "DeltaForce Insight");
    const childPath = join(projectPath, "src");
    await mkdir(childPath, { recursive: true });
    const service = new ProjectService(
      new ConfigurationStore(join(temporaryDirectory, "manager.json")),
    );

    const initialized = await service.initializeFromCurrentCwd(projectPath);
    assert.equal(initialized.rootAdded, true);
    assert.equal(initialized.project.displayName, "DeltaForce Insight");
    assert.equal(initialized.project.path, projectPath);
    assert.deepEqual((await service.list()).config.allowedProjectRoots, [projectPath]);
    assert.equal((await service.list()).config.defaultProject, initialized.alias);

    const childProject = await service.ensureProjectForCwd(childPath);
    assert.equal(childProject.project.displayName, "src");
    assert.equal(childProject.project.path, childPath);
    assert.equal((await service.list()).projects.length, 2);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("允许根中的目录自动登记且重复登记复用同一项目", async () => {
  const { temporaryDirectory, allowedRoot } = await createProjectFixture();
  try {
    const projectPath = join(allowedRoot, "workspace", "demo-workspace");
    await mkdir(projectPath, { recursive: true });
    const store = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
    await store.update((config) => ({
      ...config,
      allowedProjectRoots: [allowedRoot],
    }));
    const service = new ProjectService(store);

    const first = await service.ensureProjectForCwd(projectPath);
    const second = await service.ensureProjectForCwd(projectPath);

    assert.equal(first.alias, second.alias);
    assert.equal(first.project.displayName, "demo-workspace");
    assert.equal((await service.list()).projects.length, 1);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("添加授权根目录支持子目录且不会重复写入", async () => {
  const { temporaryDirectory, allowedRoot } = await createProjectFixture();
  try {
    const nestedRoot = join(allowedRoot, "workspace");
    await mkdir(join(nestedRoot, "project"), { recursive: true });
    const service = new ProjectService(
      new ConfigurationStore(join(temporaryDirectory, "manager.json")),
    );

    assert.equal(await service.addAllowedRoot(nestedRoot), nestedRoot);
    assert.equal(await service.addAllowedRoot(nestedRoot), nestedRoot);
    await assert.rejects(
      service.addAllowedRoot("relative-root"),
      (error: unknown) => error instanceof ProjectServiceError && error.code === "project_path_denied",
    );
    const project = await service.ensureProjectForCwd(join(nestedRoot, "project"));
    assert.equal(project.project.displayName, "project");
    assert.deepEqual((await service.list()).config.allowedProjectRoots, [nestedRoot]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("仅允许登记授权根目录内存在的项目路径", async () => {
  const { temporaryDirectory, allowedRoot } = await createProjectFixture();
  try {
    const projectPath = join(allowedRoot, "示例项目");
    await mkdir(projectPath);
    const store = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
    await store.update((config) => ({
      ...config,
      allowedProjectRoots: [allowedRoot],
    }));
    const service = new ProjectService(store);

    const project = await service.add("demo", "示例项目", projectPath);
    assert.equal(project.displayName, "示例项目");
    assert.equal(project.path, projectPath);

    await assert.rejects(
      service.add("outside", "外部目录", temporaryDirectory),
      (error: unknown) => error instanceof ProjectServiceError && error.code === "project_path_denied",
    );
    await assert.rejects(
      service.add("missing", "不存在的目录", join(allowedRoot, "missing")),
      (error: unknown) => error instanceof ProjectServiceError && error.code === "project_directory_not_found",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("移除 alias 不删除项目目录, 并清除默认项目", async () => {
  const { temporaryDirectory, allowedRoot } = await createProjectFixture();
  try {
    const projectPath = join(allowedRoot, "project");
    await mkdir(projectPath);
    const store = new ConfigurationStore(join(temporaryDirectory, "manager.json"));
    await store.update((config) => ({
      ...config,
      allowedProjectRoots: [allowedRoot],
    }));
    const service = new ProjectService(store);
    await service.add("notes", "笔记", projectPath);
    await service.setDefault("notes");

    const updated = await service.remove("notes");

    assert.deepEqual(updated.projects, {});
    assert.equal(updated.defaultProject, undefined);
    assert.equal((await stat(projectPath)).isDirectory(), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("未配置授权根目录时拒绝添加项目", async () => {
  const { temporaryDirectory, allowedRoot } = await createProjectFixture();
  try {
    const projectPath = join(allowedRoot, "project");
    await mkdir(projectPath);
    const service = new ProjectService(
      new ConfigurationStore(join(temporaryDirectory, "manager.json")),
    );

    await assert.rejects(
      service.add("project", "项目", projectPath),
      (error: unknown) => error instanceof ProjectServiceError && error.code === "project_path_denied",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
