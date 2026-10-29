import { isAbsolute, basename } from "node:path";
import {
  resolveWindowsTerminalExecutable,
  WindowsTerminalLaunchError,
} from "../src/gateway/windows-terminal-launcher.ts";

/**
 * 校验可见 UI 模式的真实平台探测自洽。
 *
 * 语义上这是 CI 的可用性探针, 不是功能断言:
 *
 * - 非 Windows 平台: 按设计不支持, 视为通过。
 * - Windows 但未安装 Windows Terminal: 按设计阻塞, 视为通过。
 * - Windows 且解析出 wt.exe: 断言结果是绝对路径且文件名为 `wt.exe`。
 *
 * 注意 Windows Terminal 常以 App Execution Alias 形式存在(位于
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`)。该目录权限受限, 对别名执行
 * `existsSync` / `Test-Path` 会返回 false, 因此不复检文件存在性。
 *
 * @returns 探测结果自洽时正常结束。
 * @throws {Error} 报告可用但返回的不是绝对 wt.exe 路径时抛出。
 */
async function main() {
  if (process.platform !== "win32") {
    console.log(`当前平台为 ${process.platform}, 可见 UI 模式按设计不支持, 探测通过。`);
    return;
  }
  let executable;
  try {
    executable = await resolveWindowsTerminalExecutable();
  } catch (error) {
    if (error instanceof WindowsTerminalLaunchError && error.code === "wt_not_found") {
      console.log("当前环境未提供 Windows Terminal, 可见 UI 模式按设计阻塞, 探测通过。");
      return;
    }
    throw error;
  }
  console.log(`已解析 wt.exe: ${executable}`);
  if (!isAbsolute(executable) || basename(executable).toLowerCase() !== "wt.exe") {
    throw new Error(`解析结果不是绝对 wt.exe 路径: ${executable}`);
  }
  if (/[\\/]Microsoft[\\/]WindowsApps[\\/]wt\.exe$/i.test(executable)) {
    console.log("该路径为 App Execution Alias, 按设计跳过存在性复检。");
  }
  console.log("可见 UI 模式前置探测通过。");
}

await main();
