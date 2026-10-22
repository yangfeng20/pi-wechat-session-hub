import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import type { IlinkCredentials } from "./wechat-ilink/api-client.ts";

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const WINDOWS_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$allowedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')",
  "$violations = @()",
  "$parentDirectory = Split-Path -Parent $env:PI_WECHAT_MANAGER_DIRECTORY",
  "$targets = @($parentDirectory, $env:PI_WECHAT_MANAGER_DIRECTORY)",
  "$entries = @(Get-ChildItem -LiteralPath $env:PI_WECHAT_MANAGER_DIRECTORY -Force -Recurse -ErrorAction Stop)",
  "foreach ($entry in $entries) {",
  "  if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $violations += 'reparse_point'; continue }",
  "  $targets += $entry.FullName",
  "}",
  "foreach ($target in $targets) {",
  "  $item = Get-Item -LiteralPath $target -Force",
  "  $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($item)",
  "  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
  "  if ($allowedSids -notcontains $ownerSid) { $violations += ('untrusted_owner:' + $target + ':' + $ownerSid) }",,,
  "  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
  "  foreach ($rule in $rules) {",
  "    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }",
  "    $sid = $rule.IdentityReference.Value",
  "    if ($allowedSids -contains $sid) { continue }",
  "    if ($target -eq $parentDirectory) {",
  "      $writeMask = [int]([System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor [System.Security.AccessControl.FileSystemRights]::CreateDirectories -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership)",
  "      if (([int]$rule.FileSystemRights -band $writeMask) -eq 0) { continue }",
  "    }",
  "    $violations += ('untrusted_allow_ace:' + $target + ':' + $sid + ':' + $rule.FileSystemRights)",,,
  "  }",
  "}",
  "if ($violations.Count -gt 0) { [Console]::Error.WriteLine(($violations -join '|')); exit 23 }",
  "[Console]::Out.Write('ok')",
].join("\n");

/**
 * 描述 POSIX manager/parent/file mode 和 owner UID 的权限快照。
 */
export interface PosixCredentialPermissionSnapshot {
  managerMode: number;
  parentMode: number;
  fileMode: number;
  managerUid: number;
  fileUid: number;
  currentUid?: number;
}

/**
 * 判断 POSIX 凭证路径是否没有 group/other 读取或写入权限。
 *
 * @param snapshot manager、父目录、凭证文件 mode 和 owner UID。
 * @returns manager/file 私有且父目录不可被其他主体写入时返回 true。
 */
export function isPosixCredentialPermissionSafe(
  snapshot: PosixCredentialPermissionSnapshot,
): boolean {
  const ownerMatches = snapshot.currentUid === undefined || (
    snapshot.managerUid === snapshot.currentUid && snapshot.fileUid === snapshot.currentUid
  );
  return (snapshot.managerMode & 0o077) === 0 &&
    (snapshot.parentMode & 0o022) === 0 &&
    (snapshot.fileMode & 0o077) === 0 &&
    ownerMatches;
}

export interface IlinkCredentialRecord {
  schemaVersion: 1;
  authorizedUserId: string;
  token: string;
  baseUrl: string;
}

export interface CreatedIlinkCredential {
  filePath: string;
  device: number;
  inode: number;
}

export type IlinkCredentialStoreOptions = {
  platform?: NodeJS.Platform;
  verifyWindowsAcl?: (managerDirectory: string, credentialFile: string) => Promise<void>;
};

/**
 * 确认 manager 目录权限安全后, 才能开始扫码流程或写入新的 Hub 凭证。
 *
 * @param managerDirectory Hub 私有 manager 数据目录。
 * @param options 平台覆盖和 Windows ACL 验证器。
 * @returns 目录及其父目录满足平台权限策略时正常返回。
 * @throws {IlinkCredentialStoreError} 路径、ACL 或 POSIX mode 不安全时抛出。
 */
