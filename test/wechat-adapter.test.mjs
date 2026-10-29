import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  createWechatAdapter,
  makeParseEvent,
  normalizePollMs,
  wechatMessageOf
} from '../src/wechat/adapter.mjs';

// 假桥客户端：events() 按脚本逐轮返回，status() 固定回一份 —— 测试不碰真网络也不等真实时间。
function fakeClient({ events = [], status = null } = {}) {
  const state = { eventCalls: [], statusCalls: 0, sends: [] };
  const api = {
    async status() {
      state.statusCalls += 1;
      return status || { ok: true, loggedIn: true, selfWxid: 'wxid_self', nickname: '小号', received: 0, error: '' };
    },
    async events({ since = 0 } = {}) {
      state.eventCalls.push(since);
      const batch = typeof events === 'function' ? events(since) : events;
      return batch || { ok: true, events: [], next: since };
    },
    async send(args) {
      state.sends.push(args);
      return { ok: true };
    }
  };
  return { api, state };
}

test('wechat adapter: 桥事件映射成与 onebot 产物同构的内部 message', () => {
  const message = wechatMessageOf(
    { seq: 7, ts: 1700000000123, from: 'wxid_friend', text: '你好' },
    { selfWxid: 'wxid_self' }
  );
  assert.deepEqual(message, {
    messageId: 'wx_7',
    chatType: 'private',
    userId: 'wxid_friend',
    groupId: null,
    selfId: 'wxid_self',
    senderName: null,
    time: 1700000000,
    ts: 1700000000123,
    seq: 7,
    text: '你好',
    segments: [{ type: 'text', data: { text: '你好' } }],
    atTargets: [],
    replyTo: null
  });
  // onebot 那边这几个字段是 pipeline 的地基，缺一个就会在别处静默失效
  for (const key of ['messageId', 'chatType', 'userId', 'groupId', 'selfId', 'time', 'text', 'segments', 'atTargets', 'replyTo']) {
    assert.ok(Object.prototype.hasOwnProperty.call(message, key), '缺字段：' + key);
  }
  assert.equal(wechatMessageOf(null), null);
  assert.equal(wechatMessageOf({ from: '', text: 'x' }), null);
  assert.equal(wechatMessageOf({ from: 'wxid_a', text: '' }), null);
});

test('wechat adapter: 自己发的消息在映射层就被丢掉，不会自问自答', async () => {
  assert.equal(wechatMessageOf({ seq: 1, from: 'wxid_self', text: '我回的' }, { selfWxid: 'wxid_self' }), null);
  assert.notEqual(wechatMessageOf({ seq: 2, from: 'wxid_a', text: '他说的' }, { selfWxid: 'wxid_self' }), null);

  const { api } = fakeClient({
    status: { ok: true, loggedIn: true, selfWxid: 'wxid_self', nickname: '', received: 0, error: '' },
    events: {
      ok: true,
      events: [
        { seq: 1, ts: 1700000000000, from: 'wxid_self', text: '我自己发的' },
        { seq: 2, ts: 1700000001000, from: 'wxid_a', text: '真消息' }
      ],
      next: 2
    }
  });
  const seen = [];
  const adapter = createWechatAdapter({ client: api, pollMs: 1000, now: () => 1000 });
  await adapter.start((message) => seen.push(message.text));
  await adapter.pollOnce({ force: true });
  await adapter.stop();
  assert.deepEqual(seen, ['真消息']);
  assert.equal(adapter.status().skippedSelf, 1);
  assert.equal(adapter.status().delivered, 1);
});

test('wechat adapter: seq 与 ts 原样透传，游标跟着桥的 next 往前走', async () => {
  const { api, state } = fakeClient({
    events: (since) => ({ ok: true, events: [{ seq: since + 3, ts: 1700000009999, from: 'wxid_a', text: '第几轮' }], next: since + 3 })
  });
  const adapter = createWechatAdapter({ client: api, pollMs: 1000, now: () => 1000 });
  const got = [];
  await adapter.start((message) => got.push(message));
  await adapter.pollOnce({ force: true });
  await adapter.pollOnce({ force: true });
  await adapter.stop();
  assert.deepEqual(got.map((m) => m.seq), [3, 6]);
  assert.deepEqual(got.map((m) => m.ts), [1700000009999, 1700000009999]);
  assert.deepEqual(got.map((m) => m.time), [1700000009, 1700000009]);
  assert.deepEqual(state.eventCalls, [0, 3], '第二次要从桥给的 next 出发，不能重放');
  assert.equal(adapter.status().cursor, 6);
});

