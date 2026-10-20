// access_token 是整条链路的唯一凭证：它一过期，HTTP 与 WS 会同时失效。
// 官方文档说明"在上一个 token 接近过期 60 秒内请求才会拿到新 token"，所以提前 60 秒刷新正好命中窗口。
const DEFAULT_API_BASE = 'https://api.bot.qq.com';
const TOKEN_PATH = '/app/getAppAccessToken';
const DEFAULT_SKEW_MS = 60 * 1000;
const DEFAULT_TTL_MS = 7200 * 1000;

export class QqBotAuthError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = 'QqBotAuthError';
    this.code = code;
    this.status = status;
  }
}

function reasonOf(error) {
  if (!error) return 'unknown';
  if (error.name === 'AbortError') return '请求超时';
  return String(error.message ?? error);
}

export function createTokenProvider({
  appId = '',
  clientSecret = '',
  apiBase = DEFAULT_API_BASE,
  fetchImpl = globalThis.fetch,
  logger = null,
  now = () => Date.now(),
  refreshSkewMs = DEFAULT_SKEW_MS,
  timeoutMs = 15000,
} = {}) {
  const base = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  let cached = { token: '', expiresAt: 0 };
  let inflight = null;

  async function fetchToken() {
    if (!appId || !clientSecret) {
      throw new QqBotAuthError('qqbot.appId / qqbot.clientSecret 未配置，拿不到 access_token');
    }
    if (typeof fetchImpl !== 'function') throw new QqBotAuthError('运行环境没有可用的 fetch');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 15000));
    let response;
    let body;
    try {
      response = await fetchImpl(base + TOKEN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appId, clientSecret }),
        signal: controller.signal,
      });
      const text = await response.text();
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new QqBotAuthError('getAppAccessToken 返回的不是 JSON：' + String(text).slice(0, 200), {
          status: response.status,
        });
      }
    } catch (error) {
      if (error instanceof QqBotAuthError) throw error;
      throw new QqBotAuthError('请求 getAppAccessToken 失败：' + reasonOf(error));
    } finally {
      clearTimeout(timer);
    }

    // 业务错误走响应体 code，HTTP 仍然可能是 200，只看状态码会漏判
    const code = body?.code;
    if (code !== undefined && code !== null && Number(code) !== 0) {
      // 文档强调 message 仅供人工排查、可能随时变，日志里必须同时带上 code
      throw new QqBotAuthError('getAppAccessToken 业务错误（code ' + code + '）：' + String(body?.message ?? ''), {
        code: Number(code),
        status: response.status,
      });
    }

    const token = typeof body?.access_token === 'string' ? body.access_token : '';
    if (!token) {
      throw new QqBotAuthError('getAppAccessToken 响应里没有 access_token', { status: response.status });
    }
    const expiresIn = Number(body?.expires_in);
    const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : DEFAULT_TTL_MS;
    cached = { token, expiresAt: now() + ttlMs };
    logger?.info?.('QQ Bot access_token 已获取', { expiresInSeconds: Math.floor(ttlMs / 1000) });
    return token;
  }

  async function getToken({ force = false } = {}) {
    const stillFresh = cached.token !== '' && now() < cached.expiresAt - refreshSkewMs;
    if (!force && stillFresh) return cached.token;
    // 启动瞬间 HTTP 与 WS 会同时要 token，单飞保证不会打两次接口
    if (!inflight) {
      inflight = fetchToken().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return {
    getToken,
    invalidate() {
      cached = { token: '', expiresAt: 0 };
    },
    async authHeader() {
      return 'QQBot ' + (await getToken());
    },
    state() {
      return { hasToken: cached.token !== '', expiresAt: cached.expiresAt };
    },
  };
}
