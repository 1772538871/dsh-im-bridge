// QQ Bot 适配器自测：全部用注入的假 fetch / 假 WebSocket，不联网、不起子进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTokenProvider, QqBotAuthError } from '../src/qqbot/auth.mjs';
import { createQqBotClient, QqBotError } from '../src/qqbot/client.mjs';
import { createQqBotGateway, INTENTS_GROUP_AND_C2C } from '../src/qqbot/gateway.mjs';
import { parseQqBotEvent, planMedia } from '../src/qqbot/parse.mjs';
import { buildTextBody, sendQqReply } from '../src/qqbot/send.mjs';
import { createQqBotAdapter, qqBotProblems, resolveQqBotConfig } from '../src/qqbot/adapter.mjs';
import { chatKeyOf } from '../src/paths.mjs';
import { validateConfig } from '../src/config.mjs';

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

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

// ---------------------------------------------------------------- auth.mjs

test('auth: 取 token 的 URL/方法与 body 符合文档，并缓存到过期前 60 秒', async () => {
  const calls = [];
  let now = 1_000_000;
  const provider = createTokenProvider({
    appId: 'APPID',
    clientSecret: 'SECRET',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ access_token: 'T1', expires_in: '7200' });
    },
    now: () => now,
  });

  assert.equal(await provider.getToken(), 'T1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.bot.qq.com/app/getAppAccessToken');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { appId: 'APPID', clientSecret: 'SECRET' });

  // 有效期内重复取不会再发请求
  now += 1000;
  assert.equal(await provider.getToken(), 'T1');
  assert.equal(calls.length, 1);

  // 进入最后 60 秒窗口后才刷新（文档：这段时间内请求才会拿到新 token）
  now += 7200 * 1000;
  assert.equal(calls.length, 1);
  assert.equal(await provider.getToken(), 'T1');
  assert.equal(calls.length, 2);
});

test('auth: 并发取 token 只打一次接口', async () => {
  let hits = 0;
  const provider = createTokenProvider({
    appId: 'A',
    clientSecret: 'S',
    fetchImpl: async () => {
      hits += 1;
      await sleep(5);
      return jsonResponse({ access_token: 'T', expires_in: 7200 });
    },
  });
  const values = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);
  assert.deepEqual(values, ['T', 'T', 'T']);
  assert.equal(hits, 1);
});

test('auth: 业务错误按响应体 code 判定（HTTP 仍是 200）', async () => {
  const provider = createTokenProvider({
    appId: 'A',
    clientSecret: 'bad',
    fetchImpl: async () => jsonResponse({ code: 100016, message: 'invalid appid or secret' }),
  });
  await assert.rejects(() => provider.getToken(), (error) => {
    assert.ok(error instanceof QqBotAuthError);
    assert.equal(error.code, 100016);
    assert.ok(String(error.message).includes('100016'));
    return true;
  });
});

test('auth: 未配置 appId/secret 时给中文错误而不是发起请求', async () => {
  const provider = createTokenProvider({ appId: '', clientSecret: '' });
  await assert.rejects(() => provider.getToken(), (error) => {
    assert.ok(error instanceof QqBotAuthError);
    assert.ok(String(error.message).includes('appId'));
    return true;
  });
});

// -------------------------------------------------------------- client.mjs

function fixedTokenProvider(token = 'TOKEN') {
  const calls = { invalidated: 0 };
  return {
    calls,
    async getToken() {
      return token;
    },
    async authHeader() {
      return 'QQBot ' + token;
    },
    invalidate() {
      calls.invalidated += 1;
    },
    state() {
      return { hasToken: true, expiresAt: 0 };
    },
  };
}

