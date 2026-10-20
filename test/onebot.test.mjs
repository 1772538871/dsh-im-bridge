// B 模块自测：只 import src/onebot/*，不 import 其它模块的实现，保证并行开发期也能跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEvent } from '../src/onebot/parse.mjs';
import { planMedia, guessExt } from '../src/onebot/media.mjs';
import { chunkText, buildMessagePayload, sendReply } from '../src/onebot/send.mjs';
import { createOneBotClient, OneBotError } from '../src/onebot/client.mjs';

const quietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- parse.mjs ----------

test('parse: CQ 码字符串（含转义）解析成 NormSegment', () => {
  const raw = {
    post_type: 'message',
    message_type: 'private',
    self_id: 10000,
    time: 1700000000,
    message_id: 321,
    user_id: 555,
    sender: { nickname: '甲' },
    message:
      '你好&#91;1&#93; [CQ:at,qq=10000] 看图 [CQ:image,file=abc.jpg,url=https://e.com/a.png?x=1&#44;y=2] [CQ:reply,id=88] &amp;bye',
  };

  const parsed = parseEvent(raw);
  assert.equal(parsed.kind, 'message');
  const m = parsed.message;
  assert.equal(m.chatType, 'private');
  assert.equal(m.userId, '555');
  assert.equal(m.groupId, null);
  assert.equal(m.selfId, '10000');
  assert.equal(m.senderName, '甲');
  assert.equal(m.time, 1700000000);
  assert.equal(m.messageId, '321');
  assert.deepEqual(m.atTargets, ['10000']);
  assert.equal(m.replyTo, '88');

  assert.deepEqual(
    m.segments.map((s) => s.type),
    ['text', 'at', 'text', 'image', 'text', 'reply', 'text'],
  );
  assert.equal(m.segments[0].data.text, '你好[1] ');
  assert.equal(m.segments[1].data.qq, '10000');
  assert.equal(m.segments[2].data.text, ' 看图 ');
  assert.equal(m.segments[3].data.file, 'abc.jpg');
  assert.equal(m.segments[3].data.url, 'https://e.com/a.png?x=1,y=2');
  assert.equal(m.segments[5].data.id, '88');
  assert.equal(m.segments[6].data.text, ' &bye');
  // 只有 text 段进 text，at/reply 不进
  assert.equal(m.text, '你好[1]  看图   &bye');
});

test('parse: &amp; 最后还原，不会把 &amp;#91; 当成 [', () => {
  const parsed = parseEvent({ post_type: 'message', message_type: 'private', user_id: 1, message: '&amp;#91;' });
  assert.equal(parsed.message.text, '&#91;');
});

test('parse: 数组消息 + at=all + 未知段归 other', () => {
  const parsed = parseEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 42,
    self_id: 10000,
    user_id: 777,
    sender: { card: '群名片', nickname: '昵称' },
    message: [
      { type: 'text', data: { text: 'hi ' } },
      { type: 'at', data: { qq: 'all' } },
      { type: 'at', data: { qq: '10000' } },
      { type: 'image', data: { file: 'x.png', url: 'https://e.com/x.png' } },
      { type: 'face', data: { id: '1' } },
      { type: 'mystery', data: { foo: 'bar' } },
    ],
  });

  const m = parsed.message;
  assert.equal(m.chatType, 'group');
  assert.equal(m.groupId, '42');
  assert.equal(m.senderName, '群名片');
  assert.deepEqual(m.atTargets, ['all', '10000']);
  assert.equal(m.text, 'hi ');
  assert.equal(m.segments[4].type, 'face');
  assert.equal(m.segments[5].type, 'other');
  assert.equal(m.segments[5].data.foo, 'bar');
  assert.equal(m.segments[5].data.cqType, 'mystery');
  assert.equal(m.replyTo, null);
});

