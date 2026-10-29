# Pi 微信会话枢纽

Pi WeChat Session Hub 是一个 Pi 扩展, 用微信管理本机多个 Pi 会话. Gateway 在独立后台进程中运行, 不依赖启动命令所在的 Pi TUI.

## 架构与会话行为

```text
任意 Pi TUI
  /wx start|status|stop|restart
          │ 本机 HMAC IPC
          ▼
独立 Hub daemon
  ├─ 微信 iLink 长轮询、鉴权、route、持久队列
  └─ 每个会话唯一 writer
       ├─ Pi TUI 正在打开该会话: 消息进入前台并回显
       └─ 没有活跃 TUI owner: Pi RPC 后台处理
```

- `/wx start` 启动共享 daemon, 不绑定当前 Pi session. 关闭所有 Pi TUI 后, daemon 仍可通过微信收发消息.
- 每条微信 route 指向同一 Pi session. 在 Pi TUI 中 `/resume` 恢复 Hub 管理的会话时, 扩展通过 IPC 将 owner 从后台 RPC 安全切换到前台 TUI; 同一会话的微信消息和回复会在该 TUI 中显示. TUI 关闭后, route 返回后台 RPC.
- 新建微信会话默认在后台, 不自动打开 Windows Terminal tab. route、session JSONL 和稳定会话索引保留.
- 同一 session 同一时刻只允许一个 runtime writer. Pi TUI session 的 cwd 位于 `allowedProjectRoots` 内时会自动登记并纳入 Hub; 授权根外的会话仍可在本机使用, 但不接入微信管理.
- 当前 Pi TUI 已成功接入 Hub 时, footer 的扩展状态行会在 MCP 状态后显示 `🟢 微信: 已接入`; Gateway 重启或连接恢复期间显示 `🟡 微信: 连接中`.

## 安装和首次使用

Node.js 需要满足 `package.json` 中的最低版本. 开发时可从项目目录临时加载:

```bash
pi --extension ./extensions/wechat-session-hub.ts
```

作为 Pi package 安装后, 扩展只注册 `/wx` 本机命令, `/wechat-manager` 保留为兼容别名. 首次使用顺序:

1. 在 Pi TUI 执行 `/wx login` 扫码授权.
2. 在 Pi TUI 执行 `/wx start` 启动后台服务. 如果 `allowedProjectRoots` 为空, Hub 会将当前 session 的 cwd 设为初始授权根, 并自动建立项目记录和默认项目.
3. 授权根内打开的 Pi session 会按当前文件夹名自动识别, 不需要逐个 `/projects add`. 如果后续要授权其他目录, 在本机 TUI 执行 `/wx roots add-current`, 或用 `/wx roots add <绝对路径>` 添加工作区根目录.

盘符根目录和用户主目录等过宽范围会要求本机确认. 授权根外的 Pi session 仍可在本机使用, 但不会接入 Hub; TUI 会提示如何添加授权根. Hub 不会扫描其他 session 文件.

配置和授权凭证保存在用户专属 Hub 目录, 仓库不包含账号凭证或授权 ID.

## 本机命令

输入 `/wx` 并回车会打开交互式操作菜单; 输入 `/wx ` 可补全子命令. `/wechat-manager` 是兼容别名. Pi 本机的 Hub 命令统一位于 `/wx` 下, 不会注册全局 `/help`、`/projects` 或 `/status`.

| 命令 | 行为 |
|---|---|
| `/wx login` | 在本地 TUI 扫码, create-only 写入 Hub 自己的凭证 |
| `/wx start` | 幂等启动独立后台 Gateway; 首次使用时初始化当前目录授权 |
| `/wx status` | 查询后台连接、PID、会话数、项目和授权根目录 |
| `/wx roots` | 查看本机授权根目录 |
| `/wx roots add-current` | 授权当前 Pi session 目录及其子目录, 并接入当前会话 |
| `/wx roots add <绝对路径>` | 在本地 TUI 授权一个工作区根目录 |
| `/wx projects` | 查看自动识别和手动登记的项目 |
| `/wx stop` | 弹出二次确认; 确认后停止接收新消息并安全收尾 |
| `/wx restart` | 安全重启后台 Gateway, 等待新服务就绪; 服务已停止时启动服务 |
| `/wx autostart on` | 开启 Windows 当前用户登录后自动连接 |
| `/wx autostart off` | 关闭并移除 Windows 登录任务 |
| `/wx help` | 查看本机命令帮助 |