test('client: 鉴权头是 "QQBot <token>"，单聊路径与 body 正确', async () => {
  const calls = [];
  const client = createQqBotClient({
    config: { apiBase: 'https://api.bot.qq.com' },
    tokenProvider: fixedTokenProvider('ABC'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ id: 'MSG1', timestamp: '2026-07-21T10:30:00+08:00' });
    },
  });

  const result = await client.sendMessage({ chatType: 'private', target: 'OPENID1', body: { content: 'hi', msg_type: 0, msg_id: 'ROBOT1', msg_seq: 1 } });
  assert.equal(result.id, 'MSG1');
  assert.equal(calls[0].url, 'https://api.bot.qq.com/v2/users/OPENID1/messages');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'QQBot ABC');
  assert.equal(calls[0].init.headers['content-type'], 'application/json; charset=utf-8');
});

test('client: 群聊路径用 group_openid，富媒体上传走 /files 并带 file_type', async () => {
  const calls = [];
  const client = createQqBotClient({
    config: {},
    tokenProvider: fixedTokenProvider(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ file_info: 'FILEINFO' });
    },
  });
  await client.uploadFile({ chatType: 'group', target: 'GROUP1', fileType: 1, url: 'https://e.com/a.png' });
  assert.equal(calls[0].url, 'https://api.bot.qq.com/v2/groups/GROUP1/files');
  assert.deepEqual(JSON.parse(calls[0].init.body), { file_type: 1, url: 'https://e.com/a.png' });
});

test('client: err_code 非 0 抛 QqBotError 并带错误码', async () => {
  const client = createQqBotClient({
    config: {},
    tokenProvider: fixedTokenProvider(),
    fetchImpl: async () => jsonResponse({ err_code: 40034005, message: '回复消息msg_id已过期' }),
  });
  await assert.rejects(
    () => client.sendMessage({ chatType: 'private', target: 'U1', body: { content: 'x' } }),
    (error) => {
      assert.ok(error instanceof QqBotError);
      assert.equal(error.code, 40034005);
      assert.ok(String(error.message).includes('40034005'));
      return true;
    },
  );
});

test('client: 401 时作废 token 并重试一次', async () => {
  let hits = 0;
  const provider = fixedTokenProvider();
  const client = createQqBotClient({
    config: {},
    tokenProvider: provider,
    fetchImpl: async () => {
      hits += 1;
      if (hits === 1) return jsonResponse({ err_code: 11243, message: 'token expired' });
      return jsonResponse({ id: 'OK' });
    },
  });
  const result = await client.sendMessage({ chatType: 'private', target: 'U1', body: { content: 'x' } });
  assert.equal(result.id, 'OK');
  assert.equal(provider.calls.invalidated, 1);
  assert.equal(hits, 2);
});

test('client: 缺少 openid 时不发请求直接报错', async () => {
  let hits = 0;
  const client = createQqBotClient({
    config: {},
    tokenProvider: fixedTokenProvider(),
    fetchImpl: async () => {
      hits += 1;
      return jsonResponse({});
    },
  });
  await assert.rejects(() => client.sendMessage({ chatType: 'group', target: '', body: {} }), QqBotError);
  assert.equal(hits, 0);
});

test('client: 取 WSS 接入点用 GET /gateway', async () => {
  const calls = [];
  const client = createQqBotClient({
    config: {},
    tokenProvider: fixedTokenProvider(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ url: 'wss://api.bot.qq.com/websocket/' });
    },
  });
  const gateway = await client.getGateway();
  assert.equal(gateway.url, 'wss://api.bot.qq.com/websocket/');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].url, 'https://api.bot.qq.com/gateway');
});

// ------------------------------------------------------------- gateway.mjs

class FakeSocket {
  static instances = [];

  static reset() {
    FakeSocket.instances = [];
  }

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.closed = true;
    this.emit('close', { code: 1000 });
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  open() {
    this.emit('open', {});
  }

