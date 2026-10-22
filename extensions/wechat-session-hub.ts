import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import {
  ConfigurationBusyError,
  createDefaultConfigurationStore,
  type ConfigurationStore,
} from "../src/config/store.ts";
import { ConfigurationValidationError } from "../src/config/validation.ts";
import { parseProjectCommand, ProjectCommandParseError } from "../src/commands/project-command-parser.ts";
import { IlinkQrLoginComponent } from "../src/commands/ilink-qr-login-component.ts";
import {
  getWechatManagerCommandCompletions,
  parseWechatManagerCommand,
  WechatManagerCommandParseError,
} from "../src/commands/wechat-manager-command-parser.ts";
import { getManagerDataDirectory } from "../src/config/paths.ts";
import { GatewayControlError } from "../src/gateway/gateway-control-ipc.ts";
import { GatewayServiceController, type GatewayDaemonLaunchSpec, type GatewayServiceStatus } from "../src/runtime/gateway-service-controller.ts";
import { WindowsLogonTaskManager, WindowsLogonTaskManagerError } from "../src/runtime/windows-logon-task-manager.ts";
import { registerUiWorkerBridgeHooks } from "../src/gateway/ui-worker-extension-bridge.ts";
import { UiWorkerIpcError } from "../src/gateway/ui-worker-ipc.ts";
import { IlinkApiError } from "../src/gateway/wechat-ilink/api-client.ts";
import { IlinkCredentialStoreError } from "../src/gateway/credential-store.ts";
import { IlinkQrLoginError, IlinkQrLoginService } from "../src/gateway/wechat-ilink/qr-login.ts";
import { BackgroundWorkerManagerError } from "../src/runtime/background-worker-manager.ts";
import { UiWorkerManagerError } from "../src/runtime/ui-worker-manager.ts";
import { PiCliUnavailableError, resolveCurrentPiCli } from "../src/runtime/pi-cli.ts";
import { ProjectService, ProjectServiceError } from "../src/projects/project-service.ts";

const HELP_TEXT = [
  "Pi 微信会话枢纽命令:",
  "/projects - 查看已登记项目",
  "/projects add <alias> --name <名称> --path <绝对路径> - 登记项目",
  "/projects remove <alias> - 移除登记, 不删除目录",
  "/projects default <alias> - 设置默认项目",
  "/wx [login|start|stop|restart|status|autostart on|autostart off] - 管理后台微信连接",
  "  login - 使用独立二维码授权 Pi Hub",
  "  start - 启动独立后台连接, 不绑定当前 Pi 会话",
  "  stop - 二次确认后停止后台连接",
  "  restart - 重启后台连接",
  "  status - 查看后台连接和前后台会话数量",
  "  autostart on|off - 管理 Windows 用户登录后的自动连接",
  "/wechat-manager - /wx 的兼容别名",
  "/status - 查看后台管理器状态",
  "/help - 查看命令帮助",
].join("\n");

/**
 * 创建本机后台 Gateway 控制器及其固定 launch 参数。
 *
 * @returns 可启动、查询和控制 Hub daemon 的实例。
 */
function createGatewayServiceController(): GatewayServiceController {
  const launchSpec = createGatewayServiceControllerSpec();
  return new GatewayServiceController(launchSpec.managerDirectory, launchSpec);
}

/**
 * 创建当前用户的 daemon launch spec。
 *
 * @returns 通过 Pi 当前 Node 与当前安装扩展启动的固定参数。
 */
function createGatewayServiceControllerSpec(): GatewayDaemonLaunchSpec {
  const managerDirectory = getManagerDataDirectory();
  return {
    managerDirectory,
    extensionPath: fileURLToPath(import.meta.url),
    daemonEntry: fileURLToPath(new URL("../src/runtime/gateway-daemon.ts", import.meta.url)),
    piInvocation: resolveCurrentPiCli(),
  };
}

/**
 * 更新 Windows 登录自动启动任务与用户配置, 失败时尽量回滚外部任务。
 *
 * @param store Hub 全局配置存储。
 * @param launchSpec 独立 daemon 启动参数。
 * @param enabled 是否在当前 Windows 用户登录后自动连接。
 * @returns 配置和 Task Scheduler 状态一致时正常结束。
 */
async function updateWindowsLogonAutoStart(
  store: ConfigurationStore,
  launchSpec: GatewayDaemonLaunchSpec,
  enabled: boolean,
): Promise<void> {
  const current = (await store.load()).config.autoStartOnWindowsLogon;
  const taskManager = new WindowsLogonTaskManager(launchSpec);
  try {
    if (enabled) {
      await taskManager.enable();
    } else {
      await taskManager.disable();
    }
    await store.update((config) => ({ ...config, autoStartOnWindowsLogon: enabled }));
  } catch (error) {
    try {
      if (current) {
        await taskManager.enable();
      } else {
        await taskManager.disable();
      }
    } catch {
      throw new WindowsLogonTaskManagerError(
        "自动启动配置更新失败, 且无法恢复之前的 Windows 登录任务状态。",
      );
    }
    throw error;
  }
}

