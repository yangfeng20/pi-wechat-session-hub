import { open } from "node:fs/promises";
import type { WorkerInstanceRecord, SessionIndexRecord } from "../registry/types.ts";

/**
 * 会话健康状态, 用于 /watch 总览。
 */
export type HealthState = "starting" | "running" | "stopping" | "error" | "disconnected" | "idle";

/**
 * 上游失败的归一化分类。
 */
export type FailureKind =
  | "daily_quota"
  | "weekly_quota"
  | "monthly_quota"
  | "rate_limit"
  | "usage_limit"
  | "auth"
  | "service_unavailable"
  | "network"
  | "aborted"
  | "unknown";

/**
 * 从 transcript 最后一条 assistant 记录中提取的失败信息。
 */
export interface TurnFailure {
  kind: FailureKind;
  /** 面向用户的一句话说明。 */
  summary: string;
  /** 服务端给出的重置时间原文, 仅额度类错误会出现。 */
  resetAt?: string;
  /** 归一化前的原始错误前缀, 用于排查。 */
  raw: string;
}

/**
 * 单个会话的健康快照。
 */
export interface SessionHealth {
  session: SessionIndexRecord;
  worker?: WorkerInstanceRecord;
  state: HealthState;
  failure?: TurnFailure;
}

/** 读取 transcript 尾部时使用的初始窗口大小。 */
const TAIL_READ_BYTES = 64 * 1024;

/** transcript 尾部窗口的最大扩展上限。 */
const TAIL_READ_MAX_BYTES = 2 * 1024 * 1024;

/** 提取到的原始错误在快照中保留的最大字符数。 */
const MAX_RAW_ERROR_CHARS = 200;

/**
 * 计算会话健康状态。
 *
 * 只使用 registry 中明确记录的 worker state, 不从静态 heartbeatAt 推断“卡住”:
 * heartbeatAt 只在状态变化时更新, 并非定时心跳, 用它判卡住会误报长时间运行的 turn。
 *
 * @param session 会话索引记录。
 * @param worker 该会话当前的 worker 实例, 可为空。
 * @param failure 最近一次 turn 的失败信息, 可为空。
 * @returns 当前健康状态。
 */
export function evaluateHealth(
  session: SessionIndexRecord,
  worker: WorkerInstanceRecord | undefined,
  failure: TurnFailure | undefined,
): { state: HealthState } {
  if (worker?.state === "stale") {
    return { state: "disconnected" };
  }
  if (worker?.state === "stopping") {
    return { state: "stopping" };
  }
  if (worker?.state === "starting") {
    return { state: "starting" };
  }
  if (worker?.state === "running") {
    return { state: "running" };
  }
  if (failure) {
    return { state: "error" };
  }
  if (!worker && session.state === "active") {
    return { state: "disconnected" };
  }
  return { state: "idle" };
}

/**
 * 将 upstream 的 errorMessage 归一化为可读的失败分类。
 *
 * 真实样本来自 Pi transcript 的 `message.errorMessage`, 形如:
 *
 * ```text
 * 429: {"message":"You have exceeded the weekly usage quota. It will reset at
 * 2026-11-16 00:00:00 +0800 CST...","type":"TooManyRequests","code":"AccountQuotaExceeded"}
 * ```
 *
 * @param errorMessage transcript 中记录的原始错误文本。
 * @returns 归一化失败信息, 无法识别时归类为 unknown。
 */
