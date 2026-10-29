import { isAbsolute, basename } from "node:path";
import { resolveWindowsTerminalExecutable } from "../src/gateway/windows-terminal-launcher.ts";

/**
 * 校验可见 UI 模式的真实平台探测自洽。
 *
 * 注意 Windows Terminal 常以 App Execution Alias 形式存在(位于
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`)。该目录权限受限, 对别名执行
 * `existsSync` / `Test-Path` 会返回 false, 因此这里不复检文件存在性,
 * 而是断言解析结果自洽: 绝对路径且文件名为 `wt.exe`。
 *
 * @returns 探测结果自洽时正常结束。
 * @throws {Error} 解析结果不是绝对 wt.exe 路径时抛出。
 */
async function main() {
  const executable = await resolveWindowsTerminalExecutable();
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
