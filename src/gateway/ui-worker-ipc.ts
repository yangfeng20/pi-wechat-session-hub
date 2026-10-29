import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants, realpathSync } from "node:fs";
import { mkdir, open, readdir, lstat, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isProcessAlive } from "../system/process-liveness.ts";
import { GatewayLease } from "../registry/gateway-lease.ts";
import { ManagerRegistry } from "../registry/manager-registry.ts";
import type { UiWorkerLaunchRecord, UiWorkerRegistration } from "./ui-worker-types.ts";

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_LAUNCH_RECORD_BYTES = 64 * 1024;

/**
 * 表示 UI worker 本机 IPC 的握手、协议或连接状态不安全。
 */
export class UiWorkerIpcError extends Error {
  /**
   * 创建不包含 launch ticket 或消息正文的 IPC 错误。
   *
   * @param code 稳定错误代码。
   * @param message 可安全显示的中文说明。
   */
  constructor(
    readonly code:
      | "pipe_unavailable"
      | "invalid_frame"
      | "handshake_rejected"
      | "worker_disconnected"
      | "request_timeout"
      | "launch_record_invalid"
      | "project_not_registered",
    message: string,
  ) {
    super(message);
    this.name = "UiWorkerIpcError";
  }
}

/**
 * UI worker 启动注册完成后的本机 IPC 连接。
 */
export class UiWorkerIpcConnection extends EventEmitter {
  /**
   * 创建已完成认证的 IPC connection。
   *
   * @param peer 已连接的 JSONL peer。
   * @param registration 当前 owner 注册信息。
   */
  constructor(
    private readonly peer: JsonLinePeer,
    readonly registration: UiWorkerRegistration,
  ) {
    super();
    this.peer.on("event", (name: string, data: Record<string, unknown>) => {
      this.emit("worker_event", name, data);
    });
    this.peer.on("close", () => this.emit("close"));
    this.peer.on("transport_error", (error: Error) => this.emit("transport_error", error));
  }

  /**
   * 向 UI worker 发送控制请求并等待它的响应。
   *
   * @param method 受控 IPC 方法名。
   * @param params 结构化参数对象。
   * @param timeoutMs 等待超时。
   * @returns UI worker 响应数据。
   * @throws {UiWorkerIpcError} worker 断开或请求超时时抛出。
   */
  request(method: string, params: Record<string, unknown>, timeoutMs = 15 * 60 * 1000): Promise<unknown> {
    return this.peer.request(method, params, timeoutMs);
  }

  /**
   * 关闭本机 IPC connection。
   *
   * @returns 无返回值。
   */
  close(): void {
    this.peer.close();
  }
}

/**
 * UI worker IPC 认证后调用的 registry、事件和断连处理器。
 */
