# Pi 微信多会话管理器设计方案

- 状态: 首版实现与自动化验证已完成; 真实账号及设备验收由使用者在本机完成
- 目标场景: 个人微信账号, 本地 Windows + Windows Terminal + Pi
- 核心决定: 微信负责控制本地多个 Pi session; `ui` 模式启动新的 Pi TUI tab, 不切换或覆盖当前已打开的 TUI

## 0. 当前实施状态

- Phase 0 验证完成: Pi 兼容矩阵 `0.85.1`、`1.0.0`、`1.3.0` 全部通过 typecheck、66 项单测(65 pass, 1 个 ACL 条件测试 skip)及 RPC smoke; Windows ACL 写入专项测试另行启用并通过。真实账号和设备测试不在仓库记录。
- Phase 1 配置、项目 alias、路径授权、Gateway lease 和 registry 已实现。
- Phase 2 background RPC worker、session 恢复、router、durable FIFO、fake iLink → Pi worker 回复链路已实现。
- Phase 3 visible UI worker 的 Windows Terminal launcher、一次性 launch ticket、HMAC named-pipe 注册、Pi 原生 `sendUserMessage()`、session switch owner 检查、心跳和关闭处理已实现; `/wechat-manager login` 提供独立 QR 授权与 create-only Hub credential writer. queue processing 时使用 `getconfig` / `sendtyping` 显示 best-effort typing indicator, 并在最终回复后取消. fake bridge/transport 自动化测试已通过.
- Phase 4 background/UI saved session 恢复、UI worker 重连、session switch owner 重绑、跨模式切换前先停止 owner 等单 writer 保护已实现; 三个 Pi 版本的完整矩阵均通过。
- 微信消息使用 `getupdates` 长轮询进入 Gateway; Pi turn settled 后通过 `sendmessage` 发一条完整最终回复. Hub 没有 token 级流式回传; iLink `sendtyping` 只提供“正在输入”提示.
- 安全审计: `npm audit --omit=dev` 为 0 vulnerabilities。全量依赖树来自 Pi CLI 开发依赖的告警: Pi `0.85.1` 报 3 项, `1.0.0` 安装审计报 1 项, `1.3.0` 为 0; 本扩展不将 Pi CLI 打包为生产依赖。
- Phase 5 24/7 Windows service/计划任务仍是可选后续部署阶段, 不属于本轮首版。
- 凭证需由用户在本机授权取得, 采用 create-only 写入且不读取或迁移其他应用凭证。24/7 Windows service/计划任务仍是可选后续部署阶段, 不属于首版。

## 1. 需求与边界

### 1.1 目标

构建一个 Pi package/extension, 将微信 ClawBot/iLink 消息接入本机 Pi, 并提供跨项目 session 管理.

1. `/new` 可在后台创建一个原生 Pi session.
2. `/new --mode ui` 可用 Windows Terminal 新建 tab, 在指定项目目录里启动真正的 `pi` TUI.
3. 新 TUI tab 由 Pi CLI 自己创建 session, 不由 Gateway 预先写 session JSONL 再尝试附着.
4. 微信消息明确路由到一个已登记的 Pi runtime.
5. 微信可全局查看 session, 恢复历史 session, 选择项目 alias, 查看 session 的活跃状态.
6. 启动 `/new --mode ui` 后, 原有 Pi TUI 窗口与当前 session 不改变.
7. 可通过 extension heartbeat/IPC 了解 Pi 进程及 session 状态, 不依赖扫描 Windows Terminal 窗口猜测.
8. Pi session JSONL 是对话历史事实源; Gateway registry 只保存 routing、运行实例和显示元数据.

### 1.2 非目标

第一版不做:

- 多用户/多租户微信机器人.
- 微信群聊支持.
- 多个 session 同时绑定同一条个人微信对话并自动判断路由.
- 在同一 Pi TUI 里同时展示多个独立 agent transcript.
- 自动删除 Pi 历史 session.
- 默认读取、覆盖、迁移或删除其他 iLink 客户端的凭证.
- 依赖第三方 agent runtime 执行 Pi session.

