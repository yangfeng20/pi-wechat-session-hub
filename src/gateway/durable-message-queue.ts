import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GatewayLease } from "../registry/gateway-lease.ts";
import type { IlinkReplyContext } from "./channel-types.ts";

export type QueueItemState = "queued" | "processing" | "completed" | "failed" | "interrupted";

export interface DurableQueueItem {
  id: string;
  messageId: string;
  routeId: string;
  text: string;
  receivedAt: string;
  updatedAt: string;
  state: QueueItemState;
  attempts: number;
  errorCode?: string;
  replyContext?: IlinkReplyContext;
}

export type QueueClaimResult =
  | { kind: "claimed"; item: DurableQueueItem }
  | { kind: "empty" }
  | { kind: "blocked"; item: DurableQueueItem };

export interface QueueDispatchResult {
  item: DurableQueueItem;
  duplicate: boolean;
  reply?: string;
}

export type QueueProcessor = (item: DurableQueueItem) => Promise<string>;

type QueueWaiter = {
  duplicate: boolean;
  promise: Promise<QueueDispatchResult>;
  resolve: (result: QueueDispatchResult) => void;
  reject: (error: Error) => void;
};

interface EnqueueEvent {
  type: "enqueue";
  id: string;
  messageId: string;
  text: string;
  receivedAt: string;
  replyContext?: IlinkReplyContext;
}

interface StateEvent {
  type: "state";
  id: string;
  state: QueueItemState;
  updatedAt: string;
  attempts: number;
  errorCode?: string;
}

interface DedupeIndex {
  schemaVersion: 1;
  entries: Array<{ messageHash: string; completedAt: string }>;
}

type QueueEvent = EnqueueEvent | StateEvent;

/**
 * 表示 durable queue 发生容量、幂等或状态冲突。
 */
export class DurableQueueError extends Error {
  /**
   * 创建 queue 错误。
   *
   * @param code 稳定错误代码。
   * @param message 面向用户的中文错误信息。
   */
  constructor(
    readonly code:
      | "queue_full"
      | "queue_item_not_found"
      | "invalid_queue_transition"
      | "queue_blocked",
    message: string,
  ) {
    super(message);
    this.name = "DurableQueueError";
  }
}

/**
 * 表示 queue JSONL 损坏, 需要 fail-closed 人工检查。
 */
export class QueueCorruptionError extends Error {
  /**
   * 创建 queue 文件损坏错误。
   *
   * @param message 不包含消息正文的中文说明。
   */
  constructor(message: string) {
    super(message);
    this.name = "QueueCorruptionError";
  }
}

const MAX_RECENT_DEDUPE_IDS = 1000;

/**
 * 将路由消息保存为按 route 分片的 append-only JSONL 队列。
 */
export class DurableMessageQueue {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly drainingRoutes = new Set<string>();
  private readonly drainRequested = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly waiters = new Map<string, QueueWaiter>();
  private readonly waiterRoutes = new Map<string, string>();

  /**
   * 创建 durable queue。
   *
   * @param directory manager 数据目录。
   * @param lease Gateway owner 租约。
   */
  constructor(
    readonly directory: string,
    private readonly lease: GatewayLease,
  ) {}