export interface UiWorkerIpcServerHandlers {
  onRegister: (
    registration: UiWorkerRegistration,
    authHash: string,
    launchRecord: UiWorkerLaunchRecord | undefined,
    connection: UiWorkerIpcConnection,
  ) => Promise<void>;
  onWorkerEvent?: (
    connection: UiWorkerIpcConnection,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<void>;
  onRequest?: (
    connection: UiWorkerIpcConnection,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  onDisconnect?: (connection: UiWorkerIpcConnection, serverStopping: boolean) => Promise<void>;
}

/**
 * 通过 stable named pipe 管理 Hub session owner 注册、重连与受控 request。
 */
export class UiWorkerIpcServer extends EventEmitter {
  readonly endpoint: string;
  private server?: Server;
  private managerAuthHash?: string;
  private stopping = false;
  private handlers?: UiWorkerIpcServerHandlers;
  private readonly pendingLaunches = new Map<string, UiWorkerLaunchRecord>();
  private readonly reservedLaunches = new Set<string>();
  private readonly connections = new Map<string, UiWorkerIpcConnection>();
  private readonly sockets = new Set<Socket>();

  /**
   * 创建 UI worker IPC server。
   *
   * @param managerDirectory manager 数据目录。
   * @param registry 单写者 manager registry。
   * @param options 可选 endpoint, 用于本机 IPC 测试。
   */
  constructor(
    private readonly managerDirectory: string,
    private readonly registry: ManagerRegistry,
    private readonly lease: GatewayLease,
    options: { endpoint?: string } = {},
  ) {
    super();
    this.endpoint = options.endpoint ?? createStableNamedPipe(managerDirectory);
  }

  /**
   * 设置注册、运行事件和连接关闭处理器。
   *
   * @param handlers worker 生命周期 handler。
   * @returns 无返回值。
   */
  setHandlers(handlers: UiWorkerIpcServerHandlers): void {
    this.handlers = handlers;
  }

  /**
   * 启动 UI worker IPC server。
   *
   * @returns server 开始监听时正常结束。
   * @throws {UiWorkerIpcError} endpoint 不可用时抛出。
   */
  async listen(): Promise<void> {
    if (process.platform !== "win32" && !this.endpoint.startsWith("/")) {
      throw new UiWorkerIpcError("pipe_unavailable", "可见 UI worker named pipe 仅支持 Windows。 ");
    }
    if (this.server) {
      return;
    }
    await this.cleanupAbandonedLaunchRecords();
    this.managerAuthHash = hashUiWorkerTicket(await readOrCreateUiWorkerAttachToken(this.managerDirectory));
    const server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      void this.acceptSocket(socket).catch(() => socket.destroy());
    });
    this.server = server;
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (): void => {
        server.off("listening", onListening);
        this.server = undefined;
        rejectListen(new UiWorkerIpcError("pipe_unavailable", "UI worker pipe endpoint 已占用或不可用。 "));
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
   * 在取得 lease 后清理上一个 Gateway 遗留的未完成一次性 launch files。
   *
   * @returns 清理完成后正常结束。
   */
  private async cleanupAbandonedLaunchRecords(): Promise<void> {
    await this.lease.assertOwned();
    const launchDirectory = join(this.managerDirectory, "launches");
    let entries;
    try {
      const launchDirectoryStat = await lstat(launchDirectory);
      if (!launchDirectoryStat.isDirectory() || launchDirectoryStat.isSymbolicLink()) {
        throw new UiWorkerIpcError("launch_record_invalid", "launches 路径不是普通目录, Gateway fail-closed。 ");
      }
      entries = await readdir(launchDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    const launchFiles = entries.filter((name) =>
      /^[a-f0-9-]{36}\.json$/i.test(name) || /^.+\.tmp$/i.test(name),
    );
    await Promise.all(launchFiles.map((name) =>
      unlink(join(launchDirectory, name)).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }),
    ));
  }

  /**
   * 将一次性启动信息写到 manager 私有目录并保存待握手记录。
   *
   * @param record 已生成的 UI worker launch record。
   * @returns launch record 文件绝对路径。
   */
  async registerLaunch(record: UiWorkerLaunchRecord): Promise<string> {
    assertLaunchRecord(record, this.managerDirectory);
    await this.lease.assertOwned();
    const launchDirectory = join(this.managerDirectory, "launches");
    await mkdir(launchDirectory, { recursive: true, mode: 0o700 });
    const launchDirectoryStat = await lstat(launchDirectory);
    if (!launchDirectoryStat.isDirectory() || launchDirectoryStat.isSymbolicLink()) {
      throw new UiWorkerIpcError("launch_record_invalid", "launches 路径不是 manager 下的普通目录。 ");
    }
    const filePath = join(launchDirectory, `${record.launchId}.json`);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    this.pendingLaunches.set(record.launchId, record);
    return filePath;
  }

  /**
   * 等待新启动的 UI worker 完成注册。
   *
   * @param launchId launch UUID。
   * @param timeoutMs 握手时限。
   * @returns 已注册连接。
   */
  waitForLaunch(launchId: string, timeoutMs: number): Promise<UiWorkerIpcConnection> {
    return this.waitForConnection((connection) => connection.registration.launchId === launchId, timeoutMs);
  }

  /**
   * 等待先前已登记且仍存活的 UI worker 重新连接。
   *
   * @param instanceId registry instance ID。
   * @param timeoutMs 最大等待时间。
   * @returns 已认证的 UI worker connection。
   */
  waitForReattach(instanceId: string, timeoutMs: number): Promise<UiWorkerIpcConnection> {
    const connection = this.connections.get(instanceId);
    if (connection) {
      return Promise.resolve(connection);
    }
    return this.waitForConnection((candidate) => candidate.registration.instanceId === instanceId, timeoutMs);
  }

  /**
   * 查询一个已认证 UI worker connection。
   *
   * @param instanceId worker instance ID。
   * @returns 当前 connection 或 undefined。
   */
  getConnection(instanceId: string): UiWorkerIpcConnection | undefined {
    return this.connections.get(instanceId);
  }

  /**
   * 删除已使用的 launch ticket 文件。
   *
   * @param launchId launch UUID。
   * @returns 无返回值。
   */
  async removeLaunch(launchId: string): Promise<void> {
    this.pendingLaunches.delete(launchId);
    this.reservedLaunches.delete(launchId);
    await this.lease.assertOwned();
    try {
      await unlink(join(this.managerDirectory, "launches", `${launchId}.json`));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  /**
   * 停止监听并断开 pipe sockets, 不关闭用户的 Pi TUI 进程。
   *
   * @returns server close 完成时正常结束。
   */
  async close(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.pendingLaunches.keys()].map((launchId) =>
      this.removeLaunch(launchId).catch(() => undefined),
    ));
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    for (const connection of this.connections.values()) {
      connection.close();
    }
    this.connections.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }

  /**
   * 等待指定的 worker registration event。
   *
   * @param predicate 连接匹配函数。
   * @param timeoutMs 最大等待时间。
   * @returns 匹配连接。
   */
  private waitForConnection(
    predicate: (connection: UiWorkerIpcConnection) => boolean,
    timeoutMs: number,
  ): Promise<UiWorkerIpcConnection> {
    const found = [...this.connections.values()].find(predicate);
    if (found) {
      return Promise.resolve(found);
    }
    return new Promise<UiWorkerIpcConnection>((resolveConnection, rejectConnection) => {
      const timer = setTimeout(() => {
        this.off("worker_registered", onRegistered);
        rejectConnection(new UiWorkerIpcError("request_timeout", "UI worker 未在期限内注册或重连。 "));
      }, timeoutMs);
      timer.unref();
      const onRegistered = (connection: UiWorkerIpcConnection): void => {
        if (!predicate(connection)) {
          return;
        }
        clearTimeout(timer);
        this.off("worker_registered", onRegistered);
        resolveConnection(connection);
      };
      this.on("worker_registered", onRegistered);
    });
  }

  /**
   * 执行 UI worker challenge-response 握手。
   *
   * @param socket 新接入的 socket。
   * @returns 注册、连接监听或安全拒绝结束。
   */
  private async acceptSocket(socket: Socket): Promise<void> {
    const peer = new JsonLinePeer(socket);
    let reservedLaunchId: string | undefined;
    try {
      const hello = await peer.nextMessage(10000);
      if (!isPlainRecord(hello)) {
        throw new UiWorkerIpcError("handshake_rejected", "UI worker hello frame 无效。 ");
      }
      if (hello.kind === "control_hello") {
        await this.acceptControlConnection(peer, hello);
        return;
      }
      if (hello.kind !== "hello") {
        throw new UiWorkerIpcError("handshake_rejected", "UI worker 首个 IPC frame 必须为 hello。 ");
      }
      const registration = parseUiWorkerRegistration(hello.registration);
      const authKind = hello.authKind === undefined ? "ticket" : hello.authKind;
      if (authKind !== "ticket" && authKind !== "manager") {
        throw new UiWorkerIpcError("handshake_rejected", "UI worker authentication kind 无效。 ");
      }
      const auth = await this.resolveAuthContext(registration, authKind);
      if (auth.launchRecord) {
        reservedLaunchId = auth.launchRecord.launchId;
      }
      const nonce = randomBytes(32).toString("base64url");
      peer.send({ kind: "challenge", nonce });
      const proof = await peer.nextMessage(10000);
      if (proof.kind !== "proof" || typeof proof.value !== "string") {
        throw new UiWorkerIpcError("handshake_rejected", "UI worker challenge response 格式无效。 ");
      }
      const expectedProof = createUiWorkerProof(auth.authHash, nonce, registration);
      if (!safeEqualBase64(proof.value, expectedProof)) {
        throw new UiWorkerIpcError("handshake_rejected", "UI worker challenge response 校验失败。 ");
      }
      const connection = new UiWorkerIpcConnection(peer, registration);
      if (!this.handlers) {
        throw new UiWorkerIpcError("pipe_unavailable", "Gateway UI worker handler 尚未注册。 ");
      }
      await this.handlers.onRegister(registration, auth.authHash, auth.launchRecord, connection);
      const oldConnection = this.connections.get(registration.instanceId);
      if (oldConnection && oldConnection !== connection) {
        oldConnection.close();
      }
      this.connections.set(registration.instanceId, connection);
      connection.on("worker_event", (name: string, data: Record<string, unknown>) => {
        void this.handlers?.onWorkerEvent?.(connection, name, data).catch(() => undefined);
      });
      peer.setRequestHandler(async (method, params) => {
        if (method === "worker_shutdown") {
          await this.handlers?.onWorkerEvent?.(connection!, "worker_shutdown", params);
          return { accepted: true };
        }
        if (this.handlers?.onRequest) {
          return this.handlers.onRequest(connection!, method, params);
        }
        throw new UiWorkerIpcError("invalid_frame", "Gateway 不支持该 UI worker IPC request。 ");
      });
      connection.once("close", () => {
        if (this.connections.get(registration.instanceId) === connection) {
          this.connections.delete(registration.instanceId);
        }
        void this.handlers?.onDisconnect?.(connection, this.stopping).catch(() => undefined);
      });
      peer.send({ kind: "registered", instanceId: registration.instanceId });
      const ready = await peer.nextMessage(5000);
      if (ready.kind !== "client_ready") {
        throw new UiWorkerIpcError("handshake_rejected", "UI worker 未能初始化 IPC request handler。 ");
      }
      if (auth.launchRecord) {
        await this.removeLaunch(auth.launchRecord.launchId);
      }
      this.emit("worker_registered", connection);
    } catch (error) {
      if (reservedLaunchId) {
        this.reservedLaunches.delete(reservedLaunchId);
      }
      const message = error instanceof UiWorkerIpcError
        ? error.message
        : "UI worker 注册未通过安全校验。";
      peer.send({ kind: "registration_error", message });
      peer.close();
    }
  }

  /**
   * 建立只允许发起 can_switch_session request 的临时本机控制连接。
   *
   * @param peer 已连接 JSONL peer。
   * @param hello 已通过 JSON decode 的首个 control frame。
   * @returns control client ready handshake 完成后正常结束。
   * @throws {UiWorkerIpcError} attach token 或 control request 校验失败时抛出。
   */
  private async acceptControlConnection(
    peer: JsonLinePeer,
    hello: Record<string, unknown>,
  ): Promise<void> {
    const registration = parseUiWorkerRegistration(hello.registration);
    await this.lease.assertOwned();
    const authHash = this.managerAuthHash;
    if (!authHash) {
      throw new UiWorkerIpcError("handshake_rejected", "Gateway UI attach key 尚未初始化。 ");
    }
    const nonce = randomBytes(32).toString("base64url");
    peer.send({ kind: "challenge", nonce });
    const proof = await peer.nextMessage(10000);
    if (proof.kind !== "proof" || typeof proof.value !== "string") {
      throw new UiWorkerIpcError("handshake_rejected", "UI switch control proof 格式无效。 ");
    }
    const expectedProof = createUiWorkerProof(authHash, nonce, registration);
    if (!safeEqualBase64(proof.value, expectedProof)) {
      throw new UiWorkerIpcError("handshake_rejected", "UI switch control attach token 校验失败。 ");
    }
    const connection = new UiWorkerIpcConnection(peer, registration);
    peer.setRequestHandler(async (method, params) => {
      await this.lease.assertOwned();
      if (method !== "can_switch_session" || !this.handlers?.onRequest) {
        throw new UiWorkerIpcError("invalid_frame", "UI switch control connection 仅允许 can_switch_session。 ");
      }
      return this.handlers.onRequest(connection, method, params);
    });
    peer.send({ kind: "control_registered", instanceId: registration.instanceId });
    const ready = await peer.nextMessage(5000);
    if (ready.kind !== "client_ready") {
      throw new UiWorkerIpcError("handshake_rejected", "UI switch control client 未能就绪。 ");
    }
  }

  /**
   * 解析初次 launch 或进程重连所需的共享秘密 hash。
   *
   * @param registration Pi extension registration。
   * @returns HMAC key 和可选启动记录。
   */
  private async resolveAuthContext(
    registration: UiWorkerRegistration,
    authKind: "ticket" | "manager",
  ): Promise<UiWorkerLaunchAuthContext> {
    const launchRecord = this.pendingLaunches.get(registration.launchId);
    if (launchRecord) {
      if (authKind !== "ticket") {
        throw new UiWorkerIpcError("handshake_rejected", "一次性 UI launch 只能使用对应 ticket 认证。 ");
      }
      if (this.reservedLaunches.has(registration.launchId)) {
        throw new UiWorkerIpcError("handshake_rejected", "UI worker launch ticket 已被另一连接使用。 ");
      }
      this.reservedLaunches.add(registration.launchId);
      if (
        launchRecord.instanceId !== registration.instanceId ||
        Date.parse(launchRecord.expiresAt) <= Date.now() ||
        launchRecord.projectAlias !== registration.projectAlias ||
        !samePath(launchRecord.projectPath, registration.cwd) ||
        (launchRecord.mode === "resume" && (
          launchRecord.sessionId !== registration.sessionId ||
          !samePath(launchRecord.sessionFile ?? "", registration.sessionFile)
        ))
      ) {
        throw new UiWorkerIpcError("handshake_rejected", "UI worker registration 与 launch record 不匹配。 ");
      }
      return { authHash: hashUiWorkerTicket(launchRecord.ticket), launchRecord };
    }

    if (authKind === "manager") {
      await this.lease.assertOwned();
      const authHash = this.managerAuthHash;
      if (!authHash) {
        throw new UiWorkerIpcError("handshake_rejected", "Gateway UI attach key 尚未初始化。 ");
      }
      await this.lease.assertOwned();
      return { authHash };
    }

    const snapshot = await this.registry.readSnapshot();
    const owner = snapshot.instances[registration.instanceId];
    if (
      !owner ||
      owner.mode !== "ui" ||
      owner.launchId !== registration.launchId ||
      owner.pid !== registration.pid ||
      owner.processBirthId !== registration.processBirthId ||
      typeof owner.ipcAuthHash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(owner.ipcAuthHash) ||
      !isProcessAlive(owner.pid)
    ) {
      throw new UiWorkerIpcError("handshake_rejected", "UI worker 不是 registry 中有效的 active owner。 ");
    }
    return { authHash: owner.ipcAuthHash };
  }
}

/**
 * 通过 Gateway named pipe 接收可见 Pi TUI control request 并安全重连。
 */
export class UiWorkerIpcClient extends EventEmitter {
  private requestHandler?: (method: string, params: Record<string, unknown>) => Promise<unknown>;

  /**
   * 创建已认证 UI worker client。
   *
   * @param peer JSONL peer。
   * @param registration 当前 worker 注册信息。
   */
  private constructor(private readonly peer: JsonLinePeer, readonly registration: UiWorkerRegistration) {
    super();
    peer.on("event", (name: string, data: Record<string, unknown>) => this.emit("gateway_event", name, data));
    peer.on("request", (requestId: string, method: string, params: Record<string, unknown>) => {
      void this.handleRequest(requestId, method, params);
    });
    peer.on("close", () => this.emit("close"));
    peer.on("transport_error", (error: Error) => this.emit("transport_error", error));
  }

  /**
   * 连接 pipe 并完成 HMAC challenge-response。
   *
   * @param endpoint stable pipe endpoint。
   * @param ticket launch record ticket。
   * @param registration 当前 worker registration。
   * @param timeoutMs 握手超时。
   * @returns 已认证 client。
   */
  static async connect(
    endpoint: string,
    ticket: string,
    registration: UiWorkerRegistration,
    options: {
      timeoutMs?: number;
      managerToken?: string;
      requestHandler?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    } = {},
  ): Promise<UiWorkerIpcClient> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const peer = new JsonLinePeer(createConnection(endpoint));
    try {
      await peer.waitUntilOpen(timeoutMs);
      peer.send({
        kind: "hello",
        registration: publicRegistration(registration),
        authKind: options.managerToken ? "manager" : "ticket",
      });
      const challenge = await peer.nextMessage(timeoutMs);
      if (challenge.kind !== "challenge" || typeof challenge.nonce !== "string") {
        throw new UiWorkerIpcError("handshake_rejected", "Gateway 未返回有效 IPC challenge。 ");
      }
      peer.send({
        kind: "proof",
        value: createUiWorkerProof(
          hashUiWorkerTicket(options.managerToken ?? ticket),
          challenge.nonce,
          registration,
        ),
      });
      const accepted = await peer.nextMessage(timeoutMs);
      if (accepted.kind !== "registered" || accepted.instanceId !== registration.instanceId) {
        throw new UiWorkerIpcError(
          "handshake_rejected",
          typeof accepted.message === "string" ? accepted.message : "Gateway 未确认 UI worker 注册。",
        );
      }
      const client = new UiWorkerIpcClient(peer, registration);
      if (options.requestHandler) {
        client.setRequestHandler(options.requestHandler);
      }
      peer.send({ kind: "client_ready" });
      return client;
    } catch (error) {
      peer.close();
      if (error instanceof UiWorkerIpcError) {
        throw error;
      }
      throw new UiWorkerIpcError("pipe_unavailable", "无法连接 Gateway named pipe。 ");
    }
  }

  /**
   * 建立不占有 session 的本机 UI switch control connection。
   *
   * @param endpoint Gateway UI IPC endpoint。
   * @param managerDirectory Hub 私有数据目录。
   * @param managerToken 当前 manager 目录稳定 attach token。
   * @param options 握手超时配置。
   * @returns 仅用于 can_switch_session 等授权 control request 的 client。
   * @throws {UiWorkerIpcError} server 身份验证或连接失败时抛出。
   */
  static async connectControl(
    endpoint: string,
    managerDirectory: string,
    managerToken: string,
    options: { timeoutMs?: number } = {},
  ): Promise<UiWorkerIpcClient> {
    const registration: UiWorkerRegistration = {
      launchId: randomUUID(),
      instanceId: randomUUID(),
      pid: process.pid,
      processBirthId: `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`,
      sessionId: "control-only",
      sessionFile: join(resolve(managerDirectory), "control-only.jsonl"),
      cwd: resolve(managerDirectory),
      projectAlias: "control",
      state: "idle",
    };
    const peer = new JsonLinePeer(createConnection(endpoint));
    const timeoutMs = options.timeoutMs ?? 3000;
    try {
      await peer.waitUntilOpen(timeoutMs);
      peer.send({ kind: "control_hello", registration: publicRegistration(registration) });
      const challenge = await peer.nextMessage(timeoutMs);
      if (challenge.kind !== "challenge" || typeof challenge.nonce !== "string") {
        throw new UiWorkerIpcError("handshake_rejected", "Gateway 未返回有效 control challenge。 ");
      }
      peer.send({
        kind: "proof",
        value: createUiWorkerProof(hashUiWorkerTicket(managerToken), challenge.nonce, registration),
      });
      const accepted = await peer.nextMessage(timeoutMs);
      if (accepted.kind !== "control_registered") {
        throw new UiWorkerIpcError("handshake_rejected", "Gateway 未确认 UI switch control connection。 ");
      }
      const client = new UiWorkerIpcClient(peer, registration);
      peer.send({ kind: "client_ready" });
      return client;
    } catch (error) {
      peer.close();
      if (error instanceof UiWorkerIpcError) {
        throw error;
      }
      throw new UiWorkerIpcError("pipe_unavailable", "无法连接 Gateway UI switch control endpoint。 ");
    }
  }

  /**
   * 配置 Gateway request handler。
   *
   * @param handler 受控 request 分派函数。
   * @returns 无返回值。
   */
  setRequestHandler(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void {
    this.requestHandler = handler;
  }

  /**
   * 向 Gateway 发起已认证 control request。
   *
   * @param method 受控 request 方法。
   * @param params 结构化参数。
   * @param timeoutMs 等待时限。
   * @returns Gateway response。
   */
  request(method: string, params: Record<string, unknown>, timeoutMs = 10000): Promise<unknown> {
    return this.peer.request(method, params, timeoutMs);
  }

  /**
   * 向 Gateway 发送 worker 生命周期事件。
   *
   * @param name 事件名。
   * @param data 事件字段。
   * @returns 无返回值。
   */
  notify(name: string, data: Record<string, unknown> = {}): void {
    this.peer.send({ kind: "event", name, data });
  }

  /**
   * 关闭 client socket。
   *
   * @returns 无返回值。
   */
  close(): void {
    this.peer.close();
  }

  /**
   * 执行 Gateway request 并返回 typed result。
   *
   * @param requestId request ID。
   * @param method 方法名。
   * @param params 参数对象。
   * @returns 无返回值。
   */
  private async handleRequest(
    requestId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (!this.requestHandler) {
        throw new UiWorkerIpcError("worker_disconnected", "UI worker 尚未准备好处理 Gateway 请求。 ");
      }
      this.peer.respond(requestId, true, await this.requestHandler(method, params));
    } catch (error) {
      this.peer.respond(
        requestId,
        false,
        undefined,
        error instanceof Error ? error.message : "UI worker request 失败。",
      );
    }
  }
}

/**
 * 通过 newline-delimited JSON 管理一个 socket 的握手消息和控制请求。
 */
class JsonLinePeer extends EventEmitter {
  private input = "";
  private closed = false;
  private readonly queue: RawFrame[] = [];
  private readonly waiters: Array<{
    resolve: (frame: RawFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private readonly requests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private requestHandler?: (method: string, params: Record<string, unknown>) => Promise<unknown>;

  /**
   * 创建底层 JSONL socket peer。
   *
   * @param socket 已连接或正在连接的 socket。
   */
  constructor(private readonly socket: Socket) {
    super();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleData(chunk));
    socket.on("error", (error) => this.emit("transport_error", error));
    socket.on("close", () => this.handleClose());
  }

  /**
   * 配置对端发来的 request handler。
   *
   * @param handler request 分派函数。
   * @returns 无返回值。
   */
  setRequestHandler(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void {
    this.requestHandler = handler;
  }

  /**
   * 等待 socket 建立连接。
   *
   * @param timeoutMs 建连时限。
   * @returns socket connected event。
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
        rejectOpen(new UiWorkerIpcError("pipe_unavailable", "连接 UI worker pipe 失败。 "));
      };
      const timer = setTimeout(() => {
        cleanup();
        rejectOpen(new UiWorkerIpcError("pipe_unavailable", "连接 UI worker pipe 超时。 "));
      }, timeoutMs);
      timer.unref();
      this.socket.once("connect", onConnect);
      this.socket.once("error", onError);
    });
  }

  /**
   * 等待握手阶段下一条 frame。
   *
   * @param timeoutMs 等待时限。
   * @returns 下一条 JSON frame。
   */
  nextMessage(timeoutMs: number): Promise<RawFrame> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    if (this.closed) {
      return Promise.reject(new UiWorkerIpcError("worker_disconnected", "UI worker IPC socket 已关闭。 "));
    }
    return new Promise<RawFrame>((resolveFrame, rejectFrame) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolveFrame);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        rejectFrame(new UiWorkerIpcError("request_timeout", "UI worker IPC handshake 超时。 "));
      }, timeoutMs);
      timer.unref();
      this.waiters.push({ resolve: resolveFrame, reject: rejectFrame, timer });
    });
  }

  /**
   * 发送一个 JSON frame。
   *
   * @param frame frame 对象。
   * @returns 无返回值。
   */
  send(frame: Record<string, unknown>): void {
    if (this.closed || this.socket.destroyed) {
      throw new UiWorkerIpcError("worker_disconnected", "UI worker IPC socket 已关闭。 ");
    }
    const body = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(body, "utf8") > MAX_FRAME_BYTES) {
      throw new UiWorkerIpcError("invalid_frame", "UI worker IPC frame 超过大小限制。 ");
    }
    this.socket.write(body);
  }

  /**
   * 发起本机 request 并等待 response。
   *
   * @param method 方法名。
   * @param params 参数对象。
   * @param timeoutMs 等待时限。
   * @returns response data。
   */
  request(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        rejectRequest(new UiWorkerIpcError("request_timeout", `UI worker IPC ${method} 请求超时。`));
      }, timeoutMs);
      timer.unref();
      this.requests.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        this.send({ kind: "request", requestId, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.requests.delete(requestId);
        rejectRequest(error instanceof Error ? error : new Error("IPC 发送失败。"));
      }
    });
  }

  /**
   * 回复对端 request。
   *
   * @param requestId request ID。
   * @param success 是否成功。
   * @param data 成功结果。
   * @param error 失败说明。
   * @returns 无返回值。
   */
  respond(requestId: string, success: boolean, data?: unknown, error?: string): void {
    this.send({ kind: "response", requestId, success, ...(data === undefined ? {} : { data }), ...(error ? { error } : {}) });
  }

  /**
   * 主动关闭 socket。
   *
   * @returns 无返回值。
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.socket.destroy();
    this.handleClose();
  }

  /**
   * 解析 newline-delimited JSON frames。
   *
   * @param chunk socket 数据片段。
   * @returns 无返回值。
   */
  private handleData(chunk: string): void {
    this.input += chunk;
    if (Buffer.byteLength(this.input, "utf8") > MAX_FRAME_BYTES && !this.input.includes("\n")) {
      this.emit("transport_error", new UiWorkerIpcError("invalid_frame", "UI worker IPC 缓冲区超过限制。 "));
      this.close();
      return;
    }
    let newlineIndex = this.input.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.input.slice(0, newlineIndex).replace(/\r$/, "");
      this.input = this.input.slice(newlineIndex + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        this.emit("transport_error", new UiWorkerIpcError("invalid_frame", "UI worker IPC frame 超过限制。 "));
        this.close();
        return;
      }
      if (line.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          this.emit("transport_error", new UiWorkerIpcError("invalid_frame", "UI worker IPC JSON frame 无效。 "));
          this.close();
          return;
        }
        if (!isPlainRecord(parsed) || typeof parsed.kind !== "string") {
          this.emit("transport_error", new UiWorkerIpcError("invalid_frame", "UI worker IPC frame 根节点无效。 "));
          this.close();
          return;
        }
        this.dispatch(parsed as RawFrame);
      }
      newlineIndex = this.input.indexOf("\n");
    }
  }

  /**
   * 分派 request response、events 和握手消息。
   *
   * @param frame JSON frame。
   * @returns 无返回值。
   */
  private dispatch(frame: RawFrame): void {
    if (frame.kind === "response" && typeof frame.requestId === "string") {
      const pending = this.requests.get(frame.requestId);
      if (pending) {
        this.requests.delete(frame.requestId);
        clearTimeout(pending.timer);
        if (frame.success === true) {
          pending.resolve(frame.data);
        } else {
          pending.reject(new UiWorkerIpcError(
            "worker_disconnected",
            typeof frame.error === "string" ? frame.error : "UI worker IPC request 被拒绝。",
          ));
        }
      }
      return;
    }
    if (frame.kind === "request") {
      if (
        typeof frame.requestId !== "string" ||
        typeof frame.method !== "string" ||
        !isPlainRecord(frame.params)
      ) {
        this.emit("transport_error", new UiWorkerIpcError("invalid_frame", "UI worker IPC request 字段无效。 "));
        this.close();
        return;
      }
      if (this.requestHandler) {
        void this.handleRequest(frame.requestId, frame.method, frame.params);
      } else {
        this.emit("request", frame.requestId, frame.method, frame.params);
      }
      return;
    }
    if (frame.kind === "event" && typeof frame.name === "string" && isPlainRecord(frame.data)) {
      this.emit("event", frame.name, frame.data);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      this.queue.push(frame);
    }
  }

  /**
   * 调用已配置的 request handler 并响应对端。
   *
   * @param requestId 对端 request ID。
   * @param method 控制方法。
   * @param params request 参数。
   * @returns 无返回值。
   */
  private async handleRequest(
    requestId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      const result = await this.requestHandler?.(method, params);
      this.respond(requestId, true, result);
    } catch (error) {
      this.respond(
        requestId,
        false,
        undefined,
        error instanceof Error ? error.message : "UI worker IPC request 失败。",
      );
    }
  }

  /**
   * 清理等待操作并广播 socket 关闭。
   *
   * @returns 无返回值。
   */
  private handleClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new UiWorkerIpcError("worker_disconnected", "UI worker IPC connection 已断开。 ");
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.requests.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.length = 0;
    this.emit("close");
  }
}

