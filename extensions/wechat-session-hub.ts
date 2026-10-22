import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import {
  ConfigurationBusyError,
  createDefaultConfigurationStore,
} from "../src/config/store.ts";
import { ConfigurationValidationError } from "../src/config/validation.ts";
import { parseProjectCommand, ProjectCommandParseError } from "../src/commands/project-command-parser.ts";
import { IlinkQrLoginComponent } from "../src/commands/ilink-qr-login-component.ts";
import {
  parseWechatManagerCommand,
  WechatManagerCommandParseError,
} from "../src/commands/wechat-manager-command-parser.ts";
import { getManagerDataDirectory } from "../src/config/paths.ts";
import { GatewayLeaseError } from "../src/registry/gateway-lease.ts";
import { GatewayRuntime, GatewayRuntimeError } from "../src/gateway/gateway-runtime.ts";
import { registerUiWorkerBridgeHooks, isUiWorkerBridgeActive } from "../src/gateway/ui-worker-extension-bridge.ts";
import { UiWorkerIpcError } from "../src/gateway/ui-worker-ipc.ts";
import { IlinkApiError } from "../src/gateway/wechat-ilink/api-client.ts";
import { IlinkCredentialStoreError } from "../src/gateway/credential-store.ts";
import { IlinkQrLoginError, IlinkQrLoginService } from "../src/gateway/wechat-ilink/qr-login.ts";
import { BackgroundWorkerManagerError } from "../src/runtime/background-worker-manager.ts";
import { UiWorkerManagerError } from "../src/runtime/ui-worker-manager.ts";
import { PiCliUnavailableError } from "../src/runtime/pi-cli.ts";
import { ProjectService, ProjectServiceError } from "../src/projects/project-service.ts";

const HELP_TEXT = [
  "Pi 微信会话枢纽命令:",
  "/projects - 查看已登记项目",
  "/projects add <alias> --name <名称> --path <绝对路径> - 登记项目",
  "/projects remove <alias> - 移除登记, 不删除目录",
  "/projects default <alias> - 设置默认项目",
  "/wechat-manager [login|start|stop|status] - 授权微信并启停 iLink Gateway",
  "  login - 使用独立二维码授权 Pi Hub, 不导入其他客户端凭证",
  "  start - 启动 iLink 消息轮询",
  "  stop - 停止 Gateway 和后台 worker",
  "  status - 查看 Gateway 状态",
  "/status - 查看管理器状态",
  "/help - 查看命令帮助",
].join("\n");