  /**
   * 持久化入站消息并按 messageId 去重。
   *
   * @param routeId 个人微信对话稳定 ID。
   * @param messageId iLink 提供的幂等消息 ID。
   * @param text 消息正文, 仅写入私有 queue 文件。
   * @param maxPending 最大未完成消息数。
   * @returns 队列项及是否为重复消息。
   * @throws {DurableQueueError} 容量不足或参数非法时抛出。
   */
  async enqueue(
    routeId: string,
    messageId: string,
    text: string,
    maxPending: number,
    replyContext?: IlinkReplyContext,
  ): Promise<{ item: DurableQueueItem; duplicate: boolean }> {
    if (
      !routeId.trim() ||
      routeId.length > 256 ||
      !messageId.trim() ||
      messageId.length > 512 ||
      !text.trim() ||
      (replyContext !== undefined && (
        !replyContext.recipientId.trim() ||
        !replyContext.contextToken.trim() ||
        replyContext.recipientId.length > 256 ||
        replyContext.contextToken.length > 8192
      ))
    ) {
      throw new DurableQueueError(
        "invalid_queue_transition",
        "routeId、messageId 不能为空且长度需在限制内, 消息正文也不能为空。",
      );
    }
    if (text.length > 32000) {
      throw new DurableQueueError(
        "invalid_queue_transition",
        "消息正文超过 durable queue 的单条消息上限。",
      );
    }
    if (!Number.isInteger(maxPending) || maxPending <= 0) {
      throw new DurableQueueError("invalid_queue_transition", "maxPending 必须是正整数。");
    }
    return this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      const items = await this.loadRoute(routeId);
      const duplicate = [...items.values()].find((item) => item.messageId === messageId);
      if (duplicate) {
        if (duplicate.state === "completed") {
          await this.compactRouteUnlocked(routeId, items.values());
        }
        return { item: duplicate, duplicate: true };
      }
      if ([...items.values()].some((item) => item.state === "completed")) {
        await this.compactRouteUnlocked(routeId, items.values());
      }
      const dedupeIndex = await this.readDedupeIndex(routeId);
      const completedAt = dedupeIndex.entries.find((entry) => entry.messageHash === hashMessageId(messageId))?.completedAt;
      if (completedAt) {
        return {
          item: {
            id: `dedupe:${hashMessageId(messageId)}`,
            messageId,
            routeId,
            text: "",
            receivedAt: completedAt,
            updatedAt: completedAt,
            state: "completed",
            attempts: 0,
          },
          duplicate: true,
        };
      }
      const pendingCount = [...items.values()].filter((item) =>
        item.state === "queued" || item.state === "processing" || item.state === "interrupted" || item.state === "failed",
      ).length;
      if (pendingCount >= maxPending) {
        throw new DurableQueueError(
          "queue_full",
          `当前 route 队列已达到上限 ${maxPending}, 新消息未入队。`,
        );
      }

      const now = new Date().toISOString();
      const event: EnqueueEvent = {
        type: "enqueue",
        id: randomUUID(),
        messageId,
        text,
        receivedAt: now,
        ...(replyContext ? { replyContext } : {}),
      };
      await this.appendEvent(routeId, event);
      return {
        item: {
          ...event,
          routeId,
          updatedAt: now,
          state: "queued",
          attempts: 0,
        },
        duplicate: false,
      };
    });
  }

  /**
   * 入队并按 route FIFO 处理消息; handler 应先完成实际回复投递再返回。
   *
   * @param routeId route 稳定 ID。
   * @param messageId channel 提供的幂等 ID。
   * @param text 用户消息正文。
   * @param maxPending 最大未完成消息数。
   * @param processor 单条消息处理函数。
   * @returns 处理结果; 重复且已结束的消息不再执行。
   */
  async dispatch(
    routeId: string,
    messageId: string,
    text: string,
    maxPending: number,
    processor: QueueProcessor,
    replyContext?: IlinkReplyContext,
  ): Promise<QueueDispatchResult> {
    const { item, duplicate } = await this.enqueue(routeId, messageId, text, maxPending, replyContext);
    if (duplicate && item.state !== "queued") {
      if (item.state === "processing" && !this.waiters.has(item.id)) {
        this.kickDrain(routeId, processor);
      }
      return { item, duplicate: true };
    }
    const existingWaiter = this.waiters.get(item.id);
    if (existingWaiter) {
      return existingWaiter.promise;
    }

    let resolveResult!: (result: QueueDispatchResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<QueueDispatchResult>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    });
    this.waiters.set(item.id, {
      duplicate,
      promise: result,
      resolve: resolveResult,
      reject: rejectResult,
    });
    this.waiterRoutes.set(item.id, routeId);
    this.kickDrain(routeId, processor);
    return result;
  }

  /**
   * 等待当前已启动的所有 route FIFO drain 完成。
   *
   * Gateway 停止接收新消息后应等待此方法, 再关闭 worker 并释放单写者租约。
   *
   * @returns 所有 drain 完成时正常结束。
   */
  async waitForIdle(): Promise<void> {
    if (this.drainingRoutes.size === 0) {
      return;
    }
    await new Promise<void>((resolveIdle) => {
      this.idleWaiters.add(resolveIdle);
    });
  }

  /**
   * 恢复某 route 的 queued 消息处理; processing 项会转为 interrupted 并阻断 FIFO。
   *
   * @param routeId route 稳定 ID。
   * @param processor 单条消息处理函数。
   * @returns 无返回值。
   */
  drainPending(routeId: string, processor: QueueProcessor): void {
    this.kickDrain(routeId, processor);
  }

  /**
   * 显式将上次 Gateway 遗留的 processing 项标为 interrupted。
   *
   * @param routeId route 稳定 ID。
   * @returns 恢复后的 route 队列。
   * @throws {DurableQueueError} 当前进程仍在处理该 route 或有多条 processing 项时抛出。
   */
  async recoverInterrupted(routeId: string): Promise<DurableQueueItem[]> {
    return this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      if (this.drainingRoutes.has(routeId)) {
        throw new DurableQueueError(
          "queue_blocked",
          "route 当前仍有 worker 在处理, 不会把 processing 项标记为中断。",
        );
      }
      const items = await this.loadRoute(routeId);
      const processingItems = [...items.values()].filter((item) => item.state === "processing");
      if (processingItems.length > 1) {
        throw new QueueCorruptionError("同一 route 同时存在多个 processing 项, 已停止恢复。");
      }
      if (processingItems.length === 1) {
        const processing = processingItems[0];
        await this.writeState(routeId, processing, "interrupted");
      }
      return [...(await this.loadRoute(routeId)).values()]
        .filter((item) => item.state !== "completed");
    });
  }

  /**
   * 声明 route 上最早的 queued 消息为 processing。
   *
   * 遇到上次进程遗留的 processing、failed 或 interrupted 项时阻塞后续消息, 防止无提示跳过。
   *
   * @param routeId route 稳定 ID。
   * @returns 已声明项、空队列或阻塞项。
   */
  async claimNext(routeId: string): Promise<QueueClaimResult> {
    return this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      const items = [...(await this.loadRoute(routeId)).values()];
      const firstUnfinished = items.find((item) => item.state !== "completed");
      if (!firstUnfinished) {
        await this.compactRouteUnlocked(routeId, items);
        return { kind: "empty" };
      }
      if (firstUnfinished.state === "processing") {
        const interrupted = await this.writeState(routeId, firstUnfinished, "interrupted");
        return { kind: "blocked", item: interrupted };
      }
      if (firstUnfinished.state === "interrupted" || firstUnfinished.state === "failed") {
        return { kind: "blocked", item: firstUnfinished };
      }

      const claimed = await this.writeState(routeId, firstUnfinished, "processing", {
        attempts: firstUnfinished.attempts + 1,
      });
      return { kind: "claimed", item: claimed };
    });
  }

  /**
   * 标记 processing 消息已完成。
   *
   * @param routeId route 稳定 ID。
   * @param itemId queue 项目 ID。
   * @returns 更新后的队列项。
   */
  async complete(routeId: string, itemId: string): Promise<DurableQueueItem> {
    return this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      const items = await this.loadRoute(routeId);
      const item = items.get(itemId);
      if (!item) {
        throw new DurableQueueError("queue_item_not_found", "未找到 queue 项目。");
      }
      const completed = await this.writeState(routeId, item, "completed");
      const updated = new Map(items);
      updated.set(itemId, completed);
      await this.compactRouteUnlocked(routeId, updated.values());
      return completed;
    });
  }

  /**
   * 标记 processing 消息失败, 只记录稳定错误类型, 不记录异常正文。
   *
   * @param routeId route 稳定 ID。
   * @param itemId queue 项目 ID。
   * @param errorCode 稳定错误代码。
   * @returns 更新后的队列项。
   */
  async fail(routeId: string, itemId: string, errorCode: string): Promise<DurableQueueItem> {
    const safeErrorCode = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(errorCode)
      ? errorCode
      : "UnknownError";
    return this.updateState(routeId, itemId, "failed", { errorCode: safeErrorCode });
  }

  /**
   * 显式重试失败或中断项, 后续 FIFO 消息仍保持在其后。
   *
   * @param routeId route 稳定 ID。
   * @param messageId 幂等消息 ID。
   * @returns 更新后的队列项。
   */
  async retry(routeId: string, messageId: string): Promise<DurableQueueItem> {
    return this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      const item = [...(await this.loadRoute(routeId)).values()]
        .find((candidate) => candidate.messageId === messageId);
      if (!item) {
        throw new DurableQueueError("queue_item_not_found", "未找到要重试的 queue 消息。");
      }
      if (item.state !== "failed" && item.state !== "interrupted") {
        throw new DurableQueueError(
          "invalid_queue_transition",
          `只有 failed 或 interrupted 消息可重试, 当前状态为 ${item.state}。`,
        );
      }
      const firstUnfinished = [...(await this.loadRoute(routeId)).values()]
        .find((candidate) => candidate.state !== "completed");
      if (firstUnfinished?.id !== item.id) {
        throw new DurableQueueError(
          "queue_blocked",
          "只能先重试 route 中最早的失败或中断消息。",
        );
      }
      return this.writeState(routeId, item, "queued", { errorCode: undefined });
    });
  }

  /**
   * 列出指定 route 的队列项, 按入队顺序返回。
   *
   * @param routeId route 稳定 ID。
   * @returns 队列状态列表。
   */
  async list(routeId: string): Promise<DurableQueueItem[]> {
    return this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      const items = await this.loadRoute(routeId);
      if ([...items.values()].some((item) => item.state === "completed")) {
        await this.compactRouteUnlocked(routeId, items.values());
      }
      return [...items.values()].filter((item) => item.state !== "completed");
    });
  }

  /**
   * 启动 route 的单项处理器, 避免并行处理同一 route。
   *
   * @param routeId route 稳定 ID。
   * @param processor 单条消息处理函数。
   * @returns 无返回值。
   */
  private kickDrain(routeId: string, processor: QueueProcessor): void {
    if (this.drainingRoutes.has(routeId)) {
      this.drainRequested.add(routeId);
      return;
    }
    this.drainingRoutes.add(routeId);
    setImmediate(() => {
      void this.processNext(routeId, processor);
    });
  }

  /**
   * 声明并处理一条 route 队列消息, 完成后异步调度下一条。
   *
   * @param routeId route 稳定 ID。
   * @param processor 单条消息处理函数。
   * @returns 无返回值。
   */
  private async processNext(routeId: string, processor: QueueProcessor): Promise<void> {
    let claim: QueueClaimResult;
    try {
      claim = await this.claimNext(routeId);
    } catch (error) {
      this.rejectRouteWaiters(routeId, asError(error));
      this.finishDrain(routeId, processor);
      return;
    }
    if (claim.kind === "empty") {
      this.finishDrain(routeId, processor);
      return;
    }
    if (claim.kind === "blocked") {
      this.rejectRouteWaiters(
        routeId,
        new DurableQueueError(
          "queue_blocked",
          `route 队列被 ${claim.item.state} 消息阻塞; 未自动跳过或重复执行。`,
        ),
      );
      this.finishDrain(routeId, processor);
      return;
    }

    const item = claim.item;
    try {
      const reply = await processor(item);
      const completed = await this.complete(routeId, item.id);
      this.resolveWaiter(item.id, {
        item: completed,
        duplicate: this.waiters.get(item.id)?.duplicate ?? false,
        reply,
      });
      setImmediate(() => {
        void this.processNext(routeId, processor);
      });
    } catch (error) {
      const failureCode = error instanceof Error ? error.name : "UnknownError";
      try {
        await this.fail(routeId, item.id, failureCode);
      } catch {
        this.rejectWaiter(item.id, new DurableQueueError(
          "queue_blocked",
          "消息处理失败且 queue 状态无法持久化, 已停止该 route 的后续处理。",
        ));
      }
      this.rejectWaiter(item.id, asError(error));
      this.rejectRouteWaiters(
        routeId,
        new DurableQueueError(
          "queue_blocked",
          "前序消息处理失败, 后续消息仍保留在队列中等待显式恢复。",
        ),
      );
      this.finishDrain(routeId, processor);
    }
  }

  /**
   * 完成当前 route drain 并处理并发到达的下一次 drain 请求。
   *
   * @param routeId route 稳定 ID。
   * @param processor 单条消息处理函数。
   * @returns 无返回值。
   */
  private finishDrain(routeId: string, processor: QueueProcessor): void {
    this.drainingRoutes.delete(routeId);
    const requested = this.drainRequested.delete(routeId);
    if (requested) {
      this.kickDrain(routeId, processor);
      return;
    }
    if (this.drainingRoutes.size === 0) {
      for (const resolveIdle of this.idleWaiters) {
        resolveIdle();
      }
      this.idleWaiters.clear();
    }
  }

  /**
   * 完成并移除指定 queue item 的等待者。
   *
   * @param itemId queue 项目 ID。
   * @param result 处理结果。
   * @returns 无返回值。
   */
  private resolveWaiter(itemId: string, result: QueueDispatchResult): void {
    const waiter = this.waiters.get(itemId);
    if (!waiter) {
      return;
    }
    this.waiters.delete(itemId);
    this.waiterRoutes.delete(itemId);
    waiter.resolve(result);
  }

  /**
   * 拒绝并移除指定 queue item 的等待者。
   *
   * @param itemId queue 项目 ID。
   * @param error 处理错误。
   * @returns 无返回值。
   */
  private rejectWaiter(itemId: string, error: Error): void {
    const waiter = this.waiters.get(itemId);
    if (!waiter) {
      return;
    }
    this.waiters.delete(itemId);
    this.waiterRoutes.delete(itemId);
    waiter.reject(error);
  }

  /**
   * 拒绝 route 上所有等待中的消息, 不删除仍持久化的 queue 记录。
   *
   * @param routeId route 稳定 ID。
   * @param error 处理错误。
   * @returns 无返回值。
   */
  private rejectRouteWaiters(routeId: string, error: Error): void {
    for (const [itemId, waiterRouteId] of this.waiterRoutes) {
      if (waiterRouteId === routeId) {
        this.rejectWaiter(itemId, error);
      }
    }
  }

  /**
   * 更新一项 queue 状态并持久化状态事件。
   *
   * @param routeId route 稳定 ID。
   * @param itemId queue 项目 ID。
   * @param state 新状态。
   * @param extra 可选的 attempts 或 errorCode 覆盖值。
   * @returns 更新后的队列项。
   */
  private async updateState(
    routeId: string,
    itemId: string,
    state: QueueItemState,
    extra: { attempts?: number; errorCode?: string } = {},
  ): Promise<DurableQueueItem> {
    return this.withWriteQueue(async () => {
      await this.lease.assertOwned();
      const item = (await this.loadRoute(routeId)).get(itemId);
      if (!item) {
        throw new DurableQueueError("queue_item_not_found", "未找到 queue 项目。");
      }
      return this.writeState(routeId, item, state, extra);
    });
  }

  /**
   * 读取不含正文的有限期幂等索引。
   *
   * @param routeId route 稳定 ID。
   * @returns 最近完成消息的哈希索引。
   */
  private async readDedupeIndex(routeId: string): Promise<DedupeIndex> {
    const filePath = this.routeDedupeFilePath(routeId);
    try {
      const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        !("schemaVersion" in value) ||
        value.schemaVersion !== 1 ||
        !("entries" in value) ||
        !Array.isArray(value.entries)
      ) {
        throw new QueueCorruptionError("route dedupe index 格式无效。");
      }
      const entries = value.entries as unknown[];
      if (entries.some((entry) => {
        return typeof entry !== "object" ||
          entry === null ||
          !("messageHash" in entry) ||
          typeof entry.messageHash !== "string" ||
          !("completedAt" in entry) ||
          typeof entry.completedAt !== "string";
      })) {
        throw new QueueCorruptionError("route dedupe index 包含无效条目。");
      }
      return value as DedupeIndex;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { schemaVersion: 1, entries: [] };
      }
      throw error;
    }
  }

  /**
   * 压缩 route queue, 移除已完成消息正文并保留有限期哈希去重信息。
   *
   * @param routeId route 稳定 ID。
   * @param values 当前 queue 项。
   * @returns 无返回值。
   */
  private async compactRouteUnlocked(
    routeId: string,
    values: Iterable<DurableQueueItem>,
  ): Promise<void> {
    const items = [...values];
    const completedItems = items.filter((item) => item.state === "completed");
    if (completedItems.length === 0) {
      return;
    }

    const dedupeIndex = await this.readDedupeIndex(routeId);
    const recent = new Map(dedupeIndex.entries.map((entry) => [entry.messageHash, entry]));
    for (const item of completedItems) {
      const messageHash = hashMessageId(item.messageId);
      recent.delete(messageHash);
      recent.set(messageHash, {
        messageHash,
        completedAt: item.updatedAt,
      });
    }
    await this.writeDedupeIndexUnlocked(routeId, {
      schemaVersion: 1,
      entries: [...recent.values()].slice(-MAX_RECENT_DEDUPE_IDS),
    });

    const pendingItems = items.filter((item) => item.state !== "completed");
    const queuePath = this.routeFilePath(routeId);
    if (pendingItems.length === 0) {
      try {
        await unlink(queuePath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
      return;
    }

    const pendingIds = new Set(pendingItems.map((item) => item.id));
    const rawContents = await readFile(queuePath, "utf8");
    const rawLines = rawContents.split("\n");
    if (rawLines.at(-1) === "") {
      rawLines.pop();
    }
    const preservedLines = rawLines.filter((line) => {
      if (!line.trim()) {
        return false;
      }
      const event = JSON.parse(line) as QueueEvent;
      return pendingIds.has(event.id);
    });
    if (preservedLines.length === 0) {
      throw new QueueCorruptionError("route queue 压缩时未找到待处理记录。");
    }
    await this.writeFileAtomically(queuePath, `${preservedLines.join("\n")}\n`);
  }

  /**
   * 原子写入 route 去重索引。
   *
   * @param routeId route 稳定 ID。
   * @param index 去重索引。
   * @returns 无返回值。
   */
  private async writeDedupeIndexUnlocked(routeId: string, index: DedupeIndex): Promise<void> {
    await this.writeFileAtomically(
      this.routeDedupeFilePath(routeId),
      `${JSON.stringify(index, null, 2)}\n`,
    );
  }

  /**
   * 原子替换文件, 临时文件与目标文件位于同一目录。
   *
   * @param filePath 目标文件。
   * @param contents 文件内容。
   * @returns 无返回值。
   */
  private async writeFileAtomically(filePath: string, contents: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      try {
        await unlink(temporaryPath);
      } catch {
        throw new Error("queue 文件写入失败, 且无法清理临时文件。");
      }
      throw error;
    }
    await handle.close();
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") {
          throw cleanupError;
        }
      }
      throw error;
    }
  }

  /**
   * 原子写入 route queue 快照, 使用 SHA-256 避免 route ID 出现在文件名。
   *
   * @param routeId route 稳定 ID。
   * @returns dedupe 文件绝对路径。
   */
  private routeDedupeFilePath(routeId: string): string {
    const routeHash = hashRouteId(routeId);
    return join(this.directory, "queue", `${routeHash}.dedupe.json`);
  }

  /**
   * 追加状态事件并返回更新后的内存状态。
   *
   * @param routeId route 稳定 ID。
   * @param current 当前队列项。
   * @param state 新状态。
   * @param extra 可选状态字段。
   * @returns 更新后的队列项。
   */
  private async writeState(
    routeId: string,
    current: DurableQueueItem,
    state: QueueItemState,
    extra: { attempts?: number; errorCode?: string } = {},
  ): Promise<DurableQueueItem> {
    validateTransition(current.state, state);
    const updatedAt = new Date().toISOString();
    const event: StateEvent = {
      type: "state",
      id: current.id,
      state,
      updatedAt,
      attempts: extra.attempts ?? current.attempts,
      ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
    };
    await this.appendEvent(routeId, event);
    return {
      ...current,
      state,
      updatedAt,
      attempts: event.attempts,
      ...(event.errorCode ? { errorCode: event.errorCode } : { errorCode: undefined }),
    };
  }

  /**
   * 从 append-only JSONL 重建 route 队列状态。
   *
   * @param routeId route 稳定 ID。
   * @returns 按入队顺序排列的当前状态 map。
   */
  private async loadRoute(routeId: string): Promise<Map<string, DurableQueueItem>> {
    const filePath = this.routeFilePath(routeId);
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return new Map();
      }
      throw error;
    }

    const items = new Map<string, DurableQueueItem>();
    const lines = contents.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let event: QueueEvent;
      try {
        event = JSON.parse(line) as QueueEvent;
      } catch {
        throw new QueueCorruptionError("route queue JSONL 有损坏记录, 已拒绝继续处理。");
      }
      if (event.type !== "enqueue" && event.type !== "state") {
        throw new QueueCorruptionError("route queue 包含未知事件类型。");
      }
      if (event.type === "enqueue") {
        if (
          typeof event.id !== "string" ||
          typeof event.messageId !== "string" ||
          typeof event.text !== "string" ||
          typeof event.receivedAt !== "string" ||
          items.has(event.id)
        ) {
          throw new QueueCorruptionError("route queue 入队记录字段无效或 ID 重复。");
        }
        items.set(event.id, {
          ...event,
          routeId,
          updatedAt: event.receivedAt,
          state: "queued",
          attempts: 0,
        });
        continue;
      }
      const current = items.get(event.id);
      if (
        !current ||
        !isQueueItemState(event.state) ||
        !Number.isInteger(event.attempts) ||
        event.attempts < 0 ||
        typeof event.updatedAt !== "string"
      ) {
        throw new QueueCorruptionError("route queue 状态事件无法匹配入队记录。");
      }
      try {
        validateTransition(current.state, event.state);
      } catch {
        throw new QueueCorruptionError("route queue 存在非法状态转换。");
      }
      items.set(event.id, {
        ...current,
        state: event.state,
        updatedAt: event.updatedAt,
        attempts: event.attempts,
        ...(event.errorCode ? { errorCode: event.errorCode } : { errorCode: undefined }),
      });
    }
    return items;
  }

  /**
   * 将队列事件追加到 route 专属文件并同步到磁盘。
   *
   * @param routeId route 稳定 ID。
   * @param event 队列事件。
   * @returns 无返回值。
   */
  private async appendEvent(routeId: string, event: QueueEvent): Promise<void> {
    const filePath = this.routeFilePath(routeId);
    await mkdir(join(this.directory, "queue"), { recursive: true });
    const handle = await open(filePath, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * 将 routeId 哈希为安全文件名。
   *
   * @param routeId route 稳定 ID。
   * @returns queue JSONL 文件绝对路径。
   */
  private routeFilePath(routeId: string): string {
    return join(this.directory, "queue", `${hashRouteId(routeId)}.jsonl`);
  }

  /**
   * 串行执行当前进程的 queue 文件更新。
   *
   * @param operation queue 更新操作。
   * @returns 操作结果。
   */
  private async withWriteQueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release = (): void => undefined;
    this.writeQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/**
 * 哈希 channel message ID, 去重索引中不保存原始值。
 *
 * @param messageId channel message ID。
 * @returns SHA-256 十六进制摘要。
 */
function hashMessageId(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex");
}

/**
 * 哈希 route ID, 避免 route 内容出现在数据文件名中。
 *
 * @param routeId route 稳定 ID。
 * @returns SHA-256 十六进制摘要。
 */
function hashRouteId(routeId: string): string {
  return createHash("sha256").update(routeId).digest("hex");
}

/**
 * 校验 queue 状态转换。
 *
 * @param current 当前状态。
 * @param next 目标状态。
 * @returns 无返回值。
 * @throws {DurableQueueError} 状态转换非法时抛出。
 */
function validateTransition(current: QueueItemState, next: QueueItemState): void {
  const allowed: Record<QueueItemState, QueueItemState[]> = {
    queued: ["processing"],
    processing: ["completed", "failed", "interrupted"],
    completed: [],
    failed: ["queued"],
    interrupted: ["queued"],
  };
  if (!allowed[current].includes(next)) {
    throw new DurableQueueError(
      "invalid_queue_transition",
      `不允许 queue 状态从 ${current} 转为 ${next}。`,
    );
  }
}

/**
 * 判断未知字符串是否为 queue 状态。
 *
 * @param value 待检查状态。
 * @returns 状态属于 QueueItemState 时返回 true。
 */
function isQueueItemState(value: unknown): value is QueueItemState {
  return value === "queued" ||
    value === "processing" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("未知 queue 处理错误。");
}

/**
 * 判断值是否为 Node.js 文件系统错误。
 *
 * @param error 待检查值。
 * @returns 值带有 Node.js 错误代码时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
