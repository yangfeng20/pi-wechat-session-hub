import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WindowsLogonAutoStartError,
  WindowsLogonAutoStartManager,
  buildWindowsLogonRunCommand,
} from "../src/runtime/windows-logon-autostart-manager.ts";
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

test("Run 项命令使用当前用户隐藏 PowerShell launcher, 不受 schtasks /TR 长度限制", () => {
  const command = buildWindowsLogonRunCommand(launchSpec);
  assert.match(command, /powershell\.exe/);
  assert.match(command, /-WindowStyle Hidden/);
  assert.match(command, /gateway-autostart-launcher\.ps1/);
  assert.ok(command.length < 261);
  assert.doesNotMatch(command, /--launch-payload/);
});

test("启用时写入隐藏 launcher 与当前用户 Run 项, 关闭时删除两者", async () => {
  const managerDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-run-key-"));
  const spec = { ...launchSpec, managerDirectory };
  const calls: Array<{ executable: string; args: string[] }> = [];
  const manager = new WindowsLogonAutoStartManager(spec, {
    platform: "win32",
    execute: async (executable, args) => {
      calls.push({ executable, args });
      return { code: 0, stdout: "The operation completed successfully.", stderr: "" };
    },
  });
  const launcherPath = join(managerDirectory, "gateway-autostart-launcher.ps1");

  try {
    await manager.enable();
    const launcher = await readFile(launcherPath, "utf8");
    assert.match(launcher, /Start-Process -FilePath \$node/);
    assert.match(launcher, /-WindowStyle Hidden/);
    assert.match(launcher, /--launch-payload/);

    assert.equal(calls.length, 1);
    assert.match(calls[0].executable, /reg\.exe$/i);
    assert.ok(calls[0].args.includes("ADD"));
    assert.ok(calls[0].args.includes(String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`));
    assert.ok(calls[0].args.includes("PiWeChatSessionHub"));
    const runValue = calls[0].args[calls[0].args.indexOf("/D") + 1];
    assert.ok(runValue.length < 261);

    assert.equal(await manager.isEnabled(), true);
    assert.ok(calls.at(-1)?.args.includes("QUERY"));

    await manager.disable();
    assert.ok(calls.at(-1)?.args.includes("DELETE"));
    await assert.rejects(stat(launcherPath));
  } finally {
    await rm(managerDirectory, { recursive: true, force: true });
  }
});

test("注册表拒绝写入时保留 Windows 返回原因", async () => {
  const managerDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-run-key-fail-"));
  const manager = new WindowsLogonAutoStartManager(
    { ...launchSpec, managerDirectory },
    {
      platform: "win32",
      execute: async () => ({ code: 1, stdout: "", stderr: "Access is denied." }),
    },
  );
  try {
    await assert.rejects(
      manager.enable(),
      (error: unknown) => error instanceof WindowsLogonAutoStartError && /Access is denied/.test(error.message),
    );
  } finally {
    await rm(managerDirectory, { recursive: true, force: true });
  }
});

test("非 Windows 平台拒绝创建 Windows 登录自动启动项", async () => {
  const manager = new WindowsLogonAutoStartManager(launchSpec, { platform: "linux" });
  await assert.rejects(manager.enable(), /仅支持 Windows/);
});
