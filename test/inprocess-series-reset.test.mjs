import test from 'node:test';
import assert from 'node:assert/strict';
import { installSeriesReset } from '../src/inprocess-runner.mjs';

function fakeAgentCtx() {
  const handlers = new Map();
  return {
    on(name, fn) { handlers.set(name, fn); },
    emit(name, payload) { const fn = handlers.get(name); return fn ? fn(payload, () => {}) : undefined; },
    handlers,
  };
}

test('呈现切换后：下一轮 pre-step 返回 startsRequestSeries（重置工具声明基线）', async () => {
  const ctx = fakeAgentCtx();
  assert.equal(installSeriesReset(ctx), true);
  // 没有切换时：原样透传
  const nextEnter = async () => ({ kind: 'enter', messages: [{ id: 'm1' }] });
  const first = await ctx.handlers.get('agent/pre-step')({}, nextEnter);
  assert.deepEqual(first, { kind: 'enter', messages: [{ id: 'm1' }] });
  assert.equal(first.startsRequestSeries, undefined);

  // 预设切换呈现后：只在下一次 pre-step 上打标，然后自动清除
  ctx.emit('tools/presentation-changed', { mode: 'ptc' });
  const second = await ctx.handlers.get('agent/pre-step')({}, nextEnter);
  assert.equal(second.startsRequestSeries, true);
  const third = await ctx.handlers.get('agent/pre-step')({}, nextEnter);
  assert.equal(third.startsRequestSeries, undefined, '只重置一次，避免每轮都丢前缀复用');
});

test('呈现切换后若本轮 step 被拒绝：不硬塞 startsRequestSeries', async () => {
  const ctx = fakeAgentCtx();
  installSeriesReset(ctx);
  ctx.emit('tools/presentation-changed', {});
  const rejected = await ctx.handlers.get('agent/pre-step')({}, async () => ({ kind: 'reject' }));
  assert.deepEqual(rejected, { kind: 'reject' });
});

test('ctx 没有 on() 时返回 false，不抛', () => {
  assert.equal(installSeriesReset({}), false);
  assert.equal(installSeriesReset(null), false);
});
