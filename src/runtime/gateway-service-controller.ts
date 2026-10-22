import { spawn } from "node:child_process";
import type { PiCliInvocation } from "./pi-cli.ts";
import { GatewayControlClient, GatewayControlError } from "../gateway/gateway-control-ipc.ts";

export type GatewayServiceState = "offline" | "starting" | "online" | "auth_required" | "stopping";

export interface GatewayServiceStatus {
  state: GatewayServiceState;
  pid?: number;
  startedAt?: string;
  foregroundSessionCount?: number;
  backgroundSessionCount?: number;
  routeCount?: number;
  error?: string;
}

export interface GatewayDaemonLaunchSpec {
  managerDirectory: string;
  extensionPath: string;
  daemonEntry: string;
  piInvocation: PiCliInvocation;
}

/**
 * 控制一个独立于当前 Pi TUI 生命周期的 Gateway daemon。
 */
export class GatewayServiceController {
  private readonly controlClient: GatewayControlClient;
  private readonly launchDaemon: (spec: GatewayDaemonLaunchSpec) => Promise<void>;

  /**
   * 创建后台 Gateway 控制器。
   *
   * @param managerDirectory Hub 私有数据目录。
   * @param launchSpec daemon 启动时需要的固定运行参数。
   * @param options 可注入控制客户端和进程启动边界。
   */
  constructor(
    private readonly managerDirectory: string,
    private readonly launchSpec: GatewayDaemonLaunchSpec,
    options: {
      controlClient?: GatewayControlClient;
      launchDaemon?: (spec: GatewayDaemonLaunchSpec) => Promise<void>;
    } = {},
  ) {
    this.controlClient = options.controlClient ?? new GatewayControlClient(managerDirectory);
    this.launchDaemon = options.launchDaemon ?? launchDetachedGatewayDaemon;
  }

  /**
   * 查询真实后台进程和 Gateway 状态。
   *
   * @returns IPC 服务提供的活动状态; 控制通道离线时返回 offline。
   * @throws {GatewayControlError} 身份校验或状态协议不可信时抛出。
   */
  async status(): Promise<GatewayServiceStatus> {
    try {
      const response = await this.controlClient.request("status");
      return parseServiceStatus(response);
    } catch (error) {
      if (error instanceof GatewayControlError && error.code === "not_running") {
        return { state: "offline" };
      }
      throw error;
    }
  }

  /**
   * 幂等启动后台 Gateway daemon。
   *
   * @returns 已存在或新启动服务的状态。
   * @throws {Error} daemon 启动失败且没有可用的现有服务时抛出。
   */
  async start(): Promise<GatewayServiceStatus> {
    const current = await this.status();
    if (current.state !== "offline") {
      return current;
    }
    try {
      await this.launchDaemon(this.launchSpec);
    } catch (error) {
      const concurrentlyStarted = await this.status().catch(() => ({ state: "offline" as const }));
      if (concurrentlyStarted.state !== "offline") {
        return concurrentlyStarted;
      }
      throw error instanceof GatewayControlError
        ? error
        : new GatewayControlError(
            "request_failed",
            error instanceof Error ? error.message : "后台 Gateway 启动失败, 请检查配置和微信授权。",
          );
    }
    return this.status();
  }

  /**
   * 请求后台 Gateway 在安全停止窗口内优雅退出。
   *
   * @returns 服务开始停止后的状态。
   * @throws {GatewayControlError} Gateway 离线或无法认证时抛出。
   */
  async stop(): Promise<GatewayServiceStatus> {
    const current = await this.status();
    if (current.state === "offline") {
      return current;
    }
    return parseServiceStatus(await this.controlClient.request("stop"));
  }

  /**
   * 请求后台 Gateway 安全停止并由 daemon 重新启动自身。
   *
   * @returns daemon 接受重启请求后的状态。
   * @throws {GatewayControlError} Gateway 离线或无法认证时抛出。
   */
  async restart(): Promise<GatewayServiceStatus> {
    const current = await this.status();
    if (current.state === "offline") {
      return this.start();
    }
    return parseServiceStatus(await this.controlClient.request("restart"));
  }
}

/**
 * 将已验证的 daemon 启动参数编码为 Node CLI payload。
 *
 * @param spec daemon 启动参数。
 * @returns 不含 shell 解释的 base64url JSON。
 */
export function encodeGatewayDaemonLaunchSpec(spec: GatewayDaemonLaunchSpec): string {
  return Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");
}