  hello(intervalMs) {
    this.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: intervalMs } }) });
  }

  frame(payload) {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

function fakeGatewayClient(url = 'wss://api.bot.qq.com/websocket/') {
  return {
    calls: 0,
    async getGateway() {
      this.calls += 1;
      return { url };
    },
  };
}

function makeGateway(overrides = {}) {
  FakeSocket.reset();
  return createQqBotGateway({
    client: overrides.client ?? fakeGatewayClient(),
    tokenProvider: overrides.tokenProvider ?? { async getToken() { return 'TOKEN'; } },
    config: { intents: INTENTS_GROUP_AND_C2C, shard: [0, 1], reconnectMinMs: 5, reconnectMaxMs: 20, ...overrides.config },
    logger: quietLogger,
    WebSocketImpl: FakeSocket,
  });
}

test('gateway: 先连 WSS 接入点，收到 op10 Hello 后才发 op2 Identify', async () => {
  const gateway = makeGateway();
  const events = [];
  await gateway.start((payload) => events.push(payload));
  assert.equal(FakeSocket.instances.length, 1);

  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'wss://api.bot.qq.com/websocket/');
  assert.equal(socket.sent.length, 0, 'Hello 之前不该发任何帧');

  socket.open();
  socket.hello(45000);
  await sleep(5);

  assert.equal(socket.sent[0].op, 2);
  const identify = socket.sent[0].d;
  assert.equal(identify.token, 'QQBot TOKEN');
  assert.equal(identify.intents, 33554432);
  assert.deepEqual(identify.shard, [0, 1]);
  assert.equal(typeof identify.properties.$browser, 'string');
  await gateway.stop();
});

test('gateway: 按 heartbeat_interval 发 op1 心跳，op11 清 ack 计数', async () => {
  const gateway = makeGateway();
  await gateway.start(() => {});
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.hello(20);
  await sleep(50);
  const beats = socket.sent.filter((frame) => frame.op === 1);
  assert.ok(beats.length >= 1, '至少应发出一次心跳');
  assert.deepEqual(beats[0], { op: 1, d: null }, '首帧心跳的 d 是 null');

  socket.frame({ op: 11 });
  socket.frame({ op: 0, s: 7, t: 'C2C_MESSAGE_CREATE', d: { id: 'M' } });
  await sleep(30);
  const afterSeq = socket.sent.filter((frame) => frame.op === 1).pop();
  assert.equal(afterSeq.d, 7, '心跳要带上最新收到的 s');
  await gateway.stop();
});

test('gateway: dispatch 事件透传给 onEvent，READY/RESUMED 不透传', async () => {
  const gateway = makeGateway();
  const events = [];
  await gateway.start((payload) => events.push(payload));
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.hello(45000);
  await sleep(5);

  socket.frame({ op: 0, s: 1, t: 'READY', d: { session_id: 'SESS-1', shard: [0, 0] } });
  socket.frame({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: { id: 'M1' } });
  assert.deepEqual(events.map((e) => e.t), ['C2C_MESSAGE_CREATE']);
  assert.equal(gateway.status().sessionId, 'SESS-1');
  assert.equal(gateway.status().ready, true);
  await gateway.stop();
});

test('gateway: 断线后用 op6 Resume 带上 session_id 与 seq', async () => {
  const gateway = makeGateway();
  await gateway.start(() => {});
  const first = FakeSocket.instances[0];
  first.open();
  first.hello(45000);
  await sleep(5);
  first.frame({ op: 0, s: 42, t: 'READY', d: { session_id: 'SESS-1', shard: [0, 0] } });

  first.close();
  await sleep(30);
  assert.equal(FakeSocket.instances.length, 2, 'close 之后应重连');

  const second = FakeSocket.instances[1];
  second.open();
  second.hello(45000);
  await sleep(5);
  const resume = second.sent[0];
  assert.equal(resume.op, 6);
  assert.equal(resume.d.session_id, 'SESS-1');
  assert.equal(resume.d.seq, 42);
  assert.equal(resume.d.token, 'QQBot TOKEN');
  await gateway.stop();
});

test('gateway: op9 丢弃会话后重新 Identify', async () => {
  const gateway = makeGateway();
  await gateway.start(() => {});
  const first = FakeSocket.instances[0];
  first.open();
  first.hello(45000);
  await sleep(5);
  first.frame({ op: 0, s: 9, t: 'READY', d: { session_id: 'SESS-1' } });

  first.frame({ op: 9 });
  await sleep(30);
  assert.equal(gateway.status().sessionId, null);
  const second = FakeSocket.instances[1];
  second.open();
  second.hello(45000);
  await sleep(5);
  assert.equal(second.sent[0].op, 2, 'op9 之后必须重新 Identify');
  await gateway.stop();
});

