# 内部设计契约（维护者用）

这里是从开发过程保留下来的接口契约，**普通用户不需要读**：

- `CONTRACT.md` —— 平台无关内核（config / storage / security / pipeline / prompt 的签名与行为）
- `CONTRACT-PLUGIN.md` —— 插件层（设置页、`/dsh-bot/api/*`、配置形状）
- `CONTRACT-QQBOT.md` —— 官方 QQ 机器人适配器（协议细节与查证清单）

它们记录"为什么这样设计"，改代码前值得读；对外文档见上一级目录。
