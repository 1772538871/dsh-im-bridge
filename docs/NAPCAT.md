# 接入 NapCat（QQ 侧）

dsh-im-bridge 不实现 QQ 协议，它说 OneBot 11。QQ 这一侧由 NapCat 提供。

## 1. 安装

1. 装官方 **QQNT** 客户端并登录你的机器人账号（建议用小号，不要用主号）。
2. 装 [NapCat](https://github.com/NapNeko/NapCatQQ)：目前常用形态是 NapCat 的 **Shell 启动器**或 **Framework 注入**，按它 README 的 Windows 一段走。
3. 启动 NapCat，用手机 QQ 扫码登录。

> Windows 上 NapCat 通常需要一个可写的 `config` 目录；默认放在它自己的安装目录即可，**不要指向本项目的 `storage.rootDir`**，两者互不干扰。

### 1.1 一键启动：让插件自己拉起 NapCat（顺带把登录二维码显示在设置页）

设置页 → **消息接入** → 平台「QQ 个人账号」，这两项都在首屏：

| 字段 | 填什么 |
| --- | --- |
| `qqNapcat.homeDir` | NapCat 的**安装目录**（例如 `D:\NapCat`），必须是绝对路径且真实存在 |
| `qqNapcat.port` | NapCat 的 WebSocket 端口，默认 `3001`，要和 `qqNapcat.wsUrl` 一致 |

填好后回到「正在接入」那张卡片，点 **一键启动**：插件会在安装目录里按顺序找
`launcher-win10.bat` → `launcher.bat` → `napcat.bat` → `NapCatWinBootMain.exe` → `napcat.mjs`，
命中哪个就用哪个（`.bat` 走 `cmd /c`，`.mjs` 用宿主自己的 node），以 `detached` 方式拉起，不占用宿主。

NapCat 会把登录二维码写到 `<安装目录>\napcat\cache\qrcode.png`（老版本是 `<安装目录>\cache\qrcode.png`）。
卡片每 3 秒读一次这张图并显示在方块里——**用手机 QQ 扫它就行**，不用再去 NapCat 面板里找。

- 二维码约 2 分钟过期，过期点「刷新二维码」；
- 扫完并且这张图 60 秒没再更新，卡片会变成绿色 `✅ 已扫码登录`；
- 然后填 `qqNapcat.accessToken`，点「检测连接」。

> 「已登录」是**弱信号**（端口通 + 二维码文件 60 秒没更新）。真机没法验证的只有这一条判断，
> 其余分支都有测试覆盖；拿不到就显示"—"，不会编一个"已登录"。

## 2. 打开 OneBot 11 正向 WebSocket

NapCat 配置里找 **网络配置 → OneBot 11 → WebSocket 服务器**（正向 WS），填：

| 项 | 值 |
| --- | --- |
| 启用 | 开 |
| 主机 | `127.0.0.1`（只给本机用，别开 `0.0.0.0`） |
| 端口 | `3001`（与 `onebot.wsUrl` 一致） |
| Token | 自己编一串，填到 `onebot.accessToken` |

保存后 NapCat 会重启该服务，日志里应出现 `WebSocket server listening on 3001`。

## 3. 让机器人收得到消息

- **私聊**：直接把机器人加好友即可；`security.allowPrivate` 要为 `true`。
- **群聊**：把机器人拉进群；`security.allowGroup` 为 `true`，`security.groupRequireAt` 为 `true` 时需要在群里 **@机器人**。

## 4. 各类消息在 NapCat 侧的注意点

| 类型 | 注意 |
| --- | --- |
| 文字 | 直接可用 |
| 图片 | 段里带 `url`，桥接直接下载；没有 `url` 时走 `get_image` |
| 文档（群文件） | 需要 `get_group_file_url`；**群文件需要机器人在群里有权限**，个别客户端版本拿不到直链，会在日志里留 `media_unavailable` |
| 语音 | 段里是 AMR/SILK。桥接只负责**落盘 + 把路径告诉 DSH**；要真正听懂，需自己配 `asr.command`（例如 `whisper-cli`），ffmpeg 已装的话可先转 wav |

## 5. 验证连通

1. 先起桥接：`node bin/bridge.mjs --config bridge.config.json`
2. 日志里应出现 `onebot connected`。
3. 用白名单里的号给机器人发一句「你好」，日志出现 `run start` 与 `run done`。

## 6. 常见坑

- **端口连不上**：NapCat 的「HTTP 服务器」和「WebSocket 服务器」是两个开关，别开错。
- **401/连上就断**：token 不一致；注意桥接是把 token 拼在 URL 上（`?access_token=`）。
- **收不到群消息**：QQ 侧开了「接收群消息但需要 @」之类的客户端设置，或者 `groupRequireAt` 与发送方式不匹配。
- **被风控**：机器人号频繁群发、加太多好友会触发风控，这是账号风险不是本项目风险。


## 7. 用 SnowLuma 代替 NapCat（个人号方案）

SnowLuma 和 NapCat 是同一层东西——**跑在本机的 QQ 互操作运行时**，把 QQ 翻译成 OneBot v11。选一个装就行，**别同时跑**（会重复收消息、重复回复）。

| | NapCat | SnowLuma |
| --- | --- | --- |
| 形态 | 注入 NTQQ | 注入 NTQQ |
| 输出 | OneBot 11（HTTP + 正向/反向 WS） | OneBot 11（HTTP `3000` + 正向 WS `3001`） |
| 安装 | 安装器 + 配置面板 | 下载 zip 解压 + `launcher.bat` |
| 前置 | 官方 QQNT 已登录 | 官方 QQNT 已登录；**路径不能有中文和空格** |

### 7.1 步骤

1. 装官方 **NTQQ** 客户端（不是旧版 QQ、不是 TIM），登录一次你那**小号**。
2. 去 [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases) 下 `SnowLuma-v<版本>-win-x64.zip`（**完整版内置 node**；带 `-lite` 的要 Node ^24.22.1）。
3. 解压到**无中文、无空格**的目录，双击 `launcher.bat` 启动。
4. 首次启动后用手机 QQ 扫码登录那个小号。
5. 在 SnowLuma 里开 OneBot v11：
   | 项 | 值 |
   | --- | --- |
   | HTTP | `127.0.0.1:3000` |
   | 正向 WS | `127.0.0.1:3001` |
   | accessToken | 自己编一串，待会填到插件里 |
6. 回到 **DSH → 设置 → 消息接入**：平台选「**QQ 个人账号**」，`WebSocket 地址` 填 `ws://127.0.0.1:3001`，`accessToken` 填同一串，保存 → 启动。
7. 用白名单里的号给小号发一句「你好」；群聊里 @ 一下小号（默认 `groupRequireAt: true`）。

### 7.2 风险（必须知道）

SnowLuma 与 NapCat 都是**注入式协议端**，违反 QQ 用户协议，**存在封号风险**。

- **只用小号**，别用主号；
- 别做群发、别频繁加好友、别在深夜持续说话；
- 想要零风险就回官方机器人（`platform = qq-official`）。

## 8. 排障表（症状 → 原因 → 处理）

| 症状 | 最可能的原因 | 怎么处理 |
| --- | --- | --- |
| 插件启动后立刻报连接失败 | OneBot 服务没开 / 端口不对 | 看 NapCat 或 SnowLuma 日志里有没有 `listening on 3001`；端口填错最常见 |
| 连上就断、或 401 | accessToken 不一致 | 两边必须逐字相同；注意桥接是把 token 拼在 URL 上（`?access_token=`） |
| 只能看到心跳、收不到消息 | 只开了 HTTP，没开**正向 WS** 事件推送 | 把 WS 打开，并确认端口和插件里一致 |
| 报 426 Upgrade Required | 把 WS 端口填成了 `http://` | 插件里 `wsUrl` 必须是 `ws://127.0.0.1:3001` |
| 私聊不回 | `security.allowPrivate` 关了，或**白名单空**（空 = 拒绝启动/拒绝服务） | 设置页确认开关与白名单；日志里会有 `denied` 与 openid |
| 群聊不回 | 没 @ 机器人（`groupRequireAt: true`），或 `allowGroup` 关了 | 在群里 @ 一次；或把 `groupRequireAt` 关掉 |
| 每条消息回两次 | 同时跑了两套（插件 + qq-bridge，或两个 SnowLuma 实例） | 只留一套；插件日志里会出现重复的 `run start` |
| 文件/图片发不出去 | QQ 官方侧要用 `file_info` 上传后发送；OneBot 侧看上传接口权限 | 先看 `logs\bridge-YYYY-MM-DD.log` 里的错误码；QQ 官方侧字段可能要按平台文档微调 |
| 重启电脑后机器人不响 | 协议端没自启，或登录态失效 | 让 NapCat/SnowLuma 开机自启，并重新扫码登录 |
| 语音消息听不懂 | `asr.command` 没配（默认只落盘给路径） | 装 whisper.cpp，把 `asr.command` 指向 `whisper-cli` |
| 想看插件到底在干什么 | — | 日志在 `<storage.rootDir>\logs\bridge-YYYY-MM-DD.log`；QQ 里发 `/status` |

## 9. 两条路怎么选

| 你想要的 | 选哪条 |
| --- | --- |
| 合规、长期跑、给别人用 | **官方机器人**（`qq-official`）：不会封，但只能进允许的群、不能冒充你 |
| 像真人一样在小号上聊、进任意群 | **个人号 + SnowLuma/NapCat**：能力全，但**有封号风险**，只适合小号 |
