import { CommandTokenizeError, tokenizeCommandArguments } from "./tokenizer.ts";

export type ProjectCommand =
  | { action: "list" }
  | { action: "add"; alias: string; displayName: string; path: string }
  | { action: "remove"; alias: string }
  | { action: "default"; alias: string };

/**
 * 表示 /projects 命令参数格式错误。
 */
export class ProjectCommandParseError extends Error {
  /**
   * 创建命令参数错误。
   *
   * @param message 面向用户的中文错误信息。
   */
  constructor(message: string) {
    super(message);
    this.name = "ProjectCommandParseError";
  }
}

/**
 * 解析 /projects 子命令, 并支持带空格的单引号或双引号参数。
 *
 * @param input Pi command handler 收到的原始参数。
 * @returns 规范化后的项目命令。
 * @throws {ProjectCommandParseError} 参数格式不合法时抛出。
 */
export function parseProjectCommand(input: string): ProjectCommand {
  let tokens: string[];
  try {
    tokens = tokenizeCommandArguments(input);
  } catch (error) {
    if (error instanceof CommandTokenizeError) {
      throw new ProjectCommandParseError(`${error.message}\n${PROJECT_COMMAND_USAGE}`);
    }
    throw error;
  }
  if (tokens.length === 0 || tokens[0] === "list") {
    if (tokens.length > 1) {
      throw usageError();
    }
    return { action: "list" };
  }

  const [action, alias, ...arguments_] = tokens;
  if (action === "remove" || action === "default") {
    if (!alias || arguments_.length > 0) {
      throw usageError();
    }
    return { action, alias };
  }

  if (action !== "add" || !alias) {
    throw usageError();
  }

  const options = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) {
      throw usageError();
    }
    const equalsIndex = argument.indexOf("=");
    const optionName = equalsIndex >= 0 ? argument.slice(2, equalsIndex) : argument.slice(2);
    const inlineValue = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : undefined;
    if (optionName !== "name" && optionName !== "path") {
      throw new ProjectCommandParseError(`未知参数: --${optionName}。\n${PROJECT_COMMAND_USAGE}`);
    }
    if (options.has(optionName)) {
      throw new ProjectCommandParseError(`参数 --${optionName} 不能重复。\n${PROJECT_COMMAND_USAGE}`);
    }
    const value = inlineValue ?? arguments_[index + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
      throw usageError();
    }
    options.set(optionName, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const displayName = options.get("name");
  const path = options.get("path");
  if (!displayName || !path) {
    throw usageError();
  }
  return {
    action: "add",
    alias,
    displayName,
    path,
  };
}

const PROJECT_COMMAND_USAGE =
  "用法: /projects | /projects add <alias> --name <名称> --path <绝对路径> | /projects remove <alias> | /projects default <alias>";

/**
 * 创建统一格式的命令用法错误。
 *
 * @returns 命令参数错误。
 */
function usageError(): ProjectCommandParseError {
  return new ProjectCommandParseError(PROJECT_COMMAND_USAGE);
}
