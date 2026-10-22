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
