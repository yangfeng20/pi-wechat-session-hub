import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join, win32 } from "node:path";
import type { GatewayDaemonLaunchSpec } from "./gateway-service-controller.ts";
import { encodeGatewayDaemonLaunchSpec } from "./gateway-service-controller.ts";

export interface RegistryCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RegistryCommandExecutor = (
  executable: string,
  args: string[],
) => Promise<RegistryCommandResult>;

/**
 * 表示 Windows 用户登录自动启动配置失败。
 */
export class WindowsLogonAutoStartError extends Error {
  /**
   * 创建 Windows 登录自动启动错误。
   *
   * @param message 可安全显示的中文说明。
   */
  constructor(message: string) {
    super(message);
    this.name = "WindowsLogonAutoStartError";
  }
}

const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const RUN_VALUE_NAME = "PiWeChatSessionHub";
const LAUNCHER_FILE_NAME = "gateway-autostart-launcher.ps1";

/**
 * 管理当前 Windows 用户登录后启动 Hub daemon 的 Run 项。
 *
 * 使用 HKCU Run 而非 Task Scheduler: Task Scheduler 的 `/TR` 有 261 字符限制,
 * 且当前用户的 schtasks 创建权限可能被系统 ACL 拒绝. HKCU Run 是用户级配置,
 * 不需要管理员权限, 启动命令也只需指向本地短 PowerShell launcher。
 */
export class WindowsLogonAutoStartManager {
  private readonly platform: NodeJS.Platform;
  private readonly execute: RegistryCommandExecutor;

  /**
   * 创建 Windows 登录自动启动管理器。
   *
   * @param launchSpec Gateway daemon 的固定启动参数。
   * @param options 平台和注册表命令边界注入。
   */
  constructor(
    private readonly launchSpec: GatewayDaemonLaunchSpec,
    options: { platform?: NodeJS.Platform; execute?: RegistryCommandExecutor } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.execute = options.execute ?? executeRegistryCommand;
  }

  /**
   * 创建或更新当前用户登录后运行的 Hub daemon Run 项。
   *
   * @returns 注册表写入成功后正常结束。
   * @throws {WindowsLogonAutoStartError} 当前平台不受支持或 Run 项创建失败时抛出。
   */
  async enable(): Promise<void> {
    this.assertWindows();
    await writeAutostartLauncher(this.launchSpec.managerDirectory, this.launchSpec);
    const runCommand = buildWindowsLogonRunCommand(this.launchSpec);
    const result = await this.execute(getRegistryExecutable(), [
      "ADD",
      RUN_KEY,
      "/V",
      RUN_VALUE_NAME,
      "/T",
      "REG_SZ",
      "/D",
      runCommand,
      "/F",
    ]);
    if (result.code !== 0) {
      const details = normalizeCommandError(result.stderr || result.stdout);
      throw new WindowsLogonAutoStartError(
        details
          ? `无法设置 Windows 登录自动启动 (reg ${result.code}): ${details}`
          : `无法设置 Windows 登录自动启动 (reg ${result.code})。`,
      );
    }
  }

  /**
   * 删除当前用户的自动启动 Run 项及私有启动器。
   *
   * @returns Run 项删除或确认不存在后正常结束。
   * @throws {WindowsLogonAutoStartError} Run 项仍存在或无法安全清理启动器时抛出。
   */
  async disable(): Promise<void> {
    this.assertWindows();
    const deletion = await this.execute(getRegistryExecutable(), [
      "DELETE",
      RUN_KEY,
      "/V",
      RUN_VALUE_NAME,
      "/F",
    ]);
    if (deletion.code !== 0) {
      const query = await this.execute(getRegistryExecutable(), ["QUERY", RUN_KEY, "/V", RUN_VALUE_NAME]);
      if (query.code === 0) {
        const details = normalizeCommandError(deletion.stderr || deletion.stdout);
        throw new WindowsLogonAutoStartError(
          details
            ? `Windows 登录自动启动项仍存在: ${details}`
            : "Windows 登录自动启动项仍存在, 未能安全关闭。",
        );
      }
    }
    await removeAutostartLauncher(this.launchSpec.managerDirectory);
  }

  /**
   * 查询当前用户的自动启动 Run 项是否存在。
   *
   * @returns Run 项存在时返回 true。
   * @throws {WindowsLogonAutoStartError} 当前平台不受支持时抛出。
   */
  async isEnabled(): Promise<boolean> {
    this.assertWindows();
    const result = await this.execute(getRegistryExecutable(), ["QUERY", RUN_KEY, "/V", RUN_VALUE_NAME]);
    return result.code === 0;
  }

  /**
   * 校验当前平台支持 Windows 用户登录自动启动。
   *
   * @returns Windows 平台时正常结束。
   * @throws {WindowsLogonAutoStartError} 非 Windows 平台时抛出。
   */
  private assertWindows(): void {
    if (this.platform !== "win32") {
      throw new WindowsLogonAutoStartError("Windows 登录自动启动仅支持 Windows。 ");
    }
  }
}

/**
 * 生成写入 HKCU Run 的短命令, 由隐藏 PowerShell launcher 启动 daemon。
 *
 * @param spec Gateway daemon 的固定启动参数。
 * @returns 可由 Windows Run 项执行的命令行。
 */
export function buildWindowsLogonRunCommand(spec: GatewayDaemonLaunchSpec): string {
  const launcherPath = getWindowsLauncherPath(spec.managerDirectory);
  const powershellPath = win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return [
    quoteWindowsArgument(powershellPath),
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    quoteWindowsArgument(launcherPath),
  ].join(" ");
}

