import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GatewayLease } from "../registry/gateway-lease.ts";

export type GatewayControlAction = "status" | "stop" | "restart";

export interface GatewayControlHandlers {
  /**
   * 执行一个固定控制动作并返回其结果.
   *
   * @param action Gateway 控制动作.
   * @returns 动作结果.
   */
  handleAction(action: GatewayControlAction, operationId?: string): Promise<unknown>;
  /**
   * 在控制结果已发出并关闭当前请求连接后执行生命周期收尾.
   *
   * @param action 已完成的控制动作.
   * @param operationId restart 动作的完成关联 ID.
   * @returns 收尾完成后正常结束.
   */
  afterActionResponse?(action: GatewayControlAction, operationId?: string): Promise<void>;
}

interface GatewayLeaseCredential {
  ownerId: string;
  pid: number;
  processBirthId: string;
  token: string;
}

/**
 * 表示后台 Gateway 控制通道不可用或响应不可信。
 */
export class GatewayControlError extends Error {
  /**
   * 创建后台 Gateway 控制错误。
   *
   * @param code 稳定错误代码。
   * @param message 可安全展示的中文说明。
   */
  constructor(
    readonly code: "not_running" | "protocol_error" | "authentication_failed" | "request_failed" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "GatewayControlError";
  }
}

/**
 * 提供独立于 Pi TUI 生命周期的本机 Gateway 控制 named pipe 或 Unix socket。
 */
export class GatewayControlServer {
  readonly endpoint: string;
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private readonly platform: NodeJS.Platform;

  /**
   * 创建经过 Gateway lease 认证的本机控制服务。
   *
   * @param managerDirectory Hub 私有数据目录。
   * @param lease 当前 Gateway lease。
   * @param handlers 只接受枚举控制动作的处理器。
   * @param options 平台和测试 endpoint 覆盖值。
   */
  constructor(
    private readonly managerDirectory: string,
    private readonly lease: GatewayLease,
    private readonly handlers: GatewayControlHandlers,
    options: { endpoint?: string; platform?: NodeJS.Platform } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.endpoint = options.endpoint ?? createGatewayControlEndpoint(managerDirectory, this.platform);
  }