test('gateway: op7 触发重连', async () => {
  const gateway = makeGateway();
  await gateway.start(() => {});
  const first = FakeSocket.instances[0];
  first.open();
  first.hello(45000);
  await sleep(5);

  first.frame({ op: 7 });
  await sleep(30);
  assert.ok(FakeSocket.instances.length >= 2, 'op7 之后应重连');
  assert.equal(gateway.status().lastError, 'server_reconnect');
  await gateway.stop();
});

test('gateway: 心跳连续无 ack 主动重连', async () => {
  const gateway = makeGateway();
  await gateway.start(() => {});
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.hello(15);
  await sleep(90);
  assert.ok(FakeSocket.instances.length >= 2, '心跳无 ack 应触发重连');
  await gateway.stop();
});

test('gateway: stop() 之后不再重连', async () => {
  const gateway = makeGateway();
  await gateway.start(() => {});
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.hello(45000);
  await sleep(5);

  await gateway.stop();
  socket.emit('close', { code: 1000 });
  await sleep(40);
  assert.equal(FakeSocket.instances.length, 1);
});

test('gateway: 不可重试的错误码停止重连', async () => {
  const gateway = makeGateway();
  await gateway.start(() => {});
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.hello(45000);
  await sleep(5);

  socket.emit('close', { code: 4914 });
  await sleep(40);
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(gateway.status().stopped, true);
});

// --------------------------------------------------------------- parse.mjs

test('parse: C2C_MESSAGE_CREATE → 私聊 NormMessage', () => {
  const parsed = parseQqBotEvent(
    {
      op: 0,
      s: 3,
      t: 'C2C_MESSAGE_CREATE',
      id: 'EVENT-1',
      d: {
        id: 'ROBOT1.0_MSG',
        author: { user_openid: 'USER-OPENID', username: '甲', bot: false },
        content: '  你好  ',
        message_type: 0,
        timestamp: '2026-07-21T10:00:00+08:00',
      },
    },
    { appId: '10000' },
  );

  assert.equal(parsed.kind, 'message');
  const m = parsed.message;
  assert.equal(m.messageId, 'ROBOT1.0_MSG');
  assert.equal(m.chatType, 'private');
  assert.equal(m.userId, 'USER-OPENID');
  assert.equal(m.groupId, null);
  assert.equal(m.selfId, '10000');
  assert.equal(m.senderName, '甲');
  assert.equal(m.text, '你好');
  assert.deepEqual(m.segments, [{ type: 'text', data: { text: '你好' } }]);
  assert.deepEqual(m.atTargets, []);
  assert.equal(m.replyTo, null);
  assert.ok(m.time > 0);
});

test('parse: GROUP_AT_MESSAGE_CREATE → 群聊，并把 selfId 记为 at 目标', () => {
  const parsed = parseQqBotEvent(
    {
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'ROBOT1.0_G',
        author: { member_openid: 'MEMBER-1', member_role: 'member', username: '小明' },
        group_openid: 'GROUP-1',
        content: ' /天气 ',
        timestamp: '2026-07-21T10:05:00+08:00',
      },
    },
    { appId: '10000' },
  );
  assert.equal(parsed.message.chatType, 'group');
  assert.equal(parsed.message.groupId, 'GROUP-1');
  assert.equal(parsed.message.userId, 'MEMBER-1');
  assert.deepEqual(parsed.message.atTargets, ['10000']);
  // security.mjs 的 groupRequireAt 只认 selfId 或 all，这里必须能过
  assert.equal(chatKeyOf(parsed.message), 'group_GROUP-1');
});

