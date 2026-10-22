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
- 同一 session 同一时刻只允许一个 runtime writer. 只有登记在 Hub 且位于授权项目范围内的 Pi TUI session 会出现在微信会话清单中.

## 安装和首次使用

Node.js 需要满足 `package.json` 中的最低版本. 开发时可从项目目录临时加载:

```bash
pi --extension ./extensions/wechat-session-hub.ts
```

作为 Pi package 安装后, 扩展会在 Pi 会话中注册 `/wx` 命令. 首次配置顺序:

1. 在全局配置中设置 `allowedProjectRoots`.
2. 使用 `/projects add <alias> --name <名称> --path <绝对路径>` 登记项目, 必要时用 `/projects default <alias>` 设置默认项目.
3. 在 Pi TUI 执行 `/wx login` 扫码授权.
4. 在任意 Pi TUI 执行 `/wx start` 启动后台服务.

配置和授权凭证保存在用户专属 Hub 目录, 仓库不包含账号凭证或授权 ID.

## 本机命令

输入 `/wx` 并回车会打开交互式操作菜单; 输入 `/wx ` 可补全子命令. `/wechat-manager` 是兼容别名.

| 命令 | 行为 |
|---|---|
| `/wx login` | 在本地 TUI 扫码, create-only 写入 Hub 自己的凭证 |
| `/wx start` | 幂等启动独立后台 Gateway |
| `/wx status` | 在任意 Pi session 查询真实后台连接、PID 和前后台会话数 |
| `/wx stop` | 弹出二次确认; 确认后停止接收新消息并安全收尾 |
| `/wx restart` | 安全停止并重启 daemon; 服务已停止时启动服务 |
| `/wx autostart on` | 开启 Windows 当前用户登录后自动连接 |
| `/wx autostart off` | 关闭并移除 Windows 登录任务 |

停止时, daemon 先停止接收新微信消息, 再 drain 已入队 route 工作并等待正在处理的 Pi turn 收尾. 本机命令会立即返回“正在停止”, 可用 `/wx status` 查询进度. 如果 daemon 非正常退出, durable queue 会保留未完成项并阻断后续 FIFO, 需要显式 `/retry <message-id> --confirm`.

Windows 自动启动默认关闭; 开启后在当前用户登录 Windows 时使用已保存授权连接. 它不在 Windows 登录桌面前运行, 也不会在启动时弹出扫码窗口. 如果尚未完成微信授权或授权失效, 需要先在 Pi TUI 执行 `/wx login`.

## 微信端命令

未知 slash command fail-closed, 不会任意透传 Pi 内置命令, 也不接受用户提供的 shell 或文件路径.

```text
/new [--mode background|ui] [--project <alias>] [--name <名称>]
/sessions [--project <alias>] [--state active|saved|pending|all] [--page <n>]
/resume <会话索引|名称>
/stop [会话索引|名称]
/retry <message-id> --confirm
/status
/projects
/help
```

`/new` 默认在后台创建会话, 也可显式使用 `/new --mode ui` 在新 Windows Terminal tab 中创建可见 UI 会话. `/sessions` 默认列出 Hub 管理的全部活跃前台和后台会话, 并在表格中标明列含义及当前微信 route. 标题优先显示 session name; 未命名时显示 Pi `/resume` 使用的首条用户文本, 最长 40 个 Unicode 字符, 超出部分以 `...` 省略. `/resume 3` 把微信 route 切换到索引为 `3` 的会话. 索引在会话排序变化后保持不变, 不因列表重排而复用.

Pi TUI 的内置 `/resume` 仍使用 Pi 自己的会话选择器. 如果选中的是 Hub 管理的会话, extension 会安全完成前后台 owner 交接.

## 配置

默认配置位置:

```text
%USERPROFILE%\.pi\agent\wechat-session-manager.json
```

如果设置了 `PI_CODING_AGENT_DIR`, 配置保存在该目录. 首次启动不会自动创建全局配置. 示例:

```json
{
  "schemaVersion": 1,
  "autoStartOnWindowsLogon": false,
  "allowedProjectRoots": [
    "D:\\Projects"
  ],
  "projects": {},
  "wechat": {
    "authorizedUserId": ""
  }
}
```

缺省字段会使用安全默认值. 历史配置中的 `defaultMode` 字段为兼容旧配置保留, 微信端 `/new` 固定创建后台会话. `wechat.credentialFile` 固定指向 manager 数据目录中的 `credentials.json`; reader 拒绝目录外路径、符号链接、未知 schema 或授权用户不匹配. QR 凭证只在文件不存在时 create-only 写入, 不读取或覆盖其他应用数据.

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
