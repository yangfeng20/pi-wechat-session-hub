# ADR 0001: 持久化 iLink 单条消息的 context_token

## 状态

已接受. 选择 A 方案作为首版实现.

## 背景

iLink 回复需要回传对应入站消息的 `context_token`. Gateway 可能在 Pi worker 执行期间重启, 因此待处理消息需要携带可恢复的回复上下文. `context_token` 是会话级敏感数据, 不能写入普通 `events.jsonl` 或日志.

## 决策

将 `recipientId` 和 `contextToken` 作为可选 `replyContext` 与入站消息正文一起保存在 route 专属 durable queue JSONL 中:

```text
queue/<route-hash>.jsonl
  pending entry: messageId + text + replyContext + state
```

成功投递后压缩 queue 文件, 移除该消息正文和回复上下文. 幂等索引仅保留最近 1000 个 `messageId` 的 SHA-256 摘要, 不保存 token 或正文. `events.jsonl` 不记录 `replyContext`.

Bot 登录 token 仍只允许放在独立 `credentialFile` 中; 本决策不会读取或迁移其他客户端凭证.

## 理由

- 保持 Node.js 核心跨 Windows、macOS 和 Linux, 不把 DPAPI 或原生密钥库绑定进主流程.
- 支持 Gateway 重启后继续处理 pending queue, 并用原始 `context_token` 正确回复.
- 与已有 durable queue 中保存 pending message text 的生命周期一致, 完成后通过压缩删除敏感 payload.

## 风险与缓解

- Pending、failed 或 interrupted queue item 会在本地文件中保存明文消息和 `context_token`.
- POSIX 启动检查 manager 目录和凭证文件无 group/other 权限, 并要求其父目录不可被 group/other 写入.
- Windows 新建或空 manager 目录时关闭继承 ACL, 仅授予当前用户、SYSTEM 和 Administrators; 已有非空目录不自动改权限。启动时递归检查 manager 数据树仅这些主体可访问, agent 父目录允许只读 ACE 但不允许不可信主体写入; PowerShell 7/ACL 校验失败时 fail-closed.
- 设备备份、管理员权限进程或同一 OS 用户下的恶意进程仍可能读取 pending queue.
- `context_token` 不会进入普通审计日志; 完成消息正文被移除, 去重索引只保留哈希.
- 若后续要求防范同一 OS 用户进程或离线磁盘读取, 可将 `replyContext` 迁移到 DPAPI/Keychain/Secret Service 抽象, queue 只保存 opaque reference.

## 实施边界

当前代码实现了 `replyContext` 的 pending queue 持久化和完成后清理、注入凭证的 iLink API/poller adapter、固定路径只读 credential provider、独立 `/wx login` QR 授权和 detached Gateway daemon. `/wx start|status|stop|restart` 通过本机 HMAC control IPC 操作共享 daemon; 普通 Pi TUI 通过稳定 attach key 注册可见 session owner, TUI 关闭后 route 切回 background RPC. `/sessions` 使用持久会话索引, Windows 登录自动启动默认关闭并由 `/wx autostart on|off` 管理当前用户计划任务. QR 登录只提交空 `local_token_list`, 并以 create-only 写入 Hub 自有 `credentials.json`; 不读取、复制、覆盖或删除其他客户端凭证. 自动化测试使用 fake QR/credentials/transport 和 fake scheduler; 真实计划任务、账号和设备验收由使用者在本机完成.
