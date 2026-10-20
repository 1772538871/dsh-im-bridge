import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalBridge } from '../src/approval-bridge.mjs';

function fakeCtx() {
  const handlers = new Map();
  return { on(name, fn) { handlers.set(name, fn); return () => {}; }, effect(fn) { return fn(); }, handlers };
}

async function run(scope, { ownRegistered = false } = {}) {
  const sent = [];
  const ctx = fakeCtx();
  const bridge = createApprovalBridge({
    ctx, logger: null,
    send: (chatKey, text) => { sent.push({ chatKey, text }); return true; },
    config: { approval: { enabled: true, timeoutMs: 10000, scope } },
  });
  bridge.attach();
  const handler = ctx.handlers.get('approval/request');
  const agent = { id: 'a1' };
  if (ownRegistered) bridge.own(agent, { chatKey: 'private_OWN' });
  const pending = handler({ agent, toolName: 'write', reason: 'escalate' }, () => Promise.resolve('unavailable'));
  await new Promise((r) => setTimeout(r, 10));
  return { bridge, sent, pending };
}

test('scope=own：别人的会话审批一律委托，不抢', async () => {
  const { sent, pending } = await run('own');
  assert.deepEqual(sent, []);
  assert.equal(await pending, 'unavailable');
});

test('scope=all：别人的会话审批也转发到最近活跃的机器人会话', async () => {
  const { sent, pending } = await run('all', { ownRegistered: true });
  assert.equal(sent.length, 1, '应该往 QQ 发一条审批卡片');
  assert.equal(sent[0].chatKey, 'private_OWN');
  assert.match(sent[0].text, /审批/);
  // 超时（10s）前不回复 -> 等到 rejected 太久，这里只断言"挂起且已发出"
  assert.equal(typeof pending.then, 'function');
});

test('scope=all 且没有可用会话时：仍然委托（fail-closed）', async () => {
  const { sent, pending } = await run('all');
  assert.deepEqual(sent, []);
  assert.equal(await pending, 'unavailable');
});
