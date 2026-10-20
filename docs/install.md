# 安装与平台接入

## 0. 先确认这四件事

| 需要 | 怎么确认 |
| --- | --- |
| Node.js ≥ 20 | `node -v` |
| DSH ≥ 0.2.1-rc.2 | `dsh --version` |
| 一个机器人 | 二选一：**QQ 官方开放平台**（合规、免挂客户端）或 **NapCat**（挂真实 QQ 客户端） |
| 一个放数据的地方 | 绝对路径，**不要 C 盘**，例如 `E:\\dsh-im-bridge-data` |

---

## 方式一：插件（推荐）

```powershell
git clone https://github.com/1772538871/dsh-im-bridge.git
cd dsh-im-bridge
dsh plugin --profile web add .
dsh web        # 必须重启：插件组合只在启动时完成
```

重开 DSH 后：**设置 → dsh bot** → 选平台 → 填参数 → **保存** → **启动**。

### 装不上的三种情况

| 报错 / 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_PNPM_UNEXPECTED_STORE` | 该 profile 的 `node_modules` 用的是另一个 pnpm store | 把现存 store 显式传进去：`dsh plugin --profile web add . --store-dir C:\Users\<你>\AppData\Local\pnpm\store\v10`（值看 `profiles/web/node_modules/.modules.yaml` 的 `storeDir`） |
| 提示 `installed as a plain dependency, not a profile layer` | 包里没声明 `dsh.bundle.patch` | 正常 checkout 不会出现；若出现说明文件被改坏，重新 clone |
| 装完设置里没有 dsh bot | 没重启 / bundles 没写进去 | 看 `profiles/web/package.json` 的 `dsh.profile.bundles` 有没有 `dsh-im-bridge`，没有就重装；有就重启 + 浏览器强刷 |

### 卸载 / 回滚

```powershell
dsh plugin --profile web remove dsh-im-bridge
dsh web
```

装之前建议先备份 profile 的两个文件：`profiles/web/package.json`、`profiles/web/cordis.patch.yml`。

---

## 方式二：命令行

适合服务器/NAS，或不想装 GUI 插件。

### 1) 准备一个能跑模型的 DSH profile

原生 `headless` profile 禁用了 `credentials`，无人值守会直接 `MISSING_CREDENTIAL`。基于它的模板复制一个，只把 credentials 打开：

```powershell
dsh --profile im-bridge --from-default-profile headless --dump-config | Out-Null
# 编辑 %DSH_HOME%\profiles\im-bridge\cordis.patch.yml，加两行：
# - id: credentials
#   disabled: false
```

验证：

```powershell
'回复 OK' | dsh --profile im-bridge --json -
# 末行应是 {"type":"final","text":"OK"}
```

### 2) 复制并修改配置

```powershell
Copy-Item bridge.config.example.json bridge.config.json
node bin/bridge.mjs --check --config bridge.config.json   # 校验 + 打印生效摘要
node bin/bridge.mjs --config bridge.config.json           # 正式跑
```

配置项逐条解释见 [config.md](config.md)。

---

## 平台接入

### QQ 官方机器人（推荐）

1. 打开 [QQ 开放平台](https://q.qq.com/) → 创建机器人 → 拿到 **AppID / AppSecret**；
2. 在「开发设置」里把 `事件订阅` 保持 **WebSocket**；
3. 在「开发体验用户」里**加上你自己的 QQ 号**——未认证主体只能靠这个白名单测试，别人发的消息机器人收不到；
4. 填进 dsh bot 设置页 → 保存 → 启动。

> ⚠️ 未认证/未上线的机器人**只能在沙箱环境建会话**（正式网关会返回 `close 4903`）。插件在 `qqOfficial.sandbox = true` 时会自动走 `sandbox.api.sgroup.qq.com`，token 接口仍走正式域（沙箱域没有这个接口）。

### NapCat / OneBot 11

见 [NAPCAT.md](NAPCAT.md)：装 QQNT + NapCat → 开「正向 WebSocket」→ 端口和 token 与设置页一致。

---

## 装完的第一条验证

1. 设置页状态行 = 「运行中 · 平台 qq-official」；
2. 你的 QQ 给机器人发「你好」；
3. 日志 `<数据目录>\logs\bridge-YYYY-MM-DD.log` 里能看到：`access_token 已获取` → `网关就绪（READY）` → 收到消息 → 回合结束。

任何一步不对，去 [troubleshooting.md](troubleshooting.md)。
