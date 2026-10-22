# Pi 微信会话枢纽

项目英文名: Pi WeChat Session Hub
项目目录: `pi-wechat-session-hub`

## 当前实现范围

已完成以下基础模块:

- 配置 schema 校验、默认值合并、未知字段保留、原子写入及 fail-closed 文件锁。
- 项目 alias 增删、默认项目设置、真实路径解析和 `allowedProjectRoots` 越界拒绝。
- `/projects`、`/status`、`/help` 和 `/wechat-manager` Pi 扩展命令。
- Gateway 单实例 `manager.lock`, 包含 PID/进程启动标识检查与心跳更新。
- JSON registry 快照: `gateway.json`、`instances.json`、`routes.json`、`session-index.json`; 审计事件追加到 `events.jsonl` 并拒绝消息正文、凭证、命令和输出字段。
- Pi RPC JSONL 客户端与后台 worker manager, 支持 Pi 原生 session 新建、保存后的恢复、prompt、优雅停止和单 owner 拒绝双开。
- `GatewayCommandRouter` 支持 `/new`、`/projects`、`/sessions`、`/resume`、`/stop`、`/retry ... --confirm`、`/status`、`/help`; sender allowlist 在入队前检查。
- route 分片 durable FIFO queue, 支持 `messageId` 去重、队列上限、processing 中断阻塞、显式重试和完成后正文压缩。
- iLink `getupdates` / `sendmessage` API client、同步游标存储和长轮询 adapter 已实现; `getconfig` / `sendtyping` 用于原生处理中提示, 不阻塞最终回复。adapter 使用注入的独立 token, 可以将 `context_token` 随 pending queue 消息持久化, 完成后删除。

Gateway runtime 已通过 `/wechat-manager start|stop|status` 显式启停, 并连接 router、durable queue、background Pi RPC worker 与 iLink poller。`/wechat-manager login` 提供独立的微信 QR 授权流程: 只提交空的 `local_token_list`, 不导入其他应用的凭证; 扫码确认后, 以 create-only 方式把授权凭证写入 Hub 自有的 `credentials.json` 并设置授权 userId。Windows UI worker 也已接入: `/new --mode ui` 使用受控 PowerShell launcher 启动 Windows Terminal 新 tab, 通过一次性 launch ticket 和 named pipe 注册 Pi 原生 session。Pi 扩展加载时不会自动联网; Gateway 仍须显式启动。独立 24/7 Windows service 属于可选后续阶段。完整设计基线见 [`docs/implementation-spec.md`](docs/implementation-spec.md)。回复上下文持久化决策见 [`docs/decisions/0001-ilink-context-token-queue.md`](docs/decisions/0001-ilink-context-token-queue.md)。

**空 session 语义:** Pi 刚启动时会返回 sessionId 和预期 sessionFile, 但 transcript 首次写入前 JSONL 文件可能不存在。registry 将其标为 `pending`; 没有文件的 session 不会被伪装成可恢复历史。收到实际用户消息并由 Pi 写入 transcript 后, 才能作为保存会话恢复。

## Pi 版本兼容

兼容策略使用 Pi 0.85.1 到 Pi 1.x 的公共扩展 API 与 CLI/RPC JSONL 协议, 不依赖 Pi 内部模块。本轮兼容矩阵已在 `0.85.1`、`1.0.0`、`1.3.0` 全部通过类型检查、66 项单测(65 pass, 1 项 ACL 条件测试跳过)和 Pi RPC 启动/停止 smoke。Windows ACL 条件测试已单独启用并通过。Pi package 的 `peerDependencies` 按官方约定使用 `*`; 支持范围和验证版本另记在 `package.json` 的 `piCompatibility` 字段中。

Pi 1.3.0 要求 Node.js `>=22.19.0`; 本机 Node.js `v22.22.3` 满足要求。

## 微信回复与命令行为

