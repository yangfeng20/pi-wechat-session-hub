export type WorkerMode = "ui" | "background";
export type WorkerState = "starting" | "idle" | "running" | "stopping" | "stale";
export type SessionState = "active" | "saved" | "pending";

export interface GatewayStatusRecord {
  ownerId: string;
  pid: number;
  processBirthId: string;
  startedAt: string;
  heartbeatAt: string;
  state: "starting" | "online" | "auth_required" | "stopping";
}

export interface WorkerInstanceRecord {
  instanceId: string;
  pid: number;
  processBirthId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  projectAlias: string;
  mode: WorkerMode;
  state: WorkerState;
  heartbeatAt: string;
  launchId?: string;
  ipcAuthHash?: string;
}

export interface SessionIndexRecord {
  sessionId: string;
  publicIndex?: number;
  sessionFile: string;
  cwd: string;
  projectAlias: string;
  name?: string;
  mode: WorkerMode;
  state: SessionState;
  lastActivityAt: string;
  lastEntryId?: string;
}

export interface RouteRecord {
  sessionId: string;
  workerInstanceId: string;
  generation: number;
  updatedAt: string;
}

export interface RegistrySnapshot {
  gateway: GatewayStatusRecord | null;
  instances: Record<string, WorkerInstanceRecord>;
  routes: Record<string, RouteRecord>;
  sessions: Record<string, SessionIndexRecord>;
}

export interface ManagerEventRecord {
  id: string;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}
