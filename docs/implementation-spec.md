# Pi 微信会话枢纽实现方案

- 状态: 后台 daemon、会话 owner 切换、稳定会话索引和可选 Windows 登录自动启动已实现并通过本轮自动化验证.
- 目标: 用户通过微信管理 Hub 注册的 Pi sessions; 本机 Pi TUI 可随时接管/释放同一 session.
- 持久事实源: Pi session JSONL. Hub registry 只保存 session 索引元数据、唯一 owner、route 和运行状态.

## 1. 目标行为

1. 插件安装后, 用户在任意 Pi TUI 执行 `/wx start`; 授权根为空时, Hub 使用当前 session cwd 初始化授权根并建立默认项目. Gateway 随后由独立 daemon 持有, 不绑定当前 Pi 进程或 session.
2. 所有 Pi TUI 退出后, Hub daemon 和后台 RPC workers 继续提供微信收发.
3. 任意 Pi TUI 中 `/wx status|stop|restart` 控制同一后台服务. `/wx stop` 必须由可见 UI 二次确认.
4. Windows 用户登录自动启动是可选项, 配置默认关闭. 开启后使用之前的 Hub 微信授权, 不在登录任务中打开 QR UI.
5. session 的前台/后台模式表示当前 owner, 不是固定 session 属性:
   - 有可见 Pi TUI owner 时, 微信消息进入该 TUI transcript, assistant 最终回复同时回到微信.
   - TUI 关闭后, 已路由 session 安全交给后台 Pi RPC worker.
   - 本机 Pi `/resume` 已由后台处理的 Hub session 时, background writer 先退出, 再由 TUI 接管同一 session.
   - 未登记 session 可由 Pi 原生 `/resume` 恢复; 仅当 cwd 位于授权根内时才自动接入 Hub.
6. `allowedProjectRoots` 是授权边界, 根内 TUI session 自动登记, 项目展示名使用当前 cwd 文件夹名称. 微信端 `/sessions` 列出 Hub 管理的活跃 sessions.

## 2. 总体架构

```text
任意 Pi TUI
  /wx start|status|stop|restart|autostart
          │ 本机 Gateway control IPC
          ▼
┌────────────────────────────────────────────────────────┐
│ 独立 Hub daemon (detached Node process)                 │
│                                                        │
│ Gateway lease / control server / iLink poller / router │
│ durable queue / route registry / stable session index  │
│                                                        │
│ 每个 session 同时只有一个 Pi writer                    │
│   ├─ 有活跃 TUI: UI owner + sendUserMessage()           │
│   └─ 无活跃 TUI: headless Pi RPC worker                │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
               Pi 原生 session JSONL
```

Hub daemon 本身是独立后台 Node 进程, 负责 Gateway、poller 和 session owner 调度. 处理每个对话的后台会话由 Pi `--mode rpc` worker 执行. daemon 和 worker 都不需要 TUI 窗口.

## 3. 后台 daemon 生命周期

### 3.1 启动

`GatewayServiceController.start()` 先尝试通过 manager 目录对应的本机控制 endpoint 读取状态. 服务离线时, 使用不经 shell 的 `spawn()` 启动 detached daemon, 隐藏窗口、忽略标准输入输出, 并通过一次性 Node IPC 启动握手等待控制 endpoint ready.

Daemon 在 Gateway runtime 初始化时取得 `GatewayLease`, 启动 UI owner IPC server 后开放 control IPC, 然后恢复 route 和启动 iLink poller. `/wx start` 不等待所有模型 turn; daemon ready 后返回启动状态. 重复 `start` 幂等, 不会建立第二个 poller.

首次在 Pi TUI 执行 `/wx start` 时, 若 `allowedProjectRoots` 为空, Hub 将当前 session cwd 设为初始授权根并按文件夹名称建立默认项目. 若路径为磁盘根或用户主目录等过宽范围, 会在本机要求确认. 后续可通过 `/wx roots add-current` 或 `/wx roots add <绝对路径>` 增加授权根; 微信端不开放这些配置操作.

### 3.2 状态与控制

control endpoint 为 Windows named pipe 或 POSIX Unix socket. 客户端使用 `manager.lock` 中的 lease token 完成 HMAC challenge-response. 只接受 `status`、`stop`、`restart` 固定动作, 不接受路径、命令或任意数据.

`status` 通过活跃 IPC 和 Gateway runtime 快照读取在线状态、PID、前台/后台 owner 数和 route 数. 仅有 `gateway.json` 的旧状态不视为在线.