- Gateway 开始处理一条已授权消息时, 通过 iLink `getconfig` 获取 `typing_ticket`, 再用 `sendtyping` 显示微信原生“正在输入”; 处理结束后发送取消状态. 该提示 best-effort, API 失败不会阻断 Pi 回复.
- Pi Hub 当前仍在 `agent_settled` 后发送一条完整最终文本, 不做 token 级实时流式回传. iLink `sendmessage` 是离散消息接口; 分块输出属于客户端应用层行为, 不能视为已验证的 iLink 原生流式或单条消息原位更新.
- 微信端只接受 Hub 显式定义的管理命令; 未知 slash command fail-closed, 不透传任意 Pi 内置命令. `/name` 目前尚未映射, 会返回未知命令.

## 运行要求

- Pi CLI 支持范围见上方兼容说明; Node.js 需满足 `package.json` 中的最低版本。
- UI 模式需要 Windows 和 Windows Terminal; background 模式由 Pi RPC worker 运行。
- iLink 授权在本机完成; 仓库不包含任何账号凭证或用户授权 ID。

## 本地开发与验证

```bash
npm install
npm run typecheck
npm test
npm run test:pi-runtime
```

`npm test` 覆盖配置、凭证隔离/ACL 策略、registry/queue、background 和 UI worker 生命周期、session switch 单 writer guard、Windows Terminal argv 构造、fake iLink QR 授权、typing indicator、create-only 凭证写入、session 恢复及 Gateway → Pi worker 全链路。UI 和 QR 测试使用 fake bridge/transport, 不启动真实 Windows Terminal、微信网络或模型.

`npm run test:pi-runtime` 使用隔离配置启动 Pi RPC, 发送 `/status` 和 `/wechat-manager status` 验证扩展加载; 不调用模型、不读写真实 Pi 配置或凭证。上面的三个 Pi 版本均已单独运行该 smoke test。

安全审计: `npm audit --omit=dev` 为 0 vulnerabilities。全量审计的告警来自 Pi CLI 的开发依赖树: Pi `0.85.1` 报 3 项, `1.0.0` 安装审计报 1 项, `1.3.0` 为 0; 本扩展不把 Pi CLI 打包为生产依赖。

可选的 Windows ACL 实测只使用 fake token, 在 `%USERPROFILE%\.pi\agent` 下创建并清理唯一临时目录, 不访问网络:

```bash
PI_WECHAT_VERIFY_WINDOWS_ACL=1 node --experimental-transform-types --test --test-name-pattern="Windows manager ACL integration" tests/credential-store.test.ts
```

验证不同 Pi 版本时, 覆盖安装只变更 `node_modules`, 不改 `package.json` 和 lockfile:

```bash
npm install --no-save --ignore-scripts --package-lock=false @earendil-works/pi-coding-agent@1.3.0
npm run typecheck
npm test
npm run test:pi-runtime
```

恢复本机版本的开发依赖:

```bash
npm install --no-save --ignore-scripts --package-lock=false @earendil-works/pi-coding-agent@0.85.1
```

`.github/workflows/pi-compat.yml` 会对 `0.85.1`、`1.0.0`、`1.3.0` 运行类型检查、单元测试和 RPC 冒烟测试。

## 安装到 Pi 中试用

在项目根目录执行:

```bash
pi --extension ./extensions/wechat-session-hub.ts
```

可运行:

- `/help` 查看 Pi 扩展命令。
- `/projects` 查看和管理项目 alias。
- `/status` 查看扩展状态。
- `/wechat-manager` 查看 Gateway 控制帮助。
- `/wechat-manager login` 在本地 TUI 展示二维码; 扫码确认后只创建 Hub 专属凭证, 不导入其他客户端凭证。
- `/wechat-manager start` 显式启动 Gateway 并开始 iLink 轮询; 若账号正在被其他客户端轮询, 先停止冲突轮询器。
- `/wechat-manager status` 查看当前 Pi 扩展实例的 Gateway 状态。
- `/wechat-manager stop` 停止轮询, 等待 route queue drain 和后台 turn 完成后关闭 background worker; 不会隐式 abort 模型 turn, UI worker tab 保持打开并可在下次 Gateway 启动时重连。