export async function verifyCredentialDirectoryPermissions(
  managerDirectory: string,
  options: IlinkCredentialStoreOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const directory = resolve(managerDirectory);
  let directoryInfo: Stats;
  let parentInfo: Stats;
  try {
    directoryInfo = await lstat(directory);
    parentInfo = await lstat(dirname(directory));
    if (
      !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
      !parentInfo.isDirectory() || parentInfo.isSymbolicLink()
    ) {
      throw new Error("unsafe_directory");
    }
  } catch {
    throw new IlinkCredentialStoreError(
      "credential_path_unsafe",
      "Hub manager 目录或父目录无法安全验证。",
    );
  }

  if (platform === "win32") {
    try {
      await (options.verifyWindowsAcl ?? verifyWindowsAcl)(directory, join(directory, "credentials.json"));
      return;
    } catch {
      throw new IlinkCredentialStoreError(
        "credential_permissions_unsafe",
        "Windows Hub 目录 ACL 不安全; 请只授权当前用户、SYSTEM 和 Administrators。",
      );
    }
  }

  const parentDirectoryInfo = await stat(dirname(directory)).catch(() => undefined);
  const currentUid = process.getuid?.();
  if (
    !parentDirectoryInfo ||
    (directoryInfo.mode & 0o077) !== 0 ||
    (parentDirectoryInfo.mode & 0o022) !== 0 ||
    (currentUid !== undefined && directoryInfo.uid !== currentUid)
  ) {
    throw new IlinkCredentialStoreError(
      "credential_permissions_unsafe",
      "POSIX Hub 目录必须归当前用户所有且无 group/other 权限, 父目录也不能被其他主体写入。",
    );
  }
}

/**
 * 独占创建 Hub 专属 credentials.json, 绝不覆盖已存在文件。
 *
 * @param managerDirectory Hub 私有 manager 数据目录。
 * @param record 已确认的 iLink 凭证记录。
 * @param options 平台覆盖和 Windows ACL 验证器。
 * @returns 新建文件身份, 供配置更新失败时安全回滚。
 * @throws {IlinkCredentialStoreError} 文件已存在、权限不安全或内容不合法时抛出。
 */
export async function createIlinkCredentialFile(
  managerDirectory: string,
  record: IlinkCredentialRecord,
  options: IlinkCredentialStoreOptions = {},
): Promise<CreatedIlinkCredential> {
  const directory = resolve(managerDirectory);
  const filePath = join(directory, "credentials.json");
  const validated = parseCredentialRecord(JSON.stringify(record));
  await verifyCredentialDirectoryPermissions(directory, options);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let createdInfo: Stats | undefined;
  try {
    handle = await open(filePath, "wx", 0o600);
    createdInfo = await handle.stat();
    await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new IlinkCredentialStoreError(
        "credential_exists",
        "Pi Hub 已有 credentials.json, 为避免覆盖凭证, 登录已停止。",
      );
    }
    if (createdInfo) {
      await removeCreatedIlinkCredentialIfUnchanged({
        filePath,
        device: createdInfo.dev,
        inode: createdInfo.ino,
      });
    }
    throw new IlinkCredentialStoreError(
      "credential_file_unsafe",
      "无法安全创建 Pi Hub credentials.json。",
    );
  }
  if (!createdInfo) {
    throw new IlinkCredentialStoreError(
      "credential_file_unsafe",
      "无法确认新凭证文件身份, 登录已停止。",
    );
  }
  try {
    await handle?.close();
  } catch {
    await removeCreatedIlinkCredentialIfUnchanged({
      filePath,
      device: createdInfo.dev,
      inode: createdInfo.ino,
    });
    throw new IlinkCredentialStoreError(
      "credential_file_unsafe",
      "无法安全关闭新建凭证文件。",
    );
  }

  const created: CreatedIlinkCredential = {
    filePath,
    device: createdInfo.dev,
    inode: createdInfo.ino,
  };
  try {
    await new IlinkCredentialStore(directory, filePath, options).load(validated.authorizedUserId);
    return created;
  } catch (error) {
    await removeCreatedIlinkCredentialIfUnchanged(created);
    if (error instanceof IlinkCredentialStoreError) {
      throw error;
    }
    throw new IlinkCredentialStoreError(
      "credential_file_unsafe",
      "新凭证未通过 Hub 安全校验, 已清理本次创建的文件。",
    );
  }
}

