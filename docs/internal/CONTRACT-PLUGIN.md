# dsh-im-bridge · DSH 插件层契约（设置页 + 宿主半边）

本文件约束插件层（`lib/`、`src/plugin/`）。业务内核（`src/config|storage|security|pipeline|prompt|onebot|qqbot/**`）已有契约见 `CONTRACT.md` / `CONTRACT-QQBOT.md`，不要改它们的签名。

## 0. 已定决策（不得推翻）
- 设置页数据通道：**自有 HTTP 路由 + 自有 JSON 配置**，不用 DSH 原生 `configForms`/`.volatile()`。
- bot 的 Agent 权限：**workspace-write + 专用工作目录**，不出现 danger-full-access。
- 客户端 bundle：**手写 `window.__ModuleLoader__.load({ id, factory })` 形状**（DSH 运行期不打包、不转译），只用 `React.createElement`，**不引入任何构建链和运行时依赖**。
- 安装：`dsh plugin --profile web add <本地路径>`，装完需重启 `dsh web`。

## 1. 仓库形态（根目录 package.json 就是插件清单）
```jsonc
{
  "name": "dsh-im-bridge",
  "version": "0.2.0",
  "type": "module",
  "main": "lib/host.js",
  "exports": { ".": "./lib/host.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": {
    "engines": { "dsh": ">=0.2.1-rc.2" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] }
  },
  "bin": { "dsh-im-bridge": "bin/bridge.mjs", "dsh-im-qqbot": "bin/qqbot.mjs" },
  "scripts": { "test": "node --test" },
  "engines": { "node": ">=20" },
  "license": "MIT"
}
```
`cordis.patch.yml`（**行 id 决定设置命名空间，必须是 `dsh-bot`**）：
```yaml
- insert:
    - id: dsh-bot
      name: 'dsh-im-bridge'
      config: {}
```

## 2. 配置文件（我们自己的，不进 profile patch）
- 默认路径：`<DSH_HOME>/dsh-bot/config.json`（`DSH_HOME` 缺省 `C:\Users\admin\.dsh`）。`DSH_BOT_CONFIG` 环境变量可覆盖。
- 原子写（`.tmp` + rename），文件缺失时用默认值并自动创建父目录；损坏时备份成 `.corrupt` 后从默认起步，**不许抛**。
- 形状：
```jsonc
{
  "enabled": false,
  "platform": "qq-napcat",              // qq-napcat | qq-official | wechat
  "testTarget": "",                     // 「发送测试消息」的收件人；空=按平台从白名单里猜
  "storage": { "rootDir": "E:\\dsh-im-bridge-data", "maxFileBytes": 104857600, "retentionDays": 30 },
  "security": { "userWhitelist": [], "groupWhitelist": [], "allowPrivate": true, "allowGroup": true,
                "groupRequireAt": true, "rateLimitPerMinute": 6, "maxConcurrentRuns": 2, "maxPromptChars": 8000 },
  "reply": { "maxChunkChars": 1500, "errorPrefix": "[bridge] ", "showSessionId": false },
  "asr": { "command": "", "args": [], "timeoutMs": 60000 },
  "log": { "dir": "", "level": "info" },
  "qqNapcat": { "wsUrl": "ws://127.0.0.1:3001", "accessToken": "", "homeDir": "", "port": 3001,
                "reconnectMinMs": 1000, "reconnectMaxMs": 30000 },   // homeDir 空 = 不用一键启动；port = 探测/连的那个 3001
  "qqOfficial": { "appId": "", "appSecret": "", "sandbox": true },
  "dsh": { "nodePath": "", "binPath": "", "profile": "im-bridge", "cwd": "", "timeoutMs": 300000, "permissionMode": "workspace-write" }
}
```
- `storage.rootDir` 落在 `C:\` 时给 warning（用户规则：项目产物不进 C 盘）。
- `log.dir` 留空 = `<storage.rootDir>/logs`（`resolveLogDir` 解析，**不写回配置文件**）。
- 数据目录分层由 `src/plugin/data-layout.mjs` 的 `ensureDataLayout({rootDir, logger, fsImpl})` 负责：保存配置成功后（`POST /config`）与运行时启动时各调一次，幂等创建 `{logs,media,history,prompts,state}` 与两份模板 `prompts/system.md`、`prompts/persona.md`（`flag:'wx'`，已存在绝不覆盖），失败只 warn 不抛。模板正文会被 `src/prompt.mjs` 读入：有内容时按 `[系统要求]` → `[角色设定]` → `[用户消息]` 固定顺序拼在提示词里；注释（`<!-- -->`）与没填的空占位（`# 角色名`、`- 性格：`）不算内容，读不到也保持原样。

## 3. HTTP 接口（`ctx.webServer.register`，全部 `kind:'prefix'`, `path:'/dsh-bot/api'`）
JSON 出入，全部 `Cache-Control: no-store`；写接口只接受 POST + `content-type: application/json`，body 上限 64KB；任何异常返回 `{ok:false, error}` 且 HTTP 仍 200（前端好处理），**不要把 stack 回给前端**。

