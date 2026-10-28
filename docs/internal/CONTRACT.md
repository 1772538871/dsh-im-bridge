# dsh-im-bridge · 接口契约（调度方写定，实现方不得擅改）

## 0. 硬约束
- Node ≥ 20，**纯 ESM，文件后缀一律 `.mjs`**，**零运行时依赖**（不装任何 npm 包；WebSocket 用 Node 内置全局 `WebSocket`）。
- 所有代码最终会整体搬到 `E:\Projects\dsh-im-bridge`。**只写 $env:TEMP staging 目录，不碰 E: 盘、不写 C:\Users\admin\.dsh、不写项目产物到 C: 其他位置。**
- 目录结构与文件归属见 §6；**只创建/编辑自己名下的文件**，不要改别人的文件；发现契约有问题就在报告里提，不要擅自改签名。
- 测试用 `node --test test/`，每个实现方只写自己名下的测试文件。
- 本机沙箱可能拦不住 pwsh 管道捕获 node 输出；若 `node` 直接跑报 EPERM/拒绝访问，用 `Start-Process -RedirectStandardOutput <file> -RedirectStandardError <file> -Wait` 再读文件。

## 1. 配置对象（src/config.mjs 产出，全项目只读不写）
```jsonc
{
  "onebot": { "wsUrl": "ws://127.0.0.1:3001", "accessToken": "", "reconnectMinMs": 1000, "reconnectMaxMs": 30000 },
  "dsh": { "nodePath": "", "binPath": "", "profile": "im-bridge", "cwd": "", "timeoutMs": 300000, "permissionMode": "workspace-write", "env": {} },
  "storage": { "rootDir": "", "maxFileBytes": 104857600, "retentionDays": 30 },
  "security": { "userWhitelist": [], "groupWhitelist": [], "allowPrivate": true, "allowGroup": true, "groupRequireAt": true,
                "rateLimitPerMinute": 6, "maxConcurrentRuns": 2, "maxPromptChars": 8000 },
  "reply": { "maxChunkChars": 1500, "errorPrefix": "[bridge] ", "showSessionId": false },
  "asr": { "command": "", "args": [], "timeoutMs": 60000 },
  "log": { "dir": "", "level": "info" }
}
```
`nodePath`/`binPath`/`cwd`/`storage.rootDir`/`log.dir` 为空或相对路径时由 config 层补默认值（见 §2），并把补出来的绝对路径写回返回的 config。

## 2. 各模块签名（逐字实现，import 路径按 §6）

### A. src/config.mjs
- `export function loadConfig({ filePath, env = process.env } = {}) -> { config, warnings: string[], filePath }`
  - 文件不存在 → 抛 `ConfigError`；`DSH_BRIDGE_CONFIG` 可指定路径。
  - 默认值：`dsh.nodePath`=`process.execPath`；`dsh.binPath`= 从 env `DSH_BIN` 或 `<DSH_HOME>/../npm/...` 找不到就留空并由 `--check` 报错；`dsh.cwd`=`<storage.rootDir>/workspace`；`storage.rootDir` 必填（无默认，缺失即报错）；`log.dir`=`<storage.rootDir>/logs`。
  - **warnings**：`storage.rootDir` 或 `log.dir` 落在 `C:\` 时追加一条中文警告（用户规则：产线数据不进 C 盘）。
- `export function validateConfig(raw) -> { ok: boolean, problems: string[], config }`（不抛异常，供 `--check` 用）
- `export function formatConfigSummary(config) -> string`（多行人读摘要，含生效路径、白名单数量、并发数）
- `export class ConfigError extends Error { problems: string[] }`

### B. src/log.mjs
- `export function createLogger({ dir, level = "info" }) -> Logger`
- `Logger = { info, warn, error, debug, child(scope: string) -> Logger, flush(): Promise<void>, filePath: string }`
- 行为：JSONL 追加到 `<dir>/bridge-YYYY-MM-DD.log`；同时一行人读文本写 stderr；写盘失败降级为只写 stderr，不得抛。

### C. src/paths.mjs
- `export function sanitizeSegment(input, { maxLength = 64 } = {}) -> string`（去掉 `\ / : * ? " < > |` 与控制符、`..`、首尾点和空格；空结果回 `_unknown_`；非 ASCII 保留但截断到 maxLength 字节安全）
- `export function chatKeyOf(chat) -> string`（`private_<userId>` / `group_<groupId>`）
- `export function attachmentPath({ rootDir, chat, kind, filename, ts = Date.now(), ext }) -> string`
  布局：`<rootDir>/media/<YYYY-MM-DD>/<chatKey>/<ts>-<kind>-<safeName>.<ext>`；`kind ∈ text|image|file|record|other`。
