export type WechatManagerCommand =
  | { action: "help" }
  | { action: "login" }
  | { action: "start" }
  | { action: "stop" }
  | { action: "restart" }
  | { action: "status" }
  | { action: "autostart"; enabled: boolean };

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
  { value: "help", label: "help", description: "查看命令说明" },
];

/**
 * 表示 /wechat-manager 参数不符合受支持的控制命令。
 */
export class WechatManagerCommandParseError extends Error {
  /**
   * 创建命令参数错误。
   *
   * @param message 可安全显示的中文用法说明。
   */
  constructor(message: string) {
    super(message);
    this.name = "WechatManagerCommandParseError";
  }
}

/**
 * 解析 Hub 本地登录、启停和自启动命令, 不接受路径、shell 命令或其他参数。
 *
 * @param args 命令前缀后的原始字符串。
 * @returns 已验证的本地控制动作。
 * @throws {WechatManagerCommandParseError} 出现未知动作或额外参数时抛出。
 */
export function parseWechatManagerCommand(args: string): WechatManagerCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { action: "help" };
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
      default:
        throw new WechatManagerCommandParseError(
          "未知 /wx 动作; 用法: /wx [login|start|stop|restart|status|autostart on|autostart off]。",
        );
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
  throw new WechatManagerCommandParseError(
    "用法: /wx [login|start|stop|restart|status|autostart on|autostart off]。",
  );
}

/**
 * 提供短前缀命令的 Pi 参数补全项。
 *
 * @param prefix 当前光标前的命令参数前缀。
 * @returns 匹配项, 无匹配时返回 null。
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
