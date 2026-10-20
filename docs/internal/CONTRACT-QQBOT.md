# dsh-im-bridge · 官方 QQ 机器人适配器（QQ Bot API v2）契约

在已有项目上加**第二条平台腿**。项目已有 OneBot 11 适配器（`src/onebot/`）与平台无关内核。
先读 `CONTRACT.md`（内核契约）和 `src/pipeline.mjs` 的 `deps` 注入机制：**pipeline 允许注入 `parseEvent` / `planMedia` / `sendReply` / `chatKeyOf`**，官方适配器靠这几个注入点复用整条内核，不改 pipeline 逻辑。

## 已由调度方从官方文档核实的事实（直接用，别改数值）
- 取 token：`POST https://api.bot.qq.com/app/getAppAccessToken`，body `{"appId":"...","clientSecret":"..."}` → `{"access_token":"...","expires_in":7200}`（建议提前 60 秒刷新）。
- 调用鉴权头：`Authorization: QQBot <access_token>`。
- Gateway：先调「获取通用 WSS 接入点」拿 url（形如 `wss://api.bot.qq.com/websocket/`），连上后平台发 `{"op":10,"d":{"heartbeat_interval":45000}}`。
- 登录鉴权 op:2：`{"op":2,"d":{"token":"QQBot <access_token>","intents":<int>,"shard":[0,1],"properties":{"$os":"windows","$browser":"dsh-im-bridge","$device":"dsh-im-bridge"}}}`。
- 关注事件：`C2C_MESSAGE_CREATE`（单聊）、`GROUP_AT_MESSAGE_CREATE`（群聊 @机器人）。

## 你必须自己查证、不许猜的部分
1. 获取通用 WSS 接入点的确切方法与路径（如 `GET /gateway/bot`）及返回字段。
2. 发消息接口：单聊 `/v2/users/{openid}/messages`、群聊 `/v2/groups/{group_openid}/messages` 的确切 body（`content`、`msg_type`、被动回复 `msg_id`、`msg_seq` 规则）。
3. 富媒体：上传接口与 `file_type` 取值（图片/语音/文件各是几），发送时如何在 body 引用（`media` / `file_info`）。
4. 收消息附件字段（`attachments` 的字段名、是否签名 url、语音是否 silk）。
5. intents 位值（单聊/群聊@ 各需哪些位，给十进制值 + 文档出处）。
查证方式：用 `fetch` 抓 `https://bot.q.qq.com/wiki/develop/api-v2/` 下的页面，去标签读正文（本机可联网）。**每个数值都要指到文档页**；抓不到就进"未证实"清单并给保守实现，宁可不订阅也不伪造。

## 文件归属（只创建/编辑这些）
- 新增：`src/qqbot/auth.mjs`、`src/qqbot/client.mjs`、`src/qqbot/gateway.mjs`、`src/qqbot/parse.mjs`、`src/qqbot/send.mjs`、`src/qqbot/adapter.mjs`、`bin/qqbot.mjs`、`test/qqbot.test.mjs`
- 可最小改动：`src/config.mjs`（加 `qqbot` 段校验）、`bridge.config.example.json`（加 `qqbot` 示例）
- 不要动 `src/onebot/**`、`src/pipeline.mjs` 现有逻辑（用注入）、`bin/bridge.mjs`

## 接口要求
- `parseQqBotEvent(raw) -> { kind:'message'|'meta_event'|'unknown', message?: NormMessage }`，`NormMessage` 与 `CONTRACT.md` §2I **完全同形**。映射：单聊 `chatType='private'`、`userId=author.user_openid`、`groupId=null`；群聊 `chatType='group'`、`groupId=group_openid`、`userId=author.member_openid`；`selfId=appId`；`messageId=raw.d.id`。附件映射成 `{type:'image'|'record'|'file', data:{url, filename, size}}`。
- `sendQqReply({client, message, text, config, logger}) -> {sent, failed}`：复用 `../onebot/send.mjs` 的 `chunkText` 分段，**被动回复带 msg_id**，多段时遵守 `msg_seq` 递增。
- `createQqBotAdapter({config, logger}) -> { start(onEvent), stop(), client, deps }`，`deps` 里给 `parseEvent / planMedia / sendReply / chatKeyOf`。
- `bin/qqbot.mjs`：`--config`、`--check`（只校验不联网）、`--dry-run "<文本>"`（假 client 走 pipeline）、`--help`；用 `createPipeline({...内核依赖, deps})`。
- 网关健壮性：op:7 重连、op:9 重鉴权、op:11 心跳 ack、按 `heartbeat_interval` 定时心跳、断线指数退避、`stop()` 后不重连。

## 测试
`node --test test/qqbot.test.mjs` 全绿（本会话 spawn 被沙箱拦，全部用注入假件，**不联网**）。覆盖：token 获取与提前刷新、鉴权头、op10→op2 握手顺序、心跳、事件解析（单聊/群聊/带附件/脏输入）、msg_id 被动回复与 msg_seq、chatKeyOf 与内核一致。

## 报告（中文）
1. 文件清单（路径+行数）。2. 文档核实清单：每条事实 → 文档 URL + 原文摘录。3. 未证实清单与保守实现。4. 测试命令 + 真实输出末尾 15 行。5. 上线前用户还需做什么。