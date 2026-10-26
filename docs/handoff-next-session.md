# Pi WeChat Session Hub 新会话交接说明

本文件为下一次 Pi 会话提供当前实现、最近讨论和待决策事项的快速上下文. 代码与测试是行为事实源; 本文件是交接摘要, 与实现不一致时以代码和最新测试为准.

## 当前仓库状态

- 分支: `main`.
- 最近提交: `009fecb docs: 更新会话恢复与 Hub 状态说明`.
- 最近相关提交:
  - `a706580 fix: 修复旧 owner 阻塞会话恢复`.
  - `2f7d7c8 feat: 恢复会话后回显最近回复`.
  - `de9b13c fix: 优化微信帮助命令换行`.
- 上述提交均为本地提交, 尚未 push.
- 本交接文档已提交; 当前工作区包含尚未提交的微信命令回复可读性和 Gateway 生命周期完成通知优化.

## 产品目标与重要约束

Pi WeChat Session Hub 让用户通过微信管理已登记项目中的多个 Pi 会话. Gateway 是脱离 Pi TUI 的独立后台 daemon; Pi session JSONL 仍是对话历史事实源.

必须保持的约束:

- 一个 Pi session 同一时刻只能有一个 runtime writer.
- 微信只能操作 Hub registry 中的 session, 不扫描或暴露所有本机 Pi session 文件.
- TUI session 只有在 cwd 与已登记项目路径匹配, 且位于 `allowedProjectRoots` 内时才接入 Hub.
- 微信命令不接受任意 shell、路径或 Pi slash command. 未知 slash command fail-closed.
- 不读取、复制、覆盖或删除其他应用凭证. Hub 凭证只写 Hub 自己的专属目录, create-only.
- 面向用户的交流、提示、文档和注释使用中文; 避免不必要地提及其他产品.

## 当前架构与命令行为

```text
Pi TUI: /wx start|status|stop|restart|autostart
                │ 本机 HMAC IPC
                ▼
       独立 Hub daemon / Gateway
          ├─ iLink poller + durable queue
          ├─ route/session registry + 稳定索引
          └─ 每个 session 唯一 Pi writer
               ├─ TUI owner: 消息进入可见会话
               └─ 无 TUI owner: 后台 Pi RPC worker
```

- `/wx` 打开本机控制菜单. `/wechat-manager` 保留兼容.
- `/wx start` 启动独立 daemon; `/wx status|stop|restart` 控制服务. `/wx stop` 需要 TUI 二次确认.
- Windows 当前用户登录自动启动配置默认关闭. 用户登录任务尚未在本机实际启用或创建.
- `/new` 默认创建后台会话; 显式 `/new --mode ui` 会启动可见 Windows Terminal UI. 默认不打开新 tab.
- `/sessions` 默认列出 Hub 管理的活跃前台/后台会话, 每页 5 条, 每个会话单独展示标题、项目、模式和状态; 当前微信 route 在列表摘要和对应会话项中标记. 标题优先使用会话名; 没有名称时仅读取 Pi `/resume` 同样采用的首条用户文本. 标题最长 32 个 Unicode code point, 超出以 `...` 省略; 暂无用户消息时显示“尚无用户消息”.
- 微信 `/resume <索引|名称>` 将该微信 sender 的 route 切换到目标 session. 空闲会话恢复后附带最多 800 个 Unicode 字符的最近回复预览; 内容过长时提示完整回复仍保留在会话记录中. 本机 TUI `/resume` 会进行 UI/background owner 交接.

## 最近讨论: 活跃 turn 中切换 route

用户询问: 微信当前会话正在处理消息时, 发送 `/resume` 或 `/new` 会不会立刻切换并让旧会话继续运行.

**当前实现是同一个 route 的 durable FIFO.** `/resume`、`/new` 和普通 prompt 都进入同一 route 队列. 若旧 turn 正在运行:

1. 新命令会持久入队, poller 可继续接收消息.
2. 旧 turn 先完成, 最终回复先发回微信.
3. 队列再处理切换命令并更新 route.
4. 后续消息发给新 session. 旧 session 不会被删除或停止, 但旧 turn 已完成; 它不再接收此 route 的后续消息.

因此命令不是立即切换. 若旧 turn 长时间不结束, 切换也会延迟. 目前没有确定要改变此行为.

下一次讨论可比较两种语义:

- 保持严格 FIFO. 优点是入站顺序容易理解, 切换不越过已发 prompt. 缺点是长 turn 会延迟切换.
- 为 `/resume`/`/new` 增加优先控制通道, 让 route 可在旧 turn 运行期间切换. 旧 worker 可以继续原 turn, 后续消息发往新 route. 这需要明确排队中的普通消息归属、回执顺序、停止/重试交互, 并验证 writer 与 route generation 无竞态.

不要在未与用户确认语义前直接改成优先切换.

## 项目 allowlist 与会话注册

