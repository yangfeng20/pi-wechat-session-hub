import { CommandTokenizeError, tokenizeCommandArguments } from "./tokenizer.ts";
import { parseProjectCommand, type ProjectCommand, ProjectCommandParseError } from "./project-command-parser.ts";

export type WechatManagerCommand =
  | { action: "help" }
  | { action: "login" }
  | { action: "start" }
  | { action: "stop" }
  | { action: "restart" }
  | { action: "status" }
  | { action: "autostart"; enabled: boolean }
  | { action: "projects"; command: ProjectCommand }
  | { action: "roots"; operation: "list" | "add-current" | "add"; path?: string };

export interface WechatManagerCommandCompletion {
  value: string;
  label: string;
  description: string;
}

const COMMAND_COMPLETIONS: WechatManagerCommandCompletion[] = [
  { value: "login", label: "login", description: "使用微信扫码授权" },
  { value: "start", label: "start", description: "启动后台微信连接" },
  { value: "status", label: "status", description: "查看连接和会话状态" },
  { value: "stop", label: "stop", description: "确认后停止后台连接" },
  { value: "restart", label: "restart", description: "重启后台连接" },
  { value: "autostart on", label: "autostart on", description: "登录 Windows 后自动连接" },
  { value: "autostart off", label: "autostart off", description: "关闭登录后自动连接" },
  { value: "projects", label: "projects", description: "查看和管理项目" },
  { value: "projects add", label: "projects add", description: "手动登记项目" },
  { value: "projects default", label: "projects default", description: "设置默认项目" },
  { value: "roots", label: "roots", description: "查看授权根目录" },
  { value: "roots add-current", label: "roots add-current", description: "授权当前目录及其子目录" },
  { value: "roots add", label: "roots add", description: "添加一个授权根目录" },
  { value: "help", label: "help", description: "查看命令说明" },
];

/**
 * 表示 /wx 参数不符合受支持的控制命令.
 */
export class WechatManagerCommandParseError extends Error {
  /**
   * 创建命令参数错误.
   *
   * @param message 可安全显示的中文用法说明.
   */
  constructor(message: string) {
    super(message);
    this.name = "WechatManagerCommandParseError";
  }
}

/**
 * 解析 Hub 本机命令, 不接受 shell 命令或未声明的参数.
 *
 * @param args /wx 命令前缀后的原始字符串.
 * @returns 已验证的本机控制动作.
 * @throws {WechatManagerCommandParseError} 出现未知动作或额外参数时抛出.
 */
export function parseWechatManagerCommand(args: string): WechatManagerCommand {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "help" };
  }
  const projectsMatch = trimmed.match(/^projects(?:\s+([\s\S]*))?$/i);
  if (projectsMatch) {
    try {
      return {
        action: "projects",
        command: parseProjectCommand(projectsMatch[1] ?? ""),
      };
    } catch (error) {
      if (error instanceof ProjectCommandParseError) {
        throw new WechatManagerCommandParseError(error.message);
      }
      throw error;
    }
  }

  let tokens: string[];
  try {
    tokens = tokenizeCommandArguments(trimmed);
  } catch (error) {
    if (error instanceof CommandTokenizeError) {
      throw new WechatManagerCommandParseError(`${error.message}\n${COMMAND_USAGE}`);
    }
    throw error;
  }
  if (tokens.length === 1) {
    switch (tokens[0]) {
      case "login":
      case "start":
      case "stop":
      case "restart":
      case "status":
      case "help":
        return { action: tokens[0] };
      case "roots":
        return { action: "roots", operation: "list" };
      default:
        break;
    }
  }
  if (tokens[0] === "roots") {
    if (tokens.length === 2 && tokens[1] === "list") {
      return { action: "roots", operation: "list" };
    }
    if (tokens.length === 2 && tokens[1] === "add-current") {
      return { action: "roots", operation: "add-current" };
    }
    if (tokens.length === 3 && tokens[1] === "add" && tokens[2].trim()) {
      return { action: "roots", operation: "add", path: tokens[2] };
    }
  }
  if (tokens.length === 2 && tokens[0] === "autostart") {
    if (tokens[1] === "on") {
      return { action: "autostart", enabled: true };
    }
    if (tokens[1] === "off") {
      return { action: "autostart", enabled: false };
    }
  }
  throw new WechatManagerCommandParseError(COMMAND_USAGE);
}

/**
 * 提供 /wx 命令参数补全项.
 *
 * @param prefix 当前光标前的命令参数前缀.
 * @returns 匹配项, 无匹配时返回 null.
 */
export function getWechatManagerCommandCompletions(
  prefix: string,
): WechatManagerCommandCompletion[] | null {
  const normalizedPrefix = prefix.trimStart().toLowerCase();
  const matches = COMMAND_COMPLETIONS.filter((completion) =>
    completion.value.toLowerCase().startsWith(normalizedPrefix),
  );
  return matches.length > 0 ? matches.map((completion) => ({ ...completion })) : null;
}

const COMMAND_USAGE =
  "用法: /wx [login|start|stop|restart|status|projects|roots|autostart on|autostart off|help]";
