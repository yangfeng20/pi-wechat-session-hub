import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { PiCliInvocation } from "./pi-cli.ts";
import { PiRpcClient, PiRpcError } from "./pi-rpc-client.ts";
import type { WorkerState } from "../registry/types.ts";

export interface BackgroundPiWorkerOptions {
  invocation: PiCliInvocation;
  cwd: string;
  name?: string;
  sessionFile?: string;
  sessionDirectory?: string;
  env?: NodeJS.ProcessEnv;
  disableDiscoveredResources?: boolean;
  startupTimeoutMs?: number;
  turnTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export interface BackgroundPiSessionInfo {
  instanceId: string;
  pid: number;
  processBirthId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  name?: string;
}

/**
 * 表示后台 Pi worker 当前不可接受消息。
 */
export class BackgroundWorkerBusyError extends Error {
  /**
   * 创建 worker busy 错误。
   *
   * @param message 面向用户的中文错误信息。
   */
  constructor(message: string) {
    super(message);
    this.name = "BackgroundWorkerBusyError";
  }
}

/**
 * 通过 Pi RPC 管理一个原生持久化 session 的后台 runtime。
 */
export class BackgroundPiWorker extends EventEmitter {
  readonly info: BackgroundPiSessionInfo;
  readonly client: PiRpcClient;
  private currentState: WorkerState = "idle";
  private readonly turnTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;

  /**
   * 创建已完成 Pi RPC 握手的后台 worker。
   *
   * @param client Pi RPC 客户端。
   * @param info Pi 返回的 session 和进程信息。
   * @param turnTimeoutMs 单轮模型执行超时。
   * @param shutdownTimeoutMs 优雅退出等待时长。
   */
  private constructor(
    client: PiRpcClient,
    info: BackgroundPiSessionInfo,
    turnTimeoutMs: number,
    shutdownTimeoutMs: number,
  ) {
    super();
    this.client = client;
    this.info = info;
    this.turnTimeoutMs = turnTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.currentState = client.isClosed ? "stale" : "idle";
    client.on("process_exit", () => this.setState("stale"));
  }