test('parse: 附件按 content_type 映射成 image/record/file 段', () => {
  const parsed = parseQqBotEvent(
    {
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'M',
        author: { member_openid: 'MEMBER-1' },
        group_openid: 'G1',
        content: '',
        attachments: [
          { content_type: 'image/jpeg', filename: 'photo.jpg', url: 'https://e.com/a.jpg', size: 256000 },
          { content_type: 'voice', filename: 'v.silk', url: 'https://e.com/v.silk', voice_wav_url: 'https://e.com/v.wav', size: 1024 },
          { content_type: 'file', filename: '报告.pdf', url: 'https://e.com/r.pdf', size: 2048 },
          { content_type: 'image/png' },
        ],
      },
    },
    { appId: '10000' },
  );

  const m = parsed.message;
  assert.equal(m.text, '');
  assert.deepEqual(m.segments.map((s) => s.type), ['image', 'record', 'file']);
  assert.equal(m.segments[0].data.url, 'https://e.com/a.jpg');
  assert.equal(m.segments[0].data.filename, 'photo.jpg');
  assert.equal(m.segments[1].data.url, 'https://e.com/v.wav', '语音优先用平台转好的 wav');
  assert.equal(m.segments[1].data.ext, 'wav');
  assert.equal(m.segments[2].data.filename, '报告.pdf');
});

test('parse: 脏输入不抛异常', () => {
  const inputs = [null, undefined, 42, 'x', {}, { op: 0 }, { op: 10 }, { op: 0, t: 'UNKNOWN_EVENT', d: {} },
    { op: 0, t: 'C2C_MESSAGE_CREATE' },
    { op: 0, t: 'C2C_MESSAGE_CREATE', d: { content: 123, author: null, attachments: 'nope' } },
    { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { author: [] } }];
  for (const input of inputs) {
    const parsed = parseQqBotEvent(input, { appId: '1' });
    assert.ok(['message', 'meta_event', 'unknown'].includes(parsed.kind), JSON.stringify(input));
  }
  assert.equal(parseQqBotEvent({ op: 0, t: 'READY', d: {} }).kind, 'meta_event');
  assert.equal(parseQqBotEvent({ op: 0, t: 'RESUMED' }).kind, 'meta_event');
  const numeric = parseQqBotEvent({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { content: 123, author: {}, attachments: 'nope' } }, { appId: '1' });
  assert.equal(numeric.message.text, '123');
});

test('planMedia: 直链附件直接交给 storage，不产生 callSpec', () => {
  const plan = planMedia({ type: 'image', data: { url: 'https://e.com/a.png', filename: '../../etc/passwd', ext: 'png' } }, { chatType: 'group' });
  assert.equal(plan.needsFetch, true);
  assert.equal(plan.url, 'https://e.com/a.png');
  assert.ok(!plan.filename.includes('..'));
  assert.equal(plan.ext, 'png');
  assert.equal(plan.callSpec, undefined);

  assert.deepEqual(planMedia({ type: 'other', data: {} }), { needsFetch: false, filename: '', ext: '' });
  assert.equal(planMedia({ type: 'image', data: {} }).needsFetch, false);
});

// ---------------------------------------------------------------- send.mjs

test('send: 被动回复带 msg_id 且 msg_seq 递增', async () => {
  const calls = [];
  const client = {
    async sendMessage(args) {
      calls.push(args);
      return { id: 'OK' };
    },
  };
  const result = await sendQqReply({
    client,
    message: { chatType: 'private', userId: 'U1', messageId: 'ROBOT1.0_MSG' },
    text: '第一段'.repeat(3) + '\n\n' + '第二段'.repeat(3),
    config: { reply: { maxChunkChars: 12 } },
  });

  assert.ok(calls.length >= 2, '长文本应被切段');
  assert.equal(result.sent, calls.length);
  assert.equal(result.failed, 0);
  assert.equal(calls[0].chatType, 'private');
  assert.equal(calls[0].target, 'U1');
  assert.equal(calls[0].body.msg_id, 'ROBOT1.0_MSG');
  assert.equal(calls[0].body.msg_type, 0);
  assert.ok(calls[0].body.msg_seq >= 1);
  assert.equal(calls[1].body.msg_seq, calls[0].body.msg_seq + 1);
});