test('parse: 未知 CQ 类型归 other 且保留原始 type', () => {
  const parsed = parseEvent({ post_type: 'message', message_type: 'private', user_id: 1, message: 'x[CQ:mystery,a=1]y' });
  assert.deepEqual(parsed.message.segments.map((s) => s.type), ['text', 'other', 'text']);
  assert.equal(parsed.message.segments[1].data.cqType, 'mystery');
  assert.equal(parsed.message.segments[1].data.a, '1');
});

test('parse: 非消息事件与脏输入不抛', () => {
  assert.deepEqual(parseEvent(null), { kind: 'unknown' });
  assert.deepEqual(parseEvent({}), { kind: 'unknown' });
  assert.deepEqual(parseEvent('nope'), { kind: 'unknown' });
  assert.deepEqual(parseEvent({ post_type: 'meta_event' }), { kind: 'meta_event' });
  assert.deepEqual(parseEvent({ post_type: 'notice' }), { kind: 'notice' });
  assert.deepEqual(parseEvent({ post_type: 'request' }), { kind: 'request' });

  const bare = parseEvent({ post_type: 'message', message_type: 'private', user_id: 1 });
  assert.equal(bare.kind, 'message');
  assert.deepEqual(bare.message.segments, []);
  assert.equal(bare.message.text, '');
  assert.equal(bare.message.senderName, null);
  assert.equal(bare.message.time, 0);
  assert.equal(bare.message.groupId, null);
  assert.equal(bare.message.replyTo, null);
  assert.deepEqual(bare.message.atTargets, []);
});

// ---------- media.mjs ----------

test('media: image 有 url 直接可下载', () => {
  const plan = planMedia({ type: 'image', data: { file: 'a.png', url: 'https://e.com/a.png' } });
  assert.equal(plan.needsFetch, true);
  assert.equal(plan.url, 'https://e.com/a.png');
  assert.equal(plan.filename, 'a.png');
  assert.equal(plan.ext, 'png');
  assert.equal(plan.callSpec, undefined);
});

test('media: image 缺 url 走 get_image', () => {
  const plan = planMedia({ type: 'image', data: { file: 'abc.jpg' } });
  assert.equal(plan.needsFetch, true);
  assert.equal(plan.url, undefined);
  assert.deepEqual(plan.callSpec, { action: 'get_image', params: { file: 'abc.jpg' } });
  assert.equal(plan.filename, 'abc.jpg');
  assert.equal(plan.ext, 'jpg');

  const byId = planMedia({ type: 'image', data: { file_id: 'F1', file: 'ignored.jpg' } });
  assert.deepEqual(byId.callSpec, { action: 'get_image', params: { file_id: 'F1' } });
  assert.equal(byId.fileId, 'F1');
});

test('media: image 既无 url 也无 id 时不下载', () => {
  const plan = planMedia({ type: 'image', data: {} });
  assert.equal(plan.needsFetch, false);
  assert.equal(plan.callSpec, undefined);
  assert.equal(plan.ext, 'jpg');
});

test('media: file 群聊/私聊走不同接口，有 url 则直连', () => {
  const group = planMedia({ type: 'file', data: { file: '报告.pdf' } }, { chatType: 'group' });
  assert.deepEqual(group.callSpec, { action: 'get_group_file_url', params: { file: '报告.pdf' } });
  assert.equal(group.filename, '报告.pdf');
  assert.equal(group.ext, 'pdf');

  const single = planMedia({ type: 'file', data: { file: 'a.bin', busid: 102 } }, { chatType: 'private' });
  assert.equal(single.callSpec.action, 'get_private_file_url');
  assert.equal(single.callSpec.params.busid, 102);

  const direct = planMedia({ type: 'file', data: { name: 'b.pdf', url: 'https://e.com/b.pdf' } }, { chatType: 'group' });
  assert.equal(direct.needsFetch, true);
  assert.equal(direct.url, 'https://e.com/b.pdf');
  assert.equal(direct.filename, 'b.pdf');
  assert.equal(direct.callSpec, undefined);
});