interface RawFrame extends Record<string, unknown> {
  kind: string;
}

interface UiWorkerLaunchAuthContext {
  authHash: string;
  launchRecord?: UiWorkerLaunchRecord;
}

/**
 * 校验 iLink/Pi IPC 外部输入是否为普通 object。
 *
 * @param value 任意 JSON value。
 * @returns 非 null 非数组 object 时返回 true。
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从未经信任的 JSON frame 校验 UI worker registration。
 *
 * @param value frame registration。
 * @returns 字段经过限制的 registration。
 * @throws {UiWorkerIpcError} 字段无效时抛出。
 */
export function parseUiWorkerRegistration(value: unknown): UiWorkerRegistration {
  if (!isPlainRecord(value)) {
    throw new UiWorkerIpcError("handshake_rejected", "UI worker registration 必须是 object。 ");
  }
  const fields = value as Record<string, unknown>;
  const allowedFields = new Set([
    "launchId",
    "instanceId",
    "pid",
    "processBirthId",
    "sessionId",
    "sessionFile",
    "cwd",
    "projectAlias",
    "state",
    "name",
  ]);
  if (
    Object.keys(fields).some((key) => !allowedFields.has(key)) ||
    !isUuid(fields.launchId) ||
    !isUuid(fields.instanceId) ||
    typeof fields.pid !== "number" || !Number.isInteger(fields.pid) || fields.pid <= 0 ||
    typeof fields.processBirthId !== "string" || !fields.processBirthId.trim() || fields.processBirthId.length > 128 ||
    typeof fields.sessionId !== "string" || !fields.sessionId.trim() || fields.sessionId.length > 256 ||
    typeof fields.sessionFile !== "string" || !isAbsolute(fields.sessionFile) || fields.sessionFile.length > 32768 ||
    typeof fields.cwd !== "string" || !isAbsolute(fields.cwd) || fields.cwd.length > 32768 ||
    typeof fields.projectAlias !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(fields.projectAlias) ||
    (fields.state !== "starting" && fields.state !== "idle" && fields.state !== "running") ||
    (fields.name !== undefined && (typeof fields.name !== "string" || fields.name.length > 100))
  ) {
    throw new UiWorkerIpcError("handshake_rejected", "UI worker registration 字段无效。 ");
  }
  return {
    launchId: fields.launchId,
    instanceId: fields.instanceId,
    pid: fields.pid,
    processBirthId: fields.processBirthId,
    sessionId: fields.sessionId,
    sessionFile: fields.sessionFile,
    cwd: fields.cwd,
    projectAlias: fields.projectAlias,
    state: fields.state,
    ...(typeof fields.name === "string" ? { name: fields.name } : {}),
  };
}

