# 仓库级约定（给 AI 代理看）

改这个仓库前先读这一页，它比 README 更有约束力。

## 不能做

- **不要引入 npm 依赖**，也不要有构建步骤：干净机器上 `node --test` 必须直接跑通。
- **不要把项目产物写到 C 盘**：截图、临时文件、日志、构建产物放项目目录或 `E:\dsh-im-bridge-data`。
- **不要提交密钥**：`bridge.config.json`、`~/.dsh/dsh-bot/config.json`、任何 token / AppSecret。
- **不要在 `src/pipeline.mjs` 里塞平台特例**：平台差异只能经 `deps` 注入（`parseEvent` / `planMedia` / `sendReply` / `chatKeyOf`）。
- **不要把 DSH 内部 API 放进关键路径**：`inprocess` 与审批桥属可降级特性，任何时候 `dsh.runner=headless|sdk` 都必须独立可用。

## 必须做

- 新行为必须有测试（`node --test`），网络与子进程用注入假件。
- 提交信息用 Conventional Commits（type + scope，见 `CONTRIBUTING.md`）。
- 改到 DSH 交互面（协议、内部服务、钩子）时，同步更新 `CONTRIBUTING.md` 的升级清单与 `package.json` 的 `dsh.compatibility.dshReleases`。
- 注释解释"为什么"，不复述代码。

## 三个执行器的边界

| runner | 依赖 | 何时用 |
| --- | --- | --- |
| `headless` | CLI 契约 `dsh --profile <p> --json -` | 默认；最稳 |
| `sdk` | 官方 JSON-RPC（`dsh-sdk-protocol`） | 想要低延迟 |
| `inprocess` | `ctx.agents` 与 `approval/request` 钩子 | 需要 QQ 审批往返；升级可能碎 |
