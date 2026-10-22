import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface PiCliInvocation {
  command: string;
  args: string[];
}

/**
 * 表示当前 Pi CLI 入口无法被安全解析。
 */
export class PiCliUnavailableError extends Error {
  /**
   * 创建 Pi CLI 入口错误。
   *
   * @param message 面向用户的中文错误信息。
   */
  constructor(message: string) {
    super(message);
    this.name = "PiCliUnavailableError";
  }
}

/**
 * 解析当前运行中 Pi 进程的 CLI JavaScript 入口, 避免从 PATH 启动另一个版本。
 *
 * @param argv Pi 进程的 argv。
 * @param runtimeExecutable Node.js 可执行文件路径。
 * @returns 不经过 shell 的 Node 命令及固定入口参数。
 * @throws {PiCliUnavailableError} CLI 入口不存在或不是文件时抛出。
 */
export function resolveCurrentPiCli(
  argv = process.argv,
  runtimeExecutable = process.execPath,
): PiCliInvocation {
  const entry = argv[1];
  if (!entry) {
    throw new PiCliUnavailableError(
      "无法确定当前 Pi CLI 入口; 请通过 Node.js 安装版 Pi 启动会话。",
    );
  }
  const cliEntry = isAbsolute(entry) ? entry : resolve(entry);
  try {
    if (!existsSync(cliEntry) || !statSync(cliEntry).isFile()) {
      throw new Error("not_file");
    }
  } catch {
    throw new PiCliUnavailableError(
      "当前 Pi CLI 入口不可用; 为避免误用 PATH 中的其他版本, 已拒绝启动后台 worker。",
    );
  }
  return {
    command: runtimeExecutable,
    args: [cliEntry],
  };
}