- `export function ensureDir(p) -> Promise<void>`

### D. src/storage.mjs
- `export function createStorage({ config, logger }) -> Storage`
- `Storage = { rootDir, saveBuffer(buffer, { chat, kind, filename, ext }) -> Promise<{path, bytes, sha256}>, saveFromUrl(url, opts) -> Promise<{path, bytes, sha256}>, resolveExisting(path), sweepRetention(now = Date.now()) -> Promise<{deleted: number, bytes: number}> , workspaceDir }`
- 规则：单文件超 `storage.maxFileBytes` 直接抛 `StorageError`（`.code = 'FILE_TOO_LARGE'`）；`saveFromUrl` 用全局 `fetch`，超限时中止并删除半成品；`sweepRetention` 按 `retentionDays` 删 `media/<date>` 下过期目录。

### E. src/security.mjs
- `export function createGuard({ config, logger, random = Math.random }) -> Guard`
- `Guard = { decide(msg, now = Date.now()) -> { allow: boolean, reason: string } }`
- 判定顺序（命中即返回，reason 用固定短码）：`chat_type_disabled`(allowPrivate/allowGroup) → `user_not_allowed`(私聊白名单；群聊要求 `userWhitelist` **为空则只按群白名单**，非空则发送者必须在其中) → `group_not_allowed` → `need_at`(群聊 groupRequireAt 且消息里没有 `at` 指向 selfId 或 `at` 全部/@机器人) → `rate_limited`（每用户滑窗 `rateLimitPerMinute`）。`allow:true` 时 reason=`ok`。
- `need_at` 之前有两道 social 豁免（只在群聊、且消息没 @ 时生效）：命中 `social.mustReplyKeywords` 任一关键词 → 放行（**优先于 groupRequireAt**，日志 info 记一行"群里出现必答词「…」"）；否则 `social.replyProbability > 0` 时以该概率放行（debug 记一行）。随机源由 `random` 注入，测试不依赖真随机。私聊不受 social 影响；两条豁免都在 `rate_limited` 之前，放行后仍受频率限制。

### F. src/queue.mjs
- `export function createSerialQueue() -> { run(key, fn) -> Promise<any>, pending(key): number, size(): number }`（同 key 串行，不同 key 并行）
- `export function createSemaphore(limit) -> { withPermit(fn) -> Promise<any>, active(): number }`

### G. src/sessions.mjs
- `export function createSessionStore({ file, logger }) -> { get(key) -> string|undefined, set(key, sessionId) -> Promise<void>, clear(key) -> Promise<void>, all() -> Record<string,string> }`
- 原子写（`tmp` + `rename`），损坏的 JSON 不抛，备份为 `.corrupt` 后从空开始。

### H. src/onebot/client.mjs
- `export function createOneBotClient({ url, accessToken, logger, onEvent, onStatus }) -> Client`
- `Client = { start() -> void, stop() -> Promise<void>, call(action, params = {}, { timeoutMs = 15000 } = {}) -> Promise<any>, isOpen(): boolean, status(): { open: boolean, lastError: string|null, attempts: number } }`
- 实现要点：内置 `WebSocket`；accessToken 非空时拼成 `?access_token=<encodeURIComponent(token)>`（内置 WebSocket 不支持自定义 header）；`call` 用自增 `echo` 关联响应，超时 reject `OneBotError`；断线指数退避重连（`reconnectMinMs`→`reconnectMaxMs`）；`onEvent(raw)` 只对 `post_type==='message'` 及未知事件透传，不在这里过滤白名单。

### I. src/onebot/parse.mjs
- `export function parseEvent(raw) -> ParsedEvent`
- `ParsedEvent = { kind: 'message'|'meta_event'|'notice'|'request'|'unknown', message?: NormMessage }`
- `NormMessage = { messageId, chatType: 'private'|'group', userId: string, groupId: string|null, selfId: string, senderName: string|null, time: number, text: string, segments: NormSegment[], atTargets: string[], replyTo: string|null }`
- `NormSegment = { type: 'text'|'image'|'file'|'record'|'at'|'reply'|'face'|'other', data: object }`
- 必须容错：`message` 为字符串（CQ 码）或数组两种形态；缺字段不抛，用 `null`/空串兜底；`atTargets` 收集 `at` 段的 qq（`all` 也收）。

