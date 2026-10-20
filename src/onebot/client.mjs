// OneBot 11 正向 WebSocket 客户端。鉴权只能走查询参数：Node 内置 WebSocket 不支持自定义请求头。
export class OneBotError extends Error {
  constructor(message, { action = null, retcode = null, msg = null, echo = null, code = null } = {}) {
    super(message);
    this.name = 'OneBotError';
    this.action = action;
    this.retcode = retcode;
    this.msg = msg;
    this.echo = echo;
    this.code = code;
  }
}

const DEFAULT_CALL_TIMEOUT_MS = 15000;
// 已经明确知道不是聊天消息的 post_type，其余（message 与未知类型）都透传给上层。
const NON_MESSAGE_POST_TYPES = new Set(['meta_event', 'notice', 'request', 'message_sent', 'heartbeat']);

function frameToText(data) {
  if (typeof data === 'string') return data;
  if (data == null) return '';
  if (typeof data.toString === 'function') return data.toString();
  return '';
}

// access_token 必须出现在查询串里；url 自身可能已带查询参数，也可能以 ? / & 结尾。
function withToken(url, token) {
  if (!token) return url;
  const sep = /[?&]$/.test(url) ? '' : url.includes('?') ? '&' : '?';
  return `${url}${sep}access_token=${encodeURIComponent(token)}`;
}