  /**
   * 开始监听控制请求。
   *
   * @returns IPC endpoint 开始监听时正常结束。
   * @throws {GatewayControlError} endpoint 无法安全创建或已被占用时抛出。
   */
  async listen(): Promise<void> {
    if (this.platform !== "win32" && !this.endpoint.startsWith("/")) {
      throw new GatewayControlError("protocol_error", "本机控制 socket 路径无效。");
    }
    if (this.server) {
      return;
    }
    await this.removeStaleSocket();
    const server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      void this.handleConnection(socket).catch(() => socket.destroy());
    });
    this.server = server;
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (): void => {
        server.off("listening", onListening);
        this.server = undefined;
        rejectListen(new GatewayControlError("not_running", "后台控制通道无法监听本机 endpoint。"));
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.endpoint);
    });
  }

  /**
   * 关闭控制 listener 并移除本地 Unix socket 文件。
   *
   * @returns 所有连接和 listener 关闭后正常结束。
   */
  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    if (this.platform !== "win32") {
      try {
        const endpointInfo = await lstat(this.endpoint);
        if (!endpointInfo.isSocket() || endpointInfo.isSymbolicLink()) {
          throw new GatewayControlError("protocol_error", "后台控制 endpoint 在关闭时已变为非 socket 文件, 未删除。 ");
        }
        await unlink(this.endpoint);
      } catch (error) {
        if (error instanceof GatewayControlError) {
          throw error;
        }
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  /**
   * 完成本机客户端挑战认证并执行固定控制动作。
   *
   * @param socket 新建的本机 IPC socket。
   * @returns 单次 request 完成后关闭连接。
   */
  private async handleConnection(socket: Socket): Promise<void> {
    const peer = new GatewayControlPeer(socket);
    let completedAction: GatewayControlAction | undefined;
    let completedOperationId: string | undefined;
    try {
      const nonce = randomBytes(32).toString("base64url");
      peer.send({ kind: "challenge", nonce });
      const request = await peer.nextMessage(10000);
      if (!isRecord(request) || request.kind !== "request") {
        throw new GatewayControlError("protocol_error", "控制请求格式无效。");
      }
      const requestId = typeof request.requestId === "string" ? request.requestId : "";
      const action = parseAction(request.action);
      const operationId = typeof request.operationId === "string" ? request.operationId : undefined;
      const operationProof = typeof request.operationProof === "string" ? request.operationProof : undefined;
      if (
        (operationId !== undefined && (!isOperationId(operationId) || action !== "restart" || !operationProof)) ||
        (operationId === undefined && operationProof !== undefined)
      ) {
        throw new GatewayControlError("protocol_error", "Gateway 控制请求 operationId 字段无效。");
      }
      const proof = typeof request.proof === "string" ? request.proof : "";
      if (!/^[a-f0-9-]{36}$/i.test(requestId) || !proof) {
        throw new GatewayControlError("protocol_error", "控制请求缺少有效身份字段。");
      }
      await this.lease.assertOwned();
      const credential = await readGatewayLeaseCredential(this.managerDirectory);
      await this.lease.assertOwned();
      if (
        !verifyProof(credential.token, nonce, requestId, action, proof) ||
        (operationId !== undefined && !verifyOperationProof(
          credential.token,
          nonce,
          requestId,
          action,
          operationId,
          operationProof!,
        ))
      ) {
        throw new GatewayControlError("authentication_failed", "后台控制客户端身份校验失败。");
      }
      const result = await this.handlers.handleAction(action, operationId);
      completedAction = action;
      completedOperationId = operationId;
      peer.send({ kind: "response", requestId, ok: true, result });
    } catch (error) {
      const message = error instanceof GatewayControlError
        ? error.message
        : "后台控制请求未能安全完成。";
      peer.send({ kind: "response", requestId: "", ok: false, message });
    } finally {
      peer.close();
      if (completedAction) {
        await Promise.resolve(this.handlers.afterActionResponse?.(completedAction, completedOperationId)).catch(() => undefined);
      }
    }
  }

  /**
   * 在确认 Gateway lease 已由当前进程持有后清理遗留 Unix socket 文件。
   *
   * @returns 文件不存在或为普通 socket 并清理后正常结束。
   * @throws {GatewayControlError} endpoint 被非 socket 文件占用时抛出。
   */
  private async removeStaleSocket(): Promise<void> {
    if (this.platform === "win32") {
      return;
    }
    try {
      const socketInfo = await lstat(this.endpoint);
      if (!socketInfo.isSocket() || socketInfo.isSymbolicLink()) {
        throw new GatewayControlError("protocol_error", "控制 socket 路径被非 socket 文件占用。");
      }
      await unlink(this.endpoint);
    } catch (error) {
      if (error instanceof GatewayControlError) {
        throw error;
      }
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new GatewayControlError("not_running", "无法安全清理遗留控制 socket。");
      }
    }
  }
}

/**
 * 连接后台 Gateway 并执行一个固定的控制动作。
 */
