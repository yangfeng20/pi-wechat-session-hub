import { tokenizeCommandArguments, CommandTokenizeError } from "../commands/tokenizer.ts";
import type { RuntimeMode } from "../config/types.ts";

export type GatewayCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "projects"; arguments: string }
  | { kind: "new"; mode?: RuntimeMode; projectAlias?: string; name?: string }
  | { kind: "sessions"; projectAlias?: string; state: "default" | "active" | "saved" | "pending" | "all"; page: number }
  | { kind: "resume"; selector: string }
  | { kind: "stop"; selector?: string }
  | { kind: "retry"; messageId: string; confirmed: boolean }
  | { kind: "prompt"; text: string };

/**
 * 表示 Gateway slash command 参数非法。
 */
export class GatewayCommandParseError extends Error {
  /**
   * 创建 command parse 错误。
   *
   * @param message 面向用户的中文说明。
   */
  constructor(message: string) {
    super(message);
    this.name = "GatewayCommandParseError";
  }
}

/**
 * 将入站文本解析为控制命令或普通 prompt。
 *
 * @param text 微信消息正文。
 * @returns 规范化命令对象。
 * @throws {GatewayCommandParseError} 已知命令的参数不合法时抛出。
 */
export function parseGatewayCommand(text: string): GatewayCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { kind: "prompt", text };
  }

  let tokens: string[];
  try {
    tokens = tokenizeCommandArguments(trimmed);
  } catch (error) {
    if (error instanceof CommandTokenizeError) {
      throw new GatewayCommandParseError(error.message);
    }
    throw error;
  }
  if (tokens.length === 0) {
    throw usageError();
  }

  const commandName = tokens[0].slice(1).toLowerCase();
  const arguments_ = tokens.slice(1);
  if (commandName === "help") {
    ensureNoArguments(arguments_);
    return { kind: "help" };
  }
  if (commandName === "status") {
    ensureNoArguments(arguments_);
    return { kind: "status" };
  }
  if (commandName === "projects") {
    return {
      kind: "projects",
      arguments: extractRawArguments(trimmed),
    };
  }
  if (commandName === "new") {
    return parseNewCommand(arguments_);
  }
  if (commandName === "sessions") {
    return parseSessionsCommand(arguments_);
  }
  if (commandName === "resume") {
    return parseResumeCommand(arguments_);
  }
  if (commandName === "stop") {
    if (arguments_.length > 1 || (arguments_.length === 1 && !arguments_[0].trim())) {
      throw usageError();
    }
    return {
      kind: "stop",
      ...(arguments_[0] ? { selector: arguments_[0] } : {}),
    };
  }
  if (commandName === "retry") {
    if (
      arguments_.length < 1 ||
      arguments_.length > 2 ||
      !arguments_[0].trim() ||
      (arguments_[1] !== undefined && arguments_[1] !== "--confirm")
    ) {
      throw usageError();
    }
    return {
      kind: "retry",
      messageId: arguments_[0],
      confirmed: arguments_[1] === "--confirm",
    };
  }

  throw new GatewayCommandParseError(
    `未知命令: /${commandName}。发送 /help 查看支持的命令。`,
  );
}

/**
 * 解析 /new 参数。
 *
 * @param arguments_ 去掉命令名后的 token 列表。
 * @returns 新建 session 参数。
 */