function publicRegistration(registration: UiWorkerRegistration): UiWorkerRegistration {
  return {
    launchId: registration.launchId,
    instanceId: registration.instanceId,
    pid: registration.pid,
    processBirthId: registration.processBirthId,
    sessionId: registration.sessionId,
    sessionFile: registration.sessionFile,
    cwd: registration.cwd,
    projectAlias: registration.projectAlias,
    state: registration.state,
    ...(registration.name === undefined ? {} : { name: registration.name }),
  };
}

/**
 * 从私有 manager/launches 目录读取并校验一次性 UI worker 启动记录。
 *
 * @param managerDirectory manager 数据目录。
 * @param launchId UI worker launch UUID。
 * @returns 已校验的一次性启动记录。
 * @throws {UiWorkerIpcError} 文件缺失、越界或内容无效时抛出。
 */
export async function readUiWorkerLaunchRecord(
  managerDirectory: string,
  launchId: string,
): Promise<UiWorkerLaunchRecord> {
  if (!isUuid(launchId)) {
    throw new UiWorkerIpcError("launch_record_invalid", "UI worker launchId 格式无效。 ");
  }
  const canonicalManagerDirectory = await realpath(resolve(managerDirectory)).catch(() => {
    throw new UiWorkerIpcError("launch_record_invalid", "manager 数据目录无法解析。 ");
  });
  const launchDirectory = join(canonicalManagerDirectory, "launches");
  const filePath = join(launchDirectory, `${launchId}.json`);
  try {
    const [canonicalLaunchDirectory, fileStat] = await Promise.all([
      realpath(launchDirectory),
      lstat(filePath),
    ]);
    if (
      !samePath(dirname(canonicalLaunchDirectory), canonicalManagerDirectory) ||
      fileStat.isSymbolicLink() ||
      !fileStat.isFile() ||
      fileStat.size <= 0 ||
      fileStat.size > MAX_LAUNCH_RECORD_BYTES
    ) {
      throw new UiWorkerIpcError("launch_record_invalid", "launch record 路径或文件状态不安全。 ");
    }
    const noFollow = "O_NOFOLLOW" in constants ? Number(constants.O_NOFOLLOW) : 0;
    const handle = await open(filePath, constants.O_RDONLY | noFollow);
    let content: string;
    try {
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.dev !== fileStat.dev ||
        openedStat.ino !== fileStat.ino ||
        openedStat.size > MAX_LAUNCH_RECORD_BYTES
      ) {
        throw new UiWorkerIpcError("launch_record_invalid", "launch record 在读取期间发生变化。 ");
      }
      content = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const record = parseLaunchRecord(JSON.parse(content) as unknown, canonicalManagerDirectory);
    if (record.launchId !== launchId || Date.parse(record.expiresAt) <= Date.now()) {
      throw new UiWorkerIpcError("launch_record_invalid", "launch record 已过期或 ID 不匹配。 ");
    }
    return record;
  } catch (error) {
    if (error instanceof UiWorkerIpcError) {
      throw error;
    }
    throw new UiWorkerIpcError("launch_record_invalid", "无法安全读取 UI worker launch record。 ");
  }
}