  /**
   * 创建或恢复 Pi session, 并等待 Pi 报告 sessionId/sessionFile。
   *
   * @param options worker 启动参数。
   * @returns 已注册 session 信息的后台 worker。
   * @throws {PiRpcError} Pi 启动失败或未返回 session 元数据时抛出。
   */
  static async start(options: BackgroundPiWorkerOptions): Promise<BackgroundPiWorker> {
    const args: string[] = [];
    if (options.sessionDirectory) {
      args.push("--session-dir", options.sessionDirectory);
    }
    if (options.sessionFile) {
      args.push("--session", options.sessionFile);
    }
    if (options.name) {
      args.push("--name", options.name);
    }
    if (options.disableDiscoveredResources) {
      args.push(
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
      );
    }

    const client = await PiRpcClient.start({
      invocation: options.invocation,
      args,
      cwd: options.cwd,
      env: options.env,
      requestTimeoutMs: options.startupTimeoutMs ?? 15000,
    });

    try {
      const stateResponse = await client.request(
        { type: "get_state" },
        options.startupTimeoutMs ?? 15000,
      );
      if (options.name) {
        await client.request(
          { type: "set_session_name", name: options.name },
          options.startupTimeoutMs ?? 15000,
        );
      }
      const state = asRecord(stateResponse.data);
      const sessionId = state?.sessionId;
      const sessionFile = state?.sessionFile;
      if (typeof sessionId !== "string" || !sessionId || typeof sessionFile !== "string" || !sessionFile) {
        throw new PiRpcError("Pi RPC 未返回持久化 sessionId/sessionFile。");
      }
      const pid = client.pid;
      if (typeof pid !== "number") {
        throw new PiRpcError("Pi RPC 子进程缺少 PID。");
      }
      if (client.isClosed) {
        throw new PiRpcError("Pi RPC 在完成启动握手后立即退出。");
      }
      const info: BackgroundPiSessionInfo = {
        instanceId: randomUUID(),
        pid,
        processBirthId: `${pid}:${Date.now()}`,
        sessionId,
        sessionFile,
        cwd: options.cwd,
        ...(options.name
          ? { name: options.name }
          : typeof state.sessionName === "string"
            ? { name: state.sessionName }
            : {}),
      };
      return new BackgroundPiWorker(
        client,
        info,
        options.turnTimeoutMs ?? 15 * 60 * 1000,
        options.shutdownTimeoutMs ?? 5000,
      );
    } catch (error) {
      await client.shutdown(2000).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 获取 worker 当前运行状态。
   *
   * @returns worker 状态。
   */
  get state(): WorkerState {
    return this.currentState;
  }

  /**
   * 向后台 Pi session 发送一条用户消息并等待本轮最终文本。
   *
   * @param message 用户消息正文。
   * @returns Pi 最终 assistant 文本。
   * @throws {BackgroundWorkerBusyError} worker 正在执行其他 turn 时抛出。
   * @throws {PiRpcError} prompt 被拒绝、超时或没有最终文本时抛出。
   */
  async prompt(message: string): Promise<string> {
    if (this.currentState !== "idle") {
      throw new BackgroundWorkerBusyError("后台 Pi session 当前不可接受新消息。");
    }
    if (!message.trim()) {
      throw new PiRpcError("不能发送空消息。");
    }

    this.setState("running");
    let accepted = false;
    let settled = false;
    const abortController = new AbortController();
    const assistantMessages: string[] = [];
    const onMessageEnd = (event: Record<string, unknown>): void => {
      const agentMessage = asRecord(event.message);
      if (agentMessage?.role !== "assistant") {
        return;
      }
      const text = extractAssistantText(agentMessage.content);
      if (text) {
        assistantMessages.push(text);
      }
    };
    this.client.on("message_end", onMessageEnd);
    const settledPromise = this.client.waitForEvent(
      "agent_settled",
      this.turnTimeoutMs,
      abortController.signal,
    );

    try {
      const response = await this.client.request({
        type: "prompt",
        message,
      });
      const responseData = asRecord(response.data);
      if (responseData?.disposition === "handled") {
        throw new PiRpcError("Pi extension 已处理该消息, 没有启动模型 turn。", "prompt");
      }
      accepted = true;
      await settledPromise;
      settled = true;
      const finalText = assistantMessages.at(-1);
      if (!finalText) {
        throw new PiRpcError("Pi session 已结束本轮, 但没有可返回的 assistant 文本。");
      }
      return finalText;
    } catch (error) {
      abortController.abort();
      await settledPromise.catch(() => undefined);
      throw error;
    } finally {
      this.client.off("message_end", onMessageEnd);
      if ((settled || !accepted) && this.state !== "stale") {
        this.setState("idle");
      }
    }
  }

  /**
   * 优雅关闭 worker; 正在运行时需显式指定允许 abort。
   *
   * @param options 关闭策略。
   * @returns 无返回值。
   * @throws {BackgroundWorkerBusyError} 正在运行且未授权 abort 时抛出。
   * @throws {PiRpcError} Pi 未能在超时内退出时抛出, 不会自动强杀。
   */
  async shutdown(options: { abortRunning?: boolean } = {}): Promise<void> {
    if (this.currentState === "stale") {
      return;
    }
    if (this.currentState === "running") {
      if (!options.abortRunning) {
        throw new BackgroundWorkerBusyError(
          "后台 Pi session 正在执行; 请等待结束或显式确认 abort 后再关闭。",
        );
      }
      await this.client.request({ type: "abort" }, this.turnTimeoutMs);
    }
    this.setState("stopping");
    await this.client.shutdown(this.shutdownTimeoutMs);
    this.setState("stale");
  }

  /**
   * 更新 worker 状态并通知监听者。
   *
   * @param state 新状态。
   * @returns 无返回值。
   */
  private setState(state: WorkerState): void {
    if (this.currentState === state) {
      return;
    }
    this.currentState = state;
    this.emit("state_change", state);
  }
}

/**
 * 将未知 RPC payload 转换为对象。
 *
 * @param value 待检查值。
 * @returns 普通对象或 undefined。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * 提取 assistant 消息中的普通文本, 不暴露 thinking 或工具参数。
 *
 * @param content Pi message content。
 * @returns 拼接后的普通文本。
 */
function extractAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => asRecord(block))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block?.text as string)
    .join("");
}