test('send: 没有 msg_id 时不传 msg_seq（那是被动回复专用字段）', async () => {
  const calls = [];
  const body = buildTextBody({ text: 'hi', messageId: '', seq: 3 });
  assert.equal(body.msg_id, undefined);
  assert.equal(body.msg_seq, undefined);
  assert.equal(body.msg_type, 0);

  await sendQqReply({
    client: { async sendMessage(args) { calls.push(args); return {}; } },
    message: { chatType: 'group', groupId: 'G1', messageId: null },
    text: 'hi',
    config: {},
  });
  assert.equal(calls[0].chatType, 'group');
  assert.equal(calls[0].target, 'G1');
});

test('send: 单段失败计入 failed 且不影响后续段', async () => {
  let index = 0;
  const failed = await sendQqReply({
    client: {
      async sendMessage() {
        index += 1;
        if (index === 1) throw new Error('boom');
        return {};
      },
    },
    message: { chatType: 'private', userId: 'U1', messageId: 'M' },
    text: '甲'.repeat(10) + '\n\n' + '乙'.repeat(10),
    config: { reply: { maxChunkChars: 10 } },
  });
  assert.equal(failed.failed, 1);
  assert.equal(failed.sent, 1);
});

test('send: 缺少目标或 client 不支持时如实计失败', async () => {
  const noTarget = await sendQqReply({ client: { async sendMessage() {} }, message: { chatType: 'private', userId: '' }, text: 'x' });
  assert.equal(noTarget.sent, 0);
  assert.equal(noTarget.failed, 1);

  const noClient = await sendQqReply({ client: {}, message: { chatType: 'private', userId: 'U1' }, text: 'x' });
  assert.equal(noClient.failed, 1);

  const empty = await sendQqReply({ client: { async sendMessage() {} }, message: {}, text: '   ' });
  assert.deepEqual(empty, { sent: 0, failed: 0 });
});

// ------------------------------------------------------------- adapter.mjs

test('adapter: deps 里 parseEvent 注入 appId，chatKeyOf 与内核一致', async () => {
  const adapter = createQqBotAdapter({
    config: { qqbot: { appId: '10000', clientSecret: 'S' } },
    logger: quietLogger,
  });

  assert.equal(typeof adapter.deps.planMedia, 'function');
  assert.equal(typeof adapter.deps.sendReply, 'function');
  assert.equal(adapter.deps.chatKeyOf, chatKeyOf);

  const group = adapter.deps.parseEvent({
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'M', author: { member_openid: 'MEM' }, group_openid: 'G1', content: 'hi' },
  });
  assert.equal(group.message.selfId, '10000');
  assert.equal(adapter.deps.chatKeyOf(group.message), 'group_G1');

  const priv = adapter.deps.parseEvent({
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'M2', author: { user_openid: 'U1' }, content: 'hi' },
  });
  assert.equal(adapter.deps.chatKeyOf(priv.message), 'private_U1');
});

test('adapter: AppSecret 可以走环境变量，校验问题给出中文提示', () => {
  const resolved = resolveQqBotConfig({ qqbot: { apiBase: 'https://api.bot.qq.com' } }, { QQBOT_APP_ID: 'ID', QQBOT_CLIENT_SECRET: 'SEC' });
  assert.equal(resolved.appId, 'ID');
  assert.equal(resolved.clientSecret, 'SEC');

  const problems = qqBotProblems({ qqbot: {} }, {});
  assert.equal(problems.length, 2);
  assert.ok(problems[0].includes('qqbot.appId'));
  assert.ok(problems[1].includes('clientSecret'));
  assert.deepEqual(qqBotProblems({ qqbot: { appId: 'A', clientSecret: 'B' } }, {}), []);
});

// --------------------------------------------------------------- config.mjs

function baseRaw(qqbot) {
  return {
    onebot: { wsUrl: 'ws://127.0.0.1:3001' },
    qqbot,
    dsh: { profile: 'im-bridge', binPath: process.execPath },
    storage: { rootDir: 'D:/bridge-data' },
    log: {},
  };
}

