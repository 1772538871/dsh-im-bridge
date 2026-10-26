/**
 * 会话绑定事务：把"读绑定 → 跑一轮 → 写绑定"整段当成一个临界区串行化。
 *
 * 为什么需要：一条新消息进来时聊天键还没有绑定，两条并发消息会同时读到"空"，
 * 各自建一个会话，后写的把先写的覆盖掉 —— 上下文被劈成两半，
 * 而且两个 agent 还同时占着写句柄，网页里点开那条会话就是空白。
 *
 * 实现是"每个 chatKey 一条 Promise 链"：后到的等前一个结束（失败也算结束），
 * 链尾一空就把键删掉，长跑进程里 Map 不会无限长。
 * 绑定本身仍存在 sessions store（chatKey → sessionId），不新增存储格式。
 */
export function createSessionBinding({ sessions = null, logger = null, now = () => Date.now() } = {}) {
  const chains = new Map();
  const queued = new Map();
  const state = { runs: 0, lastWriteAt: null };

  const log = (level, message, extra) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](message, extra);
    } catch {
      // 日志后端坏掉不能影响会话绑定
    }
  };

  async function read(chatKey) {
    try {
      const value = await sessions?.get?.(chatKey);
      return typeof value === 'string' && value !== '' ? value : null;
    } catch (error) {
      log('warn', '读取会话绑定失败', { chatKey, error: String(error?.message ?? error) });
      return null;
    }
  }

  async function write(chatKey, sessionId) {
    try {
      if (sessionId === null || sessionId === undefined || sessionId === '') {
        await sessions?.clear?.(chatKey);
      } else {
        await sessions?.set?.(chatKey, sessionId);
      }
      state.lastWriteAt = now();
      return true;
    } catch (error) {
      log('warn', '写入会话绑定失败', { chatKey, error: String(error?.message ?? error) });
      return false;
    }
  }

  /** 把 fn 排到该 chatKey 的锁后面；scope 里的读写都发生在锁内。 */
  function withBinding(chatKey, fn) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('withBinding: fn 必须是函数'));
    const key = String(chatKey ?? '');

    const invoke = async () => {
      state.runs += 1;
      const scope = {
        chatKey: key,
        get: () => read(key),
        set: (sessionId) => write(key, sessionId)
      };
      return await fn(scope);
    };

    const previous = chains.get(key) ?? Promise.resolve();
    queued.set(key, (queued.get(key) ?? 0) + 1);
    const current = previous.then(invoke, invoke);
    let tail = null;
    const settle = () => {
      const left = (queued.get(key) ?? 1) - 1;
      if (left > 0) {
        queued.set(key, left);
        return;
      }
      queued.delete(key);
      if (chains.get(key) === tail) chains.delete(key);
    };
    tail = current.then(
      () => settle(),
      () => settle()
    );
    chains.set(key, tail);
    return current;
  }

  /** 清掉一个 chatKey 的绑定；排在正在跑的那一轮后面，所以"下一条消息开始生效"。 */
  function reset(chatKey) {
    const key = String(chatKey ?? '');
    return withBinding(key, async (scope) => {
      const previousSessionId = await scope.get();
      await scope.set(null);
      log('info', '会话绑定已清空', { chatKey: key, previousSessionId });
      return { chatKey: key, sessionId: previousSessionId };
    });
  }

  function status() {
    let pending = 0;
    for (const value of queued.values()) pending += value;
    return { chats: chains.size, pending, runs: state.runs, lastWriteAt: state.lastWriteAt };
  }

  return { withBinding, reset, status };
}