test('media: record ext 默认 amr，缺 url 走 get_record', () => {
  const bare = planMedia({ type: 'record', data: { file: 'AbC123' } });
  assert.equal(bare.ext, 'amr');
  assert.deepEqual(bare.callSpec, { action: 'get_record', params: { file: 'AbC123' } });

  const silk = planMedia({ type: 'record', data: { file: 'v.silk' } });
  assert.equal(silk.ext, 'silk');

  const direct = planMedia({ type: 'record', data: { url: 'https://e.com/v.amr' } });
  assert.equal(direct.needsFetch, true);
  assert.equal(direct.url, 'https://e.com/v.amr');
  assert.equal(direct.ext, 'amr');
});

test('media: 文本/at 段不产生下载计划', () => {
  for (const type of ['text', 'at', 'reply', 'face', 'other']) {
    const plan = planMedia({ type, data: {} });
    assert.equal(plan.needsFetch, false);
    assert.equal(plan.filename, '');
    assert.equal(plan.ext, '');
    assert.equal(plan.callSpec, undefined);
  }
});

test('media: guessExt', () => {
  assert.equal(guessExt('a.PNG'), 'png');
  assert.equal(guessExt('noext', 'bin'), 'bin');
  assert.equal(guessExt('', 'amr'), 'amr');
  assert.equal(guessExt('https://e.com/x/y.webp?q=1', 'jpg'), 'webp');
  assert.equal(guessExt('C:\\tmp\\a.jpeg', 'bin'), 'jpeg');
});

// ---------- send.mjs ----------

test('send: chunkText 空输入返回空数组', () => {
  assert.deepEqual(chunkText('', 10), []);
  assert.deepEqual(chunkText('   \n\n  ', 10), []);
  assert.deepEqual(chunkText(null, 10), []);
  assert.deepEqual(chunkText(undefined, 10), []);
  assert.deepEqual(chunkText('短', 10), ['短']);
});

test('send: chunkText 长中文按句切且不丢字', () => {
  const sentence = '这是第一句话，用来测试切分。';
  const text = sentence.repeat(20);
  const chunks = chunkText(text, 40);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 40, 'chunk 超长: ' + chunk.length);
    assert.notEqual(chunk.trim(), '');
  }
  const joined = chunks.join('');
  assert.ok(joined.length >= Math.floor(text.length * 0.95), '拼接后丢字太多: ' + joined.length + '/' + text.length);
});

test('send: chunkText 无标点硬切且完整复原', () => {
  const text = 'x'.repeat(100);
  const chunks = chunkText(text, 30);
  assert.equal(chunks.length, 4);
  for (const chunk of chunks) assert.ok(chunk.length <= 30);
  assert.equal(chunks.join(''), text);
});

test('send: chunkText 多段落保持顺序', () => {
  const text = ['甲'.repeat(50), '乙'.repeat(50), '丙'.repeat(50)].join('\n\n');
  const chunks = chunkText(text, 60);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) assert.ok(chunk.length <= 60);
  const joined = chunks.join('');
  assert.ok(joined.indexOf('甲') >= 0 && joined.indexOf('甲') < joined.indexOf('乙'));
  assert.ok(joined.indexOf('乙') < joined.indexOf('丙'));
  assert.ok(joined.length >= Math.floor(text.length * 0.95));
});

test('send: chunkText 优先在换行处切', () => {
  const text = 'a'.repeat(20) + '\n' + 'b'.repeat(20);
  const chunks = chunkText(text, 25);
  assert.deepEqual(chunks, ['a'.repeat(20), 'b'.repeat(20)]);
});

test('send: buildMessagePayload 不解释 CQ 码', () => {
  const payload = buildMessagePayload('[CQ:at,qq=all] 你好');
  assert.deepEqual(payload, [{ type: 'text', data: { text: '[CQ:at,qq=all] 你好' } }]);
  assert.deepEqual(buildMessagePayload(null), [{ type: 'text', data: { text: '' } }]);
});

