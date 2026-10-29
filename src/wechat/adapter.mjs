// 微信适配器：轮询桥的 /events，把事件映射成内核认识的 message，再交给 pipeline。
// 与 onebot 那条线的差别只有"消息从哪儿来"：产物字段、deps 契约都对齐 src/onebot/parse.mjs。
import { chatKeyOf } from '../paths.mjs';
import { createWechatClient } from './client.mjs';

export const DEFAULT_POLL_MS = 1000;
// 低于 200ms 只是把本机 CPU 和微信客户端一起拖慢，收益为零
export const MIN_POLL_MS = 200;

function toText(value) {
  return value === undefined || value === null ? '' : String(value);
}

export function normalizePollMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.floor(n));
}

/**
 * 桥事件 → 内部 message（字段与 onebot 的 parseEvent 产物一一对齐）。
 * 返回 null = 这条不该进 pipeline：自己发的、空发送者、空文本。
 */
export function wechatMessageOf(event, { selfWxid = '' } = {}) {
  if (!event || typeof event !== 'object') return null;
  const from = toText(event.from).trim();
  const text = toText(event.text);
  if (from === '' || text === '') return null;
  // 自己发的消息必须在这里拦掉：否则机器人回完一句，下一轮又把这句话当新问题答一遍
  if (selfWxid !== '' && from === selfWxid) return null;
  const seq = Number(event.seq);
  const ts = Number(event.ts);
  const stamp = Number.isFinite(ts) ? Math.floor(ts) : 0;
  return {
    messageId: Number.isFinite(seq) ? 'wx_' + Math.floor(seq) : null,
    chatType: 'private',
    userId: from,
    groupId: null,
    selfId: selfWxid,
    senderName: null,
    // onebot 的 time 是秒；微信这边 ts 是毫秒，两个都留着，别让下游猜
    time: stamp > 0 ? Math.floor(stamp / 1000) : 0,
    ts: stamp,
    seq: Number.isFinite(seq) ? Math.floor(seq) : 0,
    text,
    segments: [{ type: 'text', data: { text } }],
    atTargets: [],
    replyTo: null
  };
}

/** 已经归一化过的对象原样认，没归一化的按桥事件再映射一次（deps.parseEvent 只有这一个入口）。 */
export function makeParseEvent(selfWxidOf = () => '') {
  return (raw) => {
    if (!raw || typeof raw !== 'object') return { kind: 'unknown' };
    if (raw.kind === 'message' && raw.message) return raw;
    if (raw.chatType === 'private' && typeof raw.userId === 'string') return { kind: 'message', message: raw };
    const message = wechatMessageOf(raw, { selfWxid: toText(selfWxidOf()) });
    return message === null ? { kind: 'unknown' } : { kind: 'message', message };
  };
}

/**
 * 轮询式适配器：与 napcat/qqbot 适配器同构（start/stop/status/send），
 * 另外多一个 pollOnce 给测试驱动——单测不该靠真的等 1 秒。
 */