/**
 * 只删除本次创建且 inode/dev 仍匹配的 Hub credentials.json。
 *
 * @param created 本次新建文件的路径和文件身份。
 * @returns 文件已删除或已不存在时返回 true; 身份不匹配时返回 false。
 */
export async function removeCreatedIlinkCredentialIfUnchanged(
  created: CreatedIlinkCredential,
): Promise<boolean> {
  try {
    const current = await lstat(created.filePath);
    if (
      current.isSymbolicLink() ||
      current.dev !== created.device ||
      current.ino !== created.inode
    ) {
      return false;
    }
    await unlink(created.filePath);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT";
  }
}

/**
 * iLink 凭证读取和安全校验失败的稳定错误代码。
 */
export type IlinkCredentialStoreErrorCode =
  | "credential_missing"
  | "credential_path_unsafe"
  | "credential_file_unsafe"
  | "credential_exists"
  | "credential_permissions_unsafe"
  | "credential_invalid"
  | "authorized_user_mismatch";

/**
 * 表示 iLink 凭证文件缺失、格式不合法或权限无法安全验证。
 */
export class IlinkCredentialStoreError extends Error {
  /**
   * 创建不包含凭证内容的凭证存储错误。
   *
   * @param code 稳定错误代码。
   * @param message 可安全显示给用户的中文说明。
   */
  constructor(
    readonly code: IlinkCredentialStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IlinkCredentialStoreError";
  }
}

/**
 * 只读加载枢纽专属 iLink 凭证, 不创建、更新或迁移任何账号数据。
 */
export class IlinkCredentialStore {
  private readonly managerDirectory: string;
  private readonly credentialFile: string;
  private readonly platform: NodeJS.Platform;
  private readonly verifyWindowsAcl?: (managerDirectory: string, credentialFile: string) => Promise<void>;

  /**
   * 创建受限凭证文件 reader。
   *
   * @param managerDirectory 枢纽专属 manager 数据目录。
   * @param credentialFile 配置中的凭证文件绝对路径。
   * @param options 可选平台覆盖和 Windows ACL 验证器。
   */
  constructor(
    managerDirectory: string,
    credentialFile: string,
    options: IlinkCredentialStoreOptions = {},
  ) {
    this.managerDirectory = resolve(managerDirectory);
    this.credentialFile = resolve(credentialFile);
    this.platform = options.platform ?? process.platform;
    this.verifyWindowsAcl = options.verifyWindowsAcl;
  }

