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

/**
 * 通知入口的过期处理策略。
 */
export type NotificationOverflowPolicy = "queue" | "drop";

/**
 * 通知入口配置。
 */
export interface NotificationConfiguration {
  /**
   * 过期通知的处理策略: queue 为积压补发, drop 为直接拒绝。
   */
  overflowPolicy: NotificationOverflowPolicy;
  [key: string]: unknown;
}

export interface ManagerConfiguration {
  schemaVersion: 1;
  autoStartOnWindowsLogon: boolean;
  defaultMode: RuntimeMode;
  defaultProject?: string;
  allowedProjectRoots: string[];
  projects: Record<string, ProjectDefinition>;
  wechat: WechatConfiguration;
  runtime: RuntimeConfiguration;
  notification: NotificationConfiguration;
  [key: string]: unknown;
}
