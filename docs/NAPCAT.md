# 接入 NapCat（QQ 侧）

dsh-im-bridge 不实现 QQ 协议，它说 OneBot 11。QQ 这一侧由 NapCat 提供。

## 1. 安装

1. 装官方 **QQNT** 客户端并登录你的机器人账号（建议用小号，不要用主号）。
2. 装 [NapCat](https://github.com/NapNeko/NapCatQQ)：目前常用形态是 NapCat 的 **Shell 启动器**或 **Framework 注入**，按它 README 的 Windows 一段走。
3. 启动 NapCat，用手机 QQ 扫码登录。

> Windows 上 NapCat 通常需要一个可写的 `config` 目录；默认放在它自己的安装目录即可，**不要指向本项目的 `storage.rootDir`**，两者互不干扰。

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
