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
  "qqNapcat": { "wsUrl": "ws://127.0.0.1:3001", "accessToken": "", "reconnectMinMs": 1000, "reconnectMaxMs": 30000 },
  "qqOfficial": { "appId": "", "appSecret": "", "sandbox": true },
  "dsh": { "nodePath": "", "binPath": "", "profile": "im-bridge", "cwd": "", "timeoutMs": 300000, "permissionMode": "workspace-write" }
}
```
- `storage.rootDir` 落在 `C:\` 时给 warning（用户规则：项目产物不进 C 盘）。

## 3. HTTP 接口（`ctx.webServer.register`，全部 `kind:'prefix'`, `path:'/dsh-bot/api'`）
JSON 出入，全部 `Cache-Control: no-store`；写接口只接受 POST + `content-type: application/json`，body 上限 64KB；任何异常返回 `{ok:false, error}` 且 HTTP 仍 200（前端好处理），**不要把 stack 回给前端**。

| 方法 路径 | 请求 | 响应 |
| --- | --- | --- |
| GET `/status` | — | `{ok:true, enabled, running, platform, since, lastError, stats:{received,handled,denied,failed}}` |
| GET `/config` | — | `{ok:true, config, warnings:[string], configPath}` |
| POST `/config` | `{config}` | `{ok:true, config, warnings}` 或 `{ok:false, error, problems:[string]}`（校验失败时**不落盘**） |
| POST `/control` | `{action:'start'|'stop'|'restart'}` | `{ok:true, status}` |
| GET `/platforms` | — | `{ok:true, platforms:[{id,label,description,fields:[{key,label,type,group,required,secret,placeholder,help}]}]}` |
| POST `/test-send` | `{target?}` | `{ok:true, target, chunkCount}` 或 `{ok:false, error}`（未启动、找不到收件人、真的发不出去都走这里，**不抛**） |
| GET `/logs/tail?lines=100` | — | `{ok:true, lines:[string]}`（读当前日志文件尾部，最多 500 行，路径越界一律拒绝） |

`fields` 里 `key` 用点路径（如 `qqNapcat.wsUrl`），`type` ∈ `text|password|number|boolean|stringList|select`；`secret:true` 的字段在 `GET /config` 里必须以 `"***"` 掩码返回，POST 收到 `"***"` 表示"不修改"。

`group` ∈ `basic|advanced`（缺省 `advanced`）：客户端只用它决定"首屏直接展开"还是"收进折叠区"。basic 组的口径是**新手必须看懂才能跑起来**的那几项（平台、谁能用、数据目录、收发测试消息的收件人、DSH 入口/profile、平台专属凭据），每个平台不超过 10 项；新增字段默认 advanced，想进首屏必须显式标注。

`/test-send` 的收件人解析顺序：显式 `target` → 配置 `testTarget` → 平台启发式（`qq-official` 取 `security.userWhitelist` 里 ≥20 位十六进制的 openid，`qq-napcat` 取纯数字的 QQ 号）。发送走当前已启动适配器的 `deps.sendReply`（OneBot 的适配器 deps 为 null，按 `onebotSend` 模块补齐），固定文案 + 私聊。

## 4. 宿主半边 `lib/host.js`
```js
export const name = 'dsh-bot'
export const inject = ['webServer']            // 只用这一项；缺了就整体降级，不许抛
export function apply(ctx) { /* 注册路由 + 按配置启动/停止运行时 */ }
```
- `apply` 全程 try/catch；注册失败只写日志（`ctx.logger?.warn` 或 console），**绝不让 DSH 启动失败**。
- `ctx.effect(() => () => { /* 停运行时、注销路由 */ })` 保证卸载干净。
- 运行时 = 现有内核（`src/pipeline.mjs` + 适配器）。按 `platform` 选适配器：`qq-napcat` → `src/onebot/*`；`qq-official` → `src/qqbot/*`（尚未完成则启动时返回 `{ok:false,error:'平台适配器尚未就绪'}`）；`wechat` → 明确报"未实现"。
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
- `apply(ctx)`：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'dsh-bot', order: 120, label: () => 'dsh bot' }, DshBotSection))`，整段 try/catch（第三方插件都这么写，因为 slot 服务未文档化）。
- 组件签名 `({ close }) => React.createElement(...)`；**只用 React.createElement，不用 JSX**。
- 表单数据全部来自 `GET /dsh-bot/api/platforms` + `GET /dsh-bot/api/config`，字段由 host 下发（前端不含任何平台硬编码字段表）。
- 必需要有：平台下拉、按平台渲染字段（按 `group` 分成"常用设置"+「高级设置（一般不用改）」折叠区，用原生 `details/summary`）、白名单编辑（一行一个 QQ 号）、数据目录、启用开关、保存按钮、启动/停止按钮、「发送测试消息」按钮、状态行（running/enabled/lastError）、保存/测试结果提示。
- 字段缺少 `group` 时整体按 basic 渲染（老版本 host 兼容）：宁可多显示，也不能让整页字段被折叠起来。
- 用 `fetch` 直接打 `/dsh-bot/api/*`（同源，无需鉴权头）。
- 任何网络失败都要渲染成一行人类可读的提示，不许白屏。

## 6. 测试
- `test/plugin-host.test.mjs`：用假的 req/res 对象打路由，覆盖 GET/POST config（合法、校验失败不落盘、secret 掩码往返、`***` 表示不改）、`/platforms` 字段表结构 + `group` 分组口径（basic ≤ 10 且各平台固定）、`/test-send`（未启动 / 找不到收件人 / 成功 / 发不出去）、`/status`、`/logs/tail` 的越界拒绝、control 幂等、配置文件损坏恢复、C 盘 warning。
- `test/plugin-client.test.mjs`：不加载 DSH 运行时，用 stub 的 `window.__ModuleLoader__` 捕获 factory，断言 `exports.inject`/`exports.apply` 存在、`apply` 用假 ctx 时确实调用 `ctx.slots.register({name:'settings.section', id:'dsh-bot'})`、`order` 是数字、label 函数返回 'dsh bot'；再断言组件对"字段表 + 配置"的纯渲染工具函数（把 fetch 抽成可注入）产出的元素不抛。
- 现有测试必须继续全绿（当前 257 个：`node --test`）。

## 7. 不许做的事
- 不改 `src/onebot/**`、`src/pipeline.mjs`、`src/config.mjs` 的既有签名（新增文件可以）。
- 不引入任何 npm 依赖，不加构建脚本，不生成 sourcemap。
- 不把 AppSecret 写进 profile 的 patch 文件、不写进日志、不在 `GET /config` 明文返回。