export function createWechatAdapter({ client = null, logger = null, pollMs = DEFAULT_POLL_MS, fetchImpl = undefined, baseUrl = '', now = () => Date.now() } = {}) {
  const api = client && typeof client.events === 'function' ? client : createWechatClient({ baseUrl, fetchImpl });
  const interval = normalizePollMs(pollMs);
  const state = {
    started: false,
    running: false,
    timer: null,
    inflight: null,
    cursor: 0,
    selfWxid: '',
    nickname: '',
    loggedIn: false,
    lastError: null,
    lastPollAt: 0,
    polls: 0,
    delivered: 0,
    skippedSelf: 0
  };
  let handler = null;

  const warn = (message, extra) => {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(message, extra);
    } catch {
      // 日志后端坏掉不能影响收消息
    }
  };

  function rememberSelf(status) {
    if (!status || status.ok !== true) return;
    state.loggedIn = status.loggedIn === true;
    if (status.selfWxid !== '') state.selfWxid = status.selfWxid;
    state.nickname = status.nickname;
  }

  async function refreshSelf() {
    const status = await api.status();
    rememberSelf(status);
    if (status && status.ok === false) state.lastError = status.error;
    return status;
  }

  // 一轮 = 拉一次增量。节流放在这里而不是靠定时器：定时器抖动不该变成"瞬时连拉两次"。
  async function pollOnce({ force = false } = {}) {
    const at = now();
    if (!force && state.lastPollAt !== 0 && at - state.lastPollAt < interval) {
      return { ok: true, skipped: true, delivered: 0 };
    }
    state.lastPollAt = at;
    state.polls += 1;
    // 还不知道自己是谁时不认识"自己发的消息"，先问一次（本地请求，代价可忽略）
    if (state.selfWxid === '') await refreshSelf();
    const got = await api.events({ since: state.cursor });
    if (!got || got.ok !== true) {
      state.lastError = toText(got && got.error) || '拉取微信消息失败';
      warn('微信消息拉取失败', { error: state.lastError });
      return { ok: false, error: state.lastError, delivered: 0 };
    }
    state.lastError = null;
    state.cursor = got.next;
    let delivered = 0;
    for (const event of got.events) {
      const message = wechatMessageOf(event, { selfWxid: state.selfWxid });
      if (message === null) {
        if (state.selfWxid !== '' && toText(event.from) === state.selfWxid) state.skippedSelf += 1;
        continue;
      }
      delivered += 1;
      state.delivered += 1;
      if (typeof handler === 'function') {
        try {
          const ret = handler(message);
          if (ret && typeof ret.catch === 'function') ret.catch(() => {});
        } catch (error) {
          // 单条消息失败不能打断轮询，否则后面所有消息都收不到
          warn('处理微信消息失败', { error: toText((error && error.message) || error) });
        }
      }
    }
    return { ok: true, delivered, skipped: false };
  }

  function tick() {
    if (state.inflight !== null) return;
    state.inflight = pollOnce()
      .catch(() => ({ ok: false, delivered: 0 }))
      .then((result) => {
        state.inflight = null;
        return result;
      });
  }

  return {
    platform: 'wechat',
    client: api,
    pollMs: interval,
    deps: {
      parseEvent: makeParseEvent(() => state.selfWxid),
      // 微信这一版只做文本：没有媒体规划能力，pipeline 会把 [[sendfile:]] 降级成一句说明
      planMedia: () => null,
      sendReply: async ({ message = null, text = '' } = {}) => {
        const to = toText(message && message.userId).trim();
        if (to === '') return { sent: 0, failed: 1 };
        const result = await api.send({ to, text });
        if (result && result.ok === true) return { sent: 1, failed: 0 };
        state.lastError = toText(result && result.error) || '发送失败';
        warn('微信回复发不出去', { error: state.lastError });
        return { sent: 0, failed: 1 };
      },
      chatKeyOf
    },
    start(onEvent) {
      handler = typeof onEvent === 'function' ? onEvent : handler;
      if (state.started) return Promise.resolve({ ok: true, already: true });
      state.started = true;
      state.running = true;
      // 启动先问一次状态：没登录时用户马上就能在 /status 里看到原因，而不是等第一条消息
      state.inflight = refreshSelf()
        .catch(() => null)
        .then(() => {
          state.inflight = null;
        });
      const timer = setInterval(tick, interval);
      // unref：适配器自身不该拦着进程退出（宿主关掉时 Node 要能干净地走掉）
      if (timer && typeof timer.unref === 'function') timer.unref();
      state.timer = timer;
      return Promise.resolve({ ok: true });
    },
    async stop() {
      state.started = false;
      state.running = false;
      if (state.timer !== null) {
        clearInterval(state.timer);
        state.timer = null;
      }
      if (state.inflight !== null) {
        try {
          await state.inflight;
        } catch {
          // 收尾时的失败没有处置价值
        }
      }
      handler = null;
      return { ok: true };
    },
    status() {
      return {
        platform: 'wechat',
        running: state.running === true,
        pollMs: interval,
        cursor: state.cursor,
        loggedIn: state.loggedIn === true,
        selfWxid: state.selfWxid,
        nickname: state.nickname,
        polls: state.polls,
        delivered: state.delivered,
        skippedSelf: state.skippedSelf,
        lastError: state.lastError
      };
    },
    /** 设置页/测试用的直发口：走同一条 client.send。 */
    async send({ to = '', text = '' } = {}) {
      return api.send({ to, text });
    },
    pollOnce,
    tick
  };
}