停止时, Gateway 先停止接收新微信消息, 再 drain 已入队 route 工作并等待正在处理的 Pi turn 收尾. `/wx stop` 在后台收尾期间提示“正在停止”, 完成后再通知最终状态. `/wx restart` 会安全停止旧后台进程并启动新进程, 等待新服务就绪或报告失败; 它不会启动新旧并行 poller. 如果 daemon 非正常退出, durable queue 会保留未完成项并阻断后续 FIFO, 需要显式 `/retry <message-id> --confirm`.

Windows 自动启动默认关闭; 开启后在当前用户登录 Windows 时使用已保存授权连接. 它不在 Windows 登录桌面前运行, 也不会在启动时弹出扫码窗口. 如果尚未完成微信授权或授权失效, 需要先在 Pi TUI 执行 `/wx login`.

## 微信端命令

未知 slash command fail-closed, 不会任意透传 Pi 内置命令, 也不接受用户提供的 shell 或文件路径.

```text
/new [--mode background|ui] [--project <alias>] [--name <名称>]
/sessions [--project <alias>] [--state active|saved|pending|all] [--page <n>]
/resume <会话索引|名称>
/last [会话索引|名称]
/stop [会话索引|名称]
/retry <message-id> --confirm
/status
/projects
/help
```

`/new` 默认在后台创建会话, 也可显式使用 `/new --mode ui` 在新 Windows Terminal tab 中创建可见 UI 会话. `/sessions` 默认列出 Hub 管理的全部活跃前台和后台会话, 每页 5 条, 每个会话单独展示标题、项目、模式和状态, 当前微信路由会明确标记. 标题优先显示 session name; 未命名时使用 Pi `/resume` 同样采用的首条用户文本, 最长 32 个 Unicode 字符, 超出以 `...` 省略. `/resume 3` 把微信 route 切换到索引为 `3` 的会话. 如果切换目标的 agent 已处于 idle, 回复会附带最近一次回复预览; 超过 800 个 Unicode 字符时只显示开头并提示完整内容仍在会话中. 如果 agent 正在运行, 只确认切换, 不发送旧回复. 索引在会话排序变化后保持不变, 不因列表重排而复用.

## 在微信端找回上下文

从 PC TUI 切换到手机微信时, 往往不知道会话进行到哪里了. 补一条消息又可能让 agent 白跑一轮, 因此 `/last` 提供纯只读的上下文回顾:

```text
/last              查看当前微信路由会话的最近一轮对话
/last 3            查看索引为 3 的会话最近一轮对话
/last "调查错误"   按唯一会话名称查看
```

回复包含会话编号、标题、项目、最后活动时间、运行模式, 以及最近一轮的 user 提问和 assistant 回复, 单段最多展示 600 个 Unicode 字符, 超长时提示完整内容仍在会话记录中. 工具输出和 thinking 推理不会出现在摘要里.

`/last` 只读取 Pi session JSONL 文件末尾固定区间, 不加载整个 transcript, 也不改变 route 绑定、不写入 transcript、不调用模型, 因此不会产生任何副作用或额外 token 消耗. 如果目标会话正在运行, 回复会显式标注"该会话正在运行, 以下为目前已落盘的内容", 避免把中间步骤误读为最终结论. 尚未产生任何消息的会话会明确提示无记录. 看完后可直接发送新指令, 或用 `/resume <索引>` 切换过去继续工作.

Pi TUI 的内置 `/resume` 仍使用 Pi 自己的会话选择器. 如果目标是 Hub 会话, extension 会安全完成前后台 owner 交接. 未登记 session 不再因缺少 Hub 记录而阻止 Pi 原生恢复; 恢复后仅当 cwd 位于授权根内才自动接入 Hub.