### 1.3 重要产品语义

`--mode ui` 指真正运行的交互式 Pi CLI/TUI, 不是把后台结果复制到现有 TUI.

- 新开 UI session: 新 tab 显示新的 Pi 对话; 原 TUI 不变.
- 后台 session: 由 `pi --mode rpc` 或 SDK runtime 执行; 不会在任何 TUI tab 自动回显.
- 恢复 UI session: 如果 session 已有活跃 Pi TUI, Gateway 路由到该 owner; 如果 session 已停止, 使用 WT 新 tab 执行 `pi --session <session-file>`.
- 一个 session 同一时间只有一个 Pi runtime writer. 禁止相同 JSONL session 同时由 TUI 和后台 RPC 打开并写入.

## 2. 总体架构

```text
                   微信 ClawBot / iLink
                            │
                    唯一的 getUpdates owner
                            │
                            ▼
┌────────────────────────────────────────────────────────────┐
│ Pi WeChat Manager Gateway                                  │
│                                                            │
│  鉴权 / 去重 / 命令解析 / route map / durable queue         │
│  session catalog / project alias / process heartbeat       │
│                                                            │
│  ┌──────────────────┐             ┌───────────────────┐   │
│  │ Background worker│             │ Visible Pi TUI    │   │
│  │ pi --mode rpc    │             │ wt.exe -> pi TUI  │   │
│  │ hidden session   │             │ new independent tab│   │
│  └────────┬─────────┘             └─────────┬─────────┘   │
│           │ JSONL RPC                       │ local IPC     │
└───────────┼─────────────────────────────────┼───────────────┘
            │                                 │
            ▼                                 ▼
    Pi AgentSession                   Pi extension bridge
    session JSONL                     pi.sendUserMessage()
                                              │
                                              ▼
                                      新 tab 内 TUI 原生显示
```

### 2.1 Gateway owner

唯一 Gateway owner 负责:

- 持有 iLink 长轮询连接.
- 将入站微信消息鉴权、去重、规范化并放入 route 队列.
- 根据 active route 把消息投递到后台 RPC runtime 或可见 TUI runtime.
- 收集 Pi 输出, 根据 turn 来源发送回复到微信.
- 管理所有 Pi 实例的注册表、租约、状态与会话路由.

不得让每个 Pi TUI tab 自己轮询同一微信 Bot. 否则多个 `getUpdates` 消费者会争用同一同步游标, 导致消息丢失、重复或连接互相踢掉.

第一版 Gateway 可由启动 `/wechat-manager start` 的 Pi extension host 进程承载. 其他 Pi 进程作为 worker 注册. 如果后续要求关闭所有 TUI 后仍保持微信 24/7 在线, 再把 Gateway owner 拆成独立 Windows 登录服务/计划任务; 这属于后续部署增强, 不改变 channel/session 协议.

### 2.2 Pi worker 类型

#### Visible worker

- 使用 `wt.exe` 启动独立交互式 `pi` 进程.
- Pi CLI 自己创建新 session 或恢复指定 session.
- 全局 Pi extension 在 `session_start` 时读取一次性 `launchId`, 向 Gateway 注册自己的 `sessionId`, `sessionFile`, `cwd`, `pid` 和 IPC endpoint.
- Gateway 向该 worker 投递微信 prompt.
- worker extension 调用本 runtime 的 `pi.sendUserMessage()`.
- Pi 原生 transcript/TUI 显示 user message、assistant reply 和工具调用.
- worker 把 agent 消息/settlement 事件通过 IPC 发回 Gateway, Gateway 再把结果送回微信.

#### Background worker

