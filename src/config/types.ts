export type RuntimeMode = "background" | "ui";

export interface ProjectDefinition {
  displayName: string;
  path: string;
  [key: string]: unknown;
}

export interface WechatConfiguration {
  authorizedUserId: string;
  credentialFile: string;
  [key: string]: unknown;
}

export interface RuntimeConfiguration {
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  maxBackgroundWorkers: number;
  maxQueuePerSession: number;
  [key: string]: unknown;
}

export interface ManagerConfiguration {
  schemaVersion: 1;
  defaultMode: RuntimeMode;
  defaultProject?: string;
  allowedProjectRoots: string[];
  projects: Record<string, ProjectDefinition>;
  wechat: WechatConfiguration;
  runtime: RuntimeConfiguration;
  [key: string]: unknown;
}
