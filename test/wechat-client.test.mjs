import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_BRIDGE_URL, createWechatClient, normalizeBridgeUrl } from '../src/wechat/client.mjs';

// 假 fetch：只记下"被问到了什么"，返回一份构造好的响应；测试绝不碰真网络。
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(payload, status = 200) {
  return {
    status,
    async json() {
      return payload;
    }
  };
}

test('wechat client: /status 正常时把登录信息原样交出来，桥地址末尾斜杠被抹掉', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse({ ok: true, loggedIn: true, selfWxid: 'wxid_self', nickname: '小号', received: 12 })
  );
  const client = createWechatClient({ baseUrl: 'http://127.0.0.1:19100///', fetchImpl });
  const status = await client.status();
  assert.equal(client.base, 'http://127.0.0.1:19100');
  assert.deepEqual(status, { ok: true, loggedIn: true, selfWxid: 'wxid_self', nickname: '小号', received: 12, error: '' });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:19100/status');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
});

test('wechat client: 桥活着但微信没登录 → ok:true + loggedIn:false + 那句人话', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse({ ok: true, loggedIn: false, selfWxid: '', nickname: '', received: 0, error: '没有找到 wcferry' })
  );
  const status = await createWechatClient({ fetchImpl }).status();
  assert.equal(status.ok, true);
  assert.equal(status.loggedIn, false);
  assert.equal(status.error, '没有找到 wcferry');
  assert.equal(createWechatClient({ fetchImpl }).base, DEFAULT_BRIDGE_URL);
});

test('wechat client: 请求超时折成人话，不抛给调用方', async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      const signal = init && init.signal;
      assert.ok(signal, '必须带 AbortSignal，否则超时根本停不下来');
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const client = createWechatClient({ fetchImpl, timeoutMs: 20 });
  const status = await client.status();
  assert.equal(status.ok, false);
  assert.match(status.error, /20 毫秒没响应/);
  assert.match(status.error, /bridge\.py/);
});

test('wechat client: 非 JSON 响应 / 非 200 状态都折成 ok:false，且说清是哪一步坏的', async () => {
  const notJson = fakeFetch(() => ({
    status: 200,
    async json() {
      throw new Error('Unexpected token <');
    }
  }));
  const bad = await createWechatClient({ fetchImpl: notJson }).status();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不是 JSON/);

  const http500 = fakeFetch(() => jsonResponse({ ok: false }, 500));
  const failed = await createWechatClient({ fetchImpl: http500 }).status();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /HTTP 500/);

  const boom = fakeFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  const refused = await createWechatClient({ fetchImpl: boom }).send({ to: 'wxid_a', text: 'hi' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /连不上微信桥/);
  assert.match(refused.error, /ECONNREFUSED/);
});

test('wechat client: send 校验收件人/正文，成功时把 to 与 text 原样放进请求体', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ ok: true }));
  const client = createWechatClient({ fetchImpl });

  assert.equal((await client.send({ to: '  ', text: 'hi' })).ok, false);
  assert.match((await client.send({ to: 'wxid_a', text: '' })).error, /空的/);
  assert.equal(fetchImpl.calls.length, 0, '参数不合法就不该发请求');

  const sent = await client.send({ to: ' wxid_a ', text: '你好' });
  assert.deepEqual(sent, { ok: true });
  assert.equal(fetchImpl.calls[0].url, DEFAULT_BRIDGE_URL + '/send');
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { to: 'wxid_a', text: '你好' });

  const rejected = fakeFetch(() => jsonResponse({ ok: false, error: '对方可能不是好友' }));
  const bad = await createWechatClient({ fetchImpl: rejected }).send({ to: 'wxid_a', text: 'hi' });
  assert.deepEqual(bad, { ok: false, error: '对方可能不是好友' });
});

test('wechat client: events 归一化每条事件，脏数据被丢掉，next 有兜底', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse({
      ok: true,
      events: [
        { seq: 3, ts: 1700000000123, from: 'wxid_a', text: '在吗', type: 'text' },
        { seq: 'x', from: 'wxid_b', text: '坏 seq' },
        { seq: 4, from: '', text: '没有发送者' },
        { seq: 5, ts: 'nope', from: 'wxid_c', text: '' }
      ],
      next: 5
    })
  );
  const got = await createWechatClient({ fetchImpl }).events({ since: 2 });
  assert.equal(fetchImpl.calls[0].url, DEFAULT_BRIDGE_URL + '/events?since=2');
  assert.deepEqual(got, {
    ok: true,
    events: [
      { seq: 3, ts: 1700000000123, from: 'wxid_a', text: '在吗', type: 'text' },
      { seq: 5, ts: 0, from: 'wxid_c', text: '', type: 'text' }
    ],
    next: 5
  });

  const noNext = fakeFetch(() => jsonResponse({ ok: true, events: [{ seq: 9, from: 'wxid_a', text: 'x' }] }));
  const fallback = await createWechatClient({ fetchImpl: noNext }).events({ since: 4 });
  assert.equal(fallback.next, 9, '桥没给 next 时按本批最大 seq 兜底，不能倒退回 0');
});

test('wechat client: 没有可用 fetch、响应不是对象、events 不是数组时都返回人话错误', async () => {
  const none = await createWechatClient({ fetchImpl: null }).status();
  assert.equal(none.ok, false);
  assert.match(none.error, /没有可用的 fetch/);

  const notObject = await createWechatClient({ fetchImpl: fakeFetch(() => jsonResponse(undefined)) }).status();
  assert.equal(notObject.ok, false);
  assert.match(notObject.error, /不是 JSON 对象/);

  const badEvents = await createWechatClient({ fetchImpl: fakeFetch(() => jsonResponse({ ok: true, events: 'nope' })) }).events({});
  assert.equal(badEvents.ok, false);
  assert.match(badEvents.error, /不是数组/);
});

test('wechat client: normalizeBridgeUrl 只做"空值回落 + 去尾斜杠"，不替用户改地址', () => {
  assert.equal(normalizeBridgeUrl(''), DEFAULT_BRIDGE_URL);
  assert.equal(normalizeBridgeUrl('   '), DEFAULT_BRIDGE_URL);
  assert.equal(normalizeBridgeUrl('http://127.0.0.1:19200/'), 'http://127.0.0.1:19200');
  assert.equal(normalizeBridgeUrl('127.0.0.1:19100'), '127.0.0.1:19100');
});