- Gateway 启动 `pi --mode rpc` 子进程或 SDK `AgentSessionRuntime`.
- session 文件由 Pi 自己创建并维护.
- Gateway 用 RPC `prompt`、`follow_up`、`abort` 与 worker 交互.
- 没有附着的 TUI, 因此微信消息和回复只在微信显示; `/sessions` 标记为后台运行.

第一版建议 background worker 使用 `pi --mode rpc`, 因为协议可以清晰获取 `sessionId`、`sessionFile`、消息流和工具事件, 并能保持与 Pi CLI 的 runtime 行为一致.

## 3. 命令语法

正式语法使用 long options; 可额外兼容用户偏好的简写 `ui` 和 `p:<alias>`.

### 3.1 新建会话

```text
/new [--mode background|ui] [--project <alias>] [--name <session-name>]
```

示例:

```text
/new --project demo
/new --mode background --project demo --name "调查应用错误"
/new --mode ui --project demo --name "修复输入校验"
```

默认值:

- 未指定 `--mode`: `background`.
- 未指定 `--project`: 使用 `defaultProject`; 若未配置则提示先选项目, 不隐式落到未知 cwd.
- 未指定 `--name`: Pi 使用首条 prompt 作为默认显示名称.

可选兼容简写:

```text
/new ui p:demo
/new bg p:demo
```

解析器将它规范化为 long-option 形式. 错误提示和帮助信息始终展示规范写法.

### 3.2 项目别名

```text
/projects
/projects add <alias> --name <display-name> --path <absolute-path>
/projects remove <alias>
/projects default <alias>
```

不支持微信消息传入任意路径作为 `cwd`; 新建/恢复只能引用预先登记的 alias.

### 3.3 会话清单与恢复

```text
/sessions [--project <alias>] [--state active|saved|all] [--page <n>]
/resume <session-id-or-name> [--mode background|ui]
/status
/help
```

`/sessions` 默认显示 active 与最近使用的 saved session, 分页展示; 每行包含短 ID、名称、项目 alias、状态、模式和最近活动时间.

恢复规则:

1. 目标 session 已在 worker registry 中且 owner 心跳有效: 直接把微信 active route 绑定给已有 owner, 不再启动第二个 writer.
2. 目标 session 已保存但无活跃 owner, 且 `--mode ui`: 执行 WT launcher, 以 `pi --session <sessionFile>` 打开.
3. 目标 session 已保存但无活跃 owner, 且 `--mode background` 或未指定: 启动 RPC worker 并恢复 session.
4. 目标 session 正由另一模式运行: 不自动双开; 先报告当前 owner, 若要转换模式需走显式 stop/checkpoint/relaunch 流程.

### 3.4 对话绑定

个人微信只有一个 owner route. 命令创建/选择目标 session 后更新 route:

```text
wechat_user_id -> active_session_id -> worker_instance_id
```

`/sessions` 只列会话, 不隐式切换. `/resume` 成功后才更改 active route.

## 4. 项目与配置

全局配置建议放在:

```text
%USERPROFILE%\.pi\agent\wechat-session-manager.json
```

示例:

```json
{
  "schemaVersion": 1,
  "defaultMode": "background",
  "defaultProject": "demo",
  "allowedProjectRoots": [
    "D:\\Projects"
  ],
  "projects": {
    "demo": {
      "displayName": "示例项目",
      "path": "D:\\Projects\\demo"
    },
    "notes": {
      "displayName": "个人笔记",
      "path": "D:\\Documents\\Notes"
    }
  },
  "wechat": {
    "authorizedUserId": "",
    "credentialFile": "<separate protected credential file>"
  },
  "runtime": {
    "heartbeatIntervalMs": 5000,
    "staleAfterMs": 20000,
    "maxBackgroundWorkers": 4,
    "maxQueuePerSession": 20
  }
}
```

安全要求:

- `displayName` 只用于显示; `alias` 是稳定命令 ID; `path` 是已授权目录.
- Windows path 启动前做 `realpath`/规范化并检查在 `allowedProjectRoots` 内.
- 账号 token 单独写入 ACL/权限受限的 credential 文件, 不放进 project config、Pi session 或日志.
- 配置更新采用 schema 校验和原子替换, 保留未知字段或拒绝未知字段的策略需在实现前选定.

