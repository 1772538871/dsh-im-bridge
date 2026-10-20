// 网关状态机的全部依据来自官方 WebSocket 文档：
// op10 Hello → op2 Identify（或 op6 Resume）→ op11 心跳 ack → op7 重连 / op9 无效会话。
const DEFAULT_RECONNECT_MIN_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30000;
// 文档：GROUP_AND_C2C_EVENT (1 << 25) 同时覆盖 C2C_MESSAGE_CREATE 与 GROUP_AT_MESSAGE_CREATE
export const INTENTS_GROUP_AND_C2C = 1 << 25;
const MAX_UNACKED = 2;

function reasonOf(error) {
  if (!error) return 'unknown';
  return String(error.message ?? error);
}

function bind(socket, type, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(type, handler);
    return;
  }
  // 测试用的假 socket 可能只有 on* 属性
  socket['on' + type] = handler;
}

export function createQqBotGateway({
  client,
  tokenProvider,
  config = {},
  logger = null,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  if (!client || typeof client.getGateway !== 'function') {
    throw new Error('createQqBotGateway: 需要提供 client.getGateway');
  }
  if (!tokenProvider || typeof tokenProvider.getToken !== 'function') {
    throw new Error('createQqBotGateway: 需要提供 tokenProvider');
  }

  const minMs = Number.isFinite(config.reconnectMinMs) && config.reconnectMinMs >= 0 ? Math.floor(config.reconnectMinMs) : DEFAULT_RECONNECT_MIN_MS;
  const maxMs = Number.isFinite(config.reconnectMaxMs) && config.reconnectMaxMs >= minMs ? Math.floor(config.reconnectMaxMs) : Math.max(DEFAULT_RECONNECT_MAX_MS, minMs);
  const intents = Number.isFinite(Number(config.intents)) ? Math.floor(Number(config.intents)) : INTENTS_GROUP_AND_C2C;
  const shard = Array.isArray(config.shard) && config.shard.length === 2 ? [Math.floor(Number(config.shard[0])) || 0, Math.floor(Number(config.shard[1])) || 1] : [0, 1];

  const state = {
    open: false,
    ready: false,
    stopped: false,
    attempts: 0,
    lastError: null,
    sessionId: null,
    seq: null,
    heartbeatIntervalMs: null,
  };

  let socket = null;
  let handler = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let unacked = 0;

  const log = (level, message, meta) => {
    const fn = logger?.[level];
    if (typeof fn !== 'function') return;
    try {
      fn.call(logger, message, meta);
    } catch {
      /* 日志失败不能影响连接 */
    }
  };

  function socketOpen() {
    return !!(socket && state.open);
  }

  function rawSend(payload) {
    if (!socketOpen()) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      state.lastError = '发送失败：' + reasonOf(error);
      log('warn', 'QQ Bot 网关发送失败', { error: state.lastError });
      return false;
    }
  }

  function clearHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function clearReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function stopTimers() {
    clearHeartbeat();
    clearReconnect();
  }

  function heartbeat(intervalMs) {
    clearHeartbeat();
    state.heartbeatIntervalMs = intervalMs;
    heartbeatTimer = setInterval(() => {
      if (!socketOpen()) return;
      if (unacked >= MAX_UNACKED) {
        // 连着两个周期没有 ack 说明这条连接已经僵死，等 close 事件往往等不到
        log('warn', 'QQ Bot 网关心跳连续无 ack，主动重连', { unacked });
        dropAndReconnect('heartbeat_no_ack');
        return;
      }
      if (rawSend({ op: 1, d: state.seq })) unacked += 1;
    }, intervalMs);
    // 常驻进程里定时器不该独自吊住事件循环
    heartbeatTimer.unref?.();
  }

  async function authenticate() {
    let token;
    try {
      token = await tokenProvider.getToken();
    } catch (error) {
      state.lastError = '获取 token 失败：' + reasonOf(error);
      log('error', 'QQ Bot 鉴权前取 token 失败', { error: state.lastError });
      dropAndReconnect('token_unavailable');
      return;
    }
    if (!socketOpen()) return;

    if (state.sessionId && state.seq !== null) {
      const resumed = rawSend({ op: 6, d: { token: 'QQBot ' + token, session_id: state.sessionId, seq: state.seq } });
      log('info', 'QQ Bot 网关 Resume 已发送', { sessionId: state.sessionId, seq: state.seq, sent: resumed });
      return;
    }
    // properties 官方注明"目前无实际作用"，填成可辨识的身份只为日志排查方便
    const sent = rawSend({
      op: 2,
      d: {
        token: 'QQBot ' + token,
        intents,
        shard,
        properties: { $os: process.platform, $browser: 'dsh-im-bridge', $device: 'dsh-im-bridge' },
      },
    });
    log('info', 'QQ Bot 网关 Identify 已发送', { intents, shard, sent });
  }

  function scheduleReconnect(reason) {
    if (state.stopped || reconnectTimer) return;
    const delay = Math.min(maxMs, Math.max(minMs, minMs * Math.pow(2, state.attempts)));
    state.attempts += 1;
    log('warn', 'QQ Bot 网关将在稍后重连', { reason, delayMs: delay, attempts: state.attempts });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function dropAndReconnect(reason) {
    const current = socket;
    socket = null;
    state.open = false;
    state.ready = false;
    state.lastError = reason;
    stopTimers();
    if (current) {
      try {
        current.close();
      } catch {
        /* 关闭失败的连接只剩重连一条路 */
      }
    }
    scheduleReconnect(reason);
  }

  function handlePayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    const op = Number(payload.op);

    if (Number.isFinite(payload.s)) state.seq = payload.s;

    if (op === 10) {
      const wanted = Number(payload.d?.heartbeat_interval);
      const intervalMs = Number.isFinite(wanted) && wanted > 0 ? wanted : 45000;
      heartbeat(intervalMs);
      void authenticate();
      return;
    }
    if (op === 11) {
      unacked = 0;
      return;
    }
    if (op === 1) {
      // 文档把心跳标成 Send/Receive：服务端主动要心跳时必须立刻回
      rawSend({ op: 1, d: state.seq });
      return;
    }
    if (op === 7) {
      log('info', 'QQ Bot 网关要求重连（op7）');
      dropAndReconnect('server_reconnect');
      return;
    }
    if (op === 9) {
      log('warn', 'QQ Bot 网关会话无效（op9），丢弃 session 后重新 Identify');
      state.sessionId = null;
      state.seq = null;
      dropAndReconnect('invalid_session');
      return;
    }
    if (op !== 0) return;

    const type = typeof payload.t === 'string' ? payload.t : '';
    if (type === 'READY') {
      state.ready = true;
      state.sessionId = typeof payload.d?.session_id === 'string' ? payload.d.session_id : null;
      state.attempts = 0;
      log('info', 'QQ Bot 网关就绪（READY）', { sessionId: state.sessionId, shard: payload.d?.shard ?? null });
      return;
    }
    if (type === 'RESUMED') {
      state.ready = true;
      state.attempts = 0;
      log('info', 'QQ Bot 网关已恢复（RESUMED）', { seq: state.seq });
      return;
    }
    if (type === '') return;
    try {
      handler?.(payload);
    } catch (error) {
      log('error', 'QQ Bot 事件处理抛错', { type, error: reasonOf(error) });
    }
  }

  function attach(current) {
    bind(current, 'open', () => {
      state.open = true;
      state.lastError = null;
      unacked = 0;
      log('debug', 'QQ Bot 网关连接已建立，等待 op10 Hello');
    });

    bind(current, 'message', (event) => {
      const raw = event && typeof event === 'object' ? event.data : null;
      if (typeof raw !== 'string') return;
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        log('warn', 'QQ Bot 网关收到非 JSON 帧，已忽略');
        return;
      }
      handlePayload(payload);
    });

    bind(current, 'error', (event) => {
      state.lastError = '连接错误：' + String(event?.message ?? event?.error?.message ?? 'unknown');
      log('warn', 'QQ Bot 网关连接错误', { error: state.lastError });
    });

    bind(current, 'close', (event) => {
      // 已经被 dropAndReconnect 换掉的旧连接，其 close 事件不能再触发第二轮重连
      if (socket !== current) return;
      socket = null;
      state.open = false;
      state.ready = false;
      stopTimers();
      const code = Number(event?.code);
      log('warn', 'QQ Bot 网关连接关闭', { code: Number.isFinite(code) ? code : null });
      // 4001/4002/4010-4014 这类不可重试错误必须暴露给上层，而不是无声重连
      if (Number.isFinite(code) && (code === 4001 || code === 4002 || (code >= 4010 && code <= 4014) || code === 4914 || code === 4915)) {
        state.lastError = '不可重试的网关错误码 ' + code;
        log('error', 'QQ Bot 网关返回不可重试错误，停止重连', { code });
        state.stopped = true;
        return;
      }
      scheduleReconnect('socket_closed');
    });
  }

  async function connect() {
    if (state.stopped) return;
    clearReconnect();
    if (typeof WebSocketImpl !== 'function') {
      state.lastError = '运行环境没有全局 WebSocket';
      log('error', '缺少 WebSocket 实现，无法连接 QQ Bot 网关');
      state.stopped = true;
      return;
    }

    let url = '';
    try {
      url = (await client.getGateway()).url;
    } catch (error) {
      state.lastError = '获取网关地址失败：' + reasonOf(error);
      log('error', 'QQ Bot 获取 WSS 接入点失败', { error: state.lastError });
      scheduleReconnect('gateway_unavailable');
      return;
    }
    if (!url) {
      state.lastError = '网关地址为空';
      scheduleReconnect('gateway_empty');
      return;
    }
    if (state.stopped) return;

    let current;
    try {
      current = new WebSocketImpl(url);
    } catch (error) {
      state.lastError = '创建 WebSocket 失败：' + reasonOf(error);
      scheduleReconnect('socket_construct_failed');
      return;
    }
    socket = current;
    attach(current);
  }

  return {
    async start(onEvent) {
      handler = typeof onEvent === 'function' ? onEvent : null;
      state.stopped = false;
      state.attempts = 0;
      await connect();
    },
    async stop() {
      state.stopped = true;
      stopTimers();
      const current = socket;
      socket = null;
      state.open = false;
      state.ready = false;
      if (!current) return;
      try {
        current.close();
      } catch (error) {
        log('warn', '关闭 QQ Bot 网关连接失败', { error: reasonOf(error) });
      }
    },
    isOpen() {
      return socketOpen();
    },
    status() {
      return {
        open: state.open,
        ready: state.ready,
        stopped: state.stopped,
        attempts: state.attempts,
        lastError: state.lastError,
        sessionId: state.sessionId,
        seq: state.seq,
        heartbeatIntervalMs: state.heartbeatIntervalMs,
      };
    },
    // 单测需要在不真的等 WS 时直接喂一帧
    _handlePayload: handlePayload,
  };
}
