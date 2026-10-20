# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，语义化版本。

## [0.3.0] - 2026-10-20

### 新增
- **官方 QQ 机器人（API v2）**：token 获取与提前刷新、网关握手（op10/op2/op6/op11）、被动回复（`msg_id`+`msg_seq`）、富媒体上传、错误码判定。
- **DSH 设置页插件**：侧栏「dsh bot」，选平台、填参数、白名单、数据目录、启停与状态；配置在 `<DSH_HOME>/dsh-bot/config.json`，密钥不回显。
- **长驻 SDK 执行器**（`dsh.runner=sdk`）：冷启动只付一次（实测 5.3s → 每回合 ~1.1–1.3s）。
- 官方机器人一律走沙箱环境（未上线机器人无法在正式网关建会话）。

### 修复
- 白名单为空时**拒绝启动**（核心库语义是"放行所有人"，插件层必须拦）。
- 首次运行 `dsh.cwd` 不存在导致 `spawn_error`（自动建目录，并区分 `cwd_missing`）。
- 群文件 `get_group_file_url` 缺 `group_id`（事件层补参）。
- 被动回复被拒（40034024）退化为主动消息。
- 提示词不再硬编码「NapCat / OneBot 11」。

## [0.2.0] - 2026-10-20

### 新增
- DSH 插件包形态（`dsh.bundle.patch` + `dsh.client`），可 `dsh plugin add`。
- 设置页 HTTP 接口：`/status`、`/config`、`/control`、`/platforms`、`/logs/tail`。

## [0.1.0] - 2026-10-20

### 新增
- OneBot 11（NapCat）适配器：文字/图片/文档/语音入站，附件落盘到可配置目录。
- 平台无关管线：白名单、限流、并发闸、会话续接、长回复分段。
- 命令行：`bin/bridge.mjs`（`--check` / `--dry-run`）。