export class GatewayControlClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  /**
   * 创建 Gateway 控制客户端。
   *
   * @param managerDirectory Hub 私有数据目录。
   * @param options endpoint 与请求超时时间。
   */
  constructor(
    private readonly managerDirectory: string,
    options: { endpoint?: string; timeoutMs?: number; platform?: NodeJS.Platform } = {},
  ) {
    const platform = options.platform ?? process.platform;
    this.endpoint = options.endpoint ?? createGatewayControlEndpoint(managerDirectory, platform);
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  /**
   * 向已运行 Gateway 发送状态、停止或重启请求。
   *
   * @param action 固定控制动作。
   * @param options 可选操作 ID 和响应等待时限。
   * @returns Gateway 返回的数据。
   * @throws {GatewayControlError} Gateway 离线、认证失败或响应无效时抛出。
   */
  async request(
    action: GatewayControlAction,
    options: { operationId?: string; responseTimeoutMs?: number } = {},
  ): Promise<unknown> {
    const operationId = options.operationId;
    const responseTimeoutMs = options.responseTimeoutMs ?? this.timeoutMs;
    if (operationId !== undefined && (!isOperationId(operationId) || action !== "restart")) {
      throw new GatewayControlError("protocol_error", "Gateway 控制请求 operationId 字段无效。");
    }
    const credential = await readGatewayLeaseCredential(this.managerDirectory).catch((error: unknown) => {
      throw error instanceof GatewayControlError
        ? error
        : new GatewayControlError("not_running", "后台 Gateway 当前没有活动 lease。");
    });
    const peer = new GatewayControlPeer(createConnection(this.endpoint));
    try {
      await peer.waitUntilOpen(this.timeoutMs);
      const challenge = await peer.nextMessage(this.timeoutMs);
      if (!isRecord(challenge) || challenge.kind !== "challenge" || typeof challenge.nonce !== "string") {
        throw new GatewayControlError("protocol_error", "后台 Gateway challenge 响应无效。");
      }
      const requestId = randomUUID();
      peer.send({
        kind: "request",
        requestId,
        action,
        ...(operationId
          ? {
              operationId,
              operationProof: createOperationProof(credential.token, challenge.nonce, requestId, action, operationId),
            }
          : {}),
        proof: createProof(credential.token, challenge.nonce, requestId, action),
      });
      const response = await peer.nextMessage(responseTimeoutMs);
      if (
        !isRecord(response) ||
        response.kind !== "response" ||
        response.requestId !== requestId ||
        response.ok !== true
      ) {
        const message = isRecord(response) && typeof response.message === "string"
          ? response.message
          : "后台 Gateway 未返回有效控制响应。";
        throw new GatewayControlError("request_failed", message);
      }
      return response.result;
    } catch (error) {
      if (error instanceof GatewayControlError) {
        throw error;
      }
      throw new GatewayControlError("not_running", "无法连接后台 Gateway 控制通道。");
    } finally {
      peer.close();
    }
  }
}

/**
 * 创建与 manager 数据目录绑定且不包含用户路径的控制 endpoint。
 *
 * @param managerDirectory Hub 私有数据目录。
 * @param platform 当前操作系统平台。
 * @returns Windows named pipe 或 POSIX socket 路径。
 */
export function createGatewayControlEndpoint(
  managerDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = resolve(managerDirectory);
  const normalized = platform === "win32" ? resolved.toLowerCase() : resolved;
  const scope = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return platform === "win32"
    ? `\\\\.\\pipe\\pi-wechat-session-hub-${scope}-control`
    : join(tmpdir(), `pi-wechat-session-hub-${scope}-control.sock`);
}

/**
 * 从受保护的 manager.lock 读取 Gateway lease 客户端认证材料。
 *
 * @param managerDirectory Hub 私有数据目录。
 * @returns 当前 lease 的本机认证材料。
 * @throws {GatewayControlError} lock 缺失、权限路径不可信或格式无效时抛出。
 */
async function readGatewayLeaseCredential(managerDirectory: string): Promise<GatewayLeaseCredential> {
  const lockPath = join(resolve(managerDirectory), "manager.lock");
  let lockInfo;
  try {
    lockInfo = await lstat(lockPath);
  } catch {
    throw new GatewayControlError("not_running", "后台 Gateway 当前没有活动 lease。");
  }
  if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) {
    throw new GatewayControlError("authentication_failed", "Gateway lease 文件类型不可信。");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
  } catch {
    throw new GatewayControlError("authentication_failed", "Gateway lease 文件格式无效。");
  }
  if (
    !isRecord(metadata) ||
    typeof metadata.ownerId !== "string" ||
    typeof metadata.pid !== "number" || !Number.isSafeInteger(metadata.pid) || metadata.pid <= 0 ||
    typeof metadata.processBirthId !== "string" ||
    typeof metadata.token !== "string" || !/^[a-f0-9-]{36}$/i.test(metadata.token)
  ) {
    throw new GatewayControlError("authentication_failed", "Gateway lease 身份字段无效。");
  }
  return metadata as unknown as GatewayLeaseCredential;
}

