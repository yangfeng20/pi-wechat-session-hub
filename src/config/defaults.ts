import type { ManagerConfiguration, NotificationConfiguration } from "./types.ts";
import { getCredentialFilePath } from "./paths.ts";

/**
 * 创建默认通知配置。
 *
 * @returns 默认使用积压补发策略的通知配置。
 */
export function createDefaultNotificationConfiguration(): NotificationConfiguration {
  return {
    overflowPolicy: "queue",
  };
}

/**
 * 创建默认运行时配置。
 *
 * @param credentialFile 凭证应单独保存的文件路径。
 * @returns 不会写入磁盘的默认配置对象。
 */
export function createDefaultConfiguration(
  credentialFile = getCredentialFilePath(),
): ManagerConfiguration {
  return {
    schemaVersion: 1,
    autoStartOnWindowsLogon: false,
    defaultMode: "background",
    allowedProjectRoots: [],
    projects: {},
    wechat: {
      authorizedUserId: "",
      credentialFile,
    },
    runtime: {
      heartbeatIntervalMs: 5000,
      staleAfterMs: 20000,
      maxBackgroundWorkers: 4,
      maxQueuePerSession: 20,
    },
    notification: createDefaultNotificationConfiguration(),
  };
}