/**
 * 将启动 ticket 用 SHA-256 摘要作为 HMAC key identifier。
 *
 * @param ticket 随机 launch secret。
 * @returns 十六进制摘要。
 */
export function hashUiWorkerTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

/**
 * 生成基于稳定字段序列的 UI worker HMAC proof。
 *
 * @param authHash ticket SHA-256。
 * @param nonce Gateway 随机挑战。
 * @param registration 当前 worker 注册字段。
 * @returns Base64URL proof。
 */
export function createUiWorkerProof(
  authHash: string,
  nonce: string,
  registration: UiWorkerRegistration,
): string {
  const canonical = canonicalJson(publicRegistration(registration));
  return createHmac("sha256", Buffer.from(authHash, "hex"))
    .update(nonce, "utf8")
    .update("\n", "utf8")
    .update(canonical, "utf8")
    .digest("base64url");
}

/**
 * 读取或 create-only 创建跨 Gateway 重启稳定的 UI attach 认证令牌。
 *
 * @param managerDirectory Hub 私有数据目录。
 * @returns 稳定的随机 IPC 令牌。
 * @throws {UiWorkerIpcError} key 文件权限路径、格式或写入无效时抛出。
 */
export async function readOrCreateUiWorkerAttachToken(managerDirectory: string): Promise<string> {
  const keyPath = join(managerDirectory, "ui-attachment.key");
  const newToken = randomBytes(32).toString("hex");
  let handle;
  try {
    handle = await open(keyPath, "wx", 0o600);
    await handle.writeFile(`${newToken}\n`, "utf8");
    await handle.sync();
    await handle.close();
    return newToken;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isNodeError(error) && error.code === "EEXIST") {
      const existingToken = await readUiWorkerAttachToken(managerDirectory);
      if (existingToken) {
        return existingToken;
      }
      throw new UiWorkerIpcError("handshake_rejected", "UI attach key 文件不可读取。 ");
    }
    if (handle) {
      await unlink(keyPath).catch(() => undefined);
    }
    throw new UiWorkerIpcError("handshake_rejected", "无法安全创建 UI attach key。 ");
  }
}

