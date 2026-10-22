import { isAbsolute } from "node:path";
import { createDefaultConfiguration } from "./defaults.ts";
import { getCredentialFilePath } from "./paths.ts";
import type {
  ManagerConfiguration,
  ProjectDefinition,
  RuntimeConfiguration,
  RuntimeMode,
  WechatConfiguration,
} from "./types.ts";

const PROJECT_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * 表示配置文件结构或字段不符合当前 schema。
 */
export class ConfigurationValidationError extends Error {
  /**
   * 创建配置校验错误。
   *
   * @param message 面向用户的中文错误信息。
   */
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationValidationError";
  }
}

/**
 * 校验并规范化 Pi 微信会话枢纽配置, 同时保留未知字段。
 *
 * @param value 从 JSON 解码得到的任意值。
 * @param credentialFile 默认独立凭证文件路径。
 * @returns 符合 schemaVersion 1 的配置对象。
 * @throws {ConfigurationValidationError} 配置字段非法时抛出。
 */
export function validateConfiguration(
  value: unknown,
  credentialFile = getCredentialFilePath(),
): ManagerConfiguration {
  const input = asRecord(value, "配置根节点");
  const defaults = createDefaultConfiguration(credentialFile);
  const inputWechat = input.wechat === undefined
    ? {}
    : asRecord(input.wechat, "wechat");
  const inputRuntime = input.runtime === undefined
    ? {}
    : asRecord(input.runtime, "runtime");

  const candidate: Record<string, unknown> = {
    ...defaults,
    ...input,
    wechat: {
      ...defaults.wechat,
      ...inputWechat,
    },
    runtime: {
      ...defaults.runtime,
      ...inputRuntime,
    },
    allowedProjectRoots: input.allowedProjectRoots ?? defaults.allowedProjectRoots,
    projects: input.projects ?? defaults.projects,
  };

  if (candidate.schemaVersion !== 1) {
    throw new ConfigurationValidationError("配置 schemaVersion 必须为 1。");
  }
  if (typeof candidate.autoStartOnWindowsLogon !== "boolean") {
    throw new ConfigurationValidationError("autoStartOnWindowsLogon 必须是布尔值。");
  }

  if (candidate.defaultMode !== "background" && candidate.defaultMode !== "ui") {
    throw new ConfigurationValidationError("defaultMode 只能是 background 或 ui。");
  }

  if (!Array.isArray(candidate.allowedProjectRoots)) {
    throw new ConfigurationValidationError("allowedProjectRoots 必须是路径数组。");
  }

  const allowedProjectRoots = candidate.allowedProjectRoots.map((root, index) => {
    if (typeof root !== "string" || !root.trim() || !isAbsolute(root)) {
      throw new ConfigurationValidationError(
        `allowedProjectRoots[${index}] 必须是非空绝对路径。`,
      );
    }
    return root;
  });

  const rawProjects = asRecord(candidate.projects, "projects");
  const projectEntries: Array<[string, ProjectDefinition]> = [];
  for (const [alias, rawProject] of Object.entries(rawProjects)) {
    assertProjectAlias(alias);
    const project = asRecord(rawProject, `projects.${alias}`);
    if (typeof project.displayName !== "string" || !project.displayName.trim()) {
      throw new ConfigurationValidationError(
        `projects.${alias}.displayName 必须是非空字符串。`,
      );
    }
    if (typeof project.path !== "string" || !project.path.trim() || !isAbsolute(project.path)) {
      throw new ConfigurationValidationError(
        `projects.${alias}.path 必须是非空绝对路径。`,
      );
    }
    projectEntries.push([
      alias,
      {
        ...project,
        displayName: project.displayName.trim(),
        path: project.path,
      },
    ]);
  }
  const projects = Object.fromEntries(projectEntries) as Record<string, ProjectDefinition>;

  const inputDefaultProject = candidate.defaultProject;
  if (inputDefaultProject !== undefined) {
    if (typeof inputDefaultProject !== "string") {
      throw new ConfigurationValidationError("defaultProject 必须是项目 alias 字符串。");
    }
    assertProjectAlias(inputDefaultProject);
    if (!Object.hasOwn(projects, inputDefaultProject)) {
      throw new ConfigurationValidationError(
        `defaultProject 引用了未登记的项目 alias: ${inputDefaultProject}。`,
      );
    }
  }

  const wechat = validateWechat(candidate.wechat);
  const runtime = validateRuntime(candidate.runtime);

  return {
    ...candidate,
    schemaVersion: 1,
    defaultMode: candidate.defaultMode as RuntimeMode,
    ...(inputDefaultProject === undefined ? {} : { defaultProject: inputDefaultProject }),
    allowedProjectRoots,
    projects,
    wechat,
    runtime,
  } as ManagerConfiguration;
}

/**
 * 校验稳定项目 alias 的格式。
 *
 * @param alias 待校验的项目 alias。
 * @throws {ConfigurationValidationError} alias 不符合格式时抛出。
 */
export function assertProjectAlias(alias: string): void {
  if (!PROJECT_ALIAS_PATTERN.test(alias)) {
    throw new ConfigurationValidationError(
      "项目 alias 需为 1-32 位小写字母、数字、下划线或连字符, 且以字母或数字开头。",
    );
  }
}

/**
 * 将未知值校验为普通对象。
 *
 * @param value 待校验值。
 * @param label 错误信息中使用的字段名。
 * @returns 普通键值对象。
 * @throws {ConfigurationValidationError} 值不是普通对象时抛出。
 */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationValidationError(`${label} 必须是 JSON 对象。`);
  }
  return value as Record<string, unknown>;
}

/**
 * 校验微信配置并保留扩展字段。
 *
 * @param value 待校验值。
 * @returns 微信配置对象。
 */
function validateWechat(value: unknown): WechatConfiguration {
  const wechat = asRecord(value, "wechat");
  if (typeof wechat.authorizedUserId !== "string") {
    throw new ConfigurationValidationError("wechat.authorizedUserId 必须是字符串。");
  }
  if (
    typeof wechat.credentialFile !== "string" ||
    !wechat.credentialFile.trim() ||
    !isAbsolute(wechat.credentialFile)
  ) {
    throw new ConfigurationValidationError("wechat.credentialFile 必须是非空绝对路径。");
  }
  return wechat as WechatConfiguration;
}

/**
 * 校验运行时参数并保留扩展字段。
 *
 * @param value 待校验值。
 * @returns 运行时配置对象。
 */
function validateRuntime(value: unknown): RuntimeConfiguration {
  const runtime = asRecord(value, "runtime");
  const fields: Array<keyof RuntimeConfiguration> = [
    "heartbeatIntervalMs",
    "staleAfterMs",
    "maxBackgroundWorkers",
    "maxQueuePerSession",
  ];
  for (const field of fields) {
    const fieldValue = runtime[field];
    if (typeof fieldValue !== "number" || !Number.isInteger(fieldValue) || fieldValue <= 0) {
      throw new ConfigurationValidationError(`runtime.${field} 必须是正整数。`);
    }
  }
  const staleAfterMs = runtime.staleAfterMs as number;
  const heartbeatIntervalMs = runtime.heartbeatIntervalMs as number;
  if (staleAfterMs <= heartbeatIntervalMs) {
    throw new ConfigurationValidationError(
      "runtime.staleAfterMs 必须大于 runtime.heartbeatIntervalMs。",
    );
  }
  return runtime as RuntimeConfiguration;
}
