# 配置参考

插件模式下配置在 **`<DSH_HOME>/dsh-bot/config.json`**（可用环境变量 `DSH_BOT_CONFIG` 覆盖），设置页写的就是这个文件；命令行模式用 `bridge.config.json`。两者字段一致。

## 顶层

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `enabled` | DSH 启动时是否自动拉起 bot | `false` |
| `platform` | `qq-napcat` / `qq-official` / `wechat`（未实现） | `qq-napcat` |

## storage（数据放哪）

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `rootDir` | **必填**，绝对路径。附件、日志、会话映射都在这里。落 C 盘会告警 | — |
| `maxFileBytes` | 单文件上限，超了不收 | `104857600`（100MB） |
| `retentionDays` | 附件保留天数，到期清 `media/` 下的旧目录 | `30` |

## security（谁能用、用多快）

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `userWhitelist` | 允许的发送者。**留空 = 拒绝启动**（核心库对空名单的语义是"放行所有人"） | `[]` |
| `groupWhitelist` | 允许的群；留空 = 不按群管（仍受 userWhitelist 约束） | `[]` |
| `allowPrivate` / `allowGroup` | 私聊 / 群聊是否处理 | `true` |
| `groupRequireAt` | 群里必须 @ 机器人才理 | `true` |
| `rateLimitPerMinute` | 每人每分钟上限，0 = 不限 | `6` |
| `maxConcurrentRuns` | 同时处理的消息数（每条约 300MB 内存，headless 模式） | `2` |
| `maxPromptChars` | 单条 prompt 字符上限 | `8000` |

> 官方机器人拿不到 QQ 号，只有 `openid`（一串哈希）。白名单要填 **openid**；被拒时日志会打印 "发送者不在白名单，已忽略：userId=…"，把那串复制进去即可。

## reply（回复形态）

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `maxChunkChars` | 单条回复最大字符数，超了分段发 | `1500` |
| `errorPrefix` | 错误回复前缀 | `"[bridge] "` |
| `showSessionId` | 回复里附带会话 id（排查用） | `false` |

> 官方平台有硬限制：**一条消息最多回 4 次（私聊 60 分钟内）/ 5 次（群聊 5 分钟内）**。长答案建议把 `maxChunkChars` 调大，少分几条。

## asr（语音转写，可选）

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `command` | 外部转写命令（如 `whisper`）；空 = 只把语音文件路径给 DSH | `""` |
| `args` | 传给命令的参数，支持 `{file}` 占位；没有占位符则把路径补在末尾 | `[]` |
| `timeoutMs` | 转写超时 | `60000` |

## log

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `dir` | 日志目录；空 = `<storage.rootDir>/logs` | `""` |
| `level` | `debug` / `info` / `warn` / `error` | `info` |

## dsh（怎么调本机 DSH）

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `runner` | `headless`（每条消息起新进程，最稳）/ `sdk`（常驻子进程，冷启动只付一次）/ `inprocess`（进程内，支持 QQ 审批，依赖 DSH 内部 API） | `headless` |
| `nodePath` | 跑 DSH 的 node；空 = 当前进程 | `""` |
| `binPath` | DSH 入口 `lib/bin.js` 的绝对路径 | `""` |
| `agentPreset` | 用哪个 Agent 预设（决定人格与工具集）；空 = 不挂预设 | `""` |
| `profile` | 用哪个 DSH profile（`sdk` 执行器必须指向 sdk profile） | `im-bridge` |
| `cwd` | DSH 的工作目录（它能改的范围）；空 = `<rootDir>/workspace` | `""` |
| `timeoutMs` | 单轮超时 | `300000` |
| `permissionMode` | 传给子进程的 `DSH_PERMISSION_MODE`；**不允许 `danger-full-access`**（配置校验会拒） | `workspace-write` |
| `provider` / `model` / `reasoningEffort` | 仅 `sdk` / `inprocess` 用，传给 `initialize` | `deepseek-official` / `deepseek-flash` / `high` |

## approval（QQ 审批，仅 \`inprocess\` 执行器）

| 键 | 说明 | 默认 |
| --- | --- | --- |
| \`enabled\` | 把审批请求转发到 QQ，等你回 1/2/0 | \`true\` |
| \`timeoutMs\` | 多久没回就按**拒绝**处理（下限 10000） | \`300000\` |

只有"沙箱升权重试"会触发审批；在 \`dsh.cwd\` 内读写/跑命令**不会**弹。\`dsh.permissionMode=danger-full-access\` 时策略变 never，整条链路静默失效。

## qqNapcat

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `wsUrl` | NapCat 正向 WebSocket 地址 | `ws://127.0.0.1:3001` |
| `accessToken` | 与 NapCat 里一致；拼在 URL 的 `?access_token=` 上 | `""` |
| `reconnectMinMs` / `reconnectMaxMs` | 断线重连退避区间 | `1000` / `30000` |

## qqOfficial

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `appId` | 机器人 AppID | `""` |
| `appSecret` | 机器人密钥（只存本机；接口返回时掩码 `***`） | `""` |
| `sandbox` | 走沙箱环境（未上线机器人必须开） | `true` |

## 密钥怎么处理

- 只存在配置文件里，**不写进 profile 的 patch**、不进日志、不进 git（`.gitignore` 已挡 `bridge.config.json`）；
- 设置页读到的是 `***`；提交时把 `***` 原样回传表示"不修改"，传空字符串表示"清空"。
