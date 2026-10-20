# 贡献指南

## 提交信息（Conventional Commits）

跟生态惯例一致（`dsh-context`、`dsh-TUI`、`dsh-agent-teams` 都这么写）：

```
<type>(<scope>): <一句话说明>

<可选正文：为什么这么改，而不是改了什么>
```

常用 type：`feat` / `fix` / `docs` / `test` / `refactor` / `chore` / `perf`

| scope | 覆盖 |
| --- | --- |
| `qqbot` | 官方 QQ 机器人（API v2）：auth / gateway / parse / send / adapter |
| `onebot` | NapCat / OneBot 11 |
| `pipeline` | 消息管线（解析 → 白名单 → 落盘 → 调 DSH → 回复） |
| `runner` | 执行器：headless / sdk / inprocess |
| `approval` | QQ 审批桥 |
| `plugin` | 插件宿主半边（HTTP 路由、配置存储、运行时接线） |
| `client` | 设置页（`lib/client.js`，手写 ModuleLoader bundle） |
| `prompt` | 给 DSH 的提示词拼装 |
| `security` | 白名单 / 限流 / 沙箱策略 |
| `docs` | 文档 |
| `compat` | 适配新 DSH 版本（同时改 `dsh.compatibility.dshReleases`） |

## 硬性约束

1. **零运行时依赖**：只允许 `node:*` 内置模块。不要加 npm 包，不要加构建链。
2. **纯 ESM**，`.mjs`；`lib/client.js` 必须保持 `window.__ModuleLoader__.load` 形状（DSH 运行期不打包、不转译）。
3. **测试**：`node --test`。网络与子进程必须注入假件，不联网、不 spawn 真进程。
4. 不提交密钥：`bridge.config.json`、`~/.dsh/dsh-bot/config.json` 都不入库。

## 本地开发

```powershell
node --test
node bin/bridge.mjs --check --config bridge.config.example.json
```

装进 DSH 调试插件形态：

```powershell
dsh plugin --profile web add E:\Projects\dsh-im-bridge --store-dir <你现有 pnpm store>
# 重启 dsh web 后：设置 → dsh bot
```

## DSH 升级后要做什么（重要）

这个插件有两条腿：**稳定的 CLI/JSON-RPC 腿**（`headless` / `sdk`）和**私有 API 腿**（`inprocess` + QQ 审批桥，依赖 `ctx.agents.create` 与 `approval/request` 钩子）。

升级 DSH 之后：

1. `node scripts/selfcheck.mjs` —— 一条命令验清单 / 设置页 bundle / 配置 / DSH 版本兼容性（FAIL 会以非零退出）；
2. `node --test` 全绿；
3. 重启 `dsh web` → 设置 → dsh bot → 启动；
4. 给机器人发「你好」，确认 `E:\dsh-im-bridge-data\logs\bridge-*.log` 里有 `网关就绪（READY）` 与回合记录；
5. `inprocess` 若出问题，把 `dsh.runner` 切回 `sdk`（聊天不受影响，只是没有审批往返）；
6. 确认无误后把新版本加进 `package.json` 的 `dsh.compatibility.dshReleases`，提交 `chore(compat): …`。

## 目录地图

```
lib/host.js          DSH 插件宿主半边（/dsh-bot/api/* 路由 + 运行时接线）
lib/client.js        设置页 bundle（手写 __ModuleLoader__ 形状）
src/plugin/          配置存储、HTTP 路由、平台字段表、运行时
src/dsh.mjs          headless 执行器
src/sdk-runner.mjs   sdk 长驻执行器
src/inprocess-runner.mjs  进程内执行器（配合审批桥）
src/onebot|qqbot/    两个平台适配器
src/pipeline.mjs     平台无关管线
bin/                 命令行入口
docs/                install / config / troubleshooting / manual.zh / NAPCAT / SECURITY
docs/internal/       内部设计契约（对外不用读）
```
