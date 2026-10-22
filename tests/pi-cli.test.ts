import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiCliUnavailableError, resolveCurrentPiCli } from "../src/runtime/pi-cli.ts";

test("Pi CLI invocation 保留带空格入口路径并使用当前 Node", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-cli-entry-"));
  try {
    const cliEntry = join(temporaryDirectory, "Pi CLI.js");
    await writeFile(cliEntry, "", "utf8");

    assert.deepEqual(
      resolveCurrentPiCli(["node", cliEntry], process.execPath),
      {
        command: process.execPath,
        args: [cliEntry],
      },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("拒绝不存在的 Pi CLI 入口, 不回退到 PATH 中其他版本", () => {
  assert.throws(
    () => resolveCurrentPiCli(["node", join(tmpdir(), "missing-pi-cli.js")]),
    PiCliUnavailableError,
  );
});
