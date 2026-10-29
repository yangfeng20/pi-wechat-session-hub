import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GatewayServiceStatus } from "./gateway-service-controller.ts";

export interface GatewayLifecycleOperationReceipt {
  action: "restart";
  operationId: string;
  state: "pending" | "completed" | "failed";
  serviceStatus?: GatewayServiceStatus;
  message?: string;
}

export interface GatewayLifecycleOperationWatcher {
  wait(timeoutMs: number): Promise<GatewayLifecycleOperationReceipt>;
  close(): void;
  removeReceipt(): Promise<void>;
}

/**
 * 在 manager 私有目录监听一次 Gateway 重启操作的最终结果.
 *
 * @param managerDirectory Gateway manager 数据目录.
 * @param operationId 本次操作 UUID.
 * @returns 已安装文件系统监听器的一次性等待句柄.
 */
export async function watchGatewayLifecycleOperation(
  managerDirectory: string,
  operationId: string,
): Promise<GatewayLifecycleOperationWatcher> {
  if (!isOperationId(operationId)) {
    throw new Error("Gateway 生命周期操作 ID 无效。");
  }
  const operationDirectory = await ensureOperationDirectory(managerDirectory);
  const receiptPath = join(operationDirectory, `${operationId}.json`);
  const watcher = watch(operationDirectory, { persistent: false });
  let cachedReceipt: GatewayLifecycleOperationReceipt | undefined;
  let readError: Error | undefined;
  let resolveWait: ((receipt: GatewayLifecycleOperationReceipt) => void) | undefined;
  let rejectWait: ((error: Error) => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const clearWait = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    resolveWait = undefined;
    rejectWait = undefined;
  };
  const readReceipt = async (): Promise<void> => {
    if (closed || cachedReceipt || readError) {
      return;
    }
    try {
      const parsed = parseReceipt(JSON.parse(await readFile(receiptPath, "utf8")) as unknown, operationId);
      if (parsed.state === "pending") {
        return;
      }
      cachedReceipt = parsed;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      resolveWait?.(parsed);
      resolveWait = undefined;
      rejectWait = undefined;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      readError = error instanceof Error ? error : new Error("Gateway 生命周期结果无效。");
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      rejectWait?.(readError);
      resolveWait = undefined;
      rejectWait = undefined;
    }
  };

  watcher.on("change", () => {
    void readReceipt();
  });
  watcher.on("error", (error) => {
    readError = error;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    rejectWait?.(error);
    resolveWait = undefined;
    rejectWait = undefined;
  });

  return {
    wait(timeoutMs: number): Promise<GatewayLifecycleOperationReceipt> {
      if (cachedReceipt) {
        return Promise.resolve(cachedReceipt);
      }
      if (readError) {
        return Promise.reject(readError);
      }
      return new Promise<GatewayLifecycleOperationReceipt>((resolveReceipt, rejectReceipt) => {
        resolveWait = resolveReceipt;
        rejectWait = rejectReceipt;
        timer = setTimeout(() => {
          timer = undefined;
          const reject = rejectWait;
          clearWait();
          reject?.(new Error("等待 Gateway 重启完成超时。"));
        }, timeoutMs);
        timer.unref();
        void readReceipt();
      });
    },
    close(): void {
      closed = true;
      const reject = rejectWait;
      clearWait();
      watcher.close();
      reject?.(new Error("Gateway 重启结果监听已关闭。"));
    },
    async removeReceipt(): Promise<void> {
      try {
        await unlink(receiptPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    },
  };
}

/**
 * 原子写入一次 Gateway 生命周期操作结果.
 *
 * @param managerDirectory Gateway manager 数据目录.
 * @param receipt 操作 ID、阶段、最终状态和可选错误提示.
 * @returns 操作结果写入并替换完成后正常结束.
 */
export async function writeGatewayLifecycleOperationReceipt(
  managerDirectory: string,
  receipt: GatewayLifecycleOperationReceipt,
): Promise<void> {
  if (!isOperationId(receipt.operationId)) {
    throw new Error("Gateway 生命周期操作 ID 无效。");
  }
  const operationDirectory = await ensureOperationDirectory(managerDirectory);
  const receiptPath = join(operationDirectory, `${receipt.operationId}.json`);
  const temporaryPath = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(receipt)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await replaceWithRetry(temporaryPath, receiptPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (isWindowsRenameConflict(error)) {
      throw new Error(
        "写入 Gateway 生命周期回执失败: 目标文件持续被其他进程占用, 已重试仍无法替换。",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * 原子替换目标文件, Windows 占用类错误按退避重试。
 *
 * Windows 上杀毒软件与索引器会短暂持有文件句柄, 使成功落盘的临时文件
 * 在替换阶段瞬时失败. 重试次数少且间隔短, 不改变调用方的超时预期。
 * 采用递归推进而非循环内等待, 避免在循环体内阻塞。
 *
 * @param temporaryPath 已写入的临时文件路径。
 * @param targetPath 目标回执文件路径。
 * @param attempt 当前重试序号, 从 0 开始。
 * @returns 替换完成后正常结束。
 * @throws {unknown} 非占用类错误或重试耗尽时抛出最后一次错误。
 */
async function replaceWithRetry(
  temporaryPath: string,
  targetPath: string,
  attempt = 0,
): Promise<void> {
  const retryDelaysMs = [10, 25, 50, 100, 200];
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    const delay = retryDelaysMs[attempt];
    if (!isWindowsRenameConflict(error) || delay === undefined) {
      throw error;
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, delay).unref();
    });
    return replaceWithRetry(temporaryPath, targetPath, attempt + 1);
  }
}

/**
 * 判断是否为 Windows 上常见的原子替换失败。
 *
 * Windows 不允许替换被其他进程以不共享方式打开的文件, 杀毒软件、
 * Windows Search 索引器等会短暂持有句柄, 使 `rename` 返回 EPERM/EACCES/EBUSY。
 * 这些错误是可重试的瞬时错误, 与权限配置错误不同。
 *
 * @param error 捕获的错误。
 * @returns 属可重试的 Windows 占用类错误时返回 true。
 */
function isWindowsRenameConflict(error: unknown): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/**
 * Gateway 启动就绪后完成上次 daemon 重启遗留的 pending 操作.
 *
 * @param managerDirectory Gateway manager 数据目录.
 * @param serviceStatus 新 Gateway 的最终状态.
 * @param failureMessage 存在时将 pending 操作标记为失败并记录安全提示.
 * @param operationId 可选的特定重启操作 ID.
 * @returns 所有匹配的 pending 重启操作完成后正常结束.
 */
export async function completePendingGatewayLifecycleOperations(
  managerDirectory: string,
  serviceStatus: GatewayServiceStatus,
  failureMessage?: string,
  operationId?: string,
): Promise<void> {
  if (operationId && !isOperationId(operationId)) {
    throw new Error("Gateway 生命周期操作 ID 无效。");
  }
  let operationDirectory: string;
  try {
    operationDirectory = await ensureOperationDirectory(managerDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const entries = await readdir(operationDirectory);
  const operationIds = entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -5))
    .filter(isOperationId);
  const receipts = await Promise.all(operationIds.map(async (operationId) => {
    try {
      return await readOperationReceipt(operationDirectory, operationId);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      return undefined;
    }
  }));
  const pendingOperationIds = receipts
    .filter((receipt): receipt is GatewayLifecycleOperationReceipt =>
      receipt?.state === "pending" && (!operationId || receipt.operationId === operationId),
    )
    .map((receipt) => receipt.operationId);
  await Promise.all(pendingOperationIds.map((operationId) => writeGatewayLifecycleOperationReceipt(
    managerDirectory,
    {
      action: "restart",
      operationId,
      state: failureMessage ? "failed" : "completed",
      serviceStatus,
      ...(failureMessage ? { message: failureMessage } : {}),
    },
  )));
}

/**
 * 确保生命周期操作目录是 manager 私有目录下的普通目录.
 *
 * @param managerDirectory Gateway manager 数据目录.
 * @returns 生命周期操作目录绝对路径.
 */
async function ensureOperationDirectory(managerDirectory: string): Promise<string> {
  const operationDirectory = join(resolve(managerDirectory), "lifecycle-operations");
  await mkdir(operationDirectory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(operationDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("Gateway 生命周期操作目录不安全。");
  }
  return operationDirectory;
}

/**
 * 读取并验证指定生命周期操作的结果文件.
 *
 * @param operationDirectory 操作记录目录.
 * @param operationId 本次操作 UUID.
 * @returns 已验证的操作记录.
 */
async function readOperationReceipt(
  operationDirectory: string,
  operationId: string,
): Promise<GatewayLifecycleOperationReceipt> {
  const receiptPath = join(operationDirectory, `${operationId}.json`);
  const receiptInfo = await lstat(receiptPath);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) {
    throw new Error("Gateway 生命周期结果文件类型无效。");
  }
  const contents = await readFile(receiptPath, "utf8");
  return parseReceipt(JSON.parse(contents) as unknown, operationId);
}

/**
 * 验证操作 ID 为 UUID, 避免从操作记录路径逸出.
 *
 * @param operationId 操作 ID.
 * @returns ID 有效时返回 true.
 */
function isOperationId(operationId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId);
}

/**
 * 验证生命周期结果与当前操作 ID 匹配.
 *
 * @param value JSON 文件内容.
 * @param expectedOperationId 当前等待的操作 ID.
 * @returns 已验证的生命周期操作结果.
 */
function parseReceipt(value: unknown, expectedOperationId: string): GatewayLifecycleOperationReceipt {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !("action" in value) || value.action !== "restart" ||
    !("operationId" in value) || value.operationId !== expectedOperationId ||
    !("state" in value) || (value.state !== "pending" && value.state !== "completed" && value.state !== "failed") ||
    (value.state !== "pending" && (
      !("serviceStatus" in value) || typeof value.serviceStatus !== "object" ||
      value.serviceStatus === null || Array.isArray(value.serviceStatus) ||
      !("state" in value.serviceStatus) || typeof value.serviceStatus.state !== "string"
    )) ||
    ("message" in value && typeof value.message !== "string")
  ) {
    throw new Error("Gateway 生命周期结果格式无效。");
  }
  return value as unknown as GatewayLifecycleOperationReceipt;
}

/**
 * 判断未知异常是否携带 Node.js 错误代码.
 *
 * @param error 待检查的异常.
 * @returns 错误带 code 字段时返回 true.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
