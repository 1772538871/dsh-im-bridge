# dsh-im-bridge

把 QQ 消息（文字 / 图片 / 文档 / 语音）转发给**本机**的 [DSH](https://github.com/deepseek-ai/deepseek-harness) 处理，再把 DSH 的回答发回 QQ。

它不是云服务，是把这台电脑当一台简易服务器：QQ ↔ NapCat ↔ 本仓库的桥接进程 ↔ `dsh --profile <profile>` 子进程。

```
QQ 客户端 ── QQNT 协议 ──> NapCat ──OneBot 11 (WebSocket)──> dsh-im-bridge ──stdin/stdout(NDJSON)──> dsh 子进程
   ^                                                                                                    │
   └──────────────────────── 回复文本 ◄─────────────────────────────────────────────────────────────────┘
```

## 特性

- **零运行时依赖**：纯 Node ESM，只用 Node 内置 `WebSocket`/`fetch`/`child_process`，`git clone` 后直接 `node bin/bridge.mjs`。
- **四类消息**：文字直接进 prompt；图片/文档/语音落盘后把**绝对路径**告诉 DSH，DSH 自己决定怎么读。
- **多轮对话**：每个 QQ 会话绑定一个 DSH `--session-id`，追问有上下文。
- **数据目录随便放**：所有附件、日志、会话映射都在配置的 `storage.rootDir` 下，默认 `E:\dsh-im-bridge-data`；写在 `C:\` 会主动告警。
- **白名单 + 并发闸**：不是谁发消息都能驱动这台电脑，见 [docs/SECURITY.md](docs/SECURITY.md)。

## 前置条件

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 20 | 用到内置全局 `WebSocket` |
| DSH | `@deepseek-ai/dsh`，并且有一个**能用模型**的 profile（见下） |
| NapCat | QQNT 外壳，提供 OneBot 11 接口，见 [docs/NAPCAT.md](docs/NAPCAT.md) |

### 准备一个能跑的 DSH profile

原生 `headless` profile 禁用了 `credentials`，无人值守调用会直接 `MISSING_CREDENTIAL`。基于 headless 复制一个并只把 credentials 打开：

```powershell
dsh --profile im-bridge --from-default-profile headless --dump-config | Out-Null
# 编辑 %DSH_HOME%\profiles\im-bridge\cordis.patch.yml，写入：
# - id: credentials
#   disabled: false
```

验证（约 5–6 秒出结果）：

```powershell
'回复 OK' | dsh --profile im-bridge --json -
# 末行应为 {"type":"final","text":"OK"}
```

## 快速开始

```powershell
git clone git@github.com:1772538871/dsh-im-bridge.git
cd dsh-im-bridge
Copy-Item bridge.config.example.json bridge.config.json
```

然后至少改这四项。注意：`bridge.config.example.json` 带 `//` 注释（本项目的加载器认 JSONC），**不要拿别的工具直接 `JSON.parse` 它**，复制成 `bridge.config.json` 后同样带注释也能跑。

| 键 | 怎么填 |
| --- | --- |
| `storage.rootDir` | **必填**，任意绝对路径，例如 `E:\dsh-im-bridge-data`；写在 C 盘会告警 |
| `dsh.binPath` | **必填**，DSH 入口 js。本机示例：`E:\Local\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`。不知道在哪就跑 `(Get-Command dsh).Source` 反查，或干脆设环境变量 `DSH_BIN` |
| `dsh.profile` | 上面建的 `im-bridge` |
| `security.userWhitelist` | 你自己的 QQ 号；**留空 = 谁都不放行**（这是故意的安全默认） |

```powershell
node bin/bridge.mjs --check --config bridge.config.json   # 校验 + 打印生效摘要；配置不合格 exit 1
node bin/bridge.mjs --config bridge.config.json           # 正式跑（连 OneBot WS）
```

> `dsh.binPath` 为空时 `--check` 会以「dsh.binPath 为空」退出 1 —— 这是预期行为，不是 bug。

自测一条链路但不碰 QQ：

```powershell
node bin/bridge.mjs --dry-run "用一句话自我介绍" --config bridge.config.json
```

## 配置参考

见 [`bridge.config.example.json`](bridge.config.example.json)。关键项：

| 键 | 作用 |
| --- | --- |
| `onebot.wsUrl` | NapCat 的正向 WebSocket 地址，默认 `ws://127.0.0.1:3001` |
| `onebot.accessToken` | 与 NapCat 里配的 token 一致；拼在 URL 的 `?access_token=` 上 |
| `dsh.binPath` / `dsh.profile` / `dsh.cwd` | 子进程命令；`cwd` **必须固定**（session 续接按 cwd 校验） |
| `dsh.timeoutMs` | 单次调用超时，默认 300 秒 |
| `dsh.permissionMode` | 传给子进程的 `DSH_PERMISSION_MODE`，默认 `workspace-write` |
| `storage.rootDir` | **所有落盘数据的根**，改这里就能换盘 |
| `security.userWhitelist` / `groupWhitelist` | 谁可以驱动这台电脑 |
| `security.groupRequireAt` | 群里必须 @ 机器人才响应 |
| `security.rateLimitPerMinute` / `maxConcurrentRuns` | 每用户限流 / 全局并发（每次调用约 330MB） |
| `reply.maxChunkChars` | 长回答按段拆条发送 |
| `asr.command` | 语音转写钩子（默认空 = 不转写，只把文件路径给 DSH） |

## 数据目录

```
<storage.rootDir>/media/<YYYY-MM-DD>/<private_123|group_456>/<ts>-<kind>-<name>.<ext>
<storage.rootDir>/workspace/         dsh.cwd 的默认值
<storage.rootDir>/sessions.json      每个 QQ 会话 ↔ DSH session 的映射
<storage.rootDir>/logs/bridge-*.log
```

`storage.retentionDays` 到期会清理 `media/` 下的旧目录，`workspace/` 与日志不删。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `MISSING_CREDENTIAL` | profile 没开 `credentials`，见上文；或给子进程设 `DEEPSEEK_API_KEY` |
| `session "..." does not exist` | `dsh.cwd` 或 `dsh.profile` 变了；续接要求两者一致，改回或删 `sessions.json` 对应键 |
| 子进程输出空、像卡住 | 用 `--json` 并检查末行是否有 `final`；没有 `error` 事件却没 `final` 多为超时被杀 |
| `spawn EPERM` / `ripgrep launch failed` | DSH 被跑在受限父进程里，子进程继承受限令牌。用普通终端启动桥接进程 |
| NapCat 连不上 | 确认 NapCat 开了**正向** WebSocket、端口一致、token 一致 |

## 许可

MIT，见 [LICENSE](LICENSE)。
