import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { ConfigurationStore } from "../config/store.ts";
import { assertProjectAlias } from "../config/validation.ts";
import type { ManagerConfiguration, ProjectDefinition } from "../config/types.ts";

export type ProjectServiceErrorCode =
  | "invalid_alias"
  | "duplicate_alias"
  | "project_alias_not_found"
  | "invalid_display_name"
  | "project_path_denied"
  | "project_directory_not_found"
  | "allowed_root_not_found";

/**
 * 表示项目 alias 或目录校验失败。
 */
export class ProjectServiceError extends Error {
  /**
   * 创建项目服务错误。
   *
   * @param code 稳定错误代码。
   * @param message 面向用户的中文错误信息。
   */
  constructor(
    readonly code: ProjectServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectServiceError";
  }
}

/**
 * 管理已登记项目及默认项目, 不执行 shell 命令或删除项目目录。
 */
export class ProjectService {
  /**
   * 创建项目服务。
   *
   * @param store 项目配置存储。
   */
  constructor(private readonly store: ConfigurationStore) {}

  /**
   * 列出已登记项目并按 alias 排序。
   *
   * @returns 当前配置和项目列表。
   */
  async list(): Promise<{
    config: ManagerConfiguration;
    projects: Array<[string, ProjectDefinition]>;
  }> {
    const { config } = await this.store.load();
    const projects = Object.entries(config.projects).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return { config, projects };
  }

  /**
   * 添加一个授权根目录, 后续该目录及其子目录可自动接入 Hub.
   *
   * @param rootPath 用户明确授权的目录.
   * @returns 已规范化的根目录.
   * @throws {ProjectServiceError} 目录不存在或不是绝对路径时抛出.
   */
  async addAllowedRoot(rootPath: string): Promise<string> {
    if (!isAbsolute(rootPath)) {
      throw new ProjectServiceError("project_path_denied", "授权根目录必须是绝对路径.");
    }
    const canonicalRoot = await getCanonicalDirectory(rootPath, "allowed_root_not_found");
    await this.store.update(async (config) => {
      const canonicalRoots = await Promise.all(config.allowedProjectRoots.map((root) =>
        getCanonicalDirectory(root, "allowed_root_not_found"),
      ));
      if (canonicalRoots.some((root) => isWithinDirectory(root, canonicalRoot))) {
        return config;
      }
      return {
        ...config,
        allowedProjectRoots: [...config.allowedProjectRoots, canonicalRoot],
      };
    });
    return canonicalRoot;
  }

  /**
   * 首次从当前 Pi cwd 建立授权根和默认项目.
   *
   * @param cwd 当前 Pi session 工作目录.
   * @returns 根目录是否由本次初始化添加, 以及当前项目记录.
   * @throws {ProjectServiceError} 当前目录已不在已有授权根内时抛出.
   */
  async initializeFromCurrentCwd(cwd: string): Promise<{
    rootAdded: boolean;
    alias: string;
    project: ProjectDefinition;
  }> {
    const { config } = await this.store.load();
    const rootAdded = config.allowedProjectRoots.length === 0;
    if (rootAdded) {
      await this.addAllowedRoot(cwd);
    }
    const project = await this.ensureProjectForCwd(cwd);
    return { rootAdded, ...project };
  }

  /**
   * 在授权根内自动创建或复用当前 cwd 对应的项目记录.
   *
   * @param cwd 当前 Pi session 工作目录.
   * @returns 稳定 alias 和以 cwd 文件夹名作为展示名的项目记录.
   * @throws {ProjectServiceError} cwd 不在已授权根目录内时抛出.
   */
  async ensureProjectForCwd(cwd: string): Promise<{
    alias: string;
    project: ProjectDefinition;
  }> {
    let resolved: { alias: string; project: ProjectDefinition } | undefined;
    await this.store.update(async (config) => {
      const canonicalPath = await validateProjectDirectory(cwd, config.allowedProjectRoots);
      for (const [alias, project] of Object.entries(config.projects)) {
        try {
          const projectPath = await getCanonicalDirectory(project.path, "project_directory_not_found");
          if (samePath(projectPath, canonicalPath)) {
            resolved = { alias, project: { ...project, path: projectPath } };
            return config.defaultProject ? config : { ...config, defaultProject: alias };
          }
        } catch (error) {
          if (!(error instanceof ProjectServiceError)) {
            throw error;
          }
        }
      }

      const displayName = basename(canonicalPath) || canonicalPath;
      const alias = createProjectAlias(config.projects, displayName, canonicalPath);
      const project = { displayName, path: canonicalPath };
      resolved = { alias, project };
      return {
        ...config,
        defaultProject: config.defaultProject ?? alias,
        projects: {
          ...config.projects,
          [alias]: project,
        },
      };
    });
    if (!resolved) {
      throw new ProjectServiceError("project_alias_not_found", "无法为当前目录建立项目记录.");
    }
    return resolved;
  }