## 5. 状态持久化与会话事实源

### 5.1 Pi session JSONL

Pi 原生 session file 是对话历史和工具调用的事实源. 不直接编辑 JSONL 来实现新建、切换、分叉或消息注入.

- UI 新建: Gateway 只建立 pending launch record, 随后由 WT 启动的 Pi CLI 创建 session.
- Background 新建: Gateway 启动 Pi RPC, 由 Pi 自己创建 session.
- 恢复: 调用 Pi CLI/RPC session API 加载 session file.

### 5.2 Manager registry

MVP registry 可采用单写入者 JSON 文件 + append-only JSONL event journal, 避免 Windows native SQLite 依赖. 只有 Gateway owner 写 registry; worker 只通过 IPC 提交状态事件.

建议状态位置:

```text
%USERPROFILE%\.pi\agent\wechat-session-manager\
  manager.lock
  gateway.json
  instances.json
  routes.json
  session-index.json
  events.jsonl
  queue\<route-id>.jsonl
  logs\
```

其中:

- `session-index.json`: sessionId、sessionFile、cwd/project alias、name、最近访问、lastEntryId、状态快照.
- `instances.json`: 当前在线 Pi 进程及它们拥有的 session.
- `routes.json`: 微信用户/对话到 active session 的绑定.
- `events.jsonl`: 注册、心跳、创建、恢复、route 变更、worker 退出等审计事件.
- `queue`: 未送达/运行中的微信消息及幂等 ID; Gateway 重启后可恢复.

JSON registry 使用 temp file + atomic rename. 对 Gateway owner 加 lease lock. 过期的 route 和历史 session 不自动删除.

## 6. 活跃会话发现与心跳

不能靠枚举 Windows Terminal 进程作为会话清单. `wt.exe` 用于打开 tab; active session 的权威信息由 Pi extension 向 Gateway 注册.

每个 Pi extension instance 注册:

```text
instanceId
pid
processBirthId
sessionId
sessionFile
cwd
projectAlias
mode: ui | background
state: starting | idle | running | stopping | stale
windowLabel / tabTitle
heartbeatAt
ipcEndpoint
```

- `session_start`: 注册或更新 session.
- `agent_start`: `state=running`.
- `agent_settled`: `state=idle`.
- `session_info_changed`: 更新显示名称.
- `session_shutdown`: 注销或标记 stopping.
- heartbeat: 默认 5 秒.
- 超过 20 秒未心跳: 标记 stale, 再用 PID + process birth identity 验证进程是否存活, 防止 PID reuse.
- Pi TUI 内 session 通过 `/new` 或 `/resume` 替换后, 同一 process 更新当前 session registration; 历史 session 仍在 session index.

## 7. Windows Terminal 启动方案

### 7.1 WT 的职责

WT 只负责启动可见 tab, 不作为 active Pi session 数据库.

概念命令:

```text
wt.exe -w 0 new-tab -d <project-path> --title <session-title> <shell-command>
```

- 已有 WT window: `-w 0` 目标最近窗口.
- 必须新开 WT window 时: 使用 `-w new`.
- `-d` 设置项目 cwd.
- 最后参数执行 shell/Pi CLI.

### 7.2 Launch handshake

不能假定 WT tab 一打开, Pi 一定启动成功. 必须等 Pi extension 注册:

1. Gateway 创建 `launchId` 和 `launchTicket`, 状态设为 `starting`.
2. Gateway 调用 `wt.exe` 创建 tab, 工作目录由 project alias 解析.
3. 命令以受控方式把一次性 `launchId` 交给 Pi extension; 不把密钥或未经校验的 user text拼进 PowerShell 命令.
4. Pi extension 启动后通过 named pipe 连接 Gateway, 完成 challenge/response, 上报实际 `sessionId`、`sessionFile` 和 `cwd`.
5. Gateway 校验 alias/cwd/session, 将 route 绑定到该 worker, 再向微信回报成功.
6. 超时/launch crash 时标记 `failed`, 保留诊断日志, 不把 route 绑定到不存在的 session.