/**
 * 计算 client 对固定 action 与 requestId 的 challenge proof。
 *
 * @param token Gateway lease 随机令牌。
 * @param nonce 服务端随机 challenge。
 * @param requestId 本次 request UUID。
 * @param action 已验证控制动作。
 * @returns base64url HMAC proof。
 */
function createProof(
  token: string,
  nonce: string,
  requestId: string,
  action: GatewayControlAction,
): string {
  return createHmac("sha256", token)
    .update(`${nonce}\n${JSON.stringify({ requestId, action })}`, "utf8")
    .digest("base64url");
}

/**
 * 使用恒定时间比较校验控制动作 HMAC。
 *
 * @param token Gateway lease 随机令牌。
 * @param nonce 服务端随机 challenge。
 * @param requestId 本次 request UUID。
 * @param action 已验证控制动作。
 * @param proof 客户端提供的 proof。
 * @returns proof 有效时返回 true。
 */
function verifyProof(
  token: string,
  nonce: string,
  requestId: string,
  action: GatewayControlAction,
  proof: string,
): boolean {
  const expected = Buffer.from(createProof(token, nonce, requestId, action), "base64url");
  const actual = Buffer.from(proof, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * 为 restart 操作 ID 生成兼容旧 control client 的附加 HMAC.
 *
 * @param token Gateway lease 随机令牌.
 * @param nonce 服务端随机 challenge.
 * @param requestId 本次 request UUID.
 * @param action Gateway 控制动作.
 * @param operationId restart 操作 ID.
 * @returns 绑定 operationId 的 base64url HMAC.
 */
function createOperationProof(
  token: string,
  nonce: string,
  requestId: string,
  action: GatewayControlAction,
  operationId: string,
): string {
  return createHmac("sha256", token)
    .update(`${nonce}\n${JSON.stringify({ requestId, action, operationId })}`, "utf8")
    .digest("base64url");
}

/**
 * 校验 restart 操作 ID 的附加 HMAC.
 *
 * @param token Gateway lease 随机令牌.
 * @param nonce 服务端随机 challenge.
 * @param requestId 本次 request UUID.
 * @param action Gateway 控制动作.
 * @param operationId restart 操作 ID.
 * @param proof 客户端提供的附加 proof.
 * @returns proof 有效时返回 true.
 */
function verifyOperationProof(
  token: string,
  nonce: string,
  requestId: string,
  action: GatewayControlAction,
  operationId: string,
  proof: string,
): boolean {
  const expected = Buffer.from(
    createOperationProof(token, nonce, requestId, action, operationId),
    "base64url",
  );
  const actual = Buffer.from(proof, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * 判断值是否为本次 Gateway 生命周期操作的 UUID.
 *
 * @param value 待校验 ID.
 * @returns UUID 格式有效时返回 true.
 */
function isOperationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * 将控制 action 校验为严格枚举。
 *
 * @param value 未知请求字段。
 * @returns 有效控制动作。
 * @throws {GatewayControlError} 请求动作不受支持时抛出。
 */
function parseAction(value: unknown): GatewayControlAction {
  if (value === "status" || value === "stop" || value === "restart") {
    return value;
  }
  throw new GatewayControlError("protocol_error", "Gateway 控制动作不受支持。");
}

/**
 * 判断值是否为普通对象。
 *
 * @param value 待检查值。
 * @returns 普通对象时返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 判断值是否为 Node.js 文件系统或网络错误。
 *
 * @param error 待检查值。
 * @returns 值带有错误代码时返回 true。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * 处理本机控制 socket 上的换行 JSON frame 和有界请求超时。
 */
class GatewayControlPeer {
  private input = "";
  private closed = false;
  private readonly queued: unknown[] = [];
  private readonly waiters: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  /**
   * 创建控制 peer 并挂接 socket 生命周期事件。
   *
   * @param socket 本机 IPC socket。
   */
  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleData(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new GatewayControlError("not_running", "Gateway 控制连接已关闭。")));
  }

  /**
   * 等待 socket connect event。
   *
   * @param timeoutMs 建连超时。
   * @returns 连接建立时正常结束。
   */
  waitUntilOpen(timeoutMs: number): Promise<void> {
    if (this.socket.readyState === "open") {
      return Promise.resolve();
    }
    return new Promise<void>((resolveOpen, rejectOpen) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.socket.off("connect", onConnect);
        this.socket.off("error", onError);
      };
      const onConnect = (): void => {
        cleanup();
        resolveOpen();
      };
      const onError = (): void => {
        cleanup();
        rejectOpen(new GatewayControlError("not_running", "Gateway 控制 socket 建连失败。"));
      };
      const timer = setTimeout(() => {
        cleanup();
        rejectOpen(new GatewayControlError("timeout", "Gateway 控制 socket 建连超时。"));
      }, timeoutMs);
      timer.unref();
      this.socket.once("connect", onConnect);
      this.socket.once("error", onError);
    });
  }

  /**
   * 发送一个 JSON line frame。
   *
   * @param frame 已校验结构化消息。
   * @returns frame 写入 socket 后正常结束。
   */
  send(frame: Record<string, unknown>): void {
    if (this.closed || this.socket.destroyed) {
      throw new GatewayControlError("not_running", "Gateway 控制 socket 已关闭。");
    }
    this.socket.write(`${JSON.stringify(frame)}\n`, "utf8");
  }

  /**
   * 读取并解析下一个 JSON line frame。
   *
   * @param timeoutMs 等待超时。
   * @returns 已解析 frame。
   */
  nextMessage(timeoutMs: number): Promise<unknown> {
    const queued = this.queued.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise<unknown>((resolveMessage, rejectMessage) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolveMessage);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        rejectMessage(new GatewayControlError("timeout", "等待 Gateway 控制响应超时。"));
      }, timeoutMs);
      timer.unref();
      this.waiters.push({ resolve: resolveMessage, reject: rejectMessage, timer });
      if (this.closed) {
        this.fail(new GatewayControlError("not_running", "Gateway 控制连接已关闭。"));
      }
    });
  }

  /**
   * 正常关闭 socket。
   *
   * @returns 无返回值。
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
    this.fail(new GatewayControlError("not_running", "Gateway 控制连接已关闭。"));
  }

  /**
   * 收集并分发换行分隔的 JSON frame。
   *
   * @param chunk 新收到的 UTF-8 数据。
   * @returns frame 被解析或连接被拒绝后结束。
   */
  private handleData(chunk: string): void {
    this.input += chunk;
    if (Buffer.byteLength(this.input, "utf8") > 128 * 1024) {
      this.fail(new GatewayControlError("protocol_error", "Gateway 控制 frame 超出大小限制。"));
      this.socket.destroy();
      return;
    }
    while (true) {
      const newline = this.input.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.input.slice(0, newline);
      this.input = this.input.slice(newline + 1);
      if (!line.trim()) {
        continue;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(line) as unknown;
      } catch {
        this.fail(new GatewayControlError("protocol_error", "Gateway 控制 frame JSON 无效。"));
        this.socket.destroy();
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        this.queued.push(frame);
      }
    }
  }

  /**
   * 将 socket error/close 传递给全部未完成 reader。
   *
   * @param error 连接结束原因。
   * @returns 无返回值。
   */
  private fail(error: Error): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
