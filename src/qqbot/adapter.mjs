// 组装位：把 auth/client/gateway 拼成 pipeline 需要的 deps，不改 pipeline 一行逻辑。
import { chatKeyOf } from '../paths.mjs';
import { createTokenProvider } from './auth.mjs';
import { createQqBotClient } from './client.mjs';
import { createQqBotGateway, INTENTS_GROUP_AND_C2C } from './gateway.mjs';
import { parseQqBotEvent, planMedia } from './parse.mjs';
import { sendQqReply } from './send.mjs';

export const DEFAULT_API_BASE = 'https://api.bot.qq.com';

/**
 * AppSecret 不该写进配置文件，允许用环境变量兜底；appId 同理（同一个机器人换环境时很常见）。
 * 校验与运行共用这一份解析结果，避免 --check 通过而启动失败。
 */
export function resolveQqBotConfig(config = {}, env = {}) {
  const raw = config?.qqbot ?? {};
  const appId = String(raw.appId ?? '').trim() || String(env.QQBOT_APP_ID ?? '').trim();
  const clientSecret = String(raw.clientSecret ?? '').trim() || String(env.QQBOT_CLIENT_SECRET ?? '').trim();
  return {
    appId,
    clientSecret,
    apiBase: String(raw.apiBase || DEFAULT_API_BASE).replace(/\/+$/, ''),
    intents: Number.isFinite(Number(raw.intents)) ? Math.floor(Number(raw.intents)) : INTENTS_GROUP_AND_C2C,
    shard: Array.isArray(raw.shard) && raw.shard.length === 2 ? raw.shard : [0, 1],
    reconnectMinMs: raw.reconnectMinMs,
    reconnectMaxMs: raw.reconnectMaxMs,
    requestTimeoutMs: raw.requestTimeoutMs,
    msgSeqStart: raw.msgSeqStart,
    maxPassiveReplies: raw.maxPassiveReplies,
  };
}

export function qqBotProblems(config = {}, env = {}) {
  const resolved = resolveQqBotConfig(config, env);
  const problems = [];
  if (!resolved.appId) problems.push('qqbot.appId 为空：需要一个 QQ 机器人 AppID（也可用环境变量 QQBOT_APP_ID）');
  if (!resolved.clientSecret) {
    problems.push('qqbot.clientSecret 为空：需要一个机器人 AppSecret（建议用环境变量 QQBOT_CLIENT_SECRET，不要写进配置文件）');
  }
  if (!/^https?:\/\//i.test(resolved.apiBase)) {
    problems.push('qqbot.apiBase 必须以 http:// 或 https:// 开头，当前为 ' + JSON.stringify(resolved.apiBase));
  }
  return problems;
}

export function createQqBotAdapter({ config = {}, logger = null, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, env = {} } = {}) {
  const resolved = resolveQqBotConfig(config, env);

  const tokenProvider = createTokenProvider({
    appId: resolved.appId,
    clientSecret: resolved.clientSecret,
    apiBase: resolved.apiBase,
    fetchImpl,
    logger,
    timeoutMs: resolved.requestTimeoutMs,
  });

  const client = createQqBotClient({
    config: { ...config?.qqbot, apiBase: resolved.apiBase, requestTimeoutMs: resolved.requestTimeoutMs },
    tokenProvider,
    fetchImpl,
    logger,
  });

  const gateway = createQqBotGateway({
    client,
    tokenProvider,
    config: {
      intents: resolved.intents,
      shard: resolved.shard,
      reconnectMinMs: resolved.reconnectMinMs,
      reconnectMaxMs: resolved.reconnectMaxMs,
    },
    logger,
    WebSocketImpl,
  });

  const deps = {
    // appId 必须在这一层注入：QQ 事件体里没有"机器人自己的 id"，只能由配置补
    parseEvent: (raw) => parseQqBotEvent(raw, { appId: resolved.appId }),
    planMedia,
    sendReply: sendQqReply,
    chatKeyOf,
  };

  return {
    client,
    deps,
    tokenProvider,
    gateway,
    resolved,
    start(onEvent) {
      return gateway.start(onEvent);
    },
    stop() {
      return gateway.stop();
    },
    status() {
      return { gateway: gateway.status(), token: tokenProvider.state(), appId: resolved.appId };
    },
  };
}