| 方法 路径 | 请求 | 响应 |
| --- | --- | --- |
| GET `/status` | — | `{ok:true, enabled, running, platform, since, lastError, stats:{received,handled,denied,failed}}` |
| GET `/config` | — | `{ok:true, config, warnings:[string], configPath}` |
| POST `/config` | `{config}` | `{ok:true, config, warnings}` 或 `{ok:false, error, problems:[string]}`（校验失败时**不落盘**） |
| POST `/control` | `{action:'start'|'stop'|'restart'}` | `{ok:true, status}` |
| GET `/platforms` | — | `{ok:true, platforms:[{id,label,description,fields:[{key,label,type,group,required,secret,placeholder,help}]}]}` |
| POST `/test-send` | `{target?, platform?}` | `{ok:true, target, chunkCount, platform}` 或 `{ok:false, error}`（未启动、平台对不上、找不到收件人、真的发不出去都走这里，**不抛**） |
| GET `/logs/tail?lines=100` | — | `{ok:true, lines:[string]}`（读当前日志文件尾部，最多 500 行，路径越界一律拒绝） |
| POST `/napcat/start` | `{}` | `{ok:true, pid, launcher, alreadyRunning}` 或 `{ok:false, error}` |
| GET `/napcat/status` | — | `{ok:true, listening, loggedIn, homeDir, port, qrcodeAt?, qrcodeAgeMs?}`；`loggedIn` 取不到就是 `null` |
| GET `/napcat/qr` | — | `{ok:true, dataUrl, mtimeMs}` 或 `{ok:false, error}`（`dataUrl` 是 `data:image/png;base64,…`） |
| POST `/napcat/stop` | `{}` | `{ok:true, pid}` 或 `{ok:false, error}`（只结束本插件自己拉起的那个 pid） |

`fields` 里 `key` 用点路径（如 `qqNapcat.wsUrl`），`type` ∈ `text|password|number|boolean|stringList|select`；`secret:true` 的字段在 `GET /config` 里必须以 `"***"` 掩码返回，POST 收到 `"***"` 表示"不修改"。

`/napcat/*` 四条由 `src/plugin/napcat-launcher.mjs` 实现（依赖注入 fs/spawn/net/now/kill，于是真机上没装 NapCat 也能把每个分支验掉）：`start` 在 `qqNapcat.homeDir` 里按 `launcher-win10.bat` → `launcher.bat` → `napcat.bat` → `NapCatWinBootMain.exe` → `napcat.mjs` 取第一个存在的（`.bat` 走 `cmd /c`），`detached:true + stdio:'ignore' + shell:false` 拉起且不重复拉起；`qrcode` 只读 `<homeDir>/napcat/cache/qrcode.png` 或 `<homeDir>/cache/qrcode.png`（>100 字节才算数）；`loggedIn` 只是"端口通 + 二维码文件 60 秒没更新"的弱信号，取不到一律 `null`。未配置 `homeDir` 时四条都回同一句人话并保持 HTTP 200。

`group` ∈ `basic|advanced`（缺省 `advanced`）：客户端只按它决定**默认可见**还是**收进「显示全部字段（排查用）」开关后面**（开关默认关闭，状态只活在组件内、不落配置）。basic 的口径固定为这 9 项（每个平台只出现自己相关的那些）：平台下拉、`qqOfficial.appId`、`qqOfficial.appSecret`、`qqNapcat.wsUrl`、`qqNapcat.accessToken`、`qqNapcat.homeDir`、`storage.rootDir`、`log.dir`、`enabled`。其余（并发/限流/分段/语音转写/审批/跑法/模型/预设/超时/`reply.*`/`social.*`/`approval.*`/`dsh.*`、以及**白名单**、`testTarget`）一律 advanced；新增字段默认 advanced，想进首屏必须显式标注并同步改 `test/plugin-host.test.mjs` 的 BASIC 表。

`/test-send` 的 `platform` 是「用户在设置页点的是哪张卡片」，缺省取配置里的 `platform`；它**只允许等于正在运行的那个平台**（适配器是按哪个平台建的），对不上直接回 `{ok:false, error}` 且一条都不发——否则用户在小号卡片上点测试，话会发给官方机器人那个号。

`/test-send` 的收件人解析顺序：显式 `target` → 配置 `testTarget` → 平台启发式（`qq-official` 取 `security.userWhitelist` 里 ≥20 位十六进制的 openid，`qq-napcat` 取纯数字的 QQ 号）。发送走当前已启动适配器的 `deps.sendReply`（OneBot 的适配器 deps 为 null，按 `onebotSend` 模块补齐），固定文案 + 私聊。