  /**
   * 添加一个通过允许根目录检查的项目 alias。
   *
   * @param alias 项目稳定 ID。
   * @param displayName 面向用户显示的名称。
   * @param projectPath 项目目录绝对路径。
   * @returns 新登记的项目定义。
   * @throws {ProjectServiceError} alias、路径或允许根目录非法时抛出。
   */
  async add(
    alias: string,
    displayName: string,
    projectPath: string,
  ): Promise<ProjectDefinition> {
    assertAlias(alias);
    const normalizedName = displayName.trim();
    if (!normalizedName || normalizedName.length > 100) {
      throw new ProjectServiceError(
        "invalid_display_name",
        "项目显示名称需为 1-100 个字符。",
      );
    }

    let addedProject: ProjectDefinition | undefined;
    await this.store.update(async (config) => {
      if (Object.hasOwn(config.projects, alias)) {
        throw new ProjectServiceError(
          "duplicate_alias",
          `项目 alias 已存在: ${alias}。如需替换, 请先移除旧 alias。`,
        );
      }
      const canonicalPath = await validateProjectDirectory(
        projectPath,
        config.allowedProjectRoots,
      );
      const project: ProjectDefinition = {
        displayName: normalizedName,
        path: canonicalPath,
      };
      addedProject = project;
      return {
        ...config,
        projects: {
          ...config.projects,
          [alias]: project,
        },
      };
    });

    if (!addedProject) {
      throw new Error("项目登记未产生结果。");
    }
    return addedProject;
  }

  /**
   * 解析已登记 alias 并在启动前重新验证真实路径和授权根目录。
   *
   * @param alias 项目稳定 ID。
   * @returns 可安全用于 worker cwd 的项目定义。
   * @throws {ProjectServiceError} alias 不存在或路径已越界时抛出。
   */
  async resolve(alias: string): Promise<ProjectDefinition> {
    assertAlias(alias);
    const { config } = await this.store.load();
    if (!Object.hasOwn(config.projects, alias)) {
      throw new ProjectServiceError(
        "project_alias_not_found",
        `未找到项目 alias: ${alias}。`,
      );
    }
    const project = config.projects[alias];
    const canonicalPath = await validateProjectDirectory(
      project.path,
      config.allowedProjectRoots,
    );
    return {
      ...project,
      path: canonicalPath,
    };
  }

  /**
   * 按 session 创建时记录的 cwd 恢复项目上下文, 即使 alias 已移除或改指向其他路径。
   *
   * @param alias session 索引中的项目 alias。
   * @param sessionCwd session 创建时的工作目录。
   * @returns 仍在授权根目录内的原项目路径及显示名称。
   * @throws {ProjectServiceError} 原路径不存在或已越过授权根目录时抛出。
   */
  async resolveSession(alias: string, sessionCwd: string): Promise<ProjectDefinition> {
    assertAlias(alias);
    const { config } = await this.store.load();
    const canonicalPath = await validateProjectDirectory(
      sessionCwd,
      config.allowedProjectRoots,
    );
    const displayName = Object.hasOwn(config.projects, alias)
      ? config.projects[alias].displayName
      : alias;
    return {
      displayName,
      path: canonicalPath,
    };
  }

  /**
   * 移除项目登记, 不删除实际目录, 并清除对应的默认项目设置。
   *
   * @param alias 要移除的项目 alias。
   * @returns 更新后的配置。
   * @throws {ProjectServiceError} alias 未登记时抛出。
   */
  async remove(alias: string): Promise<ManagerConfiguration> {
    assertAlias(alias);
    return this.store.update((config) => {
      if (!Object.hasOwn(config.projects, alias)) {
        throw new ProjectServiceError(
          "project_alias_not_found",
          `未找到项目 alias: ${alias}。`,
        );
      }
      const projects = { ...config.projects };
      delete projects[alias];
      const next: ManagerConfiguration = {
        ...config,
        projects,
      };
      if (config.defaultProject === alias) {
        delete next.defaultProject;
      }
      return next;
    });
  }

  /**
   * 设置默认项目 alias。
   *
   * @param alias 要设为默认的项目 alias。
   * @returns 更新后的配置。
   * @throws {ProjectServiceError} alias 未登记时抛出。
   */
  async setDefault(alias: string): Promise<ManagerConfiguration> {
    assertAlias(alias);
    return this.store.update((config) => {
      if (!Object.hasOwn(config.projects, alias)) {
        throw new ProjectServiceError(
          "project_alias_not_found",
          `未找到项目 alias: ${alias}。`,
        );
      }
      return {
        ...config,
        defaultProject: alias,
      };
    });
  }
}

