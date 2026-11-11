/**
 * Gateway daemon 的启动垫片。
 *
 * 此前 daemon 是直接用
 *   node --experimental-transform-types src/runtime/gateway-daemon.ts
 * 启动的，这在两类环境下必然失败：
 *
 *   1. Node >= 26 已移除 --experimental-transform-types，Node 直接以
 *      "bad option" + exit code 9 退出（上游把它归类成"daemon 在 ready 前退出"）。
 *   2. npm 安装后入口位于 node_modules 内，而 Node 原生 TypeScript 支持
 *      明确拒绝 node_modules 下的 .ts：
 *      ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING。
 *      即使换回仍带该 flag 的 Node 22/24 也绕不过这一条。
 *
 * 本垫片改用 jiti 加载同一份 .ts 源码 —— pi 进程内的扩展本来就是这样加载的，
 * 这里只是让独立的 daemon 子进程复用同一机制。好处：
 *
 *   - 不再依赖任何 Node TypeScript flag，Node 22 / 24 / 26 一致可用
 *   - 不受 node_modules 的 TS 排除限制
 *   - daemon 与扩展加载的是同一份源码，无需维护编译产物、也不会出现两份逻辑漂移
 *
 * 注意：本文件是 .mjs（不是 .ts），因此不会被 `pi.extensions` 的 `./extensions/*.ts`
 * glob 当成扩展入口加载；它只作为 daemon 的子进程入口被 spawn。
 */
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const entry = fileURLToPath(new URL("../src/runtime/gateway-daemon.ts", import.meta.url));
const jiti = createJiti(import.meta.url);

await jiti.import(entry);