function recordingClient(failOn = []) {
  const calls = [];
  return {
    calls,
    async call(action, params) {
      calls.push({ action, params });
      const body = params.message[0].data.text;
      if (failOn.some((marker) => body.includes(marker))) throw new Error('send failed');
      return { message_id: calls.length };
    },
  };
}

test('send: sendReply 私聊逐段发送', async () => {
  const client = recordingClient();
  const config = { reply: { maxChunkChars: 4 } };
  const res = await sendReply({
    client,
    message: { chatType: 'private', userId: '555', groupId: null },
    text: 'AA。BB。',
    config,
    logger: quietLogger,
  });
  assert.deepEqual(res, { sent: 2, failed: 0 });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].action, 'send_private_msg');
  assert.equal(client.calls[0].params.user_id, '555');
  assert.deepEqual(client.calls[0].params.message, [{ type: 'text', data: { text: 'AA。' } }]);
  assert.deepEqual(client.calls[1].params.message, [{ type: 'text', data: { text: 'BB。' } }]);
});

test('send: sendReply 群聊 + 单段失败不中断', async () => {
  const client = recordingClient(['BB']);
  const res = await sendReply({
    client,
    message: { chatType: 'group', groupId: '42' },
    text: 'AA。BB。CC。',
    config: { reply: { maxChunkChars: 4 } },
    logger: quietLogger,
  });
  assert.deepEqual(res, { sent: 2, failed: 1 });
  assert.equal(client.calls.length, 3);
  for (const c of client.calls) {
    assert.equal(c.action, 'send_group_msg');
    assert.equal(c.params.group_id, '42');
  }
});

test('send: sendReply 空文本不调用 API，缺目标计失败', async () => {
  const client = recordingClient();
  const empty = await sendReply({
    client,
    message: { chatType: 'private', userId: '555' },
    text: '',
    config: { reply: { maxChunkChars: 10 } },
    logger: quietLogger,
  });
  assert.deepEqual(empty, { sent: 0, failed: 0 });
  assert.equal(client.calls.length, 0);

  const noTarget = await sendReply({
    client,
    message: { chatType: 'private', userId: null },
    text: 'x',
    config: { reply: { maxChunkChars: 10 } },
    logger: quietLogger,
  });
  assert.deepEqual(noTarget, { sent: 0, failed: 1 });
  assert.equal(client.calls.length, 0);
});

// ---------- client.mjs（假 WebSocket，不连网） ----------

