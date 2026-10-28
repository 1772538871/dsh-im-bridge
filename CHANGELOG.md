# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，语义化版本。

## [0.9.5] - 2026-10-23

### 新增（个人号：一键启动 + 扫码登录）
- **一键启动 NapCat**：高级设置里填一次「NapCat 装在哪个目录」，之后在卡片上点「一键启动」即可拉起（自动识别
  `launcher-win10.bat` / `launcher.bat` / `napcat.bat` / `NapCatWinBootMain.exe` / `napcat.mjs`，detached 启动、不占终端、重复点不会开第二个）。
- **自动出码**：每 3 秒读 `<NapCat目录>/napcat/cache/qrcode.png`（回退 `<目录>/cache/qrcode.png`），把登录二维码直接画在原占位方块里，带刷新按钮。
- **检测登录**：探测 `127.0.0.1:3001` + 二维码文件 60 秒未更新 → 状态变绿「已扫码登录」，并提示下一步填访问令牌。
- 新增 4 条路由：`POST /napcat/start`、`GET /napcat/status`、`GET /napcat/qr`、`POST /napcat/stop`（全部恒 200，未配置时给人话）。
- 不再把 GitHub 下载页当二维码；它只在"扫不了码"时作为备选按钮出现。

### 说明
- `loggedIn` 是弱信号（端口 + 二维码静默），NapCat 登录后若删除图片会显示 `null` —— 宁可停在"等待扫码"，也不误报已登录。
- `POST /napcat/stop` 只结束由本插件启动的进程，不会碰你自己开的 NapCat。

## [0.9.4] - 2026-10-23

### 变更
- 平台图标改成 **app 图标样式**：品牌色圆角方块 + 白色字形（QQ 蓝 `#12B7F5` / 微信绿 `#07C160` / 官方机器人蓝 `#3B82F6`）。
  QQ 与微信的字形路径取自 Simple Icons（CC0），比手绘描边更像真图标；已在 `THIRD_PARTY_NOTICES.md` 记录来源与许可。
- 平台卡片名称保持 **`QQ 个人账号`**（不再带 `（NapCat / OneBot 11）` 后缀，窄栏里也不会被截断成省略号）。

## [0.9.3] - 2026-10-23

### 变更
- **平台图标换成内联 SVG**（企鹅 / 机器人 / 双气泡），跟着主题色走（`currentColor`），不再依赖系统 emoji 字体：
  部分 Windows 上 emoji 渲染成黑白方块或大小不一，换成矢量后在任何主题下都清晰一致。
- 图标用元素树渲染（不是 `dangerouslySetInnerHTML`），与二维码注入路径隔离，测试断言按 token（`qq` / `robot` / `chat`）。

## [0.9.2] - 2026-10-23

### 修复
- **个人号向导的二维码/按钮扫了打不开**：原先编码的是 `http://127.0.0.1:6099`（NapCat 面板）—— 手机上 `127.0.0.1` 指的是手机自己，电脑上点它又要求 NapCat 已经装好在跑。
  现在二维码与「打开 NapCat 下载页」按钮都指向 `https://github.com/NapNeko/NapCatQQ/releases`（手机可扫），面板地址只作为文字提示。
- 向导文案改为「小号 QQ 扫码登录，托管给 DSH」：① 下载并启动 NapCat / SnowLuma ② 在它的面板里用手机扫码登录小号 ③ 回来填地址（默认 3001）与口令 → 检测连接。
- 平台卡片名称统一为 **QQ 个人账号**（小号托管），官方机器人卡片保持原样（需要 AppID / AppSecret）。

## [0.9.1] - 2026-10-23

### 变更
- 平台名 `QQ（NapCat / OneBot 11）` → **`QQ 个人账号`**，图标换成 QQ 企鹅（🐧）；卡片名不再换行（超出显示省略号）。
- 文档里的旧叫法同步（`docs/manual.zh.md`、`docs/NAPCAT.md`）。

## [0.9.0] - 2026-10-23

### 新增（P9 拟人层）
- **发图 / 发语音**：新增 `[[sendimage: 绝对路径]]` 与 `[[sendvoice: 绝对路径]]` 标记（与 `[[sendfile:]]` 同一套规则：单独一行、每类最多 3 个、失败只追加说明）。
  OneBot 侧走 `image` / `record` 段；QQ 官方侧语音**平台不支持**，自动降级为"按文件发送 + 一行说明"，不抛不改正文。
- **打字延迟**：`reply.sendDelayMs`（每字毫秒）+ `reply.sendDelayMaxMs`（上限，默认 3000），带 ±20% 抖动；回执与进度不受影响。
- **回复总长上限**：`reply.maxReplyChars`（默认 0=不限），超出截断并附 `……（太长截断了，总共 N 字）`；先截断再分段。
- **群里必答词**：`social.mustReplyKeywords`，命中即回复，优先级高于 `security.groupRequireAt`（群里免 @）。
- **概率接话**：`social.replyProbability`（0~1），未 @ 也未命中关键词时按概率接一句。**不含任何定时器**（定时主动搭话留给后续硬闸版本）。
- 配置面：六个新字段全部在设置页「高级设置」里，人话描述；文档补「让它发图/发语音」「群里怎么触发它」两节。

