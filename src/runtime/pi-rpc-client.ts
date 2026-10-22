import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import type { PiCliInvocation } from "./pi-cli.ts";

export interface PiRpcRecord {
  type: string;
  [key: string]: unknown;
}

export interface PiRpcResponse extends PiRpcRecord {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PiRpcClientOptions {
  invocation: PiCliInvocation;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxRecordBytes?: number;
}

interface PendingRequest {
  command: string;
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * 表示 Pi RPC 命令被拒绝或后台进程退出。
 */
export class PiRpcError extends Error {
  /**
   * 创建 Pi RPC 错误。
   *
   * @param message 面向用户的中文错误信息。
   * @param command 被拒绝的 RPC 命令。
   */
  constructor(
    message: string,
    readonly command?: string,
  ) {
    super(message);
    this.name = "PiRpcError";
  }
}

/**
 * 通过 LF 分帧的 JSONL stdin/stdout 协议控制 Pi RPC 子进程。
 */
export class PiRpcClient extends EventEmitter {
  readonly pid: number | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly maxRecordBytes: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private resolveClosed!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private stdoutBuffer = "";
  private requestSequence = 0;
  private closedResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  /**
   * 创建 RPC 客户端并接管子进程输出流。
   *
   * @param child 已启动的 Pi 子进程。
   * @param requestTimeoutMs 单条命令响应超时。
   * @param maxRecordBytes 单条 JSONL 最大字节数。
   */
  private constructor(
    child: ChildProcessWithoutNullStreams,
    requestTimeoutMs: number,
    maxRecordBytes: number,
  ) {
    super();
    this.child = child;
    this.pid = child.pid;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxRecordBytes = maxRecordBytes;
    this.closed = new Promise((resolveClosed) => {
      this.resolveClosed = resolveClosed;
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => this.rejectPending(new PiRpcError(`Pi RPC 子进程错误: ${error.message}`)));
    child.on("close", (code, signal) => {
      this.closedResult = { code, signal };
      this.resolveClosed(this.closedResult);
      this.rejectPending(
        new PiRpcError(`Pi RPC 子进程已退出, code=${code ?? "null"}, signal=${signal ?? "null"}`),
      );
      this.emit("process_exit", this.closedResult);
    });
  }

  /**
   * 启动 Pi RPC 子进程。
   *
   * @param options 入口、工作目录和环境变量。
   * @returns 已完成 spawn 的 RPC 客户端。
   */
  static async start(options: PiRpcClientOptions): Promise<PiRpcClient> {
    const child = spawn(
      options.invocation.command,
      [...options.invocation.args, "--mode", "rpc", ...(options.args ?? [])],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const client = new PiRpcClient(
      child,
      options.requestTimeoutMs ?? 10000,
      options.maxRecordBytes ?? 16 * 1024 * 1024,
    );
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", () => resolveSpawn());
      child.once("error", (error) => rejectSpawn(new PiRpcError(`无法启动 Pi RPC 子进程: ${error.message}`)));
    });
    return client;
  }

  /**
   * 获取 RPC 子进程是否已退出。
   *
   * @returns 已收到 close 事件时返回 true。
   */
  get isClosed(): boolean {
    return this.closedResult !== undefined;
  }

  /**
   * 发送 RPC 命令并等待对应 response。
   *
   * @param command 不含协议 ID 的命令对象。
   * @param timeoutMs 可选的单次超时覆盖。
   * @returns RPC response。
   * @throws {PiRpcError} 命令失败、超时或进程已退出时抛出。
   */
  async request(
    command: Record<string, unknown> & { type: string },
    timeoutMs = this.requestTimeoutMs,
  ): Promise<PiRpcResponse> {
    if (this.closedResult) {
      throw new PiRpcError("Pi RPC 子进程已退出, 无法发送命令。");
    }
    const id = typeof command.id === "string"
      ? command.id
      : `pi-rpc-${++this.requestSequence}`;
    const outgoing = { ...command, id };
    if (this.pending.has(id)) {
      throw new PiRpcError(`Pi RPC 请求 ID 已在使用: ${id}`, command.type);
    }

    const responsePromise = new Promise<PiRpcResponse>((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new PiRpcError(`Pi RPC 命令响应超时: ${command.type}`, command.type));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, {
        command: command.type,
        resolve: resolveResponse,
        reject: rejectResponse,
        timeout,
      });
    });