/**
 * 校验项目目录存在且位于某个已授权根目录中。
 *
 * @param projectPath 用户提交的项目目录。
 * @param allowedRoots 已授权目录根列表。
 * @returns 真实路径, 用于持久化和后续启动。
 * @throws {ProjectServiceError} 路径不存在或越界时抛出。
 */
export async function validateProjectDirectory(
  projectPath: string,
  allowedRoots: string[],
): Promise<string> {
  if (!isAbsolute(projectPath)) {
    throw new ProjectServiceError(
      "project_path_denied",
      "项目路径必须是绝对路径。",
    );
  }

  const canonicalProjectPath = await getCanonicalDirectory(projectPath, "project_directory_not_found");
  if (allowedRoots.length === 0) {
    throw new ProjectServiceError(
      "project_path_denied",
      "尚未配置 allowedProjectRoots, 请先在配置文件中登记授权根目录。",
    );
  }

  const canonicalRoots = await Promise.all(
    allowedRoots.map(async (root) => {
      if (!isAbsolute(root)) {
        throw new ProjectServiceError(
          "project_path_denied",
          "allowedProjectRoots 中存在非绝对路径。",
        );
      }
      return getCanonicalDirectory(root, "allowed_root_not_found");
    }),
  );

  const isAllowed = canonicalRoots.some((root) => isWithinDirectory(root, canonicalProjectPath));
  if (!isAllowed) {
    throw new ProjectServiceError(
      "project_path_denied",
      "项目路径不在任何 allowedProjectRoots 目录内。",
    );
  }
  return canonicalProjectPath;
}

/**
 * 解析并确认路径指向现存目录。
 *
 * @param directoryPath 待检查目录。
 * @param errorCode 路径不存在时返回的错误代码。
 * @returns 目录真实路径。
 */
async function getCanonicalDirectory(
  directoryPath: string,
  errorCode: "project_directory_not_found" | "allowed_root_not_found",
): Promise<string> {
  try {
    const canonicalPath = await realpath(resolve(directoryPath));
    const directoryStat = await stat(canonicalPath);
    if (!directoryStat.isDirectory()) {
      throw new Error("not_directory");
    }
    return canonicalPath;
  } catch {
    const message = errorCode === "allowed_root_not_found"
      ? "allowedProjectRoots 中的目录不存在或不是目录。"
      : "项目目录不存在或不是目录。";
    throw new ProjectServiceError(errorCode, message);
  }
}

/**
 * 判断目标路径是否等于根目录或位于其子目录。
 *
 * @param root 规范化的授权根目录。
 * @param target 规范化的目标目录。
 * @returns 目标位于根目录范围内时返回 true。
 */
function isWithinDirectory(root: string, target: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const relativePath = relative(normalizedRoot, normalizedTarget);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/**
 * 比较两个规范化目录路径, 在 Windows 上忽略大小写.
 *
 * @param left 左侧路径.
 * @param right 右侧路径.
 * @returns 两条路径指向同一规范化位置时返回 true.
 */
function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * 根据文件夹名生成稳定且无冲突的项目 alias.
 *
 * @param projects 当前项目记录.
 * @param displayName 当前文件夹名称.
 * @param projectPath 已规范化的项目路径.
 * @returns 满足配置 schema 的唯一 alias.
 */
function createProjectAlias(
  projects: Record<string, ProjectDefinition>,
  displayName: string,
  projectPath: string,
): string {
  const base = displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "") || "project";
  if (!Object.hasOwn(projects, base)) {
    return base;
  }

  const pathHash = createHash("sha256")
    .update(process.platform === "win32" ? projectPath.toLowerCase() : projectPath)
    .digest("hex")
    .slice(0, 8);
  const prefix = base.slice(0, 19).replace(/-+$/g, "") || "project";
  const withHash = `${prefix}-${pathHash}`;
  if (!Object.hasOwn(projects, withHash)) {
    return withHash;
  }
  let index = 2;
  let candidate = `${prefix}-${pathHash}-${index}`;
  while (Object.hasOwn(projects, candidate)) {
    index += 1;
    candidate = `${prefix}-${pathHash}-${index}`;
  }
  return candidate;
}

/**
 * 将配置校验错误转换为项目服务稳定错误代码.
 *
 * @param alias 待校验 alias。
 * @returns 无返回值。
 * @throws {ProjectServiceError} alias 非法时抛出。
 */
function assertAlias(alias: string): void {
  try {
    assertProjectAlias(alias);
  } catch {
    throw new ProjectServiceError(
      "invalid_alias",
      "alias 需为 1-32 位小写字母、数字、下划线或连字符, 且以字母或数字开头。",
    );
  }
}
