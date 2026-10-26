import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionBinding } from '../src/session-binding.mjs';

function memorySessions() {
  const map = new Map();
  return {
    map,
    get: (key) => map.get(key),
    async set(key, value) {
      map.set(key, value);
    },
    async clear(key) {
      map.delete(key);
    },
  };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('session-binding：两条并发消息不会交叉读到同一个空绑定', async () => {
  const sessions = memorySessions();
  const binding = createSessionBinding({ sessions });
  const seen = [];

  const work = (tag, sessionId, delayMs) =>
    binding.withBinding('private_1', async (scope) => {
      seen.push([tag, await scope.get()]);
      await tick(delayMs);
      await scope.set(sessionId);
    });

  await Promise.all([work('a', 'session-a', 5), work('b', 'session-b', 0)]);

  // 第二条必须在第一条写完绑定之后才读到，所以它看到的是 a 刚落的 id
  assert.deepEqual(seen, [
    ['a', null],
    ['b', 'session-a'],
  ]);
  assert.equal(sessions.map.get('private_1'), 'session-b');
});

test('session-binding：对照组——不加锁时两条消息会同时读到空', async () => {
  const sessions = memorySessions();
  const seen = [];
  const work = async (tag, sessionId) => {
    seen.push([tag, (await sessions.get('private_1')) ?? null]);
    await tick(5);
    await sessions.set('private_1', sessionId);
  };

  await Promise.all([work('a', 'session-a'), work('b', 'session-b')]);
  assert.deepEqual(seen, [
    ['a', null],
    ['b', null],
  ]);
});

test('session-binding：不同 chatKey 之间不排队', async () => {
  const binding = createSessionBinding({ sessions: memorySessions() });
  let active = 0;
  let peak = 0;
  const work = (key) =>
    binding.withBinding(key, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(5);
      active -= 1;
    });

  await Promise.all([work('private_1'), work('private_2')]);
  assert.equal(peak, 2);
});

test('session-binding：reset 排在正在跑的那一轮后面，并回报被清掉的 id', async () => {
  const sessions = memorySessions();
  const binding = createSessionBinding({ sessions });
  const order = [];

  const inflight = binding.withBinding('private_1', async (scope) => {
    await tick(5);
    await scope.set('session-a');
    order.push('run');
  });
  const reset = binding.reset('private_1');

  const cleared = await reset;
  await inflight;

  assert.equal(cleared.sessionId, 'session-a');
  assert.equal(cleared.chatKey, 'private_1');
  assert.equal(sessions.map.has('private_1'), false);
  assert.deepEqual(order, ['run']);
});

test('session-binding：一轮抛错不会卡死同 key 的后续消息', async () => {
  const binding = createSessionBinding({ sessions: memorySessions() });
  await assert.rejects(
    binding.withBinding('private_1', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  const value = await binding.withBinding('private_1', async (scope) => await scope.get());
  assert.equal(value, null);
});

test('session-binding：存储读写失败只降级成日志，不让整轮崩', async () => {
  const lines = [];
  const logger = {
    debug: (message, extra) => lines.push({ level: 'debug', message, extra }),
    info: () => {},
    warn: (message, extra) => lines.push({ level: 'warn', message, extra }),
    error: () => {},
  };
  const sessions = {
    get() {
      throw new Error('disk gone');
    },
    async set() {
      throw new Error('disk gone');
    },
    async clear() {},
  };
  const binding = createSessionBinding({ sessions, logger });

  const outcome = await binding.withBinding('private_1', async (scope) => ({
    got: await scope.get(),
    written: await scope.set('session-a'),
  }));

  assert.deepEqual(outcome, { got: null, written: false });
  assert.equal(lines.filter((line) => line.level === 'warn').length, 2);
});

test('session-binding：status 报在跑的 key 数与最后一次写入时间', async () => {
  const sessions = memorySessions();
  let clock = 1000;
  const binding = createSessionBinding({ sessions, now: () => clock });

  clock = 2000;
  await binding.withBinding('private_1', async (scope) => await scope.set('session-a'));

  const status = binding.status();
  assert.equal(status.chats, 0, '链尾清空后不留 key');
  assert.equal(status.pending, 0);
  assert.equal(status.runs, 1);
  assert.equal(status.lastWriteAt, 2000);
});
