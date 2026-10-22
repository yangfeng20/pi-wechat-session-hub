import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWechatManagerCommand,
  WechatManagerCommandParseError,
} from "../src/commands/wechat-manager-command-parser.ts";

test("/wechat-manager 空参数映射到 help 并解析启停状态", () => {
  assert.deepEqual(parseWechatManagerCommand(""), { action: "help" });
  assert.deepEqual(parseWechatManagerCommand(" login "), { action: "login" });
  assert.deepEqual(parseWechatManagerCommand(" start "), { action: "start" });
  assert.deepEqual(parseWechatManagerCommand("stop"), { action: "stop" });
  assert.deepEqual(parseWechatManagerCommand("status"), { action: "status" });
});

test("/wechat-manager 拒绝任意附加参数和未知动作", () => {
  assert.throws(
    () => parseWechatManagerCommand("start C:/secrets.json"),
    WechatManagerCommandParseError,
  );
  assert.throws(
    () => parseWechatManagerCommand("restart"),
    WechatManagerCommandParseError,
  );
});