function parseNewCommand(arguments_: string[]): GatewayCommand {
  const options = readOptions(arguments_, ["mode", "project", "name"]);
  const mode = parseMode(options.get("mode"));
  const projectAlias = options.get("project");
  const name = options.get("name");
  if (projectAlias !== undefined && !projectAlias.trim()) {
    throw usageError();
  }
  if (name !== undefined && (!name.trim() || name.length > 100)) {
    throw new GatewayCommandParseError("session name 需为 1-100 个字符。");
  }
  return {
    kind: "new",
    ...(mode ? { mode } : {}),
    ...(projectAlias ? { projectAlias } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * 解析 /sessions 参数。
 *
 * @param arguments_ 去掉命令名后的 token 列表。
 * @returns session 列表过滤参数。
 */
function parseSessionsCommand(arguments_: string[]): GatewayCommand {
  const options = readOptions(arguments_, ["project", "state", "page"]);
  const projectAlias = options.get("project");
  const state = options.get("state") ?? "active";
  const pageText = options.get("page") ?? "1";
  const page = Number(pageText);
  if (!Number.isInteger(page) || page < 1) {
    throw new GatewayCommandParseError("page 必须是大于 0 的整数。");
  }
  if (
    state !== "default" &&
    state !== "active" &&
    state !== "saved" &&
    state !== "pending" &&
    state !== "all"
  ) {
    throw new GatewayCommandParseError("state 只能是 default、active、saved、pending 或 all。");
  }
  return {
    kind: "sessions",
    ...(projectAlias ? { projectAlias } : {}),
    state,
    page,
  };
}

/**
 * 解析 /resume 参数。
 *
 * @param arguments_ 去掉命令名后的 token 列表。
 * @returns 恢复 session 参数。
 */
function parseResumeCommand(arguments_: string[]): GatewayCommand {
  if (arguments_.length !== 1 || !arguments_[0].trim()) {
    throw usageError();
  }
  return {
    kind: "resume",
    selector: arguments_[0],
  };
}

/**
 * 解析新会话运行模式。
 *
 * @param value 模式参数。
 * @returns 已指定的运行模式, 未指定时返回 undefined。
 * @throws {GatewayCommandParseError} 模式不是 background 或 ui 时抛出。
 */
function parseMode(value: string | undefined): RuntimeMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "background" && value !== "ui") {
    throw new GatewayCommandParseError("mode 只能是 background 或 ui。");
  }
  return value;
}

/**
 * 解析指定白名单内的 long options。
 *
 * @param tokens 参数 token 列表。
 * @param allowed 允许选项名。
 * @returns 选项和值映射。
 * @throws {GatewayCommandParseError} 参数格式非法时抛出。
 */
function readOptions(tokens: string[], allowed: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw usageError();
    }
    const equalsIndex = token.indexOf("=");
    const key = equalsIndex >= 0 ? token.slice(2, equalsIndex) : token.slice(2);
    const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
    if (!allowed.includes(key)) {
      throw new GatewayCommandParseError(`未知参数: --${key}。\n${GATEWAY_COMMAND_USAGE}`);
    }
    if (options.has(key)) {
      throw new GatewayCommandParseError(`参数 --${key} 不能重复。\n${GATEWAY_COMMAND_USAGE}`);
    }
    const value = inlineValue ?? tokens[index + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
      throw usageError();
    }
    options.set(key, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  return options;
}

/**
 * 检查命令不包含额外参数。
 *
 * @param arguments_ 去掉命令名后的 token 列表。
 * @returns 无返回值。
 * @throws {GatewayCommandParseError} 存在额外参数时抛出。
 */
function ensureNoArguments(arguments_: string[]): void {
  if (arguments_.length > 0) {
    throw usageError();
  }
}

/**
 * 获取 /projects 后的原始文本, 保留路径参数的原始引号。
 *
 * @param input 完整命令文本。
 * @returns /projects 后的原始参数。
 */
function extractRawArguments(input: string): string {
  const match = input.match(/^\s*\/projects(?:\s+([\s\S]*))?$/i);
  return match?.[1]?.trim() ?? "";
}

const GATEWAY_COMMAND_USAGE =
  "用法: /new [--mode background|ui] [--project <alias>] [--name <名称>] | /sessions [--project <alias>] [--state active|saved|pending|all] [--page <n>] | /resume <会话索引|名称> | /stop [会话索引|名称] | /retry <message-id> --confirm | /status | /projects | /help";

/**
 * 创建统一格式的 command usage 错误。
 *
 * @returns Gateway command parse 错误。
 */
function usageError(): GatewayCommandParseError {
  return new GatewayCommandParseError(GATEWAY_COMMAND_USAGE);
}
