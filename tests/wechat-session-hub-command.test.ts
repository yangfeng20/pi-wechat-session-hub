import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { GatewayControlServer } from "../src/gateway/gateway-control-ipc.ts";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import { writeGatewayLifecycleOperationReceipt } from "../src/runtime/gateway-lifecycle-operation.ts";
import registerWechatSessionHub from "../extensions/wechat-session-hub.ts";

test("/wx 回车打开操作菜单, 兼容别名使用同一菜单", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-command-menu-"));
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  const commands = new Map<string, { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }>();
  const menus: string[][] = [];
  const notifications: string[] = [];
  process.env.PI_CODING_AGENT_DIR = directory;
  const pi = {
    on: () => undefined,
    registerCommand: (name: string, options: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }) => {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;
  try {
    registerWechatSessionHub(pi);
    assert.equal(commands.has("wx"), true);
    assert.equal(commands.has("wechat-manager"), true);
    assert.equal(commands.has("help"), false);
    assert.equal(commands.has("projects"), false);
    assert.equal(commands.has("status"), false);
    assert.deepEqual([...commands.keys()].sort(), ["wechat-manager", "wx"]);
    const context = {
      mode: "tui",
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          menus.push(options);
          return "help | 查看帮助";
        },
        notify: (message: string) => notifications.push(message),
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("wx")!.handler("", context);
    await commands.get("wechat-manager")!.handler("", context);

    assert.equal(menus.length, 2);
    assert.ok(menus[0].some((item) => item.startsWith("restart |")));
    assert.ok(menus[0].some((item) => item.startsWith("autostart on |")));
    assert.equal(notifications.length, 2);
    assert.equal(notifications[0], notifications[1]);
    assert.match(notifications[0], /\/wx \[login\|start\|stop\|restart\|status/);
  } finally {
    if (previousAgentDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("/wx start、stop、restart 均显示进度和最终状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-command-restart-"));
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  const managerDirectory = join(directory, "wechat-session-manager");
  const lease = await GatewayLease.acquire(managerDirectory);
  let server!: GatewayControlServer;
  server = new GatewayControlServer(managerDirectory, lease, {
    handleAction: async (action, operationId) => action === "restart"
      ? { state: "stopping", operationId }
      : { state: action === "stop" ? "offline" : "online", pid: process.pid, routeCount: 0 },
    afterActionResponse: async (action, operationId) => {
      if (action === "restart" && operationId) {
        await writeGatewayLifecycleOperationReceipt(managerDirectory, {
          action: "restart",
          operationId,
          state: "completed",
          serviceStatus: { state: "online", pid: process.pid, routeCount: 0 },
        });
      }
      if (action === "stop") {
        await server.close();
      }
    },
  });
  const commands = new Map<string, { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }>();
  const notifications: string[] = [];
  process.env.PI_CODING_AGENT_DIR = directory;
  const pi = {
    on: () => undefined,
    registerCommand: (name: string, options: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }) => {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;
  const context = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      confirm: async () => true,
    },
  } as unknown as ExtensionCommandContext;

  try {
    await server.listen();
    registerWechatSessionHub(pi);
    await commands.get("wx")!.handler("start", { ...context, mode: "rpc" } as unknown as ExtensionCommandContext);
    await commands.get("wx")!.handler("restart", context);
    await commands.get("wx")!.handler("stop", context);
    assert.deepEqual(notifications, [
      "正在启动后台微信连接, 请稍候...",
      "后台微信连接已启动并就绪。",
      "正在重启后台微信连接, 等待新服务就绪...",
      "后台微信连接已恢复并就绪。",
      "正在停止后台微信连接, 等待当前任务收尾...",
      "后台微信连接已停止。",
    ]);
  } finally {
    if (previousAgentDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
    await server.close();
    await lease.release();
    await rm(directory, { recursive: true, force: true });
  }
});