    try {
      await this.writeRecord(outgoing);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new PiRpcError("Pi RPC 写入失败。"));
      }
    }
    return responsePromise;
  }

  /**
   * 订阅下一条指定类型的 Pi RPC 事件。
   *
   * @param eventType 事件 type。
   * @param timeoutMs 等待超时。
   * @param signal 用于取消等待的 AbortSignal。
   * @returns 匹配事件记录。
   */
  waitForEvent<T extends PiRpcRecord>(
    eventType: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolveEvent, rejectEvent) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.off(eventType, onEvent);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        action();
      };
      const onEvent = (event: T): void => finish(() => resolveEvent(event));
      const onAbort = (): void => finish(() => rejectEvent(new PiRpcError("等待 Pi RPC 事件已取消。")));
      const timeout = setTimeout(
        () => finish(() => rejectEvent(new PiRpcError(`等待 Pi RPC 事件超时: ${eventType}`))),
        timeoutMs,
      );
      timeout.unref();
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.on(eventType, onEvent);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * 请求 Pi 关闭并等待子进程退出, 超时不会自动强杀。
   *
   * @param timeoutMs 优雅退出等待时长。
   * @returns 无返回值。
   * @throws {PiRpcError} 子进程未在期限内退出时抛出。
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    if (this.closedResult) {
      return;
    }
    this.child.stdin.end();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<never>((_resolveTimeout, rejectTimeout) => {
          timeout = setTimeout(
            () => rejectTimeout(new PiRpcError("Pi RPC 子进程未能优雅退出; 未执行强制终止。")),
            timeoutMs,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * 写入一条 JSONL 命令并遵守 stdin backpressure。
   *
   * @param record 要发送的 JSON 对象。
   * @returns 无返回值。
   */
  private async writeRecord(record: Record<string, unknown>): Promise<void> {
    if (!this.child.stdin.writable || this.closedResult) {
      throw new PiRpcError("Pi RPC stdin 已关闭。");
    }
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.maxRecordBytes) {
      throw new PiRpcError("Pi RPC 命令超过允许的记录大小。");
    }
    if (!this.child.stdin.write(line, "utf8")) {
      await Promise.race([
        once(this.child.stdin, "drain").then(() => undefined),
        this.closed.then(() => {
          throw new PiRpcError("Pi RPC 子进程在接收命令期间退出。");
        }),
      ]);
    }
  }

  /**
   * 按 LF 拆分 stdout JSONL, 不把 Unicode 行分隔符当成记录边界。
   *
   * @param chunk stdout 新到达的 UTF-8 文本。
   * @returns 无返回值。
   */
  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > this.maxRecordBytes && !this.stdoutBuffer.includes("\n")) {
      this.rejectPending(new PiRpcError("Pi RPC stdout 单条记录超过允许大小。"));
      this.child.kill();
      return;
    }

    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      let line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (Buffer.byteLength(line, "utf8") > this.maxRecordBytes) {
        this.rejectPending(new PiRpcError("Pi RPC stdout 单条记录超过允许大小。"));
        this.child.kill();
        return;
      }
      if (line) {
        this.consumeLine(line);
      }
      if (Buffer.byteLength(this.stdoutBuffer, "utf8") > this.maxRecordBytes) {
        this.rejectPending(new PiRpcError("Pi RPC stdout 单条记录超过允许大小。"));
        this.child.kill();
        return;
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  /**
   * 解析并分派一条完整 JSONL 记录。
   *
   * @param line JSONL 文本记录。
   * @returns 无返回值。
   */
  private consumeLine(line: string): void {
    let record: PiRpcRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not_object");
      }
      record = parsed as PiRpcRecord;
      if (typeof record.type !== "string") {
        throw new Error("missing_type");
      }
    } catch {
      this.rejectPending(new PiRpcError("Pi RPC stdout 包含无效 JSONL 记录。"));
      this.child.kill();
      return;
    }

    if (record.type === "response" && typeof record.id === "string") {
      this.consumeResponse(record as PiRpcResponse);
      return;
    }
    if (record.type === "extension_ui_request") {
      this.handleExtensionUiRequest(record);
      return;
    }
    this.emit(record.type, record);
    this.emit("rpc_record", record);
  }

  /**
   * 完成与 response ID 匹配的待处理命令。
   *
   * @param response Pi RPC response。
   * @returns 无返回值。
   */
  private consumeResponse(response: PiRpcResponse): void {
    const pending = this.pending.get(response.id ?? "");
    if (!pending) {
      this.emit("orphan_response", response);
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(response.id ?? "");
    if (!response.success) {
      pending.reject(new PiRpcError(response.error ?? `Pi RPC 命令失败: ${pending.command}`, pending.command));
      return;
    }
    pending.resolve(response);
  }

  /**
   * 对无交互界面的后台扩展请求 fail-closed, 取消所有 dialog。
   *
   * @param request 扩展 UI 请求记录。
   * @returns 无返回值。
   */
  private handleExtensionUiRequest(request: PiRpcRecord): void {
    const method = request.method;
    const id = request.id;
    if (typeof method !== "string" || typeof id !== "string") {
      this.emit("extension_ui_notice", request);
      return;
    }
    if (!["select", "confirm", "input", "editor"].includes(method)) {
      this.emit("extension_ui_notice", request);
      return;
    }

    const response = method === "confirm"
      ? { type: "extension_ui_response", id, confirmed: false }
      : { type: "extension_ui_response", id, cancelled: true };
    void this.writeRecord(response).catch((error: unknown) => {
      this.rejectPending(error instanceof Error ? error : new PiRpcError("无法取消扩展 UI 请求。"));
    });
    this.emit("extension_ui_cancelled", { method, id });
  }

  /**
   * 在进程退出或协议错误时拒绝全部待处理命令。
   *
   * @param error 终止原因。
   * @returns 无返回值。
   */
  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
