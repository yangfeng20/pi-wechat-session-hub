import assert from "node:assert/strict";
import test from "node:test";
import {
  WindowsLogonTaskManager,
  buildWindowsScheduledTaskCommand,
} from "../src/runtime/windows-logon-task-manager.ts";
import type { GatewayDaemonLaunchSpec } from "../src/runtime/gateway-service-controller.ts";

const launchSpec: GatewayDaemonLaunchSpec = {
  managerDirectory: "C:\\Users\\tester\\.pi\\agent\\wechat-session-manager",
  extensionPath: "C:\\Program Files\\Pi Hub\\extensions\\wechat-session-hub.ts",
  daemonEntry: "C:\\Program Files\\Pi Hub\\src\\runtime\\gateway-daemon.ts",
  piInvocation: {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\Program Files\\Pi\\dist\\cli.js"],
  },
};

test("Windows 登录任务以 argv 启动固定 daemon, 不经过 shell", () => {
  const command = buildWindowsScheduledTaskCommand(launchSpec);
  assert.match(command, /^"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.match(command, /gateway-daemon\.ts/);
  assert.match(command, /--launch-payload/);
  assert.equal(command.includes("&"), false);
});

test("自启动启用和禁用使用当前用户的登录触发任务", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const manager = new WindowsLogonTaskManager(launchSpec, {
    platform: "win32",
    execute: async (executable, args) => {
      calls.push({ executable, args });
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  await manager.enable();
  await manager.disable();

  assert.equal(calls.length, 2);
  assert.ok(calls[0].executable.endsWith("System32\\schtasks.exe"));
  assert.ok(calls[0].args.includes("ONLOGON"));
  assert.ok(calls[0].args.includes("/Create"));
  assert.ok(calls[1].args.includes("/Delete"));
});

test("非 Windows 平台拒绝创建 Windows 登录任务", async () => {
  const manager = new WindowsLogonTaskManager(launchSpec, { platform: "linux" });
  await assert.rejects(manager.enable(), /仅支持 Windows/);
});
