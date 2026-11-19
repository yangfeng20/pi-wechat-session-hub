# 更新日志

本文件记录所有值得关注的变更. 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/), 版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/).

## [未发布]

暂无.

## [0.1.5] - 2026-11-19

本版包含两大变更: 会话架构重构 (Hub 不再限制 writer, 只选择微信消息的目标 runtime) 与全新的微信通知入口 (外部程序与 Pi 会话可直发微信通知).

### 会话架构: 保留 Pi 原生会话切换

- **Hub 不再强制「单 writer」**: 此前 TUI 打开即接管、TUI 关闭即交回后台, 始终只有一个 writer; 现在多个 Pi runtime (TUI/RPC) 可同时打开同一 session, Pi 自己管理会话分支, Hub 只负责选择微信消息投递给哪个 runtime, 不广播
- Pi 原生 `/resume`、`/tree`、`/fork`、`/clone` 完全不被 Hub 拦截: `/tree` 不改变 route; `/fork`、`/clone` 创建新 session 时, 仅当前 route 所连接的 TUI 跟随转到新 session
- 微信 route 规则不变: 优先已接入的当前 TUI, TUI 关闭后交给同 session 其他已接入 runtime, 最后交给后台 RPC worker
- 新增原生会话切换测试覆盖 `/tree` `/fork` 场景

### 新增: 微信通知入口

- **其他程序/脚本可直发微信通知**: `node <包目录>/scripts/wx-notify.mjs "标题" "正文"`, 不经过会话队列、不触发模型、不耗 token; 退出码 0 表示已送达, 非 0 返回明确失败原因
- **Pi 会话内自动获得 `wx_notify` 工具**: 安装本包后每个会话注册该工具并进入系统提示词, 用户说「构建完微信通知我」等即可被 agent 调用, 无需任何配置
- **通知通道凭证自动管理**: 每条入站微信消息授权后捕获最新 `context_token` (ACL 保护目录, 0600, 原子写), 供主动发送使用; durable queue 完成后删除 token 的行为不变
- **24 小时窗口应对** (微信平台限制: 用户 24h 内未互动则 Bot 无法主动发送):
  - 距过期不足 4 小时时 Bot 主动提醒回复 `/renew` 续命, 每个周期最多一次
  - 过期后的通知默认积压 (`notification.overflowPolicy: "queue"`), 续命后自动补发; 可配 `"drop"` 改为直接拒绝并返回错误
  - 任意入站消息 (不只 `/renew`) 续命后都会自动补发积压
  - 积压落盘持久化 (`notification-backlog.json`, ACL 保护目录), daemon 重启不再丢失
  - 补发单轮最多 10 条, 超过合并为摘要, 避免触发微信侧连续发送限制
- **微信端新增 `/renew` 命令**: 续命通知通道并补发积压, 零副作用 (不进队列、不触发 Pi turn、不耗 token)
- 每条通知末尾固定附加「〔系统通知, 与会话无关, 请勿直接回复〕」, 防止把通知当会话上下文误回复
- 安全边界: 本机 named pipe / unix socket (不监听 TCP), `notify-shared.key` HMAC 鉴权 + ±5 分钟防重放 + 内存级限流 (默认 10 条/分钟、60 条/小时), 详见 `docs/decisions/0002-notification-ingress-context-token.md`

### 变更

- 新增依赖 `typebox@1.3.7` (`wx_notify` 工具参数 schema, 与 Pi 内置版本一致)
- 新增配置节 `notification.overflowPolicy` (默认 `queue`, 旧配置无需手动修改)

### 测试

- 新增通知模块用例: token 存储与损坏拒绝、queue/drop 策略分支、续命补发与摘要、提醒窗口、HMAC 篡改与时间戳拒绝、限流器、端到端 pipe 通信、`/renew` 解析、`wx_notify` 工具路径、积压落盘恢复
- 全量测试 155 条, 152 通过 / 0 失败 / 3 跳过

### 升级提示