`stop` 收到确认后立即返回 `stopping` 状态, daemon 停止新 poll, 收尾当前已入队工作, 关闭 background workers, 断开 UI IPC 并释放 lease. 队列仍是 durable; Gateway 停止期间不会接收新消息. 若 worker 无法安全停止, lease 保留, 状态保持可诊断, 避免启动第二个 owner.

`restart` 由 daemon 完成停止、释放 lease、关闭旧 control endpoint 后再 detached 启动新 daemon. 先释放 lease, 再启动新进程, 避免新旧 poller 重叠. 服务已经离线时, `restart` 等同于 `start`.

## 4. 前台/后台 owner 交接

每个可见 Pi TUI 在 `session_start` 后尝试连接 Gateway UI IPC. `allowedProjectRoots` 负责安全授权; cwd 位于授权根时, extension 按 cwd 文件夹名自动建立或复用项目记录, 不要求预先逐个添加 alias. cwd 超出授权范围时, session 仍可本机使用, TUI 会提示 `/wx roots add-current` 等本机授权入口.

```text
后台 RPC owner -- Pi /resume / UI attach --> 前台 TUI owner
前台 TUI owner -- session shutdown -------> 后台 RPC owner
```

- UI 接管时, IPC server 验证 Pi session file、授权根范围和 lease; 项目记录按 cwd 文件夹名自动创建或复用. 如果现有 owner 是 Hub 的 background worker, 先优雅停止该 worker, 再注册 UI owner, 并更新 route generation.
- UI owner 收到微信消息时, extension 用 Pi 原生 `sendUserMessage()` 注入消息. `agent_settled` 后将完整最终 assistant 文本交给 Gateway, 再由 iLink 发回微信.
- UI TUI 正常关闭时, 移除前台 owner; 有 route 的 session 交给后台 RPC worker, route 和 session ID 不变.
- `/wx stop` 会断开 Gateway IPC, 但仍运行的 TUI 保持本地会话. 下次 `start` 时, UI extension 会重连并恢复 owner.
- Hub 启动时, 曾标记为 UI 但已没有活跃 UI owner 的 saved route 改由后台 RPC 恢复, 不自动打开 Windows Terminal tab.
- 未登记目标的 Pi 原生 `/resume` 不因缺少 Hub registry 记录而被取消. 如果目标 transcript 没有活跃或状态不明的 Hub owner, 允许 Pi 恢复; 恢复后 cwd 在授权根内则自动登记并接入, 否则只保留本机使用.
- 已登记 session 若由其他活跃 UI owner 持有, 或旧 owner 状态不明且进程仍存活, 拒绝第二 writer. 后台 owner 则尝试安全停止并交接; 停止或交接失败时拒绝恢复.
- 未登记 transcript 不会触发本机 session 文件扫描; 仅通过用户当前 Pi 的 `/resume` 选择单个目标.

## 5. 微信端会话和索引

```text
/new [--mode background|ui] [--project <alias>] [--name <名称>]
/sessions [--project <alias>] [--state active|saved|pending|all] [--page <n>]
/resume <会话索引|名称>
/stop [会话索引|名称]
/retry <message-id> --confirm
```

`/new` 默认在后台创建 session, 不接受任意工作目录或 shell 参数; 用户可显式指定 `--mode ui` 请求在新 Windows Terminal tab 中打开可见 session. 若 route 后续通过本机 Pi TUI `/resume` 打开该 session, owner 会自动切换为 UI.

`/sessions` 默认状态为 `active`, active 集合由当前 UI 和 background owner 共同构成. 需要查看已保存/待启动 session 时可使用 `--state all` 或相应过滤项. 表头标注索引、标题、项目、模式、状态和微信 route; 当前 route 绑定的 session 标记为“当前”. 标题优先使用 session name, 未命名时读取 Pi `/resume` 同样使用的首条 user 文本, 并在 40 个 Unicode 字符后以 `...` 省略.

`SessionIndexRecord.publicIndex` 在首次写入时分配, 旧 registry 首次读取时按最近活动时间排序迁移. 索引持久保存, 不随列表排序变化; app 不主动删除旧 session 索引, 新会话递增分配. `session-index.json` 的 UUID 仍仅供内部关联使用.

## 6. Pi 本机控制命令