test('wechat adapter: pollMs 节流——间隔没到的一轮直接跳过，不发请求', async () => {
  const { api, state } = fakeClient({ events: { ok: true, events: [], next: 0 } });
  let clock = 5000;
  const adapter = createWechatAdapter({ client: api, pollMs: 1000, now: () => clock });

  const first = await adapter.pollOnce();
  assert.equal(first.delivered, 0);
  assert.equal(first.skipped, false);
  const tooSoon = await adapter.pollOnce();
  assert.equal(tooSoon.skipped, true);
  assert.equal(state.eventCalls.length, 1, '间隔内的重复调用不能真的去问桥');

  clock += 999;
  assert.equal((await adapter.pollOnce()).skipped, true);
  clock += 1;
  assert.equal((await adapter.pollOnce()).skipped, false);
  assert.equal(state.eventCalls.length, 2);
  // force 是给"用户点了检测/启动"这类显式动作留的口子
  assert.equal((await adapter.pollOnce({ force: true })).skipped, false);
  assert.equal(state.eventCalls.length, 3);

  assert.equal(normalizePollMs(0), DEFAULT_POLL_MS);
  assert.equal(normalizePollMs('abc'), DEFAULT_POLL_MS);
  assert.equal(normalizePollMs(50), MIN_POLL_MS);
  assert.equal(adapter.pollMs, 1000);
});

test('wechat adapter: start/stop 幂等，停掉之后不再有定时器', async () => {
  const { api, state } = fakeClient();
  const adapter = createWechatAdapter({ client: api, pollMs: 1000, now: () => 1000 });
  assert.equal(adapter.status().running, false);

  const first = await adapter.start(() => {});
  const second = await adapter.start(() => {});
  assert.equal(first.ok, true);
  assert.equal(second.already, true);
  assert.equal(adapter.status().running, true);
  assert.equal(state.statusCalls, 1, '重复 start 不该再问一次桥的状态');

  await adapter.stop();
  assert.equal(adapter.status().running, false);
  await adapter.stop();
  assert.equal(adapter.status().running, false, '重复 stop 必须安静地成功');
  // 停掉之后即使 tick 被外部叫到，也不该再往 pipeline 里塞消息
  const seen = [];
  await adapter.start((message) => seen.push(message));
  await adapter.stop();
  assert.deepEqual(seen, []);
});

test('wechat adapter: 拉取失败只记 lastError，不抛给轮询与 pipeline', async () => {
  const { api } = fakeClient({ events: { ok: false, error: '连不上微信桥 http://127.0.0.1:19100' } });
  const adapter = createWechatAdapter({ client: api, pollMs: 1000, now: () => 1000 });
  const result = await adapter.pollOnce();
  assert.equal(result.ok, false);
  assert.match(result.error, /连不上微信桥/);
  assert.match(adapter.status().lastError, /连不上微信桥/);

  // 桥恢复后 lastError 要跟着清掉，否则设置页会一直挂着一条过期错误
  const recovered = fakeClient({ events: { ok: true, events: [], next: 0 } });
  const second = createWechatAdapter({ client: recovered.api, pollMs: 1000, now: () => 2000 });
  await second.pollOnce();
  assert.equal(second.status().lastError, null);
});

test('wechat adapter: deps 三件套（parseEvent / sendReply / chatKeyOf）与内核契约对齐', async () => {
  const { api, state } = fakeClient();
  const adapter = createWechatAdapter({ client: api, pollMs: 1000, now: () => 1000 });
  const parse = adapter.deps.parseEvent;

  // 已经归一化过的对象原样认；桥事件再映射一次；垃圾数据当 unknown（pipeline 会忽略）
  const message = wechatMessageOf({ seq: 1, from: 'wxid_a', text: 'hi' });
  assert.deepEqual(parse(message), { kind: 'message', message });
  assert.deepEqual(parse({ kind: 'message', message }), { kind: 'message', message });
  assert.equal(parse({ seq: 1, from: 'wxid_a', text: 'hi' }).kind, 'message');
  assert.equal(parse(null).kind, 'unknown');

  assert.equal(adapter.deps.chatKeyOf(message), 'private_wxid_a');
  assert.equal(adapter.deps.planMedia(), null, '微信这一版不发媒体');

  const sent = await adapter.deps.sendReply({ message, text: '回你一句' });
  assert.deepEqual(sent, { sent: 1, failed: 0 });
  assert.deepEqual(state.sends, [{ to: 'wxid_a', text: '回你一句' }]);
  assert.deepEqual(await adapter.deps.sendReply({ message: null, text: 'x' }), { sent: 0, failed: 1 });
});

test('wechat adapter: 不知道自己是谁时先问一次 /status，再用 selfWxid 过滤自己', async () => {
  const { api, state } = fakeClient({
    status: { ok: true, loggedIn: true, selfWxid: 'wxid_self', nickname: '小号', received: 0, error: '' },
    events: { ok: true, events: [{ seq: 1, from: 'wxid_self', text: '自己的' }], next: 1 }
  });
  const adapter = createWechatAdapter({ client: api, pollMs: 1000, now: () => 1000 });
  const seen = [];
  await adapter.start((message) => seen.push(message));
  await adapter.pollOnce({ force: true });
  await adapter.stop();
  assert.equal(state.statusCalls, 1);
  assert.deepEqual(seen, []);
  assert.equal(adapter.status().selfWxid, 'wxid_self');
  assert.equal(adapter.status().loggedIn, true);

  const parse = makeParseEvent(() => 'wxid_self');
  assert.equal(parse({ seq: 2, from: 'wxid_self', text: '自己的' }).kind, 'unknown');
  assert.equal(parse({ seq: 3, from: 'wxid_a', text: '别人的' }).kind, 'message');
});
