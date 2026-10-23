import assert from "node:assert/strict";
import test from "node:test";
import {
  getWechatManagerCommandCompletions,
  parseWechatManagerCommand,
  WechatManagerCommandParseError,
} from "../src/commands/wechat-manager-command-parser.ts";

test("/wx 解析启动、停止、重启、状态和自动启动配置", () => {
  assert.deepEqual(parseWechatManagerCommand(""), { action: "help" });
  assert.deepEqual(parseWechatManagerCommand(" login "), { action: "login" });
  assert.deepEqual(parseWechatManagerCommand(" start "), { action: "start" });
  assert.deepEqual(parseWechatManagerCommand("stop"), { action: "stop" });
  assert.deepEqual(parseWechatManagerCommand("restart"), { action: "restart" });
  assert.deepEqual(parseWechatManagerCommand("status"), { action: "status" });
  assert.deepEqual(parseWechatManagerCommand("autostart on"), { action: "autostart", enabled: true });
  assert.deepEqual(parseWechatManagerCommand("autostart off"), { action: "autostart", enabled: false });
});

test("/wx 参数补全按子命令前缀筛选", () => {
  const choices = getWechatManagerCommandCompletions("autostart ");
  assert.deepEqual(choices?.map((choice) => choice.value), ["autostart on", "autostart off"]);
  assert.equal(getWechatManagerCommandCompletions("unknown"), null);
});

test("/wx 解析项目和授权根子命令, 并保留 Windows 路径空格", () => {
  assert.deepEqual(parseWechatManagerCommand("projects"), {
    action: "projects",
    command: { action: "list" },
  });
  assert.deepEqual(
    parseWechatManagerCommand('projects add demo --name "Delta Force" --path "D:\\Program Project\\deltaforce-insight"'),
    {
      action: "projects",
      command: {
        action: "add",
        alias: "demo",
        displayName: "Delta Force",
        path: "D:\\Program Project\\deltaforce-insight",
      },
    },
  );
  assert.deepEqual(parseWechatManagerCommand("roots"), { action: "roots", operation: "list" });
  assert.deepEqual(parseWechatManagerCommand("roots add-current"), {
    action: "roots",
    operation: "add-current",
  });
  assert.deepEqual(parseWechatManagerCommand('roots add "D:\\Program Project\\List"'), {
    action: "roots",
    operation: "add",
    path: "D:\\Program Project\\List",
  });
});

test("/wx 拒绝任意附加参数和未知动作", () => {
  assert.throws(
    () => parseWechatManagerCommand("autostart maybe"),
    WechatManagerCommandParseError,
  );
  assert.throws(
    () => parseWechatManagerCommand("start C:/secrets.json"),
    WechatManagerCommandParseError,
  );
  assert.throws(
    () => parseWechatManagerCommand("unknown"),
    WechatManagerCommandParseError,
  );
});
