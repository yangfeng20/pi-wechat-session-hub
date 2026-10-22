import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectCommand,
  ProjectCommandParseError,
} from "../src/commands/project-command-parser.ts";

test("空参数和 list 子命令映射到项目列表", () => {
  assert.deepEqual(parseProjectCommand(""), { action: "list" });
  assert.deepEqual(parseProjectCommand("list"), { action: "list" });
});

test("解析包含空格、中文和 Windows 反斜杠的项目路径", () => {
  const command = String.raw`add demo --name "示例项目" --path "D:\Projects\示例项目"`;

  assert.deepEqual(parseProjectCommand(command), {
    action: "add",
    alias: "demo",
    displayName: "示例项目",
    path: String.raw`D:\Projects\示例项目`,
  });
});

test("支持等号参数和单引号", () => {
  assert.deepEqual(
    parseProjectCommand("add notes --name='个人笔记' --path='/tmp/my notes'"),
    {
      action: "add",
      alias: "notes",
      displayName: "个人笔记",
      path: "/tmp/my notes",
    },
  );
});

test("拒绝未知选项、额外位置参数和未闭合引号", () => {
  assert.throws(() => parseProjectCommand("add x --name X --path /tmp --root /"), ProjectCommandParseError);
  assert.throws(() => parseProjectCommand("add x --name X --path /tmp extra"), ProjectCommandParseError);
  assert.throws(() => parseProjectCommand("add x --name \"未闭合 --path /tmp"), ProjectCommandParseError);
});