- Pi 扩展只注册 `/wx` 和兼容别名 `/wechat-manager`; 不占用 Pi 全局 `/help`、`/projects` 或 `/status` 命令.
- `/wx` 回车打开 `ctx.ui.select()` 操作菜单; `/wx help` 展示本机 Hub 帮助.
- `/wx projects` 管理项目别名; 新打开的授权范围内 session 会自动创建以 cwd 文件夹名为 displayName 的项目记录.
- `/wx roots` 查看授权根; `/wx roots add-current` 或 `/wx roots add <绝对路径>` 仅可在本机可见 TUI 修改授权根.
- `/wx ` 使用 Pi `getArgumentCompletions` 提供本机子命令补全.
- `stop` 在可见 UI 中调用 `ctx.ui.confirm()`. 无 UI 的调用 fail-closed, 不停止服务.
- `/wx status` 读取共享 daemon 状态及配置项目计数, 不查看本 Pi extension 实例里的局部内存字段.

## 7. Windows 用户登录自动启动

配置项 `autoStartOnWindowsLogon` 默认 `false`. `/wx autostart on` 使用 `schtasks.exe` 以 `execFile` argv 创建当前用户 `ONLOGON` 任务, 然后更新配置; 若配置或任务更新失败会尽量回滚. `/wx autostart off` 删除任务并更新配置. 不需要为该登录任务安装系统级 Windows service 或请求管理员权限.

任务使用已保存的 `credentials.json` 启动 daemon. QR login 必须先由用户在 TUI 完成. 若凭证失效, daemon 不弹出交互窗口; 用户可从任意 Pi TUI 查看状态并重新授权.

此方案在 Windows 用户登录后启动, 不在 Windows 登录界面前运行. 用户注销/系统关机后, 用户级进程终止, 下次登录时任务重新启动 daemon.

## 8. 路由、队列与 iLink

- 唯一 Gateway owner 持有 iLink `getupdates` 长轮询, 个人微信 sender allowlist 在持久化 queue 前检查.
- 每个微信 route 使用 durable FIFO queue 和 `messageId` 去重. `context_token` 只随 pending queue 项持久化, 完成后删除.
- Queue processing 使用 iLink `getconfig` / `sendtyping` best-effort 显示“正在输入”; typing 失败不影响 Pi turn.
- Pi turn settled 后发送一条完整最终回复. Hub 不提供 token 级微信流式回传.
- Gateway stop 先停止 poller, 再等待活动 route drain. 如果进程非正常退出, `processing` queue item 会阻断后续消息, 需用户显式 `/retry ... --confirm`.

## 9. 安全与数据约束

- `allowedProjectRoots` 是本机 Hub 的会话接入边界. 根内打开的 Pi session 会按需登记; 根外 session 仍可在 Pi 本机恢复和使用, 但不能进入 Hub registry 或微信管理.
- 微信不可传任意 shell 命令、Pi 内置 slash command、项目路径或 transcript 文件路径. 本机 `/wx roots` 命令不暴露给微信端.
- 项目 alias 和真实路径每次启动/恢复时重新校验; 项目移出授权根后拒绝路由.
- IPC challenge 使用 Gateway lease token HMAC; 普通 Pi TUI attach 使用 manager 目录 ACL 保护的稳定随机 `ui-attachment.key`. manager 目录及凭证使用当前用户专属 ACL/mode.
- iLink QR 登录只写 Hub 自己的凭证, create-only; 不读取、复制、覆盖或删除其他客户端凭证.
- 审计日志不含 prompt、模型输出、消息正文或 credential.
- Gateway registry 不修改 Pi transcript; 任何写入都由对应的唯一 Pi runtime 完成.

## 10. 验证

自动化命令:

```bash
npm run typecheck
npm test
npm run test:pi-runtime
```

测试覆盖: config 默认关闭和非法值拒绝, IPC HMAC、detached daemon ready/failure, Task Scheduler argv 构造, route/session index 迁移, background/UI handoff, saved UI route 不再开 tab, durable queue、fake iLink、typing indicator、凭证 create-only 和 Pi RPC command smoke. `npm test` 不启动真实 Windows Terminal、不访问真实微信或模型.

Pi 0.85.1、1.0.0、1.3.0 本轮均通过 typecheck、完整测试和 RPC smoke. 本轮完整单测 80 项, 79 pass、1 项 Windows ACL 条件测试 skip. Windows Task Scheduler 与真实用户 logon、微信 QR 和真实模型仍需在用户设备上验收; 本轮未创建用户计划任务或启动真实微信连接.