export async function readUiWorkerAttachToken(managerDirectory: string): Promise<string | undefined> {
  const keyPath = join(managerDirectory, "ui-attachment.key");
  let keyInfo;
  try {
    keyInfo = await lstat(keyPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw new UiWorkerIpcError("handshake_rejected", "UI attach key 文件不可读取。 ");
  }
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink()) {
    throw new UiWorkerIpcError("handshake_rejected", "UI attach key 文件类型不可信。 ");
  }
  const token = await readFile(keyPath, "utf8");
  if (!/^[a-f0-9]{64}\r?\n?$/i.test(token)) {
    throw new UiWorkerIpcError("handshake_rejected", "UI attach key 文件内容无效。 ");
  }
  return token.trim();
}

/**
 * 计算 stable named pipe 名, 不嵌入用户名或项目路径。
 *
 * @param managerDirectory manager 数据目录。
 * @returns 当前用户配置唯一的 named pipe endpoint。
 */
export function createStableNamedPipe(managerDirectory: string): string {
  const normalized = resolve(managerDirectory).toLowerCase();
  const scope = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `\\\\.\\pipe\\pi-wechat-session-hub-${scope}`;
}

/**
 * 解析 launch record 文件内容并检查字段边界。
 *
 * @param value JSON data。
 * @param managerDirectory 当前 manager 数据目录。
 * @returns 已校验 launch record。
 */
