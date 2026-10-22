import { execFile } from "node:child_process";
import { join } from "node:path";
import type { GatewayDaemonLaunchSpec } from "./gateway-service-controller.ts";
import { encodeGatewayDaemonLaunchSpec } from "./gateway-service-controller.ts";

export interface TaskSchedulerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type TaskSchedulerExecutor = (
  executable: string,
  args: string[],
) => Promise<TaskSchedulerResult>;

export class WindowsLogonTaskManagerError extends Error {
  /**
   * 创建 Windows 登录任务错误。
   *
   * @param message 可安全显示的中文说明。
   */
  constructor(message: string) {
    super(message);
    this.name = "WindowsLogonTaskManagerError";
  }
}

const TASK_NAME = "PiWeChatSessionHub";

/**
 * 管理当前 Windows 用户登录后启动 Hub daemon 的计划任务。
 */
export class WindowsLogonTaskManager {
  private readonly platform: NodeJS.Platform;
  private readonly execute: TaskSchedulerExecutor;

  /**
   * 创建 Windows 登录计划任务管理器。
   *
   * @param launchSpec Hub daemon 的固定启动参数。
   * @param options 平台和 schtasks 边界注入。
   */
  constructor(
    private readonly launchSpec: GatewayDaemonLaunchSpec,
    options: { platform?: NodeJS.Platform; execute?: TaskSchedulerExecutor } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.execute = options.execute ?? executeTaskScheduler;
  }

  /**
   * 创建或更新当前用户登录后运行的 Hub daemon 任务。
   *
   * @returns Task Scheduler 确认创建后正常结束。
   * @throws {WindowsLogonTaskManagerError} 当前平台不受支持或任务创建失败时抛出。
   */
  async enable(): Promise<void> {
    this.assertWindows();
    const result = await this.execute(getTaskSchedulerExecutable(), [
      "/Create",
      "/F",
      "/SC",
      "ONLOGON",
      "/TN",
      TASK_NAME,
      "/TR",
      buildWindowsScheduledTaskCommand(this.launchSpec),
      "/RL",
      "LIMITED",
    ]);
    if (result.code !== 0) {
      throw new WindowsLogonTaskManagerError("无法创建 Windows 登录自动启动任务; 配置未启用。");
    }
  }

  /**
   * 删除自动启动任务; 任务不存在时按已关闭处理。
   *
   * @returns 删除成功或确认任务不存在后正常结束。
   * @throws {WindowsLogonTaskManagerError} 任务仍存在但无法删除时抛出。
   */
  async disable(): Promise<void> {
    this.assertWindows();
    const deletion = await this.execute(getTaskSchedulerExecutable(), ["/Delete", "/TN", TASK_NAME, "/F"]);
    if (deletion.code === 0) {
      return;
    }
    const query = await this.execute(getTaskSchedulerExecutable(), ["/Query", "/TN", TASK_NAME]);
    if (query.code === 0) {
      throw new WindowsLogonTaskManagerError("Windows 登录自动启动任务仍存在, 未能安全关闭。");
    }
  }

  /**
   * 查询当前用户的自动启动任务是否存在。
   *
   * @returns 任务存在时返回 true。
   * @throws {WindowsLogonTaskManagerError} 当前平台不受支持时抛出。
   */
  async isEnabled(): Promise<boolean> {
    this.assertWindows();
    const result = await this.execute(getTaskSchedulerExecutable(), ["/Query", "/TN", TASK_NAME]);
    return result.code === 0;
  }

  /**
   * 校验当前平台支持 Windows Task Scheduler。
   *
   * @returns Windows 平台时正常结束。
   * @throws {WindowsLogonTaskManagerError} 非 Windows 平台时抛出。
   */
  private assertWindows(): void {
    if (this.platform !== "win32") {
      throw new WindowsLogonTaskManagerError("Windows 登录自动启动任务仅支持 Windows。");
    }
  }
}

/**
 * 将固定 daemon 参数编码为 Task Scheduler 可执行的 Windows command line。
 *
 * @param spec daemon 启动参数。
 * @returns 经过 Windows argv 规则引用的 command line。
 */
export function buildWindowsScheduledTaskCommand(spec: GatewayDaemonLaunchSpec): string {
  const args = [
    "--experimental-transform-types",
    spec.daemonEntry,
    "--launch-payload",
    encodeGatewayDaemonLaunchSpec(spec),
  ];
  return [spec.piInvocation.command, ...args].map(quoteWindowsArgument).join(" ");
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
 * 获取系统自带 Task Scheduler CLI 的绝对路径。
 *
 * @returns System32 下的 schtasks.exe 路径。
 */
function getTaskSchedulerExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return join(systemRoot, "System32", "schtasks.exe");
}

/**
 * 使用 execFile 直接调用 schtasks.exe, 不经过 shell。
 *
 * @param executable 固定 Windows Task Scheduler CLI。
 * @param args 结构化 argv 参数。
 * @returns exit code、stdout 与 stderr。
 */
function executeTaskScheduler(
  executable: string,
  args: string[],
): Promise<TaskSchedulerResult> {
  return new Promise<TaskSchedulerResult>((resolveResult, rejectResult) => {
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
      rejectResult(new WindowsLogonTaskManagerError("无法访问 Windows Task Scheduler。"));
    });
  });
}