/**
 * 在 manager 私有目录中生成隐藏 PowerShell launcher。
 *
 * launcher 将长 daemon 参数留在脚本内容中; HKCU Run 项只保存短路径,
 * 避免 schtasks `/TR` 的 261 字符限制, 并通过 Start-Process -WindowStyle
 * Hidden 保持 daemon 启动时不弹出控制台窗口。
 *
 * @param managerDirectory Hub 私有数据目录。
 * @param spec Gateway daemon 的固定启动参数。
 * @returns launcher 写入成功后正常结束。
 * @throws {WindowsLogonAutoStartError} manager 目录不安全或 launcher 无法写入时抛出。
 */
async function writeAutostartLauncher(
  managerDirectory: string,
  spec: GatewayDaemonLaunchSpec,
): Promise<void> {
  let directoryInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryInfo = await lstat(managerDirectory);
  } catch (error) {
    throw new WindowsLogonAutoStartError(
      `自动启动数据目录不存在或不可访问 (${isNodeError(error) ? error.code : "UnknownError"})。请先执行 /wx start。`,
    );
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new WindowsLogonAutoStartError("自动启动目录不是安全的普通目录, 拒绝写入 launcher。 ");
  }

  const launcherPath = getLauncherFilePath(managerDirectory);
  try {
    const existing = await lstat(launcherPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new WindowsLogonAutoStartError("自动启动 launcher 路径不是普通文件, 拒绝覆盖。 ");
    }
  } catch (error) {
    if (error instanceof WindowsLogonAutoStartError) {
      throw error;
    }
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const encoded = encodeGatewayDaemonLaunchSpec(spec);
  const daemonArgs = [
    "--experimental-transform-types",
    spec.daemonEntry,
    "--launch-payload",
    encoded,
  ].map(quoteWindowsArgument).join(" ");
  const launcherSource = [
    "$ErrorActionPreference = 'Stop'",
    `$node = ${quotePowerShellLiteral(spec.piInvocation.command)}`,
    `$arguments = ${quotePowerShellLiteral(daemonArgs)}`,
    `$workingDirectory = ${quotePowerShellLiteral(spec.managerDirectory)}`,
    "$env:PI_WECHAT_HUB_DAEMON = '1'",
    "Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $workingDirectory -WindowStyle Hidden",
    "",
  ].join("\r\n");
  const temporaryPath = `${launcherPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(launcherSource, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, launcherPath);
    } catch (error) {
      if (isNodeError(error) && (error.code === "EEXIST" || error.code === "EPERM")) {
        await unlink(launcherPath).catch(() => undefined);
        await rename(temporaryPath, launcherPath);
      } else {
        throw error;
      }
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new WindowsLogonAutoStartError(
      `无法写入自动启动 launcher (${error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError"})。`,
    );
  }
}

/**
 * 删除已生成的 launcher; 不存在时按已清理处理。
 *
 * @param managerDirectory Hub 私有数据目录。
 * @returns 无返回值。
 */
async function removeAutostartLauncher(managerDirectory: string): Promise<void> {
  try {
    await unlink(getLauncherFilePath(managerDirectory));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new WindowsLogonAutoStartError("自动启动项已处理, 但 launcher 文件无法清理。 ");
    }
  }
}

/**
 * 计算 launcher 的当前平台与 Windows 路径。
 *
 * @param managerDirectory Hub 私有数据目录。
 * @returns 当前平台的文件系统路径。
 */
function getLauncherFilePath(managerDirectory: string): string {
  return join(managerDirectory, LAUNCHER_FILE_NAME);
}

/**
 * 计算 launcher 的 Windows 路径。
 *
 * @param managerDirectory Hub 私有数据目录。
 * @returns Windows 风格绝对路径。
 */
function getWindowsLauncherPath(managerDirectory: string): string {
  return win32.join(managerDirectory, LAUNCHER_FILE_NAME);
}

/**
 * 将字符串安全包入 PowerShell 单引号字面量。
 *
 * @param value 原始字符串。
 * @returns PowerShell 单引号字面量。
 */
function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 清理并压缩注册表命令错误文本。
 *
 * @param text reg.exe 标准错误或标准输出。
 * @returns 单行错误说明。
 */
function normalizeCommandError(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}

/**
 * 判断未知值是否为携带 Node 错误码的异常。
 *
 * @param error 待判断值。
 * @returns 值为 Node.js 文件系统错误时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * 按 Windows argv 规则引用一个 command line 参数。
 *
 * @param value 原始参数。
 * @returns 可作为单个 argv 参数解析的引用字符串。
 */
export function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) {
    return value;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes);
    quoted += character;
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  quoted += '"';
  return quoted;
}

/**
 * 获取 Windows 注册表 CLI 的绝对路径。
 *
 * @returns System32 下的 reg.exe 路径。
 */
function getRegistryExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return win32.join(systemRoot, "System32", "reg.exe");
}

/**
 * 使用 execFile 调用 reg.exe, 不经过 shell。
 *
 * @param executable 固定的 Windows 注册表 CLI。
 * @param args 结构化 argv 参数。
 * @returns exit code、stdout 与 stderr。
 */
function executeRegistryCommand(executable: string, args: string[]): Promise<RegistryCommandResult> {
  return new Promise<RegistryCommandResult>((resolveResult, rejectResult) => {
    execFile(executable, args, {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolveResult({ code: 0, stdout, stderr });
        return;
      }
      const rawExitCode = error.code;
      const exitCode = typeof rawExitCode === "number"
        ? rawExitCode
        : typeof rawExitCode === "string" && /^\d+$/.test(rawExitCode)
          ? Number(rawExitCode)
          : undefined;
      if (exitCode !== undefined) {
        resolveResult({ code: exitCode, stdout, stderr });
        return;
      }
      rejectResult(new WindowsLogonAutoStartError("无法访问当前用户的自动启动注册表项。 "));
    });
  });
}
