export function createSerialQueue() {
  const entries = new Map();

  const pendingOf = (entry) => (entry ? entry.pending : 0);

  return {
    run(key, fn) {
      const name = String(key);
      let entry = entries.get(name);
      if (!entry) {
        entry = { tail: Promise.resolve(), pending: 0 };
        entries.set(name, entry);
      }
      entry.pending += 1;
      // 前一个任务失败不能卡死同一个 key 的后续消息，所以两个分支都接着往下走
      const current = entry.tail.then(
        () => fn(),
        () => fn()
      );
      entry.tail = current.then(
        () => undefined,
        () => undefined
      );
      const settle = () => {
        entry.pending -= 1;
        if (entry.pending === 0 && entries.get(name) === entry) entries.delete(name);
      };
      current.then(settle, settle);
      return current;
    },
    pending(key) {
      return pendingOf(entries.get(String(key)));
    },
    size() {
      let total = 0;
      for (const entry of entries.values()) total += entry.pending;
      return total;
    }
  };
}

export function createSemaphore(limit) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
  let active = 0;
  const waiters = [];

  const acquire = () =>
    new Promise((resolveWaiter) => {
      if (active < max) {
        active += 1;
        resolveWaiter();
        return;
      }
      waiters.push(resolveWaiter);
    });

  const release = () => {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      active += 1;
      next();
    }
  };

  return {
    async withPermit(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        // 走到这里可能是正常返回也可能是抛错，许可都必须还回去，否则并发额度会永久泄漏
        release();
      }
    },
    active() {
      return active;
    }
  };
}
