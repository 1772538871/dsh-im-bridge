# 配置参考

插件模式下配置在 **`<DSH_HOME>/dsh-bot/config.json`**（可用环境变量 `DSH_BOT_CONFIG` 覆盖），设置页写的就是这个文件；命令行模式用 `bridge.config.json`。两者字段一致。

> **90% 的人只需要改前 5 项**：平台、谁能用、数据目录、AppID+AppSecret（或 NapCat 地址）、DSH 入口路径。
> 设置页把它们放在「常用设置」里直接展开，其余全部收进「高级设置（一般不用改）」——下表的顺序和页面一致。

---

## 常用设置（默认展开）

| 键 | 一句人话 | 默认 |
| --- | --- | --- |
| `platform` | 用哪种方式连 QQ：`qq-official`=官方机器人（不用挂客户端）/ `qq-napcat`=接自己电脑上的 NapCat / `wechat` 未实现 | `qq-napcat` |
| `enabled` | 开机自动启动：勾上以后 DSH 一起来，机器人也跟着起来 | `false` |
| `security.userWhitelist` | **谁能用**：填你自己的 QQ 号，一行一个。留空不让启动（故意的，等于不设门禁） | `[]` |
| `storage.rootDir` | **机器人存东西的文件夹**：别人发的图片/文档/语音、日志、会话映射都在这。必须绝对路径，别选 C 盘 | `E:\dsh-im-bridge-data` |
| `testTarget` | **测试消息发给谁**：点「发送测试消息」时发到这个号；留空=按平台从白名单里自动挑一个 | `""` |
| `dsh.binPath` | **DSH 主程序在哪**：一般不用填（会自动找）；日志里出现 `spawn_error` 时再手填 | `""` |
| `dsh.profile` | 用哪套 DSH 设置，默认就好 | `im-bridge` |
| `qqOfficial.appId` | 机器人 AppID，QQ 开放平台后台能抄到 | `""` |
| `qqOfficial.appSecret` | 机器人 AppSecret。只存你这台电脑上，接口返回时掩码 `***` | `""` |
| `qqNapcat.wsUrl` | NapCat 的地址（NapCat 里开一个 WebSocket 服务端，端口对上就行） | `ws://127.0.0.1:3001` |
| `qqNapcat.accessToken` | NapCat 的口令；NapCat 里没设就留空 | `""` |

> 官方机器人拿不到 QQ 号，只有 `openid`（一串哈希）。白名单要填 **openid**；被拒时日志会打印 "发送者不在白名单，已忽略：userId=…"，把那串复制进去即可。

---

## 高级设置（折叠区，一般不用改）

### storage · 剩下的两项

| 键 | 一句人话 | 默认 |
| --- | --- | --- |
| `maxFileBytes` | 单个文件最大多少字节，超了不收，并把半截文件删掉 | `104857600`（100MB） |
| `retentionDays` | 附件留几天，过期自动清 `media/` 下的旧目录（日志和工作目录不动） | `30` |

### security · 剩下的几项

| 键 | 一句人话 | 默认 |
| --- | --- | --- |
| `groupWhitelist` | 哪些群可以用（一行一个群号）；留空=不按群管，仍受 userWhitelist 约束 | `[]` |
| `allowPrivate` / `allowGroup` | 私聊 / 群聊管不管 | `true` |
| `groupRequireAt` | 群里必须 @ 它才理，不然当没听见 | `true` |
| `rateLimitPerMinute` | 每人每分钟最多问几次，`0`=不限 | `6` |
| `maxConcurrentRuns` | 同时几个问题一起想（headless 方式每个约占 300MB 内存，调太大电脑会卡） | `2` |
| `maxPromptChars` | 一次最多看多少字，超了截断 | `8000` |

### reply · 回复长什么样

| 键 | 一句人话 | 默认 |
| --- | --- | --- |
| `maxChunkChars` | 一条回复最多多少字，超了拆成几条发 | `1500` |
| `errorPrefix` | 出错时的提示前面加什么标签 | `"[bridge] "` |
| `showSessionId` | 回复末尾带上内部编号（排查用） | `false` |