- 默认 Hub 配置: `%USERPROFILE%\.pi\agent\wechat-session-manager.json`.
- 如果设置了 `PI_CODING_AGENT_DIR`, 配置位于该目录下的 `wechat-session-manager.json`.
- `allowedProjectRoots` 只能在配置文件中修改, 当前没有 `/projects roots` 命令. 不支持 glob; 一个 root 覆盖它本身和所有子目录.
- `/projects add <alias> --name <名称> --path <绝对路径>` 只登记项目 alias, 不会改 `allowedProjectRoots`.
- UI bridge 要求 Pi session 的 cwd 与某个 `projects.<alias>.path` 精确匹配. 仅把路径放进允许根目录仍不够.
- 曾诊断到一条当前 Pi session 因 cwd 未登记/不在允许根内而没有进入 Hub registry; `session_start` 中的 `project_not_registered` 会静默跳过. 之后用户询问过修改 root 和登记 alias 的步骤, 但交接时不应假定本机配置的最终状态, 应先用 `/projects` 和微信 `/sessions` 复核.
- 把父目录加入 `allowedProjectRoots` 会扩大 Hub 可登记范围; 优先授权具体项目目录, 避免直接授权过宽的父目录.

## 本机安装与更新

用户执行过 Pi local-path package 安装. Pi 的 local path package 默认写入用户级 settings, 不复制源码; 后续修改对应目录会被新的进程读取.

Gateway 是常驻 daemon, 已运行进程不会自动加载磁盘上的新代码. 修改 Gateway 代码后在已加载扩展的 Pi TUI 执行 `/wx restart`, 再从微信验证. 大多数情况下不需重新 `pi install` 或重启所有 Pi TUI.

若出现旧的 `/help`/`/new` 输出, 先确认 daemon 已 restart, 再考虑 package path 或运行中的旧进程.

## 近期已完成的相关改动

- `/sessions` 改为每页 5 条的窄屏文本卡片, 每项独立显示索引/标题和项目/模式/状态; 当前 route 显示“当前微信路由”和“【当前】”标记. 标题优先取会话名, 否则读取 Pi `/resume` 使用的首条用户文本; 清理控制字符并在 32 个 Unicode code point 后追加 `...`.
- 微信 `/help` 按会话、项目、Hub 状态分组并缩短长语法行.
- 微信 `/status` 使用中文状态摘要, 不暴露 PID 或内部技术字段.
- 空闲会话 `/resume` 回复最多 800 个 Unicode 字符的最近回复预览, 超长时显示开头并说明完整内容仍在 transcript.
- `/wx start`、`/wx stop`、`/wx restart` 先显示进度, 完成后再通知最终状态. `/wx stop` 的控制请求等待 runtime 安全收尾; `/wx restart` 通过 operationId 和 lifecycle receipt 等待新 daemon ready, Pi 端用本地文件事件唤醒, 不循环轮询网络.
- `tests/gateway-service-controller.test.ts` 覆盖异步 lifecycle receipt 和 final status; `tests/wechat-session-hub-command.test.ts` 覆盖 restart 进度与完成通知.
- `tests/gateway-command-router.test.ts` 增加会话卡片、稳定索引、当前 route 标记、分页、状态摘要、帮助分组和恢复预览截断回归测试.

**文档不一致提醒:** README 配置说明中仍有旧句子称微信 `/new` 固定创建后台会话; 实现现在支持显式 `--mode ui`. 后续可顺手修正文案.

## 验证状态

最近一次验证, 在本机 Pi 开发依赖 `0.85.1` 下:

- `npm run typecheck`: 通过.
- `npm test`: 92 项, 91 pass, 1 项条件 Windows ACL 测试 skip.
- `git diff --check`: 通过.
- Gateway restart 的完成通知通过隔离控制 IPC、异步 lifecycle receipt 和 fake TUI notification 测试; 未对真实微信连接执行 `/wx restart`.

Pi `0.85.1`、`1.0.0`、`1.3.0` 完整兼容矩阵在较早的实现阶段已跑通; 最近的微信回复和生命周期通知优化只在 `0.85.1` 完整验证, 尚未重新跑全部版本矩阵. Windows ACL 专项测试在较早验证时通过. 最近一次 `npm audit --omit=dev` 遇 npm registry `503`; 依赖锁文件未变, 但该次未完成新审计.

## 建议下一会话优先确认

1. 用户希望 `/resume`/`/new` 在旧 turn 未完成时立即切换, 还是继续保持 FIFO 等待.
2. 当前 Pi TUI session 的实际 cwd 是否已精确登记, `allowedProjectRoots` 是否过宽.
3. 对未登记 cwd 是否应从静默跳过改为给本机 TUI 明确提示, 同时继续 fail-closed.
4. 在 `/wx restart` 后实测微信 `/help` 分组、`/status` 中文摘要、`/sessions` 卡片/分页和 `/resume` 长回复预览, 以及 `/new --mode ui` 是否打开可见 tab.
5. 是否需要修 README 中旧 `/new` 描述, 并在合并更多改动后重跑 Pi `1.0.0` / `1.3.0` 矩阵.

## 常用验证命令

```bash
npm run typecheck
npm test
npm run test:pi-runtime
```

在运行常驻 Gateway 的环境中, 修改代码后执行:

```text
/wx restart
/wx status
```

再通过微信发送相应命令验证.