- 升级后需重启 Pi TUI 并执行 `/wx restart`, 让 daemon 跑新代码
- 首次使用通知入口: 在微信给 Bot 发一条消息激活通道, 之后即可用 `wx-notify` CLI 或会话内 `wx_notify` 工具发通知

## [0.1.4] - 2026-11-12

本版重做 `/watch` 会话健康总览: 默认视图改为「当前打开着的会话」, 并新增「最后提问」列.

### 改进

- **`/watch` 默认视图改为按「是否还开在后台」筛选**
  - 原规则按会话状态筛选(非空闲), 结果是 256 个会话里有 250 个长期空闲的历史会话被藏起来, 而真正开在后台但刚跑完的会话(worker 状态 idle)反而看不见
  - 改为按 registry 中是否还有 worker 实例判断: 有 worker = 当前可操作, 直接展示, 不论 running 还是 idle; 异常与断连会话始终展示
  - 汇总行改为「打开 N 个（共 M）」, 不再用总数误导; 页尾补充「共 M 个会话, 发 `/watch --all` 查看全部」
  - 实测本机: 默认视图从 2 行变为 7 行, 正好对应当前开着的 7 个会话
- **新增「最后提问」列, 取代会话标题**
  - 取 transcript 中最后一条 user 消息, 即你自己最后一句话, 比会话标题更能帮助回忆起该会话在干什么
  - 超长内容按 Unicode code point 截断到 22 字并加省略号, 避免手机端横向滚动
  - 仅对会被展示的行读取, 不为几百个历史会话做无意义 IO
  - 读取采用与 `readLatestFailure` 相同的动态扩窗策略(64KB → 2MB): 长会话中最后一条用户消息会被大量 assistant 输出挤出初始窗口, 固定窗口会误报「暂无提问」
- **活动时间改为相对描述**: `2026-11-12 14:54` 改为 `14m` / `2h` / `1d`, 手机上无需心算
- 移除表格中的 PID 列(手机端无用且撑宽), 需要诊断时用 `/wx status`

### 测试

- 更新 `/watch` 用例: 断言默认视图按 worker 实例筛选、展示最后提问而非会话标题、`--all` 不再输出分页提示
- 全量测试 134 条, 131 通过 / 0 失败 / 3 跳过

### 升级提示

- 升级后需重启 Pi TUI 并执行 `/wx restart`, 否则 daemon 仍跑旧代码

## [0.1.3] - 2026-11-11

本版修复 `/watch` 会话健康总览的误报: 用户主动中断与历史遗留失败被长期当作「需要处理」的异常.

### 修复

- **`/watch` 把用户主动中断当成错误**
  - transcript 中 `stopReason: aborted` / `errorMessage: Operation aborted` 表示用户自己按了中断, 属于正常操作痕迹, 但原逻辑只看到 `errorMessage` 非空就判为失败, 结果在总览里永久显示错误并进入「需要处理」列表
  - 新增 `interrupted` 状态: 主动中断显示为「已中断」, 默认与空闲会话一起收起, `--all` 仍可查看
  - 实测样本: 本机 248 个会话中有 3 个属于此类误报
- **历史遗留失败被当作当前故障**
  - 健康状态由 transcript 最后一条 assistant 记录推导, 而 transcript 不会再变化, 因此一个多月前的一次失败会每天出现在「需要处理」里
  - 失败信息现在带上 transcript 条目的 `timestamp`(`detectedAt`), 超过 24 小时的失败视为历史记录, 不再报异常; 「需要处理」列表同时显示失败发生时间
  - 缺少可信时间戳时按未过期处理, 避免因解析不到时间而漏报真实故障
- **上游合规拦截被归为「未知错误」**
  - 新增 `policy_blocked` 分类, 识别 `Request blocked` / `are not allowed` / `violates` / `account suspension` 等文本, 显示为「请求被上游合规策略拦截」, 便于判断应该换模型或换账号, 而不是当成偶发故障重试

### 测试

