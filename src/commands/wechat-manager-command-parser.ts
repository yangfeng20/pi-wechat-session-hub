export type WechatManagerCommand =
  | { action: "help" }
  | { action: "login" }
  | { action: "start" }
  | { action: "stop" }
  | { action: "status" };

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
 * 解析 Gateway 本地登录/启停命令, 不接受路径、shell 命令或其他参数。
 *
 * @param args /wechat-manager 后的原始字符串。
 * @returns help、login、start、stop 或 status 控制动作。
 * @throws {WechatManagerCommandParseError} 出现未知动作或额外参数时抛出。
 */
export function parseWechatManagerCommand(args: string): WechatManagerCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { action: "help" };
  }
  if (tokens.length !== 1) {
    throw new WechatManagerCommandParseError(
      "用法: /wechat-manager [login|start|stop|status]。",
    );
  }
  switch (tokens[0]) {
    case "login":
    case "start":
    case "stop":
    case "status":
      return { action: tokens[0] };
    default:
      throw new WechatManagerCommandParseError(
        "未知 /wechat-manager 动作; 用法: /wechat-manager [login|start|stop|status]。",
      );
  }
}
