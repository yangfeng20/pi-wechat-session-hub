import { dirname, join, resolve } from "node:path";
import { ConfigurationStore } from "../config/store.ts";
import { ManagerRegistry } from "../registry/manager-registry.ts";
import { ProjectService } from "../projects/project-service.ts";
import { GatewayRuntime } from "../gateway/gateway-runtime.ts";
import { GatewayControlServer, type GatewayControlAction } from "../gateway/gateway-control-ipc.ts";
import {
  decodeGatewayDaemonLaunchSpec,
  launchDetachedGatewayDaemon,
  type GatewayDaemonLaunchSpec,
  type GatewayServiceState,
} from "./gateway-service-controller.ts";

interface GatewayDaemonProcessChannel {
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  disconnect?: () => void;
}

/**
 * 启动独立的 Hub daemon, 由它持有 Gateway lease 和微信 poller。
 *
 * @returns Gateway 正常停止或启动失败后结束。
 */
export async function runGatewayDaemon(): Promise<void> {
  const launchSpec = readLaunchSpec(process.argv.slice(2));
  const managerDirectory = resolve(launchSpec.managerDirectory);
  const agentDirectory = dirname(managerDirectory);
  const configStore = new ConfigurationStore(
    join(agentDirectory, "wechat-session-manager.json"),
    join(managerDirectory, "credentials.json"),
  );
  const projectService = new ProjectService(configStore);
  const workerEnvironment = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_WECHAT_HUB_DAEMON: "1",
  };
  let serviceState: GatewayServiceState = "starting";
  let runtimeStart: Promise<GatewayRuntime> | undefined;
  let runtime: GatewayRuntime | undefined;
  let controlServer: GatewayControlServer | undefined;
  let registry: ManagerRegistry | undefined;
  let shutdownTask: Promise<void> | undefined;
  let restartRequested = false;
  let readySent = false;

  const beginShutdown = (restart: boolean): void => {
    restartRequested = restartRequested || restart;
    if (shutdownTask) {
      return;
    }
    serviceState = "stopping";
    shutdownTask = (async () => {
      try {
        const currentRuntime = runtime ?? await runtimeStart;
        await currentRuntime?.stop();
      } catch {
        serviceState = runtime ? toGatewayServiceState(runtime.status) : "starting";
        shutdownTask = undefined;
        return;
      }
      await controlServer?.close();
      controlServer = undefined;
      if (restartRequested) {
        try {
          await launchDetachedGatewayDaemon(launchSpec);
        } catch {
          process.exitCode = 1;
        }
      }
    })();
    void shutdownTask.catch(() => {
      process.exitCode = 1;
    });
  };

  runtimeStart = GatewayRuntime.start({
    dataDirectory: managerDirectory,
    configStore,
    projectService,
    invocation: launchSpec.piInvocation,
    extensionPath: launchSpec.extensionPath,
    env: workerEnvironment,
    onControlReady: async (lease, gatewayRegistry) => {
      registry = gatewayRegistry;
      controlServer = new GatewayControlServer(managerDirectory, lease, {
        handleAction: async (action) => handleControlAction(action),
      });
      await controlServer.listen();
      readySent = true;
      notifyParent({ kind: "ready" });
    },
  });

  try {
    runtime = await runtimeStart;
    if (shutdownTask) {
      serviceState = "stopping";
    } else {
      serviceState = toGatewayServiceState(runtime.status);
    }
    runtime.on("status_change", (state: string) => {
      serviceState = shutdownTask ? "stopping" : toGatewayServiceState(state);
    });
    if (shutdownTask) {
      beginShutdown(false);
    }
  } catch (error) {
    if (!readySent) {
      notifyParent({ kind: "failed", message: toSafeStartupMessage(error) });
    }
    await controlServer?.close().catch(() => undefined);
    controlServer = undefined;
    process.exitCode = 1;
  }

  async function handleControlAction(action: GatewayControlAction): Promise<unknown> {
    if (action === "stop" || action === "restart") {
      beginShutdown(action === "restart");
      return buildStatus("stopping");
    }
    return buildStatus(serviceState);
  }

  async function buildStatus(state: GatewayServiceState): Promise<Record<string, unknown>> {
    const snapshot = await registry?.readSnapshot();
    const liveInstances = Object.values(snapshot?.instances ?? {}).filter((instance) =>
      instance.state !== "stale" && instance.state !== "stopping",
    );
    return {
      state,
      pid: process.pid,
      startedAt: snapshot?.gateway?.startedAt,
      foregroundSessionCount: liveInstances.filter((instance) => instance.mode === "ui").length,
      backgroundSessionCount: liveInstances.filter((instance) => instance.mode === "background").length,
      routeCount: Object.keys(snapshot?.routes ?? {}).length,
    };
  }
}

/**
 * 从固定 CLI 参数读取并校验 daemon launch payload。
 *
 * @param args daemon 启动参数。
 * @returns 已校验 launch spec。
 * @throws {Error} CLI 参数不是固定 payload 格式时抛出。
 */
function readLaunchSpec(args: string[]): GatewayDaemonLaunchSpec {
  if (args.length !== 2 || args[0] !== "--launch-payload") {
    throw new Error("后台 Gateway 只接受受控 launch payload。");
  }
  return decodeGatewayDaemonLaunchSpec(args[1]);
}

/**
 * 向通过 Node IPC 启动的父进程报告 ready 或安全启动错误。
 *
 * @param message 不含凭证或消息正文的握手消息。
 * @returns 当前进程不受父 IPC 管道管理时正常结束。
 */
function notifyParent(message: Record<string, unknown>): void {
  const childProcess = process as unknown as GatewayDaemonProcessChannel;
  if (typeof childProcess.send !== "function") {
    return;
  }
  childProcess.send(message, () => childProcess.disconnect?.());
}

/**
 * 将 Gateway runtime 状态缩窄为对外状态枚举。
 *
 * @param value runtime 状态字符串。
 * @returns 可公开状态时返回 true。
 */
function toGatewayServiceState(value: string): GatewayServiceState {
  if (value === "offline" || value === "starting" || value === "online" ||
    value === "auth_required" || value === "stopping") {
    return value;
  }
  return value === "stopped" ? "offline" : "stopping";
}

/**
 * 将启动错误转换为不泄露配置、路径或凭证的简短说明。
 *
 * @param error runtime 初始化异常。
 * @returns 安全的中文错误文本。
 */
function toSafeStartupMessage(error: unknown): string {
  if (error instanceof Error && /configuration_incomplete|credential|授权|凭证/.test(error.message)) {
    return "后台 Gateway 尚未具备有效微信授权, 请先在 Pi TUI 执行 /wx login。";
  }
  return "后台 Gateway 启动失败, 请检查配置、授权和会话 owner 状态。";
}

if (process.env.PI_WECHAT_HUB_DAEMON === "1" || process.argv.includes("--launch-payload")) {
  void runGatewayDaemon().catch(() => {
    notifyParent({ kind: "failed", message: "后台 Gateway 启动失败, 请检查配置和授权。" });
    process.exitCode = 1;
  });
}