Gateway 默认不会启动。启动后, 微信端可运行 `/new --mode background|ui`, `/resume <session-id> [--mode background|ui]`, `/sessions` 和 `/stop`; Pi session shutdown 时扩展会尝试优雅停止本实例 Gateway。

## 配置

默认配置位置:

```text
%USERPROFILE%\.pi\agent\wechat-session-manager.json
```

若设置了 `PI_CODING_AGENT_DIR`, 则配置保存在该目录下。首次启动不会自动创建全局配置。可先手动创建如下配置, 再使用 `/projects add`:

```json
{
  "schemaVersion": 1,
  "defaultMode": "background",
  "allowedProjectRoots": [
    "D:\\Projects"
  ],
  "projects": {},
  "wechat": {
    "authorizedUserId": ""
  }
}
```

未提供的 `runtime` 字段会补入默认值。`wechat.credentialFile` 必须指向 manager 数据目录中的固定 `credentials.json`; reader 会拒绝目录外路径、符号链接、未知 schema 和授权 userId 不匹配。首次使用先登记 `allowedProjectRoots` 和项目 alias, 然后在本地 Pi TUI 执行 `/wechat-manager login`. 扫码确认后, Hub 会从 iLink 响应取得授权 userId, 仅在 `credentials.json` 不存在时创建凭证, 再填入 `wechat.authorizedUserId`.

Windows 首次创建空 manager 目录时会关闭继承 ACL, 仅授权当前用户、SYSTEM 和 Administrators; 已有非空目录不会自动改权限, 登录和启动时都会检查整个目录树。agent 父目录允许其他主体只读, 但不允许其写入; manager 目录及其文件仅接受上述三个主体。POSIX 要求 manager 目录与文件无 group/other 权限, 且父目录不能被 group/other 写入。权限无法验证时 fail-closed。

## 安全约束与后续阶段

- Pi session JSONL 是对话历史事实源; Gateway 不直接编辑 session 文件。
- 项目路径启动前重新解析真实路径, 并检查仍位于授权根目录内。
- 每个 session 同时只允许一个 registry owner; 状态不明确时 fail-closed。
- `events.jsonl` 不记录消息正文、模型输出或凭证。queue 只在未完成期间保存原消息正文和 `replyContext`; 完成后会压缩移除 payload, 并仅保留最近 1000 个 messageId 的 SHA-256 摘要用于去重。
- UI `session_start` 以一次性票据向本机 named pipe 注册, 单 session 单 owner; route 到 UI worker 时通过 Pi `sendUserMessage()` 把微信消息写入该 TUI 原生 transcript。
- UI `session_before_switch` 会通过 Gateway IPC 检查目标 session owner; 未登记、路径未授权或仍由其他 Pi runtime 持有时拒绝切换。
- Gateway shutdown 会断开 UI pipe 但保留仍运行的 TUI owner; 下次启动等待其重新认证, 失败时 fail-closed, 不会自动双开。
- `/wechat-manager login` 在用户确认后通过空 `local_token_list` 申请 Pi Hub 独立 iLink 授权; `credentials.json` 采用 create-only, 已存在时不覆盖, 且不从其他应用导入凭证。
- Windows ACL 实现依赖 PowerShell 7/.NET 和系统 `icacls.exe`; 使用 fake token 的专属目录 ACL 集成测试已通过。真实账号授权和设备验收需在使用者自己的环境中完成。
- 自动化验证已覆盖 Pi 版本矩阵、Gateway 与 worker 生命周期、iLink fake transport 和 typing indicator; 具体验证命令见上方。24/7 Windows service/计划任务仍是可选后续阶段。