export function createOneBotClient({
  url,
  accessToken = '',
  logger = null,
  onEvent = null,
  onStatus = null,
  // 契约 §1 的 onebot.reconnectMinMs / reconnectMaxMs 由调用方带进来；缺省值与契约默认配置一致。
  reconnectMinMs = 1000,
  reconnectMaxMs = 30000,
} = {}) {
  if (!url || typeof url !== 'string') throw new Error('createOneBotClient 需要 url');

  const minDelay = Math.max(1, Number(reconnectMinMs) || 1000);
  const maxDelay = Math.max(minDelay, Number(reconnectMaxMs) || 30000);

  let log = logger;
  try {
    if (typeof logger?.child === 'function') log = logger.child('onebot');
  } catch {
    log = logger;
  }

  let socket = null;
  let stopped = true;
  let open = false;
  let lastError = null;
  let attempts = 0;
  let echoSeq = 0;
  let nextDelay = minDelay;
  let reconnectTimer = null;
  const pending = new Map();

  function emit(level, message, meta) {
    const fn = log?.[level];
    if (typeof fn !== 'function') return;
    try {
      if (meta === undefined) fn.call(log, message);
      else fn.call(log, message, meta);
    } catch {
      // 日志后端坏掉不能影响协议收发
    }
  }

  function status() {
    return { open, lastError, attempts };
  }

  function emitStatus() {
    if (typeof onStatus !== 'function') return;
    try {
      onStatus(status());
    } catch (err) {
      emit('error', 'onStatus 回调抛错', { error: String(err?.message ?? err) });
    }
  }

  function settlePending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function forward(raw) {
    if (typeof onEvent !== 'function') return;
    try {
      const ret = onEvent(raw);
      if (ret && typeof ret.catch === 'function') {
        ret.catch((err) => emit('error', 'onEvent 处理失败', { error: String(err?.message ?? err) }));
      }
    } catch (err) {
      emit('error', 'onEvent 处理失败', { error: String(err?.message ?? err) });
    }
  }

  function handleFrame(data) {
    const text = frameToText(data);
    if (!text) return;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      emit('warn', '收到非 JSON 帧，已丢弃', { error: String(err?.message ?? err) });
      return;
    }
    if (!payload || typeof payload !== 'object') {
      emit('warn', '收到非对象帧，已丢弃');
      return;
    }

    if (payload.echo !== undefined && payload.echo !== null && pending.has(String(payload.echo))) {
      const key = String(payload.echo);
      const entry = pending.get(key);
      pending.delete(key);
      clearTimeout(entry.timer);
      // retcode 缺省按 0 处理：部分实现只在失败帧里带它。
      const retcode = payload.retcode === undefined ? 0 : Number(payload.retcode);
      if (retcode !== 0) {
        const detail = payload.msg ?? payload.wording ?? '';
        entry.reject(new OneBotError(`调用 ${entry.action} 失败: retcode=${retcode} ${detail}`.trim(), {
          action: entry.action,
          retcode,
          msg: payload.msg ?? payload.wording ?? null,
          echo: key,
          code: 'retcode',
        }));
        return;
      }
      entry.resolve(payload.data === undefined ? null : payload.data);
      return;
    }

    if (payload.echo !== undefined && payload.echo !== null) {
      emit('warn', '收到无人认领的 echo 响应，已丢弃', { echo: payload.echo });
      return;
    }

    const postType = payload.post_type;
    if (typeof postType === 'string' && NON_MESSAGE_POST_TYPES.has(postType)) return;
    forward(payload);
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = nextDelay;
    nextDelay = Math.min(nextDelay * 2, maxDelay);
    emit('warn', '连接已断开，准备重连', { delayMs: delay, attempts });
    emitStatus();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    if (typeof reconnectTimer?.unref === 'function') reconnectTimer.unref();
  }

  function connect() {
    if (stopped) return;
    // 每次连接都重新读全局 WebSocket：Node 20 早期没有这个全局，测试也会临时替换它。
    const WS = globalThis.WebSocket;
    if (typeof WS !== 'function') {
      lastError = '当前运行时没有全局 WebSocket';
      emit('error', lastError);
      scheduleReconnect();
      return;
    }

    let ws;
    try {
      ws = new WS(withToken(url, accessToken));
    } catch (err) {
      lastError = String(err?.message ?? err);
      emit('error', '建立 WebSocket 失败', { error: lastError });
      scheduleReconnect();
      return;
    }
    socket = ws;
    attempts += 1;

    ws.onopen = () => {
      if (socket !== ws) return;
      open = true;
      lastError = null;
      attempts = 0;
      nextDelay = minDelay;
      emit('info', 'OneBot 连接已建立');
      emitStatus();
    };
    ws.onmessage = (event) => handleFrame(event?.data);
    ws.onerror = (event) => {
      if (socket !== ws) return;
      lastError = String(event?.message ?? event?.error?.message ?? 'websocket error');
      emit('error', 'OneBot 连接错误', { error: lastError });
      emitStatus();
    };
    ws.onclose = (event) => {
      const wasOpen = open;
      open = false;
      if (socket === ws) socket = null;
      if (stopped) {
        emitStatus();
        return;
      }
      lastError = lastError ?? `连接关闭 code=${event?.code ?? 'unknown'}`;
      if (wasOpen) emit('warn', 'OneBot 连接已关闭');
      emitStatus();
      scheduleReconnect();
    };
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    attempts = 0;
    nextDelay = minDelay;
    connect();
  }

  async function stop() {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const ws = socket;
    socket = null;
    open = false;
    settlePending(new OneBotError('OneBot 客户端已停止', { code: 'stopped' }));
    emitStatus();
    if (!ws) return;

    await new Promise((resolve) => {
      let timer = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      // 覆盖原 handler：停止后即使收到 close 也不能再排重连。
      timer = setTimeout(finish, 300);
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = finish;
        ws.close();
      } catch {
        finish();
      }
    });
  }

  function call(action, params = {}, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
    if (typeof action !== 'string' || !action) {
      return Promise.reject(new OneBotError('call 缺少 action', { code: 'bad_action' }));
    }
    if (!open || !socket) {
      return Promise.reject(new OneBotError('OneBot 连接未打开，无法调用 ' + action, { action, code: 'not_open' }));
    }
    const echo = String((echoSeq += 1));
    let frame;
    try {
      frame = JSON.stringify({ action, params, echo });
    } catch (err) {
      return Promise.reject(new OneBotError('params 无法序列化: ' + String(err?.message ?? err), { action, echo, code: 'bad_params' }));
    }

    const ws = socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(echo);
        reject(new OneBotError(`调用 ${action} 超时（${timeoutMs}ms）`, { action, echo, code: 'timeout' }));
      }, Math.max(1, Number(timeoutMs) || DEFAULT_CALL_TIMEOUT_MS));
      pending.set(echo, { resolve, reject, timer, action });
      try {
        ws.send(frame);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(echo);
        reject(new OneBotError('发送失败: ' + String(err?.message ?? err), { action, echo, code: 'send_failed' }));
      }
    });
  }

  return {
    start,
    stop,
    call,
    isOpen: () => open,
    status,
  };
}