- 新增主动中断不算故障、时间窗口生效与边界、缺少时间戳不漏报、合规拦截分类、`readLatestFailure` 带时间戳等用例
- 全量测试 134 条, 131 通过 / 0 失败 / 3 跳过

### 升级提示

- 升级后需重启 Pi TUI, 让新的健康判定生效

## [0.1.2] - 2026-11-11

本版核心是**修复 npm 安装场景下后台服务无法启动**, 并新增 Windows 登录后自动启动、会话健康总览, 以及一批微信端展示修复.

### 修复

- **npm 安装后后台 Gateway 无法启动**(#1, PR #2, 感谢 [@leliyliu](https://github.com/leliyliu))
  - 此前 daemon 以 `node --experimental-transform-types src/runtime/gateway-daemon.ts` 启动, 这在两种常见环境下必然失败:
    - Node >= 26 已移除该参数, 子进程以 `bad option` 退出(退出码 9), 上层报「后台 Gateway 在 ready 前退出 (code 9)」
    - 从 npm 安装时入口位于 `node_modules` 内, 而 Node 原生 TypeScript 支持拒绝剥离 `node_modules` 下的 `.ts`(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), 降级 Node 也无效
  - 改为通过 `jiti` 加载同一份 `.ts` 源码(新增 `extensions/daemon-entry.mjs` 启动垫片), Node 22 / 24 / 26 一致可用, 且不需要维护编译产物
  - 仅在入口仍以 `.ts` 结尾时保留该参数, 自定义入口与测试行为不变
  - Windows 登录自动启动的 launcher 同步适配: `.mjs` 入口不再传该参数
  - macOS 上 POSIX 控制 socket 路径超长导致的 `listen()` EINVAL 一并修复(`sun_path` 上限 104 字节)
- **单条消息投递失败会永久卡死整条 route**
  - 队列原为严格 FIFO 阻塞语义, 队首标记 `failed` / `interrupted` 后永久阻断该 route 后续消息, 且不向用户回任何提示. 表现为微信能发消息、Hub 显示在线, 但永远收不到回复, 连 `/status` 也被堵在队列里. 线上曾因此卡死 9 天
  - 新增 `skipped` 状态: 遇到遗留 `processing` / `failed` / `interrupted` 项时跳过并放行后续消息
  - 跳过时主动向微信回提示, 含消息 ID、原文预览、失败原因与 `/retry` 指令; 提示投递失败只放弃提示, 不阻塞队列
  - `/status` 新增「已跳过」段, 展示跳过数量、消息 ID 与原因
- **回复过长导致 iLink 投递失败**, 按实测上限重做单条消息约束
  - 实测结论: `item_list` 只能含 **1 个** `text_item`(2 个时即使总长仅 30 字也返回 `ret=-2 prepare failed`); 请求体 UTF-8 字节上限约 16800(16791 成功 / 16926 失败, 中文 5456 字成功 / 5501 字失败)
  - 移除 `splitTextItems`, `sendText` 恒定发送单 item, 上限设为 16500 字节
- **UI 会话 reload 后重连失败**
- **`/wx autostart on` 在非提升用户下失败**, 改用当前用户注册表启动项
  - Task Scheduler 方案有两层问题: 完整 `/TR` 命令 787 字符, 超过 261 字符上限; 且当前非提升用户连创建 `notepad.exe` 任务都返回 `Access is denied`
  - 改为写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, 不需要管理员权限
  - Run 项只调用短 PowerShell launcher, 由 launcher 以隐藏窗口启动 Node Gateway, 完整 launch payload 留在私有 manager 目录中
  - 失败提示保留 `reg.exe` 返回原因, 不再吞掉底层错误; 配置失败会回滚
- **`/last` 误报「尚未产生回复」**: 最新一轮失败时改为显示真实错误原因

### 新增

- **`/watch [--all]` 会话健康总览**
  - 默认列出运行中、启动中、异常与断连会话, `--all` 包含空闲会话; 表格显示索引、标题、项目、当前状态与最后活动时间
  - 从 transcript 最后一条 assistant 的 `stopReason` / `errorMessage` 归类失败, 可识别周 / 5 小时 / 月额度耗尽、TPM 限流、鉴权失败、服务不可用(503)、网络错误与中断; 上游提供重置时间时直接显示原时间
  - 不依据 `heartbeatAt` 推断卡死: 该字段只在状态变化时写入, 不是周期心跳
- **Windows 登录后自动启动**(`/wx autostart on|off`), 默认关闭
  - 使用已保存授权在登录时连接, 不在登录桌面前运行, 启动时不弹扫码窗口
  - 授权失效时需先在本机执行 `/wx login`

### 改进

- **微信端命令改为 markdown 表格与分段显示**. 实测确认微信支持表格、列表、加粗、行内代码与 `---` 分隔线; **单个 `\n` 会被渲染为空格**, 这是此前信息挤成一行的真因
  - `/sessions`: 改为四列表格 + 项目汇总, 索引列去掉冗余 `#` 前缀; 移除页码参数, 一次展示所有符合筛选条件的会话
  - `/status`: 纯文本字段堆叠改为两列键值表, 可见 UI 模式并入表格
  - `/projects`: 改为三列表格, 默认项目加粗并补充登记命令提示
  - `/new`、`/last`、`/resume`、`/help` 与跳过提示: 消除单换行导致的信息粘连, 标签与正文分段展示
- README 与实现说明同步更新会话列表展示方式与自动启动机制

### 测试

- 新增 Windows 登录自动启动管理器测试, 覆盖 Run 项写入、launcher 生成与失败回滚
- 新增 `.mjs` daemon 入口断言: launcher 不传 Node TypeScript 参数, 且包含 `daemon-entry.mjs` 与 `--launch-payload`
- CI 新增 `Gateway npm bootstrap` 检查(Node 22 与 Node 26), 将包打成 tarball 解压到 `node_modules/` 后实际加载 daemon 垫片, 覆盖 npm 安装场景
- 全量测试 128 条, 125 通过 / 0 失败 / 3 跳过

### 升级提示

- 从 0.1.x 升级后**需要重启 Pi TUI**, 让新扩展入口生效
- 若此前已开启自动启动, **需要重新执行一次 `/wx autostart on`**: launcher 中记录的是绝对路径, 旧 launcher 仍指向源码目录的入口
- npm 包内文件的安装位置发生变化时, 旧的 daemon 进程不会自动切换, 请执行 `/wx restart`

## [0.1.1] - 2026-10-29

### 修复

- 修复 0.1.0 的 npm 索引元数据异常
  - 0.1.0 首次发布时 2FA 触发了 npm staged publishing, 先落地了 `0.0.0-stage` 占位 stub, 之后才写入真实 0.1.0. 结果 registry 上 packument 的 `readme` 与 `readmeFilename` 均为空字符串(tarball 内 `README.md` 正常), 导致该包无法进入 npm search 索引, `pi.dev/packages` 因而查不到
  - `0.0.0-stage` 已 unpublish 清除, 重新发布 0.1.1 以重建元数据

## [0.1.0] - 2026-10-29

### 新增

- 首个公开版本
- 微信远程下发任务, 由本机 Pi 执行, 结果回到微信
- 会话常驻: Pi TUI 全部关闭后仍可在微信继续对话
- 前后台自动交接: TUI 打开即接管, 关闭即交回后台, 始终只有一个 writer
- 多项目多会话管理与稳定数字索引
- `/last` 只读回顾最近一轮对话, 不调模型不耗 token
- 授权根目录白名单与 fail-closed 命令处理
- AGPL-3.0 许可证与安装文档

[未发布]: https://github.com/yangfeng20/pi-wechat-session-hub/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/yangfeng20/pi-wechat-session-hub/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/yangfeng20/pi-wechat-session-hub/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/yangfeng20/pi-wechat-session-hub/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/yangfeng20/pi-wechat-session-hub/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yangfeng20/pi-wechat-session-hub/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yangfeng20/pi-wechat-session-hub/releases/tag/v0.1.0