### J. src/onebot/media.mjs
- `export function planMedia(segment, { chatType = 'private' } = {}) -> { needsFetch: boolean, url?: string, fileId?: string, filename: string, ext: string, callSpec?: { action: string, params: object } }`
  - image：优先 `data.url`；否则 `get_image`（`file_id` 或 `file`）
  - file：`data.url` → 否则群聊 `get_group_file_url`、私聊 `get_private_file_url`；`filename` 取 `data.file`/`data.name`
  - record：`data.url` → 否则 `get_record`（`file`/`file_id`）；ext 默认 `amr`
- `export function guessExt(filename, fallback) -> string`
- **纯函数，不做网络**；真正下载由 pipeline 用 `storage.saveFromUrl` 完成。

### K. src/onebot/send.mjs
- `export function chunkText(text, maxChars) -> string[]`（按段落→行→句→硬切；不产生空串；`text` 为空返回 `[]`）
- `export function buildMessagePayload(text) -> Array<{type:'text', data:{text}}>`（避免 CQ 注入）
- `export async function sendReply({ client, message, text, config, logger }) -> { sent: number, failed: number }`（`send_private_msg`/`send_group_msg`，逐段发送，单段失败记日志继续）

### L. src/dsh.mjs
- `export function runDsh({ config, prompt, sessionId, logger, signal, spawnImpl }) -> Promise<DshResult>`
- `DshResult = { ok, text, sessionId, reason, exitCode, durationMs, events, stderrTail }`
- 命令：`nodePath binPath --profile <dsh.profile> --json -`；`stdin` 写 prompt 后 end；`cwd = dsh.cwd`；`env = { ...process.env, DSH_PERMISSION_MODE: dsh.permissionMode, ...dsh.env }`；超时 `dsh.timeoutMs` 后 kill 并 `ok:false, reason:'timeout'`。
- 逐行解析 NDJSON：`session` 事件取 `sessionId`；`final` 事件取 `text`；`error` 事件记 `reason:'runner_error'`；`status.turn_end.reason.kind==='completed'` 才算成功。
- **成功判定：有 final 事件 且 无 error 事件**（模型中途报错时有 final 但 `turn_end.reason.kind==='error'`，要判失败并把 error message 带出来）。
- `export function parseNdjsonLines(chunkBuffer) -> { events: object[], rest: string }`（可单独单测；容忍跨 chunk 半行）

### M. src/prompt.mjs
- `export function buildPrompt({ config, message, savedAttachments = [], voiceTranscript = null }) -> string`
- 内容要求（中文）：说明你在通过 QQ 机器人回复；只输出纯文本、不要 markdown 表格/代码围栏；控制在 `reply.maxChunkChars` 字符内；列出附件（类型 + 绝对路径）并提示可读；有语音转写时贴转写文本；末尾附用户原文。若 `message.text` 为空且只有附件，也要能构造出合法 prompt。

### N. src/asr.mjs
- `export function transcribe({ config, filePath, logger }) -> Promise<{ ok: boolean, text: string, reason: string }>`（`asr.command` 为空 → `{ok:false, reason:'not_configured'}`；有则 spawn，超时 `asr.timeoutMs`，stdout 去空白即转写结果）

### O. src/pipeline.mjs
- `export function createPipeline({ config, logger, client, storage, guard, serial, semaphore, sessions, runDsh, binding, approvalBridge, questionBridge, deps }) -> { handleEvent(raw) -> Promise<void>, stats(): object }`
  （`binding` / `approvalBridge` / `questionBridge` 可选；前两者不传就用默认实现/不报挂起数）
- 流程：`parseEvent` → 非 message 直接返回 → `guard.decide` → 拒绝则 debug 日志返回 → 附件逐个 `planMedia` +`storage` 落地（失败降级成文字说明，不整条失败）→ 语音走 `asr.transcribe` → `parseCommand` 命中命令则就地回一句（不进 DSH）→ `serial.run(chatKey)` 内 `sessionBinding.withBinding(chatKey)`（读绑定 → `semaphore.withPermit(() => runDsh(...))` → 写绑定）→ `sendReply`；`result.rebound === true` 只记 warn；捕获所有异常，错误回复 `reply.errorPrefix + 简短原因`（不得把 stack 发给用户）。

