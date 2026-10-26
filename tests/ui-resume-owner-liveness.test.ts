import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UiWorkerExtensionBridge } from "../src/gateway/ui-worker-extension-bridge.ts";

const MISSING_PROCESS_ID = 2147483647;

/**
 * 使用临时 registry 验证给定 PID 被操作系统拒绝查询时的 session 切换结果.
 *
 * @param pid owner registry 中记录的进程 ID.
 * @param state owner registry 中记录的运行状态.
 * @returns Pi bridge 对 sessionFile 的切换许可.
 */
async function canSwitchWithPermissionDeniedOwner(
  pid: number,
  state: "idle" | "stale",
): Promise<boolean> {
  const managerDirectory = await mkdtemp(join(tmpdir(), "pi-wechat-resume-liveness-"));
  const sessionFile = join(managerDirectory, "target-session.jsonl");
  const originalKill = process.kill;
  await writeFile(join(managerDirectory, "instances.json"), JSON.stringify({
    oldOwner: {
      instanceId: "old-owner",
      pid,
      sessionFile,
      state,
    },
  }), "utf8");

  try {
    process.kill = ((targetPid: number, signal?: NodeJS.Signals | number) => {
      if (targetPid === pid && signal === 0) {
        throw Object.assign(new Error("模拟 Windows EPERM"), { code: "EPERM" });
      }
      return originalKill(targetPid, signal);
    }) as typeof process.kill;

    const bridge = new UiWorkerExtensionBridge(undefined, {} as never, managerDirectory);
    return await bridge.canSwitchSession(sessionFile);
  } finally {
    process.kill = originalKill;
    await rm(managerDirectory, { recursive: true, force: true });
  }
}

test("Windows 已不存在的 active owner PID 返回 EPERM 时允许恢复 session", {
  skip: process.platform !== "win32",
}, async () => {
  assert.equal(await canSwitchWithPermissionDeniedOwner(MISSING_PROCESS_ID, "idle"), true);
});

test("Windows 查询存活 owner 返回 EPERM 时仍拒绝 session 切换", {
  skip: process.platform !== "win32",
}, async () => {
  assert.equal(await canSwitchWithPermissionDeniedOwner(process.pid, "stale"), false);
});
