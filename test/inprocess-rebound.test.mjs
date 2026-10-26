import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFLICT_RETRY_DELAYS_MS, createInProcessRunner } from '../src/inprocess-runner.mjs';

const CONFIG = { dsh: { cwd: '', timeoutMs: 5000, runner: 'inprocess' } };
const CONFLICT_TEXT = 'session "s-1" is already owned by an active write handle';

/** conflicts：前 N 次 create 都以"写句柄被占用"失败，之后正常。 */
function makeAgents({ conflicts = 0 } = {}) {
  const state = { attempts: [], created: [], disposal: [], prompted: [], disposed: [] };
  let blocked = conflicts;
  const service = {
    async create(options) {
      state.attempts.push(options.sessionId);
      if (blocked > 0) {
        blocked -= 1;
        throw new Error(CONFLICT_TEXT);
      }
      state.created.push(options.sessionId);
      const events = [];
      const session = {
        get seq() {
          return events.length;
        },
        eventAt: (index) => events[index],
      };
      const agent = {
        session,
        followup(message) {
          state.prompted.push(message);
          events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } });
          events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
        },
        whenIdle: () => Promise.resolve(),
        cancel() {},
      };
      return {
        agent,
        async dispose() {
          state.disposed.push(options.sessionId);
        },
      };
    },
  };
  return { service, state };
}

function ctxOf(agents) {
  return {
    get(name) {
      if (name === 'agents') return agents;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
}

function memoryLogger() {
  const lines = [];
  const push = (level) => (message, extra) => lines.push({ level, message, extra });
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

test('inprocess：退避间隔是 200/600/1200 毫秒', () => {
  assert.deepEqual(CONFLICT_RETRY_DELAYS_MS, [200, 600, 1200]);
});

test('inprocess：冲突一次后重试成功——仍用原会话，不换 id、不标 rebound', async () => {
  const { service, state } = makeAgents({ conflicts: 1 });
  const logger = memoryLogger();
  const runner = createInProcessRunner({ ctx: ctxOf(service), config: CONFIG, logger, retryDelaysMs: [1, 1, 1] });

  const result = await runner.run({ prompt: '在吗', sessionId: 's-1' });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 's-1');
  assert.equal(result.rebound, undefined);
  assert.deepEqual(state.attempts, ['s-1', 's-1'], '首次 + 一次重试');
  const ok = logger.lines.find((line) => /退避重试拿到会话/.test(line.message));
  assert.equal(ok.extra.attempt, 1);
  await runner.stop();
});

test('inprocess：三次退避都冲突才换新会话，result.rebound 为 true 且日志带 reboundFrom', async () => {
  const { service, state } = makeAgents({ conflicts: 4 });
  const logger = memoryLogger();
  const runner = createInProcessRunner({ ctx: ctxOf(service), config: CONFIG, logger, retryDelaysMs: [1, 1, 1] });

  const result = await runner.run({ prompt: '在吗', sessionId: 's-1' });

  assert.equal(result.ok, true);
  assert.equal(result.rebound, true);
  assert.match(result.sessionId, /^session-[0-9a-f-]{36}$/);
  assert.notEqual(result.sessionId, 's-1');
  assert.equal(state.attempts.filter((id) => id === 's-1').length, 4, '首次 + 3 次退避重试');
  assert.equal(state.attempts.length, 5);

  const warn = logger.lines.find((line) => line.level === 'warn' && /改用新会话继续/.test(line.message));
  assert.equal(warn.extra.reboundFrom, 's-1');
  assert.equal(warn.extra.newSessionId, result.sessionId);
  assert.equal(warn.extra.attempts, 3);
  await runner.stop();
});

test('inprocess：换新会话后照常出答案，答题用的是新 handle', async () => {
  const { service, state } = makeAgents({ conflicts: 4 });
  const runner = createInProcessRunner({ ctx: ctxOf(service), config: CONFIG, retryDelaysMs: [1, 1, 1] });

  const result = await runner.run({ prompt: '在吗', sessionId: 's-1' });

  assert.equal(result.text, 'ok');
  assert.equal(state.prompted.length, 1);
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0], result.sessionId);
  await runner.stop();
});

test('inprocess：不是写句柄冲突的错不做退避，直接 runner_error', async () => {
  const state = { attempts: 0 };
  const service = {
    async create() {
      state.attempts += 1;
      throw new Error('provider adapter 未注册');
    },
  };
  const runner = createInProcessRunner({ ctx: ctxOf(service), config: CONFIG, retryDelaysMs: [1, 1, 1] });

  const result = await runner.run({ prompt: '在吗', sessionId: 's-1' });

  assert.equal(result.reason, 'runner_error');
  assert.match(result.error, /provider adapter/);
  assert.equal(state.attempts, 1, '这种错重试也不会好');
});