### Q. src/session-binding.mjs
- `export function createSessionBinding({ sessions, logger, now }) -> { withBinding(chatKey, fn) -> Promise<any>, reset(chatKey) -> Promise<{ chatKey, sessionId }>, status() -> { chats, pending, runs, lastWriteAt } }`
- `fn(scope)` 的 `scope = { chatKey, get() -> Promise<string|null>, set(sessionId) -> Promise<boolean> }`。
- 同一 chatKey 的绑定事务串行（每个 key 一条 Promise 链，前一个失败也继续），不同 key 互不排队；链尾清空即删键，长跑进程里 Map 不会无限长。
- 绑定仍存在 `sessions` store（chatKey → sessionId），不新增存储格式；读写异常只降级成 warn 日志。

### R. src/commands.mjs
- `export function parseCommand(text) -> { name: 'new'|'status'|'export'|'help', args: string } | null`；只认 `/`（或全角 `／`）开头、且首词在 `new/status/export/help` 与 `新会话/状态/导出/帮助` 之内，其余返回 `null`（普通消息不许被抢）。
- 文案：`commandHelpText({ sessionId })`（≤4 行）、`commandNewSessionText(previousSessionId)`、`commandStatusText({ platform, runner, sessionId, lastDurationMs, approvalPending, questionPending })`（没有挂起就不出现"正在等"那行）、`commandExportDoneText({ path, count })`、`commandExportFailedText(reason)`。
- 导出：`encodeCwdSegment(cwd)`（`<DSH_HOME>/sessions/--<cwd 编码>--`；`[A-Za-z0-9._-]` 保留、连续分隔符压成一个 `-`、非 ASCII 转 `~XXXX`）、`findSessionLog`（直算不到就扫一遍 sessions 根）、`decodeZstdFrames`（多帧 zstd 按魔数 `28 B5 2F FD` 逐帧解，解不开就把尾巴并到下一帧）、`parseSessionLog`、`buildHistoryMarkdown`、`exportSessionMarkdown({ dshHome, cwd, sessionId, outDir, now })`（失败返回 `{ ok:false, message }`，不抛）。

### P. bin/bridge.mjs
- CLI：`--config <path>`、`--check`（只校验+打印摘要+退出，不连 WS）、`--dry-run "<文本>"`（用假 client 走一遍 pipeline，真实调用 dsh）、`--help`。
- 启动时：加载配置 → 校验失败打印 problems 并 exit 1 → 建 logger/storage/guard/queue/sessions/pipeline → 连 WS → 优雅退出（SIGINT/SIGTERM 时 `client.stop()` + `logger.flush()`）。

## 3. 数据目录布局（storage.rootDir 下）
```
<rootDir>/media/<YYYY-MM-DD>/<chatKey>/<ts>-<kind>-<safeName>.<ext>
<rootDir>/workspace/            dsh.cwd 默认值
<rootDir>/sessions.json         每聊天的 --session-id 映射
<rootDir>/logs/bridge-YYYY-MM-DD.log
```

## 4. 错误类型
`ConfigError{problems}`、`StorageError{code}`、`OneBotError{action, message}`；其余一律普通 `Error`。

## 5. 测试要求
`node --test test/` 必须全绿。纯函数必须测（chunkText/sanitizeSegment/parseEvent/parseNdjsonLines/buildPrompt/guard 判定/attachmentPath/planMedia/validateConfig）。涉及网络或子进程的用注入的 fake（`spawnImpl`、假 client、假 fetch）测，**不要在测试里真连 QQ 或真跑 dsh**。

## 6. 文件归属（严格）
- A（core）：`package.json` `.gitignore` `bridge.config.example.json` `src/config.mjs` `src/log.mjs` `src/paths.mjs` `src/storage.mjs` `src/security.mjs` `src/queue.mjs` `src/sessions.mjs` `test/core.test.mjs`
- B（onebot）：`src/onebot/client.mjs` `src/onebot/parse.mjs` `src/onebot/media.mjs` `src/onebot/send.mjs` `test/onebot.test.mjs`
- C（dsh+pipeline）：`src/dsh.mjs` `src/prompt.mjs` `src/asr.mjs` `src/pipeline.mjs` `bin/bridge.mjs` `test/dsh.test.mjs` `test/pipeline.test.mjs`
- 文档（README/NAPCAT/SECURITY）由调度方最后统一写，谁都不要写。
