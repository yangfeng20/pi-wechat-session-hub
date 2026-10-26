import { spawnSync } from "node:child_process";
import { join } from "node:path";

const TASKLIST_TIMEOUT_MS = 3000;
const TASKLIST_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * 判断指定进程是否仍可能运行, 只有明确确认进程不存在时才返回 false.
 *
 * Windows 上 process.kill(pid, 0) 的 EPERM 可能对应已退出的 PID, 因此会用 tasklist 快照复核.
 *
 * @param pid 操作系统进程 ID.
 * @returns 进程存在或状态不明确时返回 true.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    if (
      process.platform === "win32" &&
      isNodeError(error) &&
      (error.code === "EPERM" || error.code === "EACCES")
    ) {
      return isWindowsProcessAlive(pid);
    }
    return true;
  }
}

/**
 * 使用 Windows 进程快照复核 PID 是否存在.
 *
 * @param pid 操作系统进程 ID.
 * @returns tasklist 确认 PID 存在时返回 true; 查询失败或结果不完整时保守返回 true.
 */
function isWindowsProcessAlive(pid: number): boolean {
  const tasklistPath = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "tasklist.exe")
    : "tasklist.exe";
  const result = spawnSync(tasklistPath, ["/FO", "CSV", "/NH"], {
    encoding: "buffer",
    maxBuffer: TASKLIST_MAX_BUFFER_BYTES,
    timeout: TASKLIST_TIMEOUT_MS,
    windowsHide: true,
  });

  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    return true;
  }

  const processIds = parseTasklistProcessIds(result.stdout);
  return processIds.size === 0 || processIds.has(pid);
}

/**
 * 从 tasklist CSV 快照中提取进程 ID 列.
 *
 * @param output tasklist 标准输出字节.
 * @returns 成功解析出的进程 ID 集合.
 */
function parseTasklistProcessIds(output: Buffer): Set<number> {
  const processIds = new Set<number>();
  for (const line of output.toString("latin1").split(/\r?\n/)) {
    const match = /^"[^"]*","(\d+)"/.exec(line);
    if (match) {
      processIds.add(Number(match[1]));
    }
  }
  return processIds;
}

/**
 * 判断未知值是否为携带 Node 错误码的异常.
 *
 * @param error 待判断值.
 * @returns 值为带错误码的 Error 时返回 true.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
