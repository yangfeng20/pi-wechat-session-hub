import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveWindowsTerminalExecutable,
  WindowsTerminalLaunchError,
  WindowsTerminalLauncher,
} from "../src/gateway/windows-terminal-launcher.ts";

test("WindowsApps wt.exe execution alias 即使 existsSync 为 false 仍可从 where.exe 安全解析", async () => {
  const alias = "C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
  const resolved = await resolveWindowsTerminalExecutable({
    localAppData: "C:\\Users\\test\\AppData\\Local",
    systemRoot: "C:\\Windows",
    fileExists: () => false,
    findOnPath: async () => `${alias}\r\n`,
  });
  assert.equal(resolved, alias);
});

test("Windows Terminal resolver 不信任任意 PATH 候选", async () => {
  await assert.rejects(
    resolveWindowsTerminalExecutable({
      localAppData: "C:\\Users\\test\\AppData\\Local",
      systemRoot: "C:\\Windows",
      fileExists: () => false,
      findOnPath: async () => "C:\\Temp\\untrusted\\wt.exe\r\n",
    }),
    (error: unknown) => error instanceof WindowsTerminalLaunchError && error.code === "wt_not_found",
  );
});

test("Windows Terminal launcher 以 argv 启动固定脚本且不拼接用户消息", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-wt-launcher-"));
  const scriptPath = join(directory, "start-ui-worker.ps1");
  await writeFile(scriptPath, "$ErrorActionPreference = 'Stop'\n", "utf8");
  let capturedCommand = "";
  let capturedArgs: string[] = [];
  let capturedOptions: SpawnOptions | undefined;
  const fakeSpawn = ((command: string, args: string[], options: SpawnOptions) => {
    capturedCommand = command;
    capturedArgs = args;
    capturedOptions = options;
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => child;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as typeof import("node:child_process").spawn;

  try {
    const launcher = new WindowsTerminalLauncher({
      wtExecutable: "C:/WindowsApps/wt.exe",
      scriptPath,
      platform: "win32",
      spawnProcess: fakeSpawn,
    });
    const managerDirectory = "C:/Users/test user/.pi/agent/wechat-session-manager";
    const projectPath = "D:/Projects/中文项目 with spaces";
    const launchId = "6b09e2d7-4a14-4dc7-bd55-66ed011f2531";
    await launcher.launch(managerDirectory, projectPath, launchId);

    assert.equal(capturedCommand, "C:/WindowsApps/wt.exe");
    assert.deepEqual(capturedArgs.slice(0, 7), [
      "-w",
      "0",
      "new-tab",
      "-d",
      projectPath,
      "--title",
      "Pi UI session",
    ]);
    assert.ok(capturedArgs.includes(scriptPath));
    assert.ok(capturedArgs.includes(managerDirectory));
    assert.ok(capturedArgs.includes(launchId));
    assert.equal(capturedOptions?.shell, undefined);
    assert.equal(capturedOptions?.detached, true);
    assert.equal(capturedOptions?.cwd, projectPath);
    assert.equal(capturedArgs.some((argument) => argument.includes("test message")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