export function classifyFailure(errorMessage: string): TurnFailure {
  const raw = errorMessage.trim().slice(0, MAX_RAW_ERROR_CHARS);
  const lowered = errorMessage.toLowerCase();
  const resetAt = extractResetTime(errorMessage);

  if (lowered.includes("weekly usage quota")) {
    return { kind: "weekly_quota", summary: "周额度已耗尽", ...(resetAt ? { resetAt } : {}), raw };
  }
  if (lowered.includes("5-hour usage quota") || lowered.includes("5 hour usage quota")) {
    return { kind: "daily_quota", summary: "5 小时额度已耗尽", ...(resetAt ? { resetAt } : {}), raw };
  }
  if (lowered.includes("monthly usage quota")) {
    return { kind: "monthly_quota", summary: "月额度已耗尽", ...(resetAt ? { resetAt } : {}), raw };
  }
  if (lowered.includes("tokens per minute") || lowered.includes("tpm")) {
    return { kind: "rate_limit", summary: "触发 TPM 限流", raw };
  }
  if (lowered.includes("usage limit has been reached") || lowered.includes("usage limit")) {
    return { kind: "usage_limit", summary: "触发用量上限", ...(resetAt ? { resetAt } : {}), raw };
  }
  if (lowered.includes("429") && lowered.includes("too many requests")) {
    return { kind: "rate_limit", summary: "被限流 (429)", ...(resetAt ? { resetAt } : {}), raw };
  }
  if (lowered.includes("not supported for this image model") || lowered.includes("complexity")) {
    return { kind: "unknown", summary: "模型不支持该请求参数", raw };
  }
  if (lowered.includes("auth_unavailable") || lowered.includes("unauthorized") || lowered.includes("401")) {
    return { kind: "auth", summary: "上游鉴权不可用", raw };
  }
  if (lowered.includes("503") || lowered.includes("service unavailable") || lowered.includes("overloaded")) {
    return { kind: "service_unavailable", summary: "上游服务不可用", raw };
  }
  if (
    lowered.includes("websocket error") ||
    lowered.includes("stream disconnected") ||
    lowered.includes("connection error") ||
    lowered.includes("fetch failed") ||
    lowered.includes("econnreset") ||
    lowered.includes("etimedout")
  ) {
    return { kind: "network", summary: "网络连接中断", raw };
  }
  if (lowered.includes("aborted") || lowered.includes("terminated")) {
    return { kind: "aborted", summary: "请求被中断", raw };
  }
  if (lowered.startsWith("429")) {
    return { kind: "rate_limit", summary: "被限流 (429)", ...(resetAt ? { resetAt } : {}), raw };
  }
  return { kind: "unknown", summary: "上游返回未知错误", raw };
}

/**
 * 从错误文本中提取服务端给出的重置时间。
 *
 * @param errorMessage 原始错误文本。
 * @returns 含时区的重置时间原文, 不存在时返回 undefined。
 */
export function extractResetTime(errorMessage: string): string | undefined {
  const match = errorMessage.match(
    /reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\s+[+-]\d{4})?(?:\s+[A-Z]{2,5})?)/i,
  );
  return match?.[1]?.trim();
}

/**
 * 从 session transcript 尾部读取最后一条 assistant 记录的失败信息。
 *
 * 只读取文件尾部有限窗口: 失败记录总是本次 turn 的最后一条, 不会出现在
 * 很久以前的位置, 因此无需全文扫描。
 *
 * @param sessionFile Pi session 文件路径。
 * @returns 失败信息; 最后一条 assistant 正常结束或无法读取时返回 undefined。
 */
export async function readLatestFailure(sessionFile: string): Promise<TurnFailure | undefined> {
  const handle = await open(sessionFile, "r").catch(() => undefined);
  if (!handle) {
    return undefined;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return undefined;
    }
    let windowBytes = Math.min(size, TAIL_READ_BYTES);
    for (;;) {
      const start = size - windowBytes;
      const chunk = Buffer.alloc(windowBytes);
      await handle.read(chunk, 0, windowBytes, start);
      const text = chunk.toString("utf8");
      const buffer = start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
      const failure = scanFailureLines(buffer);
      if (failure !== undefined) {
        return failure;
      }
      if (start === 0 || windowBytes >= TAIL_READ_MAX_BYTES) {
        return undefined;
      }
      windowBytes = Math.min(size, windowBytes * 2);
    }
  } finally {
    await handle.close();
  }
}

/**
 * 在一段 transcript 文本中从后向前定位最后一条 assistant 记录的失败信息。
 *
 * @param buffer 已剔除尾部半行的 transcript 文本片段。
 * @returns 失败信息; 最后一条 assistant 正常结束时返回 undefined。
 */
function scanFailureLines(buffer: string): TurnFailure | undefined {
  const lines = buffer.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }
    const message = entry.message;
    if (message.role !== "assistant") {
      continue;
    }
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
    if (errorMessage) {
      return classifyFailure(errorMessage);
    }
    if (stopReason === "error") {
      return { kind: "unknown", summary: "上游返回错误但未提供详情", raw: "stopReason=error" };
    }
    return undefined;
  }
  return undefined;
}

/**
 * 将心跳年龄格式化为简短的中文描述。
 *
 * @param ageMs 距今毫秒数。
 * @returns 形如 `8m` 或 `刚刚` 的文本。
 */
export function formatDuration(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 10) {
    return "刚刚";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/**
 * 将会话状态映射为总览表格使用的短标签。
 *
 * @param state 健康状态。
 * @returns 带图标的短标签。
 */
export function formatHealthState(state: HealthState): string {
  switch (state) {
    case "running":
      return "🟢 运行中";
    case "starting":
      return "🟡 启动中";
    case "stopping":
      return "🟠 停止中";
    case "error":
      return "🔴 错误";
    case "disconnected":
      return "⚫ 断连";
    case "idle":
      return "⚪ 空闲";
  }
}

/**
 * 判断未知值是否为非数组对象。
 *
 * @param value 待检查值。
 * @returns 值可安全读取字段时返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
