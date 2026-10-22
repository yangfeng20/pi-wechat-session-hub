import assert from "node:assert/strict";
import test from "node:test";
import {
  GatewayCommandParseError,
  parseGatewayCommand,
} from "../src/gateway/command-parser.ts";

test("解析新建后台 session, 支持带空格的 session name", () => {
  assert.deepEqual(
    parseGatewayCommand('/new --mode background --project demo --name "调查应用错误"'),
    {
      kind: "new",
      mode: "background",
      projectAlias: "demo",
      name: "调查应用错误",
    },
  );
});

test("解析 session 分页、恢复和显式重试确认", () => {
  assert.deepEqual(
    parseGatewayCommand("/sessions --project demo --state saved --page 2"),
    {
      kind: "sessions",
      projectAlias: "demo",
      state: "saved",
      page: 2,
    },
  );
  assert.deepEqual(
    parseGatewayCommand('/resume "调查应用错误" --mode background'),
    {
      kind: "resume",
      selector: "调查应用错误",
      mode: "background",
    },
  );
  assert.deepEqual(
    parseGatewayCommand("/retry wx-message-1 --confirm"),
    {
      kind: "retry",
      messageId: "wx-message-1",
      confirmed: true,
    },
  );
});

test("普通文本作为 prompt, 未知 slash command fail-closed", () => {
  assert.deepEqual(parseGatewayCommand("继续排查这个问题"), {
    kind: "prompt",
    text: "继续排查这个问题",
  });
  assert.throws(() => parseGatewayCommand("/unknown command"), GatewayCommandParseError);
  assert.throws(() => parseGatewayCommand("/new --mode invalid"), GatewayCommandParseError);
});

test("/projects parser 保留原始引号供项目命令解析器使用", () => {
  assert.deepEqual(
    parseGatewayCommand('/projects add demo --name "示例项目" --path "D:\\Projects\\demo"'),
    {
      kind: "projects",
      arguments: 'add demo --name "示例项目" --path "D:\\Projects\\demo"',
    },
  );
});
