# 安全说明（请先读这一页）

dsh-im-bridge 的本质是：**任何能给它发消息的人，都能让这台电脑上的 DSH 干活**。DSH 有文件读写、跑命令的能力。所以这不是一个普通聊天机器人，而是一个远程执行入口。

## 默认防线

1. **白名单**：`security.userWhitelist` / `security.groupWhitelist` 为空时**不会**放行任何人；非白名单消息只记 debug 日志、不回任何内容（不回"你不在白名单"以免被探测）。
2. **群聊必须 @**：`groupRequireAt=true` 时只处理 `at` 到机器人的消息，避免被群聊噪声淹没，也降低误触发的概率。
3. **限流**：`rateLimitPerMinute` 按用户滑动窗口计数；超限丢弃并记日志。
4. **并发闸**：`maxConcurrentRuns` 默认 2（单次 DSH 调用约 330MB），既是资源保护也是 DoS 缓解。
5. **沙箱**：DSH 子进程以 `dsh.permissionMode`（默认 `workspace-write`）运行，只能改 `dsh.cwd` 指定的工作目录。headless 模式下**没有审批应答器**，需要审批的操作会被直接判定不可用/拒绝，不会挂起等待。
6. **不把内部信息发给用户**：错误回复只带简短原因，不发送 stack、路径列表、session id（除非 `reply.showSessionId` 打开）。

## 你必须自己做的

- 机器人用**小号**，不要用主号；NapCat 的登录态就是账号本身。
- OneBot WS 只监听 `127.0.0.1`，**不要**开 `0.0.0.0` + 端口映射到公网。要远程用就上 VPN/内网穿透 + 强 token。
- `accessToken` 不要提交进 git；`bridge.config.json` 已在 `.gitignore` 里，仓库只提交 `bridge.config.example.json`。
- 不要为了让 DSH「能干更多事」就随手把 `dsh.permissionMode` 调成 `danger-full-access`：那等于把整台机器交给白名单里的每个账号，一句 prompt 注入就能删文件。

## 数据与隐私

- 所有附件、日志、会话映射都在 `storage.rootDir` 下（默认 `E:\dsh-im-bridge-data`）。落在 `C:\` 时 `--check` 会告警。
- 日志会记录 QQ 号、消息摘要与文件路径——按隐私敏感数据对待，`retentionDays` 到期清理，或定期手动删 `logs/`。
- 群里别人的图片/文件会被下载到你的盘上，注意磁盘与合规。

## 漏洞怎么报

开 issue 或私下联系仓库所有者，不要先公开 PoC。