## 配置

默认配置位置:

```text
%USERPROFILE%\.pi\agent\wechat-session-manager.json
```

如果设置了 `PI_CODING_AGENT_DIR`, 配置保存在该目录下的 `wechat-session-manager.json`. 首次在 Pi TUI 执行 `/wx start` 时, Hub 会自动创建缺省配置并初始化当前 session 的授权根和项目记录. `allowedProjectRoots` 是安全边界, 一个根目录覆盖其子目录. 授权范围内的当前 Pi session 会按 cwd 文件夹名自动登记, 不需要逐个添加项目 alias, 也不会扫描其他目录或 Pi session 文件. 后续授权新工作区时, 可在本机 TUI 执行 `/wx roots add-current` 或 `/wx roots add <绝对路径>`. 示例:

```json
{
  "schemaVersion": 1,
  "autoStartOnWindowsLogon": false,
  "allowedProjectRoots": [],
  "projects": {},
  "wechat": {
    "authorizedUserId": ""
  }
}
```

缺省字段会使用安全默认值. 历史配置中的 `defaultMode` 字段为兼容旧配置保留, 不决定微信端 `/new` 的运行模式; `/new` 默认创建后台会话, 也可通过 `--mode ui` 显式创建可见 UI 会话. `wechat.credentialFile` 固定指向 manager 数据目录中的 `credentials.json`; reader 拒绝目录外路径、符号链接、未知 schema 或授权用户不匹配. QR 凭证只在文件不存在时 create-only 写入, 不读取或覆盖其他应用数据.

Windows 首次创建空 manager 目录时会关闭继承 ACL, 仅授权当前用户、SYSTEM 和 Administrators; 已有非空目录不会自动修改权限, 登录和启动时会验证目录树. POSIX 要求 manager 目录和凭证文件无 group/other 权限, 且父目录不能被 group/other 写入. 权限无法验证时 fail-closed.

## 安全与运行边界

- Pi session JSONL 是对话历史事实源; Gateway 不直接编辑 transcript.
- Gateway 通过 `manager.lock` 保证单实例. control IPC 使用当前 lease token 完成 HMAC challenge, UI attach 使用 manager 目录 ACL 保护的稳定随机 key; 在线状态由活跃 IPC 校验, 不依赖过期 `gateway.json`.
- route 绑定、会话索引和 worker owner 持久保存; session 恢复前重新验证项目路径是否仍位于 `allowedProjectRoots`.
- 审计事件不记录消息正文、模型输出或凭证. 队列只在未完成期间保存原消息及 `replyContext`; 完成后压缩移除 payload, 并保留最近 1000 个 messageId 的 SHA-256 摘要用于去重.
- iLink `sendtyping` 仅提供 best-effort “正在输入”提示. Pi turn settled 后 Hub 发送一条完整最终回复, 不做 token 级微信流式回传.
- 关闭服务后不会自动登录或生成 QR. 自动启动仅由 `autoStartOnWindowsLogon` 和当前用户登录计划任务控制.

## 开发与验证

```bash
npm install
npm run typecheck
npm test
npm run test:pi-runtime
```

当前自动化测试覆盖配置/索引迁移、Gateway IPC 和 detached daemon 启动失败保护、Windows 登录任务参数、前后台 session handoff、durable queue、iLink fake transport、typing indicator、凭证隔离和 worker 生命周期. `npm test` 使用 fake Pi/iLink, 不访问真实微信服务、不启动真实 Windows Terminal, 也不调用模型. 条件 ACL 集成测试默认跳过, 可单独启用:

```bash
PI_WECHAT_VERIFY_WINDOWS_ACL=1 node --experimental-transform-types --test --test-name-pattern="Windows manager ACL integration" tests/credential-store.test.ts
```

Pi RPC smoke 使用隔离配置检查扩展命令注册, 不访问真实账号凭证. 版本兼容范围和 CI 矩阵见 `package.json` 的 `piCompatibility` 与 `.github/workflows/pi-compat.yml`.

## 许可证

本仓库目前未指定开源许可证. 公开发布前需选择并添加许可证文件.
