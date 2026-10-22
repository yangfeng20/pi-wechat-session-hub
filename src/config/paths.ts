import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * 获取 Pi 微信会话枢纽的数据目录。
 *
 * @param agentDirectory Pi agent 目录, 可为空以使用默认目录。
 * @param homeDirectory 用户主目录, 用于测试时注入。
 * @returns 规范化后的数据目录绝对路径。
 */
export function getManagerDataDirectory(
  agentDirectory = process.env.PI_CODING_AGENT_DIR,
  homeDirectory = homedir(),
): string {
  const baseDirectory = agentDirectory?.trim()
    ? isAbsolute(agentDirectory)
      ? agentDirectory
      : resolve(homeDirectory, agentDirectory)
    : join(homeDirectory, ".pi", "agent");

  return join(baseDirectory, "wechat-session-manager");
}

/**
 * 获取 Pi 微信会话枢纽配置文件的绝对路径。
 *
 * @param agentDirectory Pi agent 目录, 可为空以使用默认目录。
 * @param homeDirectory 用户主目录, 用于测试时注入。
 * @returns 配置文件绝对路径。
 */
export function getManagerConfigurationPath(
  agentDirectory = process.env.PI_CODING_AGENT_DIR,
  homeDirectory = homedir(),
): string {
  const baseDirectory = agentDirectory?.trim()
    ? isAbsolute(agentDirectory)
      ? agentDirectory
      : resolve(homeDirectory, agentDirectory)
    : join(homeDirectory, ".pi", "agent");

  return join(baseDirectory, "wechat-session-manager.json");
}

/**
 * 获取凭证文件路径。此函数只计算路径, 不读取或写入凭证。
 *
 * @param agentDirectory Pi agent 目录, 可为空以使用默认目录。
 * @param homeDirectory 用户主目录, 用于测试时注入。
 * @returns 独立凭证文件绝对路径。
 */
export function getCredentialFilePath(
  agentDirectory = process.env.PI_CODING_AGENT_DIR,
  homeDirectory = homedir(),
): string {
  return join(getManagerDataDirectory(agentDirectory, homeDirectory), "credentials.json");
}