/**
 * 格式化可在任何 Pi 会话查看的共享 Gateway 状态。
 *
 * @param status 后台 Hub 返回的状态快照。
 * @param autoStart Windows 登录自动启动配置。
 * @returns 面向用户的状态文本。
 */
function formatGatewayServiceStatus(
  status: GatewayServiceStatus,
  autoStart: boolean,
): string {
  const stateText: Record<GatewayServiceStatus["state"], string> = {
    offline: "已停止",
    starting: "启动中",
    online: "已连接",
    auth_required: "需要重新授权",
    stopping: "停止中",
  };
  return [
    `微信连接: ${stateText[status.state]}`,
    `后台进程 PID: ${status.pid ?? "无"}`,
    `前台会话: ${status.foregroundSessionCount ?? 0}`,
    `后台会话: ${status.backgroundSessionCount ?? 0}`,
    `微信 route: ${status.routeCount ?? 0}`,
    `Windows 登录自动启动: ${autoStart ? "开启" : "关闭"}`,
    ...(status.error ? [`状态说明: ${status.error}`] : []),
  ].join("\n");
}

/**
 * 注册 Pi 微信会话枢纽的本地管理命令。
 *
 * @param pi Pi 扩展 API。
 * @returns 无返回值。
 */
export default function registerWechatSessionHub(pi: ExtensionAPI): void {
  const store = createDefaultConfigurationStore();
  const projectService = new ProjectService(store);
  registerUiWorkerBridgeHooks(pi, projectService, getManagerDataDirectory());


  pi.registerCommand("projects", {
    description: "查看和管理 Pi 微信会话枢纽的项目 alias",
    handler: async (args, ctx) => {
      try {
        const command = parseProjectCommand(args);
        if (command.action === "list") {
          const { config, projects } = await projectService.list();
          const lines = projects.length === 0
            ? [
                "尚无已登记项目。",
                config.allowedProjectRoots.length === 0
                  ? "请先在配置文件中设置 allowedProjectRoots。"
                  : "可使用 /projects add 登记项目。",
              ]
            : [
                "已登记项目:",
                ...projects.map(([alias, project]) => {
                  const defaultMark = config.defaultProject === alias ? " (默认)" : "";
                  return `${alias}${defaultMark}: ${project.displayName} - ${project.path}`;
                }),
              ];
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        if (command.action === "add") {
          const project = await projectService.add(
            command.alias,
            command.displayName,
            command.path,
          );
          ctx.ui.notify(
            `项目已登记: ${command.alias} - ${project.displayName}`,
            "info",
          );
          return;
        }

        if (command.action === "remove") {
          await projectService.remove(command.alias);
          ctx.ui.notify(`已移除项目登记: ${command.alias}; 项目目录未删除。`, "info");
          return;
        }

        await projectService.setDefault(command.alias);
        ctx.ui.notify(`默认项目已设置为: ${command.alias}`, "info");
      } catch (error) {
        ctx.ui.notify(toUserMessage(error), "error");
      }
    },
  });

  pi.registerCommand("status", {
    description: "查看 Pi 微信会话枢纽状态",
    handler: async (_args, ctx) => {
      try {
        const snapshot = await store.load();
        const serviceStatus = await createGatewayServiceController().status();
        const projectCount = Object.keys(snapshot.config.projects).length;
        const defaultProject = snapshot.config.defaultProject ?? "未设置";
        ctx.ui.notify(
          [
            "Pi 微信会话枢纽状态:",
            formatGatewayServiceStatus(serviceStatus, snapshot.config.autoStartOnWindowsLogon),
            `配置: ${snapshot.exists ? "已加载" : "尚未创建"}`,
            `项目 alias: ${projectCount}`,
            `默认项目: ${defaultProject}`,
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(toUserMessage(error), "error");
      }
    },
  });

  pi.registerCommand("help", {
    description: "查看 Pi 微信会话枢纽命令帮助",
    handler: async (_args, ctx) => {
      ctx.ui.notify(HELP_TEXT, "info");
    },
  });

  const handleWechatManagerCommand = async (
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    try {
      let commandArguments = args;
      if (!commandArguments.trim()) {
        if (!ctx.hasUI) {
          ctx.ui.notify(HELP_TEXT, "info");
          return;
        }
        const selected = await ctx.ui.select("Pi 微信会话枢纽", [
          "login | 微信扫码授权",
          "start | 启动后台连接",
          "status | 查看连接状态",
          "stop | 确认后停止连接",
          "restart | 重启后台连接",
          "autostart on | 登录 Windows 后自动连接",
          "autostart off | 关闭登录后自动连接",
          "help | 查看帮助",
        ]);
        if (!selected) {
          return;
        }
        commandArguments = selected.split(" | ", 1)[0];
      }

      const command = parseWechatManagerCommand(commandArguments);
      if (command.action === "help") {
        ctx.ui.notify(HELP_TEXT, "info");
        return;
      }
      if (command.action === "login") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("iLink QR 登录需要可见 Pi TUI; 请在本地交互终端执行 /wx login。", "error");
          return;
        }
        const proceed = await ctx.ui.confirm(
          "授权 Pi Hub 使用微信",
          "请确认该微信/iLink 账号没有被其他客户端同时轮询. 继续后 Pi Hub 会申请独立授权, 只写入自己的 credentials.json, 不读取或修改其他客户端数据.",
        );
        if (!proceed) {
          ctx.ui.notify("未发起微信授权。", "info");
          return;
        }
        const abortController = new AbortController();
        const loginService = new IlinkQrLoginService({
          managerDirectory: getManagerDataDirectory(),
          configStore: store,
        });
        const result = await ctx.ui.custom<
          { type: "success"; authorizedUserId: string } | { type: "error"; message: string }
        >((tui, _theme, _keybindings, done) => {
          const component = new IlinkQrLoginComponent(() => abortController.abort());
          void loginService.login({
            signal: abortController.signal,
            onQrCode: (_content, terminalQr) => {
              component.setQr(terminalQr);
              tui.requestRender();
            },
            onStatus: (status) => {
              component.setStatus(status);
              tui.requestRender();
            },
            requestVerificationCode: async () =>
              ctx.ui.input("微信配对码", "输入微信页面显示的数字"),
          }).then((login) => {
            done({ type: "success", authorizedUserId: login.authorizedUserId });
          }).catch((error: unknown) => {
            done({ type: "error", message: toUserMessage(error) });
          });
          return {
            render: (width) => component.render(width),
            handleInput: (data) => component.handleInput(data),
            invalidate: () => component.invalidate(),
          };
        });
        if (result?.type === "success") {
          ctx.ui.notify(
            "微信授权已写入 Pi Hub 专属凭证. 请执行 /wx start 启动后台连接。",
            "info",
          );
        } else {
          ctx.ui.notify(result?.message ?? "扫码授权已取消, 未启动微信轮询。", "warning");
        }
        return;
      }

      const serviceController = createGatewayServiceController();
      if (command.action === "status") {
        const snapshot = await store.load();
        const status = await serviceController.status();
        ctx.ui.notify(formatGatewayServiceStatus(status, snapshot.config.autoStartOnWindowsLogon), "info");
        return;
      }
      if (command.action === "start") {
        const status = await serviceController.start();
        ctx.ui.notify(`后台微信连接: ${status.state === "online" ? "已连接" : "启动中"}.`, "info");
        return;
      }
      if (command.action === "stop") {
        const current = await serviceController.status();
        if (current.state === "offline") {
          ctx.ui.notify("后台微信连接当前已停止。", "info");
          return;
        }
        if (ctx.mode !== "tui") {
          ctx.ui.notify("停止后台连接需要可见 Pi TUI 确认; 已保持服务运行。", "error");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "停止 Pi 微信会话枢纽?",
          "确认后会停止接收新微信消息, 并等待已入队任务和正在处理的 Pi turn 收尾后关闭.",
        );
        if (!confirmed) {
          ctx.ui.notify("已取消停止, 后台微信连接保持运行。", "info");
          return;
        }
        const status = await serviceController.stop();
        ctx.ui.notify(`后台微信连接: ${status.state === "offline" ? "已停止" : "正在停止"}.`, "info");
        return;
      }
      if (command.action === "restart") {
        const status = await serviceController.restart();
        ctx.ui.notify(`后台微信连接: ${status.state === "online" ? "已连接" : "正在重启"}.`, "info");
        return;
      }
      if (command.action === "autostart") {
        await updateWindowsLogonAutoStart(store, createGatewayServiceControllerSpec(), command.enabled);
        ctx.ui.notify(`Windows 用户登录自动启动已${command.enabled ? "开启" : "关闭"}.`, "info");
      }
    } catch (error) {
      ctx.ui.notify(toUserMessage(error), "error");
    }
  };

  const commandOptions = {
    description: "管理独立后台微信连接和 Pi 会话",
    getArgumentCompletions: getWechatManagerCommandCompletions,
    handler: handleWechatManagerCommand,
  };
  pi.registerCommand("wx", commandOptions);
  pi.registerCommand("wechat-manager", {
    ...commandOptions,
    description: "兼容别名: 请优先使用 /wx",
  });
}

function toUserMessage(error: unknown): string {
  if (
    error instanceof ProjectCommandParseError ||
    error instanceof ProjectServiceError ||
    error instanceof ConfigurationBusyError ||
    error instanceof ConfigurationValidationError ||
    error instanceof WechatManagerCommandParseError ||
    error instanceof GatewayControlError ||
    error instanceof WindowsLogonTaskManagerError ||
    error instanceof IlinkApiError ||
    error instanceof IlinkCredentialStoreError ||
    error instanceof IlinkQrLoginError ||
    error instanceof BackgroundWorkerManagerError ||
    error instanceof UiWorkerManagerError ||
    error instanceof UiWorkerIpcError ||
    error instanceof PiCliUnavailableError
  ) {
    return error.message;
  }
  return "操作失败, 请检查项目配置和本地目录权限。详细信息不会记录到普通日志。";
}