  /**
   * 读取并验证凭证文件, 并校验其中声明的授权微信用户。
   *
   * @param expectedAuthorizedUserId 配置中的唯一授权用户 ID。
   * @returns 仅供内存使用的 iLink API 凭证。
   * @throws {IlinkCredentialStoreError} 文件路径、权限、内容或用户 ID 不安全时抛出。
   */
  async load(expectedAuthorizedUserId: string): Promise<IlinkCredentials> {
    if (!expectedAuthorizedUserId.trim()) {
      throw new IlinkCredentialStoreError(
        "authorized_user_mismatch",
        "启动 Gateway 前必须配置唯一授权微信 userId。",
      );
    }
    this.assertConfiguredPathIsAppOwned();

    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(this.managerDirectory);
    } catch {
      throw new IlinkCredentialStoreError(
        "credential_path_unsafe",
        "枢纽数据目录不存在或无法解析, 已拒绝读取凭证。",
      );
    }
    let canonicalParent: string;
    let fileStat;
    try {
      const directoryStat = await lstat(this.managerDirectory);
      const parentStat = await lstat(dirname(this.managerDirectory));
      if (
        !directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
        !parentStat.isDirectory() || parentStat.isSymbolicLink()
      ) {
        throw new Error("unsafe_manager_directory");
      }
      canonicalParent = await realpath(dirname(this.credentialFile));
      fileStat = await lstat(this.credentialFile);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new IlinkCredentialStoreError(
          "credential_missing",
          "未找到枢纽专属 iLink 凭证文件; Gateway 不会自动扫码, 也不会读取其他应用凭证。",
        );
      }
      if (error instanceof IlinkCredentialStoreError) {
        throw error;
      }
      throw new IlinkCredentialStoreError(
        "credential_file_unsafe",
        "iLink 凭证文件无法安全检查。",
      );
    }
    if (
      !samePath(canonicalDirectory, canonicalParent, this.platform) ||
      fileStat.isSymbolicLink() ||
      !fileStat.isFile() ||
      fileStat.size <= 0 ||
      fileStat.size > MAX_CREDENTIAL_FILE_BYTES
    ) {
      throw new IlinkCredentialStoreError(
        "credential_file_unsafe",
        "凭证必须是枢纽数据目录中的普通 credentials.json 文件, 且大小不能超过 64 KB。",
      );
    }

    await this.verifyPermissions(canonicalDirectory, this.credentialFile, fileStat);
    const content = await this.readOpenedFile(fileStat);
    const record = parseCredentialRecord(content);
    if (record.authorizedUserId !== expectedAuthorizedUserId) {
      throw new IlinkCredentialStoreError(
        "authorized_user_mismatch",
        "凭证文件声明的授权微信 userId 与配置不一致, 已拒绝启动。",
      );
    }
    return { token: record.token, baseUrl: record.baseUrl };
  }

  /**
   * 确保配置路径精确指向 manager 数据目录的固定凭证文件。
   *
   * @returns 无返回值。
   * @throws {IlinkCredentialStoreError} 配置路径越界或使用其他文件名时抛出。
   */
  private assertConfiguredPathIsAppOwned(): void {
    const expected = join(this.managerDirectory, "credentials.json");
    if (
      basename(this.credentialFile) !== "credentials.json" ||
      !samePath(this.credentialFile, expected, this.platform)
    ) {
      throw new IlinkCredentialStoreError(
        "credential_path_unsafe",
        "wechat.credentialFile 必须指向枢纽数据目录中的 credentials.json, 不读取目录外凭证。",
      );
    }
  }

  /**
   * 在当前平台验证凭证文件和父目录权限。
   *
   * @param managerDirectory 规范化后的 manager 数据目录。
   * @param credentialFile 凭证文件路径。
   * @param fileStat 初步取得的文件状态。
   * @returns 无返回值。
   * @throws {IlinkCredentialStoreError} 权限不满足当前平台策略时抛出。
   */
  private async verifyPermissions(
    managerDirectory: string,
    credentialFile: string,
    fileStat: Stats,
  ): Promise<void> {
    if (this.platform === "win32") {
      if (this.verifyWindowsAcl) {
        try {
          await this.verifyWindowsAcl(managerDirectory, credentialFile);
          return;
        } catch {
          throw new IlinkCredentialStoreError(
            "credential_permissions_unsafe",
            "Windows 凭证目录 ACL 未通过验证; 请仅授权当前用户、SYSTEM 和 Administrators。",
          );
        }
      }
      await verifyWindowsAcl(managerDirectory, credentialFile);
      return;
    }

    const directoryStat = await stat(managerDirectory);
    const parentDirectoryStat = await stat(dirname(managerDirectory));
    const getUid = process.getuid;
    if (!isPosixCredentialPermissionSafe({
      managerMode: directoryStat.mode,
      parentMode: parentDirectoryStat.mode,
      fileMode: fileStat.mode,
      managerUid: directoryStat.uid,
      fileUid: fileStat.uid,
      ...(getUid ? { currentUid: getUid() } : {}),
    })) {
      throw new IlinkCredentialStoreError(
        "credential_permissions_unsafe",
        "POSIX 凭证目录和文件必须归当前用户所有, 且 group/other 权限为 0。",
      );
    }
  }

  /**
   * 以已打开文件句柄读取凭证, 并检查打开对象与 lstat 对象一致。
   *
   * @param expectedStat 打开前取得的普通文件状态。
   * @returns UTF-8 文件内容。
   * @throws {IlinkCredentialStoreError} 文件被替换或无法安全打开时抛出。
   */
  private async readOpenedFile(expectedStat: Stats): Promise<string> {
    let handle;
    try {
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      handle = await open(this.credentialFile, constants.O_RDONLY | noFollow);
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.dev !== expectedStat.dev ||
        openedStat.ino !== expectedStat.ino ||
        openedStat.size > MAX_CREDENTIAL_FILE_BYTES
      ) {
        throw new IlinkCredentialStoreError(
          "credential_file_unsafe",
          "凭证文件在读取期间发生变化, 已拒绝使用。",
        );
      }
      return await handle.readFile("utf8");
    } catch (error) {
      if (error instanceof IlinkCredentialStoreError) {
        throw error;
      }
      throw new IlinkCredentialStoreError(
        "credential_file_unsafe",
        "凭证文件无法安全读取。",
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

/**
 * 验证 iLink 凭证文件的 JSON schema 和字段边界。
 *
 * @param content UTF-8 凭证文件内容。
 * @returns 已校验的枢纽专属凭证记录。
 * @throws {IlinkCredentialStoreError} JSON/schema 不合法时抛出。
 */
function parseCredentialRecord(content: string): IlinkCredentialRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new IlinkCredentialStoreError(
      "credential_invalid",
      "iLink 凭证文件不是有效 JSON。",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new IlinkCredentialStoreError(
      "credential_invalid",
      "iLink 凭证文件根节点必须是 JSON 对象。",
    );
  }
  const record = parsed as Record<string, unknown>;
  const allowedKeys = new Set(["schemaVersion", "authorizedUserId", "token", "baseUrl"]);
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    record.schemaVersion !== 1 ||
    typeof record.authorizedUserId !== "string" ||
    !record.authorizedUserId.trim() ||
    typeof record.token !== "string" ||
    !record.token.trim() ||
    record.token.length > 16384 ||
    typeof record.baseUrl !== "string" ||
    !record.baseUrl.trim() ||
    record.baseUrl.length > 2048
  ) {
    throw new IlinkCredentialStoreError(
      "credential_invalid",
      "iLink 凭证文件必须仅包含 schemaVersion、authorizedUserId、token 和 baseUrl, 且字段有效。",
    );
  }
  return {
    schemaVersion: 1,
    authorizedUserId: record.authorizedUserId,
    token: record.token,
    baseUrl: record.baseUrl,
  };
}

