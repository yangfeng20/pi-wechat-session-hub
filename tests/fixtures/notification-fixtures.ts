import type { ManagerConfiguration } from "../../src/config/types.ts";

/**
 * 创建带默认通知配置的配置 store 假实现, 供多个通知测试复用。
 *
 * @param overflowPolicy 过期策略。
 * @returns 配置 store。
 */
export function createFakeConfigStore(overflowPolicy: "queue" | "drop" = "queue") {
  const config = {
    notification: { overflowPolicy },
  } as unknown as ManagerConfiguration;
  return { load: async () => ({ config }) };
}
