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