实现需测试 Windows Terminal app execution alias、Node `spawn` 参数、路径含空格/中文、当前无 WT window、WT 已开启多个 window、shell 命令 quoting 和 Pi extension 自动加载.

## 8. IPC 与消息路由

### 8.1 Windows named pipe

Gateway 与每个 Pi worker 使用本机 named pipe, 例如:

```text
\\.\pipe\pi-wechat-manager-<user-scope>-<instance-id>
```

每次连接校验随机 challenge token, 验证同一 OS user/process lease; 拒绝未登记的进程和重复 instanceId. 不在公网监听端口.

### 8.2 消息协议

至少支持:

```text
worker.register
worker.heartbeat
worker.session_changed
worker.turn_started
worker.turn_settled
worker.ui_request
worker.error
manager.prompt
manager.follow_up
manager.abort
manager.get_state
manager.shutdown
```

所有消息包含 `requestId`, `instanceId`, `sessionId`, `routeId`, `generation`. 来自旧 session generation 的迟到回包要丢弃.

### 8.3 可见 Pi turn

Gateway 向注册的 UI worker 发 `manager.prompt`. worker extension 调用当前 Pi runtime 的 `pi.sendUserMessage()`; TUI 原生显示 user/assistant/tool entries. worker 订阅 Pi 的 streaming/tool events 转发 Gateway, Gateway 负责微信端回复和状态消息.

### 8.4 后台 Pi turn

Gateway 启动 `pi --mode rpc` 并解析 JSONL. Background session 不显示在现有 TUI; `mode=background` 标记在 `/sessions` 中, 微信仍可看到结果.

## 9. 并发、切换和单写入者规则

- 每个 sessionId 同时最多一个 runtime owner.
- 一个微信 route 同时只有一个 active session.
- 同一个 route 消息 FIFO; 同一 session 内新消息按 Pi `follow_up`/`steer` 规则投递.
- 不同 session 可以并行, 但受 `maxBackgroundWorkers` 限制.
- 活跃 UI session 要路由到现有 worker; 不得用第二个 Pi 打开同一 session file.
- UI session 转后台: 请求 worker 先 idle/checkpoint/close, 后启动 RPC resume.
- Background session 转 UI: RPC worker 先 idle/close, 再启动 WT `pi --session <file>`.
- 如果切换期间 session 正在执行, 默认先拒绝或提示 `/stop`; 不静默强杀, 不混合两个 writer.
- 当前 TUI A 不会因为 `/new ui` 或绑定 UI session B 而切换; B 在新 tab.

## 10. iLink 账号与已有客户端绑定

微信 channel connection 是第一阶段 release gate:

1. 不读取、复制、覆盖或删除其他客户端的本地凭证.
2. 通过 Pi Hub 自己的 QR 流程申请独立授权.
3. 如果服务端报告账号已有绑定, 停止并提示用户按服务官方流程处理; 仅删除本地配置不视作服务端解绑.
4. 同一个 bot credential 任何时刻只允许一个 `getUpdates` poller.
5. 不自动停止其他客户端、解绑账号或清理其本地状态.

## 11. 错误处理与可观测性

`/status` 至少显示:

- Gateway online/offline, iLink polling 状态.
- 当前微信 route 绑定 session name / short ID / project alias.
- 当前 worker mode、PID、TUI/background、idle/running.
- active queue 深度、最近消息和回复时间.
- 最近 launch/session/IPC 错误.

用户可见错误需区分:

- `project_alias_not_found`
- `project_path_denied`
- `wt_not_found`
- `pi_command_not_found`
- `worker_registration_timeout`
- `session_owned_by_other_process`
- `wechat_auth_unavailable`
- `gateway_poll_conflict`
- `session_resume_failed`

