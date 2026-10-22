import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import test from "node:test";
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