function parseLaunchRecord(value: unknown, managerDirectory: string): UiWorkerLaunchRecord {
  if (!isPlainRecord(value)) {
    throw new UiWorkerIpcError("launch_record_invalid", "UI worker launch record 根节点无效。 ");
  }
  const record = value as Record<string, unknown>;
  const allowedFields = new Set([
    "schemaVersion",
    "launchId",
    "instanceId",
    "ticket",
    "mode",
    "projectAlias",
    "projectPath",
    "sessionName",
    "sessionId",
    "sessionFile",
    "managerDirectory",
    "agentDirectory",
    "pipeEndpoint",
    "nodeExecutable",
    "piCliEntry",
    "extensionPath",
    "createdAt",
    "expiresAt",
  ]);
  if (
    Object.keys(record).some((key) => !allowedFields.has(key)) ||
    record.schemaVersion !== 1 ||
    !isUuid(record.launchId) ||
    !isUuid(record.instanceId) ||
    typeof record.ticket !== "string" || !/^[a-f0-9]{64}$/i.test(record.ticket) ||
    (record.mode !== "new" && record.mode !== "resume") ||
    typeof record.projectAlias !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(record.projectAlias) ||
    typeof record.projectPath !== "string" || !isAbsolute(record.projectPath) ||
    typeof record.managerDirectory !== "string" || !samePath(record.managerDirectory, managerDirectory) ||
    typeof record.agentDirectory !== "string" || !isAbsolute(record.agentDirectory) ||
    typeof record.pipeEndpoint !== "string" ||
    typeof record.nodeExecutable !== "string" || !isAbsolute(record.nodeExecutable) ||
    typeof record.piCliEntry !== "string" || !isAbsolute(record.piCliEntry) ||
    typeof record.extensionPath !== "string" || !isAbsolute(record.extensionPath) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    (record.sessionName !== undefined && (typeof record.sessionName !== "string" || record.sessionName.length > 100)) ||
    (record.mode === "resume" && (
      typeof record.sessionId !== "string" || !record.sessionId.trim() ||
      typeof record.sessionFile !== "string" || !isAbsolute(record.sessionFile)
    ))
  ) {
    throw new UiWorkerIpcError("launch_record_invalid", "UI worker launch record 字段无效。 ");
  }
  return record as unknown as UiWorkerLaunchRecord;
}