const runtimeProcess = process as NodeJS.Process & { piWechatSessionHubRuntime?: GatewayRuntime };
let activeGatewayRuntime = runtimeProcess.piWechatSessionHubRuntime;

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

  pi.on("session_shutdown", async () => {
    const runtime = activeGatewayRuntime;
    if (!runtime) {
      return;
    }
    try {
      await runtime.stop();
    } catch {
      if (runtime.status === "stopped") {
        setActiveGatewayRuntime(undefined);
      }
      return;
    }
    if (activeGatewayRuntime === runtime) {
      setActiveGatewayRuntime(undefined);
    }
  });

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
        const projectCount = Object.keys(snapshot.config.projects).length;
        const defaultProject = snapshot.config.defaultProject ?? "未设置";
        const gatewayStatus = activeGatewayRuntime?.status ?? "当前扩展实例未启动";
        ctx.ui.notify(
          [
            "Pi 微信会话枢纽状态:",
            `Gateway: ${gatewayStatus}`,
            `微信 iLink: ${activeGatewayRuntime?.status === "online" ? "轮询中" : "未连接或需检查状态"}`,
            `配置: ${snapshot.exists ? "已加载" : "尚未创建"}`,
            `项目 alias: ${projectCount}`,
            `默认项目: ${defaultProject}`,
            "Pi worker: Gateway runtime 管理 background RPC 与 UI TUI tab",
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

  pi.registerCommand("wechat-manager", {
    description: "通过独立 QR 授权微信, 启停 Pi 微信会话枢纽 Gateway 并查看状态",
    handler: async (args, ctx) => {
      try {
        const command = parseWechatManagerCommand(args);
        if (command.action === "help") {
          ctx.ui.notify(HELP_TEXT, "info");
          return;
        }
        if (command.action === "status") {
          ctx.ui.notify(`Gateway: ${activeGatewayRuntime?.status ?? "当前扩展实例未启动"}`, "info");
          return;
        }
        if (command.action === "login") {
          if (ctx.mode !== "tui") {
            ctx.ui.notify("iLink QR 登录需要可见 Pi TUI; 请在本地交互终端执行 /wechat-manager login。", "error");
            return;
          }
          if (isUiWorkerBridgeActive()) {
            ctx.ui.notify("请在独立的 Pi 管理会话中执行扫码授权, 不要在 UI worker tab 中操作。", "error");
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
              "微信授权已写入 Pi Hub 专属凭证. 请确保该账号没有其他活跃轮询器, 再执行 /wechat-manager start。",
              "info",
            );
          } else {
            ctx.ui.notify(result?.message ?? "扫码授权已取消, 未启动微信轮询。", "warning");
          }
          return;
        }
        if (command.action === "start") {
          if (isUiWorkerBridgeActive()) {
            ctx.ui.notify("可见 UI worker tab 不能同时承载 Gateway owner; 请在独立的 Pi 管理会话中启动。", "error");
            return;
          }
          if (activeGatewayRuntime) {
            ctx.ui.notify(`Gateway 已在当前扩展实例运行: ${activeGatewayRuntime.status}`, "info");
            return;
          }
          const runtime = await GatewayRuntime.start({
            dataDirectory: getManagerDataDirectory(),
            configStore: store,
            projectService,
            extensionPath: fileURLToPath(import.meta.url),
          });
          setActiveGatewayRuntime(runtime);
          ctx.ui.notify("Gateway 已启动; 使用 /wechat-manager status 查看状态, /wechat-manager stop 优雅停止。", "info");
          return;
        }

        if (!activeGatewayRuntime) {
          ctx.ui.notify("当前 Pi 扩展实例没有运行中的 Gateway。", "info");
          return;
        }
        const runtime = activeGatewayRuntime;
        await runtime.stop();
        if (activeGatewayRuntime === runtime) {
          setActiveGatewayRuntime(undefined);
        }
        ctx.ui.notify("Gateway 与后台 worker 已停止。", "info");
      } catch (error) {
        if (activeGatewayRuntime?.status === "stopped") {
          setActiveGatewayRuntime(undefined);
        }
        ctx.ui.notify(toUserMessage(error), "error");
      }
    },
  });
}

/**
 * 持久化当前 Pi Node 进程内的 Gateway 引用, 以便 session 切换后仍可安全停止。
 *
 * @param runtime 活跃 Gateway; 传 undefined 表示已停止。
 * @returns 无返回值。
 */
function setActiveGatewayRuntime(runtime: GatewayRuntime | undefined): void {
  activeGatewayRuntime = runtime;
  if (runtime) {
    runtimeProcess.piWechatSessionHubRuntime = runtime;
  } else {
    delete runtimeProcess.piWechatSessionHubRuntime;
  }
}

/**
 * 将内部错误转换为不包含配置内容或凭证的用户提示。
 *
 * @param error 捕获到的错误。
 * @returns 可安全显示的中文错误信息。
 */
function toUserMessage(error: unknown): string {
  if (
    error instanceof ProjectCommandParseError ||
    error instanceof ProjectServiceError ||
    error instanceof ConfigurationBusyError ||
    error instanceof ConfigurationValidationError ||
    error instanceof WechatManagerCommandParseError ||
    error instanceof GatewayRuntimeError ||
    error instanceof GatewayLeaseError ||
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
