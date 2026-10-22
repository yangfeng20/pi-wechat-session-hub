import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export type WindowsTerminalLaunchErrorCode =
  | "unsupported_platform"
  | "wt_not_found"
  | "launch_failed";

/**
 * 表示 Windows Terminal UI worker 无法安全启动。
 */
export class WindowsTerminalLaunchError extends Error {
  /**
   * 创建不包含用户命令或凭证的启动错误。
   *
   * @param code 稳定错误代码。
   * @param message 可安全显示的中文说明。
   */
  constructor(
    readonly code: WindowsTerminalLaunchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WindowsTerminalLaunchError";
  }
}

/**
 * 通过固定 PowerShell launcher 在 Windows Terminal 中启动独立 Pi TUI tab。
 */
export class WindowsTerminalLauncher {
  private readonly scriptPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly spawnProcess: typeof spawn;

  /**
   * 创建 Windows Terminal launcher。
   *
   * @param options 可注入 Windows Terminal CLI 和受控启动脚本路径。
   */
  constructor(options: {
    wtExecutable?: string;
    scriptPath?: string;
    platform?: NodeJS.Platform;
    spawnProcess?: typeof spawn;
  } = {}) {
    this.wtExecutable = options.wtExecutable;
    this.scriptPath = options.scriptPath ?? fileURLToPath(
      new URL("../../scripts/start-ui-worker.ps1", import.meta.url),
    );
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  private readonly wtExecutable?: string;

  /**
   * 在指定项目目录启动 UI worker tab。
   *
   * @param managerDirectory manager 数据目录。
   * @param projectPath 经 ProjectService 验证的项目目录。
   * @param launchId UUID 启动记录 ID。
   * @returns Windows Terminal 接受启动请求后正常结束。
   * @throws {WindowsTerminalLaunchError} 平台、CLI 或参数不安全时抛出。
   */
  async launch(managerDirectory: string, projectPath: string, launchId: string): Promise<void> {
    if (this.platform !== "win32") {
      throw new WindowsTerminalLaunchError(
        "unsupported_platform",
        "当前系统不支持 Windows Terminal UI worker; 可使用 background 模式。",
      );
    }
    if (!/^[a-f0-9-]{36}$/i.test(launchId)) {
      throw new WindowsTerminalLaunchError("launch_failed", "UI worker launchId 无效, 已拒绝启动。");
    }
    const wtExecutable = this.wtExecutable ?? await resolveWindowsTerminalExecutable();
    const pwshExecutable = resolvePowerShellExecutable();
    if (!existsSync(this.scriptPath)) {
      throw new WindowsTerminalLaunchError("launch_failed", "受控 UI worker 启动脚本不存在, 已拒绝启动。");
    }

    const args = [
      "-w",
      "0",
      "new-tab",
      "-d",
      projectPath,
      "--title",
      "Pi UI session",
      pwshExecutable,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      this.scriptPath,
      managerDirectory,
      launchId,
    ];
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      const child = this.spawnProcess(wtExecutable, args, {
        cwd: projectPath,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.once("spawn", () => {
        child.unref();
        resolveLaunch();
      });
      child.once("error", () => {
        rejectLaunch(new WindowsTerminalLaunchError(
          "launch_failed",
          "Windows Terminal 未能接受 UI worker 启动请求。",
        ));
      });
    });
  }
}

/**
 * 解析当前 Windows Terminal app execution alias 或安装路径。
 *
 * @param options 可注入的 WindowsApps 路径、文件存在检查器和 where.exe 查询器。
 * @returns wt.exe 绝对路径。
 * @throws {WindowsTerminalLaunchError} 系统找不到受信任的 wt.exe 时抛出。
 */
export async function resolveWindowsTerminalExecutable(options: {
  localAppData?: string;
  systemRoot?: string;
  fileExists?: (path: string) => boolean;
  findOnPath?: (wherePath: string) => Promise<string>;
} = {}): Promise<string> {
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  const windowsAppsPath = localAppData
    ? join(localAppData, "Microsoft", "WindowsApps", "wt.exe")
    : undefined;
  const fileExists = options.fileExists ?? existsSync;
  if (windowsAppsPath && fileExists(windowsAppsPath)) {
    return windowsAppsPath;
  }

  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const wherePath = join(systemRoot, "System32", "where.exe");
  try {
    const output = options.findOnPath
      ? await options.findOnPath(wherePath)
      : (await promisify(execFile)(wherePath, ["wt.exe"], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      })).stdout;
    const candidate = output.split(/\r?\n/).find((line) => line.trim())?.trim();
    if (candidate && fileExists(candidate)) {
      return candidate;
    }
    if (candidate && windowsAppsPath && sameWindowsPath(candidate, windowsAppsPath)) {
      return candidate;
    }
  } catch {
    throw new WindowsTerminalLaunchError(
      "wt_not_found",
      "未找到 Windows Terminal wt.exe; 已拒绝启动 UI worker。",
    );
  }
  throw new WindowsTerminalLaunchError(
    "wt_not_found",
    "未找到 Windows Terminal wt.exe; 已拒绝启动 UI worker。",
  );
}

/**
 * 比较 Windows 文件路径并忽略大小写。
 *
 * @param left 路径一。
 * @param right 路径二。
 * @returns 规范化后的路径相同时返回 true。
 */
function sameWindowsPath(left: string, right: string): boolean {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}

/**
 * 解析 PowerShell 7 可执行文件, 不回退到 profile 脚本或系统命令解释器。
 *
 * @returns pwsh.exe 路径或可信 app execution alias。
 */
function resolvePowerShellExecutable(): string {
  const programFiles = process.env.ProgramFiles;
  const installationPath = programFiles
    ? join(programFiles, "PowerShell", "7", "pwsh.exe")
    : undefined;
  if (installationPath && existsSync(installationPath)) {
    return installationPath;
  }
  const localAppData = process.env.LOCALAPPDATA;
  const appExecutionAlias = localAppData
    ? join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe")
    : undefined;
  return appExecutionAlias && existsSync(appExecutionAlias)
    ? appExecutionAlias
    : "pwsh.exe";
}
