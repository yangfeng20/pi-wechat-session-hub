本版修复 `/watch` 会话健康总览的误报: 用户主动中断与历史遗留失败被长期当作「需要处理」的异常.

## 升级提示

- 升级后需重启 Pi TUI, 让新的健康判定生效

## 问题

实机上 `/watch` 显示 4 条异常, 排查后发现**全部是误报**:

| 会话 | 实际情况 | 被误报为 |
| --- | --- | --- |
| #228 | 用户主动中断 | 🔴 错误 |
| #186 | 用户主动中断 | 🔴 错误 |
| #155 | 用户主动中断 | 🔴 错误 |
| #91 | 2026-10-30 的旧错误, 距今 12 天, 会话早已保存且无 worker | 🔴 错误 |

全量扫描本机 248 个会话: 正常结束 171 个, `aborted` 3 个, 真错误 1 个. 也就是说 `/watch` 报的 4 条异常里, 3 条是误报, 剩下 1 条是过期信息.

## 修复

### 用户主动中断不再算故障

transcript 中 `stopReason: aborted` / `errorMessage: Operation aborted` 表示用户自己按了中断, 属于正常操作痕迹. 但原逻辑只要 `errorMessage` 非空就返回 failure, `evaluateHealth` 拿到 failure 即判 error, 结果永久显示错误并进入「需要处理」列表.

新增 `interrupted` 状态: 主动中断显示为「已中断」, 默认与空闲会话一起收起(`--all` 仍可查看), 不计入异常数.

### 历史遗留失败不再每天上报

健康状态由 transcript 最后一条 assistant 记录推导, 而 transcript 不会再变化, 因此一个多月前的一次失败会每天出现在「需要处理」里.

`TurnFailure` 新增 `detectedAt`, 取自 transcript 条目的 `timestamp`. 超过 24 小时的失败视为历史记录, 不再报异常;「需要处理」列表同时显示失败发生时间. 缺少可信时间戳时按未过期处理, 避免因解析不到时间而漏报真实故障.

### 上游合规拦截单独分类

新增 `policy_blocked` 分类, 识别 `Request blocked` / `are not allowed` / `violates` / `account suspension` 等文本, 显示为「请求被上游合规策略拦截」, 便于判断应该换模型或换账号, 而不是当成偶发故障反复重试.

## 验证

- 用本机 248 个真实会话运行修复后的 `evaluateHealth`: 错误从 4 降为 0, 其中 3 条转为已中断, 1 条转为空闲
- 全量测试 134 条, 131 通过 / 0 失败 / 3 跳过
- 新增用例覆盖: 主动中断不算故障、时间窗口生效与边界、缺少时间戳不漏报、合规拦截分类、`readLatestFailure` 带时间戳

## 安装

```bash
pi install npm:pi-wechat-session-hub@0.1.3
```

或跟随默认分支:

```bash
pi install git:github.com/yangfeng20/pi-wechat-session-hub
```

完整变更见 [CHANGELOG.md](https://github.com/yangfeng20/pi-wechat-session-hub/blob/main/CHANGELOG.md).