/**
 * 解码并验证 daemon 启动 payload。
 *
 * @param encoded base64url JSON 字符串。
 * @returns 已验证启动参数。
 * @throws {Error} payload 格式或路径字段无效时抛出。
 */
export function decodeGatewayDaemonLaunchSpec(encoded: string): GatewayDaemonLaunchSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("后台 Gateway 启动参数编码无效。");
  }
  if (!isRecord(parsed) || !isAbsolutePath(parsed.managerDirectory) ||
    !isAbsolutePath(parsed.extensionPath) || !isAbsolutePath(parsed.daemonEntry) ||
    !isRecord(parsed.piInvocation) || !isAbsolutePath(parsed.piInvocation.command) ||
    !Array.isArray(parsed.piInvocation.args) ||
    !parsed.piInvocation.args.every((argument) => typeof argument === "string")) {
    throw new Error("后台 Gateway 启动参数字段无效。");
  }
  return parsed as unknown as GatewayDaemonLaunchSpec;
}

/**
 * 通过独立进程启动 Gateway daemon, 并等待本机控制 endpoint ready。
 *
 * @param spec daemon 启动参数。
 * @returns daemon 已开始持有服务进程时正常结束。
 * @throws {Error} 子进程无法创建、提前退出或未能及时 ready 时抛出。
 */
export async function launchDetachedGatewayDaemon(spec: GatewayDaemonLaunchSpec): Promise<void> {
  const encoded = encodeGatewayDaemonLaunchSpec(spec);
  const args = [
    "--experimental-transform-types",
    spec.daemonEntry,
    "--launch-payload",
    encoded,
  ];
  const child = spawn(spec.piInvocation.command, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
    env: {
      ...process.env,
      PI_WECHAT_HUB_DAEMON: "1",
    },
  });
  child.unref();

  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("后台 Gateway 启动超时, 请使用 /wx status 检查。")), 30000);
    timeout.unref();
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (child.connected) {
        child.disconnect();
      }
      if (error) {
        rejectLaunch(error);
      } else {
        resolveLaunch();
      }
    };
    const onMessage = (message: unknown): void => {
      if (!isRecord(message)) {
        finish(new Error("后台 Gateway 启动握手响应无效。"));
        return;
      }
      if (message.kind === "ready") {
        finish();
        return;
      }
      if (message.kind === "failed") {
        finish(new Error(typeof message.message === "string" ? message.message : "后台 Gateway 启动失败。"));
      }
    };
    const onError = (): void => finish(new Error("无法创建后台 Gateway 进程。"));
    const onExit = (code: number | null): void => {
      finish(new Error(`后台 Gateway 在 ready 前退出 (code ${code ?? "unknown"})。`));
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

/**
 * 解析并校验 daemon 返回的状态对象。
 *
 * @param value 未知 IPC response payload。
 * @returns Gateway service 状态。
 * @throws {GatewayControlError} 状态字段不受支持时抛出。
 */
function parseServiceStatus(value: unknown): GatewayServiceStatus {
  if (!isRecord(value) || !isGatewayServiceState(value.state)) {
    throw new GatewayControlError("protocol_error", "后台 Gateway 状态响应字段无效。");
  }
  const numericFields = ["pid", "foregroundSessionCount", "backgroundSessionCount", "routeCount"] as const;
  for (const field of numericFields) {
    if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0)) {
      throw new GatewayControlError("protocol_error", "后台 Gateway 状态计数字段无效。");
    }
  }
  if (value.startedAt !== undefined && typeof value.startedAt !== "string") {
    throw new GatewayControlError("protocol_error", "后台 Gateway 启动时间字段无效。");
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    throw new GatewayControlError("protocol_error", "后台 Gateway 状态错误字段无效。");
  }
  return value as unknown as GatewayServiceStatus;
}

/**
 * 判断状态值是否为受支持的 Gateway lifecycle state。
 *
 * @param value 未知状态字段。
 * @returns 状态受支持时返回 true。
 */
function isGatewayServiceState(value: unknown): value is GatewayServiceState {
  return value === "offline" || value === "starting" || value === "online" ||
    value === "auth_required" || value === "stopping";
}

/**
 * 判断值是否为普通对象。
 *
 * @param value 待校验值。
 * @returns 普通对象时返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 判断路径是否为绝对路径。
 *
 * @param value 待校验字段。
 * @returns 绝对路径字符串时返回 true。
 */
function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("/") || /^[a-z]:[\\/]/i.test(value));
}
