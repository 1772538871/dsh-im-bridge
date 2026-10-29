// 微信桥的 HTTP 客户端：只认 bridge.py 那三个接口，任何失败都折成 {ok:false,error}。
// 注入风格与 src/plugin/napcat-launcher.mjs 一致：fetchImpl 从外部传，测试不碰真网络。
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:19100';
export const DEFAULT_TIMEOUT_MS = 5000;

function toText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

/** 桥地址永远只是"本机某个端口"：末尾斜杠抹掉，空值回落默认，非法值留给调用方校验。 */
export function normalizeBridgeUrl(value) {
  const text = toText(value).trim();
  return (text === '' ? DEFAULT_BRIDGE_URL : text).replace(/\/+$/, '');
}

export function normalizeTimeoutMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

function abortedOf(error) {
  const name = error && error.name ? String(error.name) : '';
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return /abort/i.test(String((error && error.message) || ''));
}

function eventOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seq = Number(raw.seq);
  const from = toText(raw.from).trim();
  if (!Number.isFinite(seq) || from === '') return null;
  const ts = Number(raw.ts);
  return {
    seq: Math.floor(seq),
    ts: Number.isFinite(ts) ? Math.floor(ts) : 0,
    from,
    text: toText(raw.text),
    type: toText(raw.type) || 'text'
  };
}

/**
 * createWechatClient({ baseUrl, fetchImpl, timeoutMs }) → { status, send, events }
 * 三个方法都返回 { ok:true, ... } 或 { ok:false, error }，永不抛：调用方是 pipeline 与设置页，
 * 它们只按 ok 分支走（契约：所有业务失败都 HTTP 200 + ok:false）。
 */
export function createWechatClient({ baseUrl = '', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = normalizeBridgeUrl(baseUrl);
  const limit = normalizeTimeoutMs(timeoutMs);

  async function call(method, path, body) {
    if (typeof fetchImpl !== 'function') {
      return { ok: false, error: '当前环境没有可用的 fetch，连不上微信桥 ' + base };
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // 已经结束的请求再 abort 只会抛，忽略
      }
    }, limit) : null;
    let response;
    let payload;
    try {
      const init = { method, headers: {}, cache: 'no-store' };
      if (controller) init.signal = controller.signal;
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      response = await fetchImpl(base + path, init);
      if (!response || typeof response.status !== 'number') {
        return { ok: false, error: '微信桥返回了无法识别的响应（' + base + '）' };
      }
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: '微信桥返回 HTTP ' + response.status + '：' + base + path };
      }
      try {
        payload = typeof response.json === 'function' ? await response.json() : null;
      } catch {
        return { ok: false, error: '微信桥返回的不是 JSON：确认 ' + base + ' 上跑的是 tools/wcf-bridge/bridge.py' };
      }
    } catch (error) {
      if (abortedOf(error)) {
        return { ok: false, error: '微信桥 ' + limit + ' 毫秒没响应：它可能没启动（python tools/wcf-bridge/bridge.py）' };
      }
      return { ok: false, error: '连不上微信桥 ' + base + '：' + errorText(error) };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: '微信桥返回的不是 JSON 对象：确认 ' + base + ' 上跑的是 tools/wcf-bridge/bridge.py' };
    }
    return { ok: true, payload };
  }

  return {
    base,
    timeoutMs: limit,
    /** 桥活没活、微信登没登。loggedIn=false 时 error 就是那句人话。 */
    async status() {
      const got = await call('GET', '/status');
      if (!got.ok) return { ok: false, error: got.error };
      const payload = got.payload;
      if (payload.ok === false) return { ok: false, error: toText(payload.error) || '微信桥说状态不可用' };
      const received = Number(payload.received);
      return {
        ok: true,
        loggedIn: payload.loggedIn === true,
        selfWxid: toText(payload.selfWxid),
        nickname: toText(payload.nickname),
        received: Number.isFinite(received) ? Math.floor(received) : 0,
        error: toText(payload.error)
      };
    },
    /** 发一条私聊文本。to 是对方 wxid。 */
    async send({ to = '', text = '' } = {}) {
      const target = toText(to).trim();
      const body = toText(text);
      if (target === '') return { ok: false, error: '缺少收件人：需要一个 wxid' };
      if (body === '') return { ok: false, error: '要发的字是空的' };
      const got = await call('POST', '/send', { to: target, text: body });
      if (!got.ok) return { ok: false, error: got.error };
      if (got.payload.ok === false) return { ok: false, error: toText(got.payload.error) || '微信桥没发出去' };
      return { ok: true };
    },
    /** 增量拉事件：since 之后的新消息 + 下一次该用的 next 游标。 */
    async events({ since = 0 } = {}) {
      const from = Number(since);
      const cursor = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0;
      const got = await call('GET', '/events?since=' + cursor);
      if (!got.ok) return { ok: false, error: got.error };
      const payload = got.payload;
      if (payload.ok === false) return { ok: false, error: toText(payload.error) || '微信桥说事件接口不可用' };
      if (!Array.isArray(payload.events)) return { ok: false, error: '微信桥的 events 不是数组，可能版本不匹配' };
      const events = payload.events.map(eventOf).filter(Boolean);
      const next = Number(payload.next);
      // 桥没给 next 时按本批最大 seq 兜底：游标宁可停住，也不能因为一个空响应从头重放
      const fallback = events.reduce((max, item) => (item.seq > max ? item.seq : max), cursor);
      return { ok: true, events, next: Number.isFinite(next) && next >= 0 ? Math.floor(next) : fallback };
    }
  };
}