const RealWebSocket = globalThis.WebSocket;

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  send(frame) {
    this.sent.push(JSON.parse(frame));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.({ code: 1000 }));
  }

  open() {
    this.onopen?.({});
  }

  recv(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

// 客户端在每次连接时读 globalThis.WebSocket，所以这里替换全局即可注入假实现。
function useFakeWebSocket() {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  return () => {
    globalThis.WebSocket = RealWebSocket;
    FakeWebSocket.instances = [];
  };
}

test('client: access_token 拼查询串、echo 关联返回 data', async () => {
  const restore = useFakeWebSocket();
  const events = [];
  const client = createOneBotClient({
    url: 'ws://127.0.0.1:3001',
    accessToken: 'a b&c',
    logger: quietLogger,
    onEvent: (e) => events.push(e),
  });
  try {
    assert.equal(client.isOpen(), false);
    await assert.rejects(() => client.call('get_status'), (err) => err instanceof OneBotError && err.code === 'not_open');

    client.start();
    assert.equal(FakeWebSocket.instances.length, 1);
    const ws = FakeWebSocket.instances[0];
    assert.equal(ws.url, 'ws://127.0.0.1:3001?access_token=' + encodeURIComponent('a b&c'));

    ws.open();
    assert.equal(client.isOpen(), true);
    assert.deepEqual(client.status(), { open: true, lastError: null, attempts: 0 });

    const pendingCall = client.call('get_status', { a: 1 });
    assert.equal(ws.sent.length, 1);
    assert.equal(ws.sent[0].action, 'get_status');
    assert.deepEqual(ws.sent[0].params, { a: 1 });
    ws.recv({ status: 'ok', retcode: 0, data: { online: true, good: true }, echo: ws.sent[0].echo });
    assert.deepEqual(await pendingCall, { online: true, good: true });
    assert.equal(events.length, 0);
  } finally {
    await client.stop();
    restore();
  }
});

test('client: retcode!==0 抛 OneBotError 并带 retcode/msg', async () => {
  const restore = useFakeWebSocket();
  const client = createOneBotClient({ url: 'ws://x', logger: quietLogger });
  try {
    client.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const pendingCall = client.call('send_private_msg', { user_id: 1 });
    ws.recv({ status: 'failed', retcode: 100, msg: 'bad token', echo: ws.sent[0].echo });
    await assert.rejects(pendingCall, (err) => {
      assert.ok(err instanceof OneBotError);
      assert.equal(err.retcode, 100);
      assert.equal(err.msg, 'bad token');
      assert.equal(err.action, 'send_private_msg');
      assert.equal(err.code, 'retcode');
      return true;
    });
  } finally {
    await client.stop();
    restore();
  }
});

test('client: 调用超时 reject OneBotError', async () => {
  const restore = useFakeWebSocket();
  const client = createOneBotClient({ url: 'ws://x', logger: quietLogger });
  try {
    client.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const pendingCall = client.call('get_status', {}, { timeoutMs: 20 });
    await assert.rejects(pendingCall, (err) => err instanceof OneBotError && err.code === 'timeout');
  } finally {
    await client.stop();
    restore();
  }
});

test('client: 只透传 message 与未知事件，丢弃 heart/unmatched echo', async () => {
  const restore = useFakeWebSocket();
  const events = [];
  const client = createOneBotClient({ url: 'ws://x', logger: quietLogger, onEvent: (e) => events.push(e) });
  try {
    client.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.recv({ post_type: 'message', message_type: 'private', user_id: 1, message: 'hi' });
    ws.recv({ post_type: 'notice', notice_type: 'group_recall' });
    ws.recv({ post_type: 'meta_event', meta_event_type: 'heartbeat' });
    ws.recv({ post_type: 'request', request_type: 'friend' });
    ws.recv({ post_type: 'weird_thing', x: 1 });
    ws.recv({ status: 'ok', retcode: 0, echo: '9999', data: {} });
    assert.equal(events.length, 2);
    assert.equal(events[0].post_type, 'message');
    assert.equal(events[1].post_type, 'weird_thing');
  } finally {
    await client.stop();
    restore();
  }
});

test('client: stop 后正在等待的 call 被 reject，且不再重连', async () => {
  const restore = useFakeWebSocket();
  const client = createOneBotClient({ url: 'ws://x', reconnectMinMs: 5, reconnectMaxMs: 20, logger: quietLogger });
  try {
    client.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const pendingCall = client.call('get_status');
    await client.stop();
    await assert.rejects(pendingCall, (err) => err instanceof OneBotError && err.code === 'stopped');
    const before = FakeWebSocket.instances.length;
    await sleep(40);
    assert.equal(FakeWebSocket.instances.length, before);
    assert.equal(client.isOpen(), false);
  } finally {
    await client.stop();
    restore();
  }
});

test('client: 掉线后按退避重连', async () => {
  const restore = useFakeWebSocket();
  const client = createOneBotClient({ url: 'ws://x', reconnectMinMs: 5, reconnectMaxMs: 20, logger: quietLogger });
  try {
    client.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    assert.equal(client.isOpen(), true);

    ws.drop();
    assert.equal(client.isOpen(), false);
    assert.equal(client.status().lastError, '连接关闭 code=1006');

    await sleep(60);
    assert.ok(FakeWebSocket.instances.length >= 2, '应当重连过');
    assert.equal(client.status().attempts, 1);
    // 第二次掉线 → 退避翻倍但仍受 reconnectMaxMs 封顶
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].drop();
    await sleep(60);
    assert.ok(FakeWebSocket.instances.length >= 3);
  } finally {
    await client.stop();
    restore();
  }
});