> 官方平台有硬限制：**一条消息最多回 4 次（私聊 60 分钟内）/ 5 次（群聊 5 分钟内）**。长答案建议把 `maxChunkChars` 调大，少分几条。

### asr · 语音转写（可以不管）

| 键 | 一句人话 | 默认 |
| --- | --- | --- |
| `command` | 外部转写命令（如 `whisper`）；空=只把语音文件路径给 DSH，它听不见内容 | `""` |
| `args` | 传给命令的参数，一行一个，支持 `{file}` 占位；没有占位符就把路径补在末尾 | `[]` |
| `timeoutMs` | 转写最多等多久 | `60000` |

### log · 出问题看这里

| 键 | 一句人话 | 默认 |
| --- | --- | --- |
| `dir` | 日志目录；空= `<storage.rootDir>/logs` | `""` |
| `level` | 记多细：`debug` 全记 / `info` 正常 / `warn` 只记问题 / `error` 只记错误 | `info` |

### dsh · 怎么调本机 DSH

| 键 | 一句人话 | 默认 |
| --- | --- | --- |
| `runner` | 干活方式：`inprocess` 最快且能在 QQ 里审批；`sdk` 稳（常驻子进程，冷启动只付一次）；`headless` 最保守（每条消息起新进程，约 5.3s） | `headless` |
| `nodePath` | 跑 DSH 的 node；空=当前进程 | `""` |
| `agentPreset` | 用哪个人格预设（决定说话风格和能用的工具）；空=不挂预设 | `""` |
| `cwd` | 它干活的文件夹（它能改的范围）；空= `<rootDir>/workspace` | `""` |
| `timeoutMs` | 一个问题最多等多久，超了就放弃 | `300000` |
| `permissionMode` | 传给子进程的 `DSH_PERMISSION_MODE`；**不允许 `danger-full-access`**（配置校验会直接拒） | `workspace-write` |
| `provider` / `model` / `reasoningEffort` | 只有 `sdk` / `inprocess` 用得上，握手时传给 DSH | `deepseek-official` / `deepseek-flash` / `high` |

### approval · 审批发到 QQ（只有 `inprocess` 用得上）

| 键 | 一句人话 | 默认 |
| --- | --- | --- |
| `enabled` | 把审批请求发到 QQ，等你回 1/2/0 | `true` |
| `timeoutMs` | 最多等你多久，超时按**拒绝**处理（下限 10000） | `300000` |
| `scope` | `own`=只问机器人自己的操作；`all`=你在网页里手动开的会话也发到 QQ（安全面更大） | `own` |
| `chatKey` | 网页会话的审批发到哪个 QQ 会话；空=最近说话的那个 | `""` |

回复支持 `1/确认/允许/同意/好的/可以` 放行、`2/拒绝/不行/不要` 拒绝、`0/取消`。只有"沙箱升权重试"会触发审批；在 `dsh.cwd` 内读写/跑命令**不会**弹。超时之所以按拒绝而不是取消：取消会让模型立刻重试同一个操作，变成死循环。

### qqNapcat / qqOfficial · 平台专属的剩下几项

| 键 | 一句人话 | 默认 |
| --- | --- | --- |
| `qqNapcat.reconnectMinMs` / `reconnectMaxMs` | 掉线后多久开始重连、最长等多久（毫秒） | `1000` / `30000` |
| `qqOfficial.sandbox` | 走沙箱环境；官方还没给沙箱域名，勾不勾都连正式环境 | `true` |

---

## 密钥怎么处理

- 只存在配置文件里，**不写进 profile 的 patch**、不进日志、不进 git（`.gitignore` 已挡 `bridge.config.json`）；
- 设置页读到的是 `***`；提交时把 `***` 原样回传表示"不修改"，传空字符串表示"清空"。

## 改完怎么确认

设置页 → **保存** → **启动** → 点 **「发送测试消息」**：

- 成功：页面显示「已发送给 <号>」，QQ 里收到一条「【测试】dsh bot 已连通…」；
- 失败：页面直接给原因（没启动 / 不知道该发给谁 / 发不出去），照着改对应那一项即可。