/**
 * 使用 PowerShell/.NET 检查 Windows manager 目录和凭证文件 ACL。
 *
 * @param managerDirectory manager 数据目录。
 * @param credentialFile iLink 凭证文件。
 * @returns ACL 仅授予当前用户、SYSTEM 和 Administrators 时正常返回。
 * @throws {Error} PowerShell 不可用或 ACL 包含其他授权主体时抛出。
 */
async function verifyWindowsAcl(managerDirectory: string, credentialFile: string): Promise<void> {
  const execFileAsync = promisify(execFile);
  const encodedScript = Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64");
  try {
    await execFileAsync(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
      {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          PI_WECHAT_MANAGER_DIRECTORY: managerDirectory,
          PI_WECHAT_CREDENTIAL_FILE: credentialFile,
        },
      },
    );
  } catch (error) {
    const failureCode = isNodeError(error) ? String(error.code) : error instanceof Error ? error.name : typeof error;
    throw new IlinkCredentialStoreError(
      "credential_permissions_unsafe",
      `Windows 凭证目录 ACL 未通过验证 (${failureCode}); 请仅授权当前用户、SYSTEM 和 Administrators。`,
    );
  }
}

/**
 * 比较路径, 在 Windows 上忽略大小写。
 *
 * @param left 左侧路径。
 * @param right 右侧路径。
 * @param platform 目标平台。
 * @returns 两条路径指向同一规范路径时返回 true。
 */
function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * 判断值是否为 Node.js 文件系统错误。
 *
 * @param error 待检查值。
 * @returns 值包含 Node.js 错误代码时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
