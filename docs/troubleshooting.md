# 排错

## 先看日志

```
<storage.rootDir>\logs\bridge-YYYY-MM-DD.log
```

JSON 一行一条，`msg` 是人话。也可以 `GET /dsh-bot/api/logs/tail?lines=200`（设置页同源）。

## 一条命令先体检

```powershell
node scripts/selfcheck.mjs
```

验：插件清单、设置页 bundle 形状、配置合法性、DSH 版本是否在兼容表里。FAIL 会非零退出。

## 症状 → 原因

| 症状 | 最可能的原因 | 怎么办 |
| --- | --- | --- |
| 设置侧栏没有「dsh bot」 | 没重启 / bundles 没写进去 / 浏览器缓存 | 重启 `dsh web` → Ctrl+F5；查 `profiles/web/package.json` 的 `dsh.profile.bundles` |
| 点启动被拒："白名单为空" | 安全默认 | 填你自己的号（官方平台填 **openid**） |
| 状态「运行中」但发消息没反应 | 不在白名单 / 群里没 @ / 平台权限没开 | 日志里搜 `发送者不在白名单`、`need_at`；官方平台看下面错误码 |
| 日志 `close 4903 create session error` | 未上线机器人在**正式**网关建会话 | 打开 `qqOfficial.sandbox`（走沙箱域） |
| 日志 `获取 WSS 接入点失败 … code 11001` | token 接口被指向了沙箱域 | 已修（token 固定走正式域）；确认版本 ≥ 0.3.0 |
| 日志 `40034024 msg_id 无效或越权` | 被动回复的 msg_id 随会话失效 | 已内置兜底：自动改发主动消息；若仍失败看 `failed` 计数 |
| 日志 `4013 / 4014` | 事件权限没开通 | 开放平台申请 `GROUP_AND_C2C_EVENT`（intents `33554432`） |
| 日志 `4914` | 环境域名不匹配（沙箱 vs 正式） | 确认机器人状态与 `sandbox` 开关一致 |
| 日志 `spawn_error` | 找不到 DSH 或起不来 | 查 `dsh.binPath`；确认 `node -v` ≥ 20 |
| 日志 `cwd_missing` | 工作目录建不出来（父路径是文件等） | 换一个可写目录作为 `dsh.cwd` |
| 日志 `MISSING_CREDENTIAL` | 用的 profile 没有凭据 | 命令行模式按 [install.md](install.md#1-准备一个能跑模型的-dsh-profile) 打开 credentials |
| 回了半句就没了 | 官方平台 4/5 次被动回复上限 | 把 `reply.maxChunkChars` 调大（如 3000），少分段 |
| 回复很慢（每句 5 秒多） | 用的是 `headless`（每条消息冷启动） | `dsh.runner` 改 `sdk`（常驻子进程，实测每回合 ~1.2s） |
| 改完配置不生效 | 执行器仍持有旧状态 | 点「重启」，或重启 `dsh web` |

## 官方平台三个容易误解的点

1. **拿不到 QQ 号**：事件里只有 `openid`，白名单必须填 openid；
2. **必须在沙箱**：未认证主体在正式网关建不了会话；
3. **必须走「开发体验用户」**：没加进去的号发消息，平台根本不下发事件（日志里连一行都不会有）。

## 需要更多信息时

把这三样贴进 issue：`node scripts/selfcheck.mjs` 输出、日志末尾 30 行、DSH 版本。
