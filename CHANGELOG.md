# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，语义化版本。

## [0.4.1] - 2026-10-20

### 修复
- **进程内会话不进工作区**：GUI 的工作区是显式成员表，插件自建的会话不在表里 → 永远“未分组”。现在建会话后用 `workspaceRegistry.resolveByPath(cwd)` + `attachSession` 自动登记。
- **第二条回复被平台静默丢弃**（`err_code 40054005 消息被去重`）：同一 `msg_id` 下 `msg_seq` 每次从 1 开始。现在按 `msg_id` 递增，被拒时自动改发主动消息。
- **回合以 `blocked` 结束，且没有错误文案**：归档会话会被 `ArchivedSessionGate` 的 pre-step 门禁直接 reject（GUI 里“删除”= 归档）。现在开跑前自动 `unarchiveSession`，恢复不了就换新会话 id（历史保留）。
- **审批回复只认 1/2/0**：现在也认 `确认 / 好的 / 可以 / 允许 / 同意`、`不行 / 不要 / 拒绝`、`取消`。

## [0.4.0] - 2026-10-20

### 新增
- **进程内执行器（\`dsh.runner=inprocess\`）+ QQ 审批桥**：在 DSH 主进程内建 Agent，把「沙箱升权重试」的审批请求转发到 QQ，按回复放行（\`1\`）/ 拒绝（\`2\`）/ 取消（\`0\`），超时按拒绝处理。
- 审批应答方以 \`prepend\` 注册，抢在浏览器 GUI 之前；只认领本插件创建的 Agent。

### 变更
- 文档重构：README 改为落地页（架构图 + 能/不能 + 两条安装路径 + 文档索引），细节拆到 \`docs/install.md\`、\`docs/config.md\`、\`docs/troubleshooting.md\`；内部设计契约移入 \`docs/internal/\`。

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