/**
 * 校验内部 launch record 并确保时间窗口有效。
 *
 * @param record launch record。
 * @param managerDirectory 当前 Gateway 数据目录。
 * @returns 无返回值。
 * @throws {UiWorkerIpcError} launch record 无效时抛出。
 */
function assertLaunchRecord(record: UiWorkerLaunchRecord, managerDirectory: string): void {
  parseLaunchRecord(record, resolve(managerDirectory));
  if (Date.parse(record.expiresAt) <= Date.now()) {
    throw new UiWorkerIpcError("launch_record_invalid", "UI worker launch record 已过期。 ");
  }
}

/**
 * 校验 UUID 字符串。
 *
 * @param value 候选字符串。
 * @returns UUID 格式有效时返回 true。
 */
function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

/**
 * 对 object key 排序后生成稳定 JSON 文本。
 *
 * @param value JSON-compatible value。
 * @returns 确定性序列化文本。
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 以常量时间比较两个 Base64URL 字符串。
 *
 * @param provided client proof。
 * @param expected server proof。
 * @returns 两者相同时返回 true。
 */
function safeEqualBase64(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, "base64url");
  const right = Buffer.from(expected, "base64url");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * 比较绝对路径, Windows 平台忽略大小写。
 *
 * @param left 路径一。
 * @param right 路径二。
 * @returns 规范化路径一致时返回 true。
 */
function samePath(left: string, right: string): boolean {
  const leftPath = normalizeComparablePath(left);
  const rightPath = normalizeComparablePath(right);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

/**
 * 将路径归一化为可比较形式, 尽量消解 Windows 8.3 短名与符号链接差异。
 *
 * GitHub Windows runner 的临时目录会是 `RUNNER~1`, 而 `realpath` 返回
 * `runneradmin`。两侧若一侧已规范化、另一侧未规范化, 纯字符串比较会
 * 误判为不同路径。这里尽力对两侧同时做 `realpathSync.native`; 任一侧
 * 无法解析(例如文件尚未创建)时回退到 `resolve` 结果。
 *
 * @param value 待归一化路径。
 * @returns 用于相等比较的路径字符串。
 */
function normalizeComparablePath(value: string): string {
  const resolved = resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
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