## 4. 宿主半边 `lib/host.js`
```js
export const name = 'dsh-bot'
export const inject = ['webServer']            // 只用这一项；缺了就整体降级，不许抛
export function apply(ctx) { /* 注册路由 + 按配置启动/停止运行时 */ }
```
- `apply` 全程 try/catch；注册失败只写日志（`ctx.logger?.warn` 或 console），**绝不让 DSH 启动失败**。
- `ctx.effect(() => () => { /* 停运行时、注销路由 */ })` 保证卸载干净。
- 运行时 = 现有内核（`src/pipeline.mjs` + 适配器）。按 `platform` 选适配器：`qq-napcat` → `src/onebot/*`；`qq-official` → `src/qqbot/*`（尚未完成则启动时返回 `{ok:false,error:'平台适配器尚未就绪'}`）；`wechat` → `src/wechat/*`（轮询本机 WeChatFerry 桥，缺模块则报 `{ok:false,error:'平台适配器尚未就绪'}`）。
- 同一时刻只允许一个运行时实例；`start`/`stop`/`restart` 幂等。
- 日志：写到 `<storage.rootDir>/logs/bridge-YYYY-MM-DD.log`（复用 `src/log.mjs`）。

## 5. 客户端半边 `lib/client.js`（手写，无构建）
形状（照抄官方包的包装）：
```js
window.__ModuleLoader__.load({
  id: 'dsh-im-bridge',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    // ...定义组件与 apply...
    module.exports.apply = apply
    module.exports.inject = ['slots', 'locale']
    return module.exports
  }
})
```
- `apply(ctx)`：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'dsh-bot', order: 120, label: () => '消息接入' }, DshBotSection))`，整段 try/catch（第三方插件都这么写，因为 slot 服务未文档化）。
- 组件签名 `({ close }) => React.createElement(...)`；**只用 React.createElement，不用 JSX**。
- 表单数据全部来自 `GET /dsh-bot/api/platforms` + `GET /dsh-bot/api/config`，字段由 host 下发（前端不含任何平台硬编码字段表）。
- 必需要有：平台下拉、按平台渲染字段（`visibleFields(fields, showAllFields)` 默认只留 `group:'basic'`，底部一个默认关闭的「显示全部字段（排查用）」复选框放开 advanced）、数据目录、日志目录、启用开关、保存按钮、启动/停止按钮、「发送测试消息」按钮、状态行（running/enabled/lastError）、保存/测试结果提示。
- 字段缺少 `group` 时整体按 basic 渲染（老版本 host 兼容）：宁可多显示，也不能让整页字段被开关藏掉。显示名（标题、副标题、slot label）是「消息接入」；`id`/`order`/`API_BASE`/`window.__ModuleLoader__` 的 id 一律仍是 `dsh-bot`，不许跟着文案改。
- 用 `fetch` 直接打 `/dsh-bot/api/*`（同源，无需鉴权头）。
- 任何网络失败都要渲染成一行人类可读的提示，不许白屏。

## 6. 测试
- `test/plugin-host.test.mjs`：用假的 req/res 对象打路由，覆盖 GET/POST config（合法、校验失败不落盘、secret 掩码往返、`***` 表示不改）、`/platforms` 字段表结构 + `group` 分组口径（basic ≤ 10 且各平台固定）、`/test-send`（未启动 / 找不到收件人 / 成功 / 发不出去）、`/status`、`/logs/tail` 的越界拒绝、control 幂等、配置文件损坏恢复、C 盘 warning。
- `test/plugin-client.test.mjs`：不加载 DSH 运行时，用 stub 的 `window.__ModuleLoader__` 捕获 factory，断言 `exports.inject`/`exports.apply` 存在、`apply` 用假 ctx 时确实调用 `ctx.slots.register({name:'settings.section', id:'dsh-bot'})`、`order` 是数字、label 函数返回 '消息接入'；再断言组件对"字段表 + 配置"的纯渲染工具函数（把 fetch 抽成可注入）产出的元素不抛。
- `test/napcat-launcher.test.mjs`：一键启动器的全部分支（候选启动器挑选顺序、homeDir 缺失/不存在、spawn 参数 `detached`/`stdio ignore`/无 shell 拼接、重复 start 不重复拉起、端口已在监听不重复起、qrcode 两条路径回退与 >100 字节门槛、dataUrl 前缀、status 探测超时归零、stop 只杀自己的 pid）+ 四条路由的成功/未配置/方法不对/异常分支。
- `test/napcat-client.test.mjs`：`describeNapcatPanel` 的三种方块形态与"绝不编已登录"、`readNapcatOnce`（注入时钟判过期）、`createNapcatWatcher`（注入假 fetch/定时器：进来先拉一次、3 秒一轮、stop 清定时器、卸载后迟到的响应丢弃），以及渲染出的 `<img src=dataUrl>`、占位与绿色方块。
- 现有测试必须继续全绿（`node --test`）。

## 7. 不许做的事
- 不改 `src/onebot/**`、`src/pipeline.mjs`、`src/config.mjs` 的既有签名（新增文件可以）。
- 不引入任何 npm 依赖，不加构建脚本，不生成 sourcemap。
- 不把 AppSecret 写进 profile 的 patch 文件、不写进日志、不在 `GET /config` 明文返回。