test('config: qqbot 段缺省时补齐默认值且不报错（不影响 OneBot 配置）', () => {
  const result = validateConfig(baseRaw(undefined), { env: {} });
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.config.qqbot.apiBase, 'https://api.bot.qq.com');
  assert.equal(result.config.qqbot.intents, 33554432);
  assert.deepEqual(result.config.qqbot.shard, [0, 1]);
  assert.equal(result.config.qqbot.appId, '');
});

test('config: qqbot 段的类型错误逐条报出', () => {
  const badBase = validateConfig(baseRaw({ apiBase: 'api.bot.qq.com' }), { env: {} });
  assert.equal(badBase.ok, false);
  assert.ok(badBase.problems.some((p) => p.includes('qqbot.apiBase')));

  const badShard = validateConfig(baseRaw({ shard: [0] }), { env: {} });
  assert.equal(badShard.ok, false);
  assert.ok(badShard.problems.some((p) => p.includes('qqbot.shard')));

  const badIntents = validateConfig(baseRaw({ intents: 'many' }), { env: {} });
  assert.equal(badIntents.ok, false);
  assert.ok(badIntents.problems.some((p) => p.includes('qqbot.intents')));
});

test('config: qqbot 段合法值时原样保留', () => {
  const result = validateConfig(
    baseRaw({ appId: '10000', clientSecret: 'SEC', apiBase: 'https://sandbox.api.bot.qq.com', intents: 1 << 25, shard: [0, 2] }),
    { env: {} },
  );
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.config.qqbot.apiBase, 'https://sandbox.api.bot.qq.com');
  assert.deepEqual(result.config.qqbot.shard, [0, 2]);
  assert.equal(result.config.qqbot.intents, 33554432);
});

// ------------------------------------------------------ 与内核的端到端缝合

test('pipeline 缝合：注入的 deps 能把 QQ 事件走通并回一条带 msg_id 的被动回复', async () => {
  const { createPipeline } = await import('../src/pipeline.mjs');
  const { createGuard } = await import('../src/security.mjs');
  const { createSerialQueue, createSemaphore } = await import('../src/queue.mjs');

  const config = {
    storage: { rootDir: 'D:/bridge-data' },
    security: { userWhitelist: [], groupWhitelist: [], allowPrivate: true, allowGroup: true, groupRequireAt: true, rateLimitPerMinute: 0, maxConcurrentRuns: 1, maxPromptChars: 8000 },
    reply: { maxChunkChars: 1500, errorPrefix: '[bridge] ', showSessionId: false },
    qqbot: { appId: '10000' },
  };

  const sent = [];
  const fakeClient = {
    async sendMessage(args) {
      sent.push(args);
      return { id: 'OK' };
    },
  };
  const store = {};
  const sessions = {
    async get(key) {
      return store[key];
    },
    async set(key, value) {
      store[key] = value;
    },
  };

  const adapter = createQqBotAdapter({ config, logger: quietLogger });
  const pipeline = createPipeline({
    config,
    logger: quietLogger,
    client: fakeClient,
    storage: { async saveFromUrl() { throw new Error('这条消息没有附件，不该下载'); } },
    guard: createGuard({ config, logger: quietLogger }),
    serial: createSerialQueue(),
    semaphore: createSemaphore(1),
    sessions,
    runDsh: async () => ({ ok: true, text: '回复正文', sessionId: 'SESS-NEW' }),
    deps: adapter.deps,
  });

  await pipeline.handleEvent({
    op: 0,
    s: 5,
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'ROBOT1.0_MSG', author: { user_openid: 'USER-OPENID', username: '甲' }, content: '你好', timestamp: '2026-07-21T10:00:00+08:00' },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatType, 'private');
  assert.equal(sent[0].target, 'USER-OPENID');
  assert.equal(sent[0].body.msg_id, 'ROBOT1.0_MSG');
  assert.ok(sent[0].body.msg_seq >= 1, '被动回复必须带 msg_seq');
  assert.equal(sent[0].body.content, '回复正文');
  assert.equal(store['private_USER-OPENID'], 'SESS-NEW');
  assert.equal(pipeline.stats().handled, 1);
});

test('pipeline 缝合：群聊事件靠 selfId 记为 at 目标，能过 groupRequireAt', async () => {
  const { createPipeline } = await import('../src/pipeline.mjs');
  const { createGuard } = await import('../src/security.mjs');
  const { createSerialQueue, createSemaphore } = await import('../src/queue.mjs');

  const config = {
    storage: { rootDir: 'D:/bridge-data' },
    security: { userWhitelist: [], groupWhitelist: [], allowPrivate: true, allowGroup: true, groupRequireAt: true, rateLimitPerMinute: 0, maxConcurrentRuns: 1, maxPromptChars: 8000 },
    reply: { maxChunkChars: 1500, errorPrefix: '[bridge] ', showSessionId: false },
    qqbot: { appId: '10000' },
  };
  const sent = [];
  const adapter = createQqBotAdapter({ config, logger: quietLogger });
  const pipeline = createPipeline({
    config,
    logger: quietLogger,
    client: { async sendMessage(args) { sent.push(args); return {}; } },
    storage: { async saveFromUrl() { throw new Error('不该下载'); } },
    guard: createGuard({ config, logger: quietLogger }),
    serial: createSerialQueue(),
    semaphore: createSemaphore(1),
    sessions: { async get() { return null; }, async set() {} },
    runDsh: async () => ({ ok: true, text: '群里收到', sessionId: 'S1' }),
    deps: adapter.deps,
  });

  await pipeline.handleEvent({
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'M-GROUP', author: { member_openid: 'MEM-1' }, group_openid: 'GROUP-1', content: '/help', timestamp: '2026-07-21T10:00:00+08:00' },
  });

  assert.equal(pipeline.stats().denied, 0, '群 @ 事件不该被判 need_at');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatType, 'group');
  assert.equal(sent[0].target, 'GROUP-1');
});

test('bin/qqbot --check：缺 AppID/Secret 返回 1，补齐后打印摘要返回 0', async () => {
  const bin = await import('../bin/qqbot.mjs');
  const { fileURLToPath } = await import('node:url');
  const configPath = fileURLToPath(new URL('../bridge.config.example.json', import.meta.url));

  const makeIo = (env) => {
    const writes = { out: '', err: '' };
    return {
      writes,
      io: {
        stdout: { write: (chunk) => { writes.out += chunk; } },
        stderr: { write: (chunk) => { writes.err += chunk; } },
        env: { DSH_BIN: process.execPath, ...env },
      },
    };
  };

  const missing = makeIo({});
  assert.equal(await bin.main(['--config', configPath, '--check'], missing.io), 1);
  assert.ok(missing.writes.err.includes('qqbot.appId'), missing.writes.err);

  const ready = makeIo({ QQBOT_APP_ID: '10000', QQBOT_CLIENT_SECRET: 'SECRET' });
  assert.equal(await bin.main(['--config', configPath, '--check'], ready.io), 0, ready.writes.err);
  assert.ok(ready.writes.out.includes('QQ Bot 参数'));
  assert.ok(ready.writes.out.includes('33554432'));
});

// -------------------------------------------------------------- bin 层辅助

test('bin/qqbot: parseArgs 与 dry-run payload 形状', async () => {
  const bin = await import('../bin/qqbot.mjs');
  assert.deepEqual(bin.parseArgs(['--config', 'a.json', '--check']), {
    configPath: 'a.json',
    check: true,
    dryRun: null,
    help: false,
    unknown: [],
  });
  const payload = bin.buildDryRunPayload('你好', { appId: '10000' });
  assert.equal(payload.op, 0);
  assert.equal(payload.t, 'C2C_MESSAGE_CREATE');
  assert.equal(payload.d.content, '你好');
  const parsed = parseQqBotEvent(payload, { appId: '10000' });
  assert.equal(parsed.kind, 'message');
  assert.equal(parsed.message.userId, 'dry-run');
});
