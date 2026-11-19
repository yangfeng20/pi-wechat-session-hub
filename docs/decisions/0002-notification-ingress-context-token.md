# ADR 0002: 通知入口持久化活跃 context_token 并直发微信

## 状态

已接受.

## 背景

用户希望其他 Pi 会话与外部程序能通过 Hub 向微信推送通知 (构建结果、任务完成、告警等).
iLink 协议规定: Bot 主动发送必须携带目标用户最近一条入站消息的 `context_token`,
该 token 约在用户最后一条消息 24 小时后过期, 过期后发送返回 `ret=-2` 或被静默丢弃.

ADR 0001 决定 pending queue 完成后删除 `context_token`, 不长期保存. 通知功能需要
在"没有 pending 消息"时也能发送, 因此必须单独保存一条活跃 token 记录, 与 ADR 0001
形成有意识的例外.

## 决定

1. 新增 `ContextTokenStore`: 授权用户每条入站消息通过授权校验后, 将最新
   `{recipientId, contextToken, receivedAt}` 覆盖写入 manager 目录下的
   `ilink-context-token.json` (0600, 原子写, 拒绝符号链接). 只保存一个用户的
   单条活跃记录; durable queue 的"完成后删除"行为不变.
2. 新增 `NotificationService`: 复用 `IlinkApiClient.sendText` 直发微信, 不经过
   durable queue、Pi worker 与模型. 发送前做 20 小时新鲜度预检 (留 4 小时余量).
3. 过期策略 `notification.overflowPolicy` 可配置: `queue` (默认, 积压待续命后补发)
   或 `drop` (直接拒绝并返回失败原因). 积压仅存内存, 上限 100 条, 补发单轮最多
   10 条, 超出合并为摘要, 避免触发微信侧连续发送限制.
4. 微信端新增 `/renew` 命令: 在入站路径直接拦截, 不进 durable queue、不触发
   Pi turn、零 token 消耗; 续命效果由入站 token 捕获自动完成, 命令只负责确认
   与触发积压补发.
5. 距 token 过期不足 4 小时时, Gateway 心跳定时器触发一次续命提醒
   (每个过期周期最多一次), 提醒文案引导用户回复 `/renew`.
6. 新增本机通知入口 `NotificationIngressServer`: named pipe / unix socket,
   endpoint 由 manager 目录哈希推导 (与 control IPC 同模式), 鉴权使用
   `notify-shared.key` 的 HMAC-SHA256 proof (绑定 requestId + 时间戳 + payload,
   ±5 分钟防重放), 内存级限流默认 10 条/分钟、60 条/小时. 不监听 TCP.
7. 所有通知正文末尾固定附加"〔系统通知, 与会话无关, 请勿直接回复〕"提示,
   防止用户把通知当作会话上下文回复.

## 理由

- 24 小时窗口是微信平台硬限制, 无法绕过; 积压补发 + 过期前提醒 + `/renew`
  是该约束下用户体验最优的组合, 全部不依赖外部推送渠道.
- token 明文存储与 ADR 0001 对 pending 消息的取舍一致: manager 目录 ACL
  仍是唯一防线, 暴露面从"pending 期间"扩大为"始终有一条活跃记录", 换取
  主动推送能力.
- 通知走独立路径而非 durable queue, 保证零副作用: 不写 transcript、不触发
  模型调用、不占用 route FIFO.
- HMAC 鉴权 + 时间戳防重放 + key 文件 ACL, 与现有 UI attach key 威胁模型一致:
  同 OS 用户进程本可读取 key, 防线针对其他用户与远程攻击者.

## 风险与缓解

- `ilink-context-token.json` 明文保存 context_token (至多 24 小时时效),
  manager 目录 ACL 限制为当前用户/SYSTEM/Administrators; 设备备份与同用户
  恶意进程仍可读取, 风险等级与 pending queue 一致.
- 微信侧可能存在"用户未回复时连续接收条数上限", 补发单轮限 10 条并合并摘要;
  限流器防止调用方高频触发风控.
- 续命提醒本身依赖尚未过期的 token, 属 best-effort; 提醒失败只等下个周期,
  不做任何灰色保活操作.
- 通知入口不写审计日志正文;积压通知仅存内存, daemon 退出即丢弃 (queue 模式
  下会丢, 属已知取舍: 换取不落盘).

## 实施边界

`scripts/wx-notify.mjs` 提供零依赖 CLI; `/wx notify` 后续可加. 通知入口与
Gateway 生命周期绑定, `/wx stop` 后入口不可用. 自动化测试覆盖 token 存储、
策略分支、补发/摘要、提醒窗口、HMAC 校验与端到端 pipe 通信; 真实微信投递
仍需用户在本机验收.
