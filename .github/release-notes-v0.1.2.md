本版核心是**修复 npm 安装场景下后台服务无法启动**, 并新增 Windows 登录后自动启动、会话健康总览, 以及一批微信端展示修复.

> 已实测验证: 在 Windows + Node 22.22.3 下以 `pi install npm:pi-wechat-session-hub@0.1.2` 安装, 后台 daemon 正常启动, 微信收发正常, Windows 登录自动启动的 launcher 可正确拉起进程.

## 升级提示

- 从 0.1.x 升级后**需要重启 Pi TUI**, 让新扩展入口生效
- 若此前已开启自动启动, **需要重新执行一次 `/wx autostart on`**: launcher 中记录的是绝对路径, 旧 launcher 仍指向源码目录的入口
- 切换安装位置(源码目录 ↔ npm 包)后, 旧的 daemon 进程不会自动切换, 请执行 `/wx restart`

## 修复

### npm 安装后后台 Gateway 无法启动

#1, PR #2, 感谢 [@leliyliu](https://github.com/leliyliu)

此前 daemon 以 `node --experimental-transform-types src/runtime/gateway-daemon.ts` 启动, 这在两种常见环境下必然失败:

- Node >= 26 已移除该参数, 子进程以 `bad option` 退出(退出码 9), 上层报「后台 Gateway 在 ready 前退出 (code 9)」
- 从 npm 安装时入口位于 `node_modules` 内, 而 Node 原生 TypeScript 支持拒绝剥离 `node_modules` 下的 `.ts`(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), 降级 Node 也无效

改为通过 `jiti` 加载同一份 `.ts` 源码(新增 `extensions/daemon-entry.mjs` 启动垫片), Node 22 / 24 / 26 一致可用, 且不需要维护编译产物. 仅在入口仍以 `.ts` 结尾时保留该参数, 自定义入口与测试行为不变. Windows 登录自动启动的 launcher 同步适配. macOS 上 POSIX 控制 socket 路径超长导致的 `listen()` EINVAL 一并修复(`sun_path` 上限 104 字节).

### 单条消息投递失败会永久卡死整条 route

队列原为严格 FIFO 阻塞语义, 队首标记 `failed` / `interrupted` 后永久阻断该 route 后续消息, 且不向用户回任何提示. 表现为微信能发消息、Hub 显示在线, 但永远收不到回复, 连 `/status` 也被堵在队列里. 线上曾因此卡死 9 天.

新增 `skipped` 状态: 遇到遗留 `processing` / `failed` / `interrupted` 项时跳过并放行后续消息. 跳过时主动向微信回提示, 含消息 ID、原文预览、失败原因与 `/retry` 指令. `/status` 新增「已跳过」段.

### 回复过长导致 iLink 投递失败

按实测上限重做单条消息约束. 实测结论: `item_list` 只能含 **1 个** `text_item`(2 个时即使总长仅 30 字也返回 `ret=-2 prepare failed`); 请求体 UTF-8 字节上限约 16800(16791 成功 / 16926 失败, 中文 5456 字成功 / 5501 字失败). 移除 `splitTextItems`, `sendText` 恒定发送单 item, 上限设为 16500 字节.

### `/wx autostart on` 在非提升用户下失败

Task Scheduler 方案有两层问题: 完整 `/TR` 命令 787 字符, 超过 261 字符上限; 且当前非提升用户连创建 `notepad.exe` 任务都返回 `Access is denied`.

改为写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, 不需要管理员权限. Run 项只调用短 PowerShell launcher, 由 launcher 以隐藏窗口启动 Node Gateway, 完整 launch payload 留在私有 manager 目录中. 失败提示保留 `reg.exe` 返回原因, 配置失败会回滚.

### 其他

- UI 会话 reload 后重连失败
- `/last` 误报「尚未产生回复」: 最新一轮失败时改为显示真实错误原因

## 新增

### `/watch [--all]` 会话健康总览

默认列出运行中、启动中、异常与断连会话, `--all` 包含空闲会话; 表格显示索引、标题、项目、当前状态与最后活动时间.

从 transcript 最后一条 assistant 的 `stopReason` / `errorMessage` 归类失败, 可识别周 / 5 小时 / 月额度耗尽、TPM 限流、鉴权失败、服务不可用(503)、网络错误与中断; 上游提供重置时间时直接显示原时间. 不依据 `heartbeatAt` 推断卡死: 该字段只在状态变化时写入, 不是周期心跳.

### Windows 登录后自动启动

`/wx autostart on|off`, 默认关闭. 使用已保存授权在登录时连接, 不在登录桌面前运行, 启动时不弹扫码窗口. 授权失效时需先在本机执行 `/wx login`.

## 改进

微信端命令改为 markdown 表格与分段显示. 实测确认微信支持表格、列表、加粗、行内代码与 `---` 分隔线; **单个 `\n` 会被渲染为空格**, 这是此前信息挤成一行的真因.

- `/sessions`: 改为四列表格 + 项目汇总, 索引列去掉冗余 `#` 前缀; 移除页码参数, 一次展示所有符合筛选条件的会话
- `/status`: 纯文本字段堆叠改为两列键值表, 可见 UI 模式并入表格
- `/projects`: 改为三列表格, 默认项目加粗并补充登记命令提示
- `/new`、`/last`、`/resume`、`/help` 与跳过提示: 消除单换行导致的信息粘连, 标签与正文分段展示

README 与实现说明同步更新会话列表展示方式与自动启动机制.

## 测试

- 新增 Windows 登录自动启动管理器测试, 覆盖 Run 项写入、launcher 生成与失败回滚
- 新增 `.mjs` daemon 入口断言: launcher 不传 Node TypeScript 参数, 且包含 `daemon-entry.mjs` 与 `--launch-payload`
- CI 新增 `Gateway npm bootstrap` 检查(Node 22 与 Node 26), 将包打成 tarball 解压到 `node_modules/` 后实际加载 daemon 垫片, 覆盖 npm 安装场景
- 全量测试 128 条, 125 通过 / 0 失败 / 3 跳过
- 实机验证: npm 安装布局下 daemon 启动、微信收发、登录自启动 launcher 均正常

## 安装

```bash
pi install npm:pi-wechat-session-hub@0.1.2
```

或跟随默认分支:

```bash
pi install git:github.com/yangfeng20/pi-wechat-session-hub
```

完整变更见 [CHANGELOG.md](https://github.com/yangfeng20/pi-wechat-session-hub/blob/main/CHANGELOG.md).