凭证、完整 session path 和消息正文默认不写普通日志.

## 12. 安全模型

- 单一微信用户 allowlist; 未授权消息在下载附件和路由前拒绝.
- project alias 绑定绝对路径, 使用 realpath 检查在允许根路径下.
- shell 命令只能由程序构建固定 `wt`/`pi` argv; 不拼接用户提供的任意命令字符串.
- session ID 使用 Pi 提供的 ID, 展示短 ID; 恢复时要求唯一匹配.
- 文件出站默认关闭或限定到授权 project root.
- pending launch ticket 一次性、短时有效; named pipe 限同用户并校验 instance registration.
- 工具审批超时、通道掉线、来源错配、nonce 失效均 fail-closed.
- 默认不向微信暴露 thinking 原文、完整 shell 输出或本地凭据.

## 13. 实施阶段

### Phase 0: 环境与账号验证

- 核对当前 Pi Node 版本、Pi binary、全局扩展加载和 Windows Terminal `wt.exe`.
- 用安全测试路径单独验证 `wt.exe` 新 tab + Pi TUI.
- 不触碰其他客户端登录状态, 单独验证 WeChat/iLink direct login 可行性.

### Phase 1: 配置和项目目录

- 配置 schema、project alias、path validation.
- `/projects`, `/status`, `/help`.
- 单进程 Gateway lock 与 session registry.

### Phase 2: Background MVP

- `/new --project <alias>` 默认 background.
- Spawn `pi --mode rpc`, persist session ID and status.
- `/sessions`, `/resume`, `/stop`.
- 消息队列、去重和 Pi final reply 回 WeChat.

### Phase 3: Visible WT sessions

- `/new --mode ui --project <alias>`.
- WT launcher、one-time launch registration、named pipe.
- WeChat prompt enters Pi TUI native session and TUI shows transcript.
- Existing TUI unaffected; visible active status from heartbeat.

### Phase 4: 恢复、切换和故障处理

- Resume saved session in UI/background.
- Cross-mode transfer with single-writer enforcement.
- Crash/stale heartbeat recovery, Gateway owner handoff.
- Verify duplicate message, provider error, user cancel, Pi quit, WT close, Gateway restart, path with spaces and Chinese chars.

### Phase 5: 24/7 service (可选)

- Windows Scheduled Task or service wrapper for Gateway auto-start.
- Session workers can be recovered after login/reboot.
- This phase must be opt-in; first release can require at least one Pi TUI/Gateway owner running.

## 14. 验收标准

1. `/new --mode ui --project demo` 会通过 WT 新 tab 启动 Pi, Pi 自己创建 session.
2. 原有 Pi TUI 的 cwd、sessionId、transcript 不改变.
3. 新 tab 成功 register 前, 微信不会显示“会话已就绪”.
4. 微信消息进入新 tab 对应的 Pi session, 在该 TUI 可见; 回复同时回微信.
5. 默认 `/new --project demo` 启动无 TUI 的后台 Pi runtime, 原有 TUI 不变.
6. `/sessions` 能同时列出 active UI、active background 和 saved sessions, 且标明 project alias.
7. `/resume <id> --mode ui` 对活跃 session 复用其现有 owner; 对 saved session 才启动新 WT tab.
8. 没有 session 会发生双 writer.
9. WT 启动失败、Pi 注册超时、Gateway crash 或微信 API 失败不会静默丢失 route/message.
10. 未登记 alias、路径越界、未授权微信用户、错误 launch ticket 都被拒绝.

## 15. 后续会话入口

Pi Hub 提供独立 `/wechat-manager login` QR 流程, 并以 create-only 写入 Hub 自有 `credentials.json`; 不读取、复制、覆盖或删除其他客户端凭证. 自动化测试使用 fake QR/credentials/transport; 使用者应在自己的环境完成真实账号和设备验收.
