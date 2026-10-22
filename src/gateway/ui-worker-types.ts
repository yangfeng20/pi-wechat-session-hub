import type { WorkerState } from "../registry/types.ts";

/**
 * 一次性 UI worker 启动记录, 内容存于受 ACL 保护的 manager/launches 目录。
 */
export interface UiWorkerLaunchRecord {
  schemaVersion: 1;
  launchId: string;
  instanceId: string;
  ticket: string;
  mode: "new" | "resume";
  projectAlias: string;
  projectPath: string;
  sessionName?: string;
  sessionId?: string;
  sessionFile?: string;
  managerDirectory: string;
  agentDirectory: string;
  pipeEndpoint: string;
  nodeExecutable: string;
  piCliEntry: string;
  extensionPath: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * UI Pi extension 经 named pipe 提交的 session/进程注册信息。
 */
export interface UiWorkerRegistration {
  launchId: string;
  instanceId: string;
  pid: number;
  processBirthId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  projectAlias: string;
  state: WorkerState;
  name?: string;
}

/**
 * Gateway 与可见 Pi TUI worker 之间的 request/response 信封。
 */
export interface UiWorkerIpcEnvelope {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}