## [0.8.0] - 2026-10-23

### 新增
- **接入向导里的真二维码**：宿主侧新增 `lib/qr.js`（零依赖，字节模式 + 纠错 M + 版本 1–10），
  `GET /platforms` 响应新增 `wizardQr`（开放平台链接与 NapCat 面板各一张内联 SVG），客户端把 SVG 注入向导卡。
- 编码失败只省略 `wizardQr` 键，接口不报错；客户端拿不到 SVG 就退回原占位（不会白屏）。
- 移植自 `qrcode-generator`（Kazuhiko Arase, MIT），版权与裁剪说明见 `THIRD_PARTY_NOTICES.md`。

### 验证
- 两条真实 URL 编码为 v3/29（mask 4）与 v2/25（mask 3），并用 jsQR 独立解码回原文；
- 另在真 Chromium 里把生成的 SVG 画到 canvas 再解码，两条 URL 均还原。
- 测试 398 → 418。

## [0.7.0] - 2026-10-23

### 变更
- **设置页改成两栏接入面板**：左栏平台卡片（图标 + 名称，选中蓝描边；未支持的平台标「即将支持」并禁用），
  右栏「正在接入 / 手动接入」两个 Tab + 在线状态药丸。
- 接入向导卡重排：状态小字 → 主标题 → 说明 → 220×220 占位块（在手机上打开 / 复制链接）→ 编号步骤 → 次级按钮，
  可收起（「接入向导已收起，配置没有改动。」）。
- 新增底部「已绑定」卡：头像 / 名称 / 状态点（运行正常·未启动·启动失败）+ 最近检查时间，
  展开可看平台、跑法、会话数、最近一轮耗时、白名单人数。
- 窄屏（<720px）两栏自动堆叠。
- 真二维码留待后续（代码中 `TODO(P7)`），当前为占位块 + 链接按钮。

### 文档
- `docs/NAPCAT.md` 新增第 7/8/9 节：SnowLuma 个人号路线（6 步接入）、11 条排障表、官方机器人 vs 个人号选型。

## [0.6.0] - 2026-10-23

### 新增
- **连接向导（三步点通）**：设置页顶部三步卡片 —— 打开开放平台 / 填凭证并验证 / 发测试消息。
  新增 `POST /dsh-bot/api/verify-credentials`：token 走正式域、`/gateway` 二次确认，失败按 `credentials|sandbox|gateway|unknown` 分级给人话（断网不会被误报成"密钥错"）。
- **把文件发回 QQ**：回复正文里单独一行写 `[[sendfile: <绝对路径>]]`，会把文件按平台能力发出去
  （QQ 官方走 `/files` multipart 上传 + `msg_type=7`；OneBot 走 image/file 段）。
  最多 3 个；不存在的路径、超过大小上限、发送失败都只追加一行说明，绝不中断回复；缺 `sendFile` 依赖时降级成文字路径。

### 兼容
- DSH `0.2.1-rc.4` 已验证（全量 348 项测试通过），加入兼容表。

## [0.5.0] - 2026-10-23

### 新增
- **会话绑定 + 锁（`src/session-binding.mjs`）**：同一个 chatKey 的"读绑定 → 跑一轮 → 写绑定"整段串行。两条并发消息不再各读到一个空绑定、各建一个会话（上下文分叉 + 同时占住写句柄）。
- **写句柄冲突改成退避重试链**：同一会话先按 200 / 600 / 1200ms 重试三次，仍抢不到才换新会话；结果带 `rebound: true`，日志里带 `reboundFrom`。原来的"释放一次重试一次"只是这条链的第一步。
- **QQ 里的命令系统（`src/commands.mjs`）**：`/new`、`/status`、`/export`、`/help`，各有中文同义词 `/新会话`、`/状态`、`/导出`、`/帮助`；命令不进 DSH、不占并发名额、不产生会话。
- **`/export`**：把当前会话导成 markdown（多帧 zstd 逐帧解，只取 `user/message` 与 `assistant/message` 的文字块），落到 `<storage.rootDir>/history/<会话 id>-<yyyyMMdd-HHmmss>.md`，回绝对路径 + 条数。

### 变更
- `dsh.newSessionPerMessage` 降级为**调试开关**（默认 `false`）：躲写句柄占用不再靠它。
- `dsh.releaseOnIdle` 语义不变（默认 `false`），文档改为说清"关掉时网页里点开可能读不到历史"。
- `createPipeline` 新增可选 `binding` / `approvalBridge` / `questionBridge`（`/status` 要报审批与提问的挂起数）。

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
