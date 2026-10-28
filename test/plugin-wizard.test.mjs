import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  API_PREFIX,
  MSG_SECRET_WRONG,
  MSG_UNPUBLISHED,
  SANDBOX_API_BASE,
  TOKEN_API_BASE,
  createApiHandler,
  nicknameOf,
  verifyQqBotCredentials
} from '../src/plugin/routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

// ---------------------------------------------------------------- 宿主侧：验证凭证

// 假 fetch：按顺序回放响应，同时把每次请求（url + body）记下来给断言用。
function fakeFetch(responses) {
  const calls = [];
  const queue = (responses || []).slice();
  const impl = async (url, init) => {
    const text = init && typeof init.body === 'string' ? init.body : '';
    calls.push({ url: String(url), method: String((init && init.method) || 'GET'), body: text ? JSON.parse(text) : null });
    const next = queue.length > 0 ? queue.shift() : { status: 200, body: {} };
    if (typeof next === 'function') return next(url, init);
    const status = next.status === undefined ? 200 : next.status;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (typeof next.raw === 'string' ? next.raw : JSON.stringify(next.body === undefined ? {} : next.body))
    };
  };
  return { impl, calls };
}

const TOKEN_OK = { status: 200, body: { access_token: 'tok-1', expires_in: 7200 } };
const GATEWAY_OK = { status: 200, body: { url: 'wss://api.sgroup.qq.com/websocket' } };

test('verifyQqBotCredentials: 缺 AppID / AppSecret 直接说该填哪个，不外呼', async () => {
  const { impl, calls } = fakeFetch([]);
  const noId = await verifyQqBotCredentials({ fetchImpl: impl });
  assert.deepEqual(Object.keys(noId).sort(), ['error', 'ok', 'step']);
  assert.equal(noId.ok, false);
  assert.equal(noId.step, 'credentials');
  assert.match(noId.error, /AppID/);

  const noSecret = await verifyQqBotCredentials({ appId: '10000', fetchImpl: impl });
  assert.equal(noSecret.step, 'credentials');
  assert.match(noSecret.error, /AppSecret/);
  assert.equal(calls.length, 0, '连凭证都没有就不该往外发请求');
});

test('verifyQqBotCredentials: token 走正式域，网关二次确认走沙箱域', async () => {
  const { impl, calls } = fakeFetch([TOKEN_OK, GATEWAY_OK]);
  const result = await verifyQqBotCredentials({ appId: ' 10000 ', appSecret: ' sec ', sandbox: true, fetchImpl: impl });

  assert.deepEqual(result, { ok: true, appId: '10000', sandbox: true });
  assert.equal(calls.length, 2);
  // 沙箱域没有 getAppAccessToken（实测 404），token 必须走正式域
  assert.equal(calls[0].url, TOKEN_API_BASE + '/app/getAppAccessToken');
  assert.deepEqual(calls[0].body, { appId: '10000', clientSecret: 'sec' });
  assert.equal(calls[1].url, SANDBOX_API_BASE + '/gateway');
  assert.equal(calls[1].method, 'GET');
  assert.equal('nickname' in result, false, '昵称取不到就整个键省掉');
});

test('verifyQqBotCredentials: sandbox=false 时网关也走正式域', async () => {
  const { impl, calls } = fakeFetch([TOKEN_OK, GATEWAY_OK]);
  const result = await verifyQqBotCredentials({ appId: '10000', appSecret: 'sec', sandbox: false, fetchImpl: impl });
  assert.equal(result.ok, true);
  assert.equal(result.sandbox, false);
  assert.equal(calls[1].url, TOKEN_API_BASE + '/gateway');
});

test('verifyQqBotCredentials: 网关响应里带昵称就顺带返回，不带不硬失败', async () => {
  const { impl } = fakeFetch([TOKEN_OK, { status: 200, body: { url: 'wss://x', bot: { username: '大龙虾' } } }]);
  const result = await verifyQqBotCredentials({ appId: '10000', appSecret: 'sec', fetchImpl: impl });
  assert.equal(result.nickname, '大龙虾');
  assert.equal(nicknameOf({ data: { bot: { username: ' 另一个 ' } } }), '另一个');
  assert.equal(nicknameOf(undefined), '');
  assert.equal(nicknameOf({ url: 'wss://x' }), '');
});

test('verifyQqBotCredentials: 业务错误码 = 凭证不对（给出去哪儿改）', async () => {
  const { impl } = fakeFetch([{ status: 200, body: { code: 100016, message: 'invalid appid or secret' } }]);
  const result = await verifyQqBotCredentials({ appId: '1', appSecret: 'bad', fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'credentials');
  assert.ok(result.error.startsWith(MSG_SECRET_WRONG), result.error);
  assert.match(result.error, /重置密钥/);
  assert.match(result.error, /100016/, '错误码要带上，方便贴给平台客服');
});

test('verifyQqBotCredentials: 连不上是 unknown，别让人跑去重置密钥', async () => {
  const { impl } = fakeFetch([
    async () => {
      throw new Error('getaddrinfo ENOTFOUND api.bot.qq.com');
    }
  ]);
  const result = await verifyQqBotCredentials({ appId: '1', appSecret: 'sec', fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'unknown');
  assert.match(result.error, /连不上/);
  assert.ok(!result.error.includes('重置密钥'), '网络问题不该导向"重置密钥"：' + result.error);
});

test('verifyQqBotCredentials: 网关 404 / 环境错误码 = 机器人还没发布', async () => {
  const notFound = await verifyQqBotCredentials({
    appId: '1',
    appSecret: 'sec',
    sandbox: true,
    fetchImpl: fakeFetch([TOKEN_OK, { status: 404, body: { message: 'not found' } }]).impl
  });
  assert.equal(notFound.step, 'sandbox');
  assert.ok(notFound.error.startsWith(MSG_UNPUBLISHED), notFound.error);
  assert.match(notFound.error, /体验成员/);
  assert.match(notFound.error, /沙箱域/);

  const envCode = await verifyQqBotCredentials({
    appId: '1',
    appSecret: 'sec',
    fetchImpl: fakeFetch([TOKEN_OK, { status: 200, body: { err_code: 4914, message: 'env mismatch' } }]).impl
  });
  assert.equal(envCode.step, 'sandbox');
  assert.match(envCode.error, /4914/);
});

test('verifyQqBotCredentials: 网关 401 = 凭证不对，空网关地址 = gateway', async () => {
  // 401 会触发 client 的"刷 token 重试一次"，所以队列里要备好第二轮的两条响应
  const unauthorized = await verifyQqBotCredentials({
    appId: '1',
    appSecret: 'sec',
    fetchImpl: fakeFetch([TOKEN_OK, { status: 401, body: {} }, TOKEN_OK, { status: 401, body: {} }]).impl
  });
  assert.equal(unauthorized.step, 'credentials');
  assert.equal(unauthorized.error, MSG_SECRET_WRONG);

  const empty = await verifyQqBotCredentials({
    appId: '1',
    appSecret: 'sec',
    fetchImpl: fakeFetch([TOKEN_OK, { status: 200, body: {} }]).impl
  });
  assert.equal(empty.step, 'gateway');
  assert.match(empty.error, /网关/);
});

// ---- POST /verify-credentials（HTTP 恒 200，失败也走 ok:false） ----

function makeStore(config) {
  return {
    path: 'X:\\fake\\config.json',
    read: () => ({ config, warnings: [], problems: [], configPath: 'X:\\fake\\config.json' }),
    save: async () => ({ ok: true, config })
  };
}

function makeRuntime() {
  return { status: () => ({ running: false, enabled: false, platform: 'qq-official', stats: {} }) };
}

function fakeReq({ method = 'POST', url = API_PREFIX + '/verify-credentials', headers = { 'content-type': 'application/json' }, body = '' } = {}) {
  const buffer = body === '' ? null : Buffer.from(body, 'utf8');
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (buffer) yield buffer;
    }
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(chunk) {
      if (typeof chunk === 'string') this.body += chunk;
      return this;
    }
  };
}

async function post(handler, payload, options = {}) {
  const res = fakeRes();
  const req = fakeReq({ ...options, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  await handler(req, res);
  assert.equal(res.statusCode, 200, '接口任何分支都必须 HTTP 200');
  return JSON.parse(res.body || '{}');
}

const SAVED_CONFIG = {
  platform: 'qq-official',
  qqOfficial: { appId: '9999', appSecret: 'stored-secret', sandbox: true }
};

test('POST /verify-credentials: body 里带凭证就用它，不带就用已保存配置', async () => {
  const explicit = fakeFetch([TOKEN_OK, GATEWAY_OK]);
  const handler = createApiHandler({ configStore: makeStore(SAVED_CONFIG), runtime: makeRuntime(), fetchImpl: explicit.impl });
  const json = await post(handler, { appId: '1234', appSecret: 'typed-secret', sandbox: false });
  assert.equal(json.ok, true);
  assert.equal(json.appId, '1234');
  assert.equal(json.sandbox, false);
  assert.equal(JSON.stringify(json).includes('secret'), false, '响应里绝不能回显密钥');
  assert.deepEqual(explicit.calls[0].body, { appId: '1234', clientSecret: 'typed-secret' });
  assert.equal(explicit.calls[1].url, TOKEN_API_BASE + '/gateway');

  const fallback = fakeFetch([TOKEN_OK, GATEWAY_OK]);
  const handler2 = createApiHandler({ configStore: makeStore(SAVED_CONFIG), runtime: makeRuntime(), fetchImpl: fallback.impl });
  const json2 = await post(handler2, {});
  assert.equal(json2.ok, true);
  assert.equal(json2.appId, '9999');
  assert.equal(json2.sandbox, true, '缺省跟已保存的沙箱开关一致');
  assert.deepEqual(fallback.calls[0].body, { appId: '9999', clientSecret: 'stored-secret' });
  assert.equal(fallback.calls[1].url, SANDBOX_API_BASE + '/gateway');
});

test('POST /verify-credentials: 密钥掩码 "***" 表示用已保存的那个，不拿掩码去换 token', async () => {
  const fake = fakeFetch([TOKEN_OK, GATEWAY_OK]);
  const handler = createApiHandler({ configStore: makeStore(SAVED_CONFIG), runtime: makeRuntime(), fetchImpl: fake.impl });
  const json = await post(handler, { appId: '9999', appSecret: '***' });
  assert.equal(json.ok, true);
  assert.equal(fake.calls[0].body.clientSecret, 'stored-secret');
});

test('POST /verify-credentials: 参数形状不对 / 方法不对都 200 + ok:false', async () => {
  const fake = fakeFetch([TOKEN_OK, GATEWAY_OK]);
  const handler = createApiHandler({ configStore: makeStore(SAVED_CONFIG), runtime: makeRuntime(), fetchImpl: fake.impl });

  const badId = await post(handler, { appId: 123 });
  assert.equal(badId.ok, false);
  assert.match(badId.error, /appId/);

  const badSandbox = await post(handler, { sandbox: 'yes' });
  assert.equal(badSandbox.ok, false);
  assert.match(badSandbox.error, /sandbox/);

  const wrongType = await post(handler, '{}', { headers: { 'content-type': 'text/plain' } });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.error, /content-type/);

  const getJson = await post(handler, '', { method: 'GET', body: undefined });
  assert.equal(getJson.ok, false);
  assert.match(getJson.error, /只接受 POST \/verify-credentials/);
  assert.equal(fake.calls.length, 0);
});

test('POST /verify-credentials: 验证不过时把 step 带回去给页面说人话', async () => {
  const fake = fakeFetch([TOKEN_OK, { status: 404, body: {} }]);
  const handler = createApiHandler({ configStore: makeStore(SAVED_CONFIG), runtime: makeRuntime(), fetchImpl: fake.impl });
  const json = await post(handler, { appId: '1', appSecret: 'sec' });
  assert.equal(json.ok, false);
  assert.equal(json.step, 'sandbox');
  assert.match(json.error, /还没发布/);
});

// ---------------------------------------------------------------- 客户端：向导纯逻辑

function captureEntry() {
  const registered = [];
  const win = { __ModuleLoader__: { load: (entry) => registered.push(entry) } };
  const context = vm.createContext({ window: win, console: { warn() {}, log() {}, error() {} } });
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  assert.equal(registered.length, 1);
  return registered[0];
}

function flattenChildren(children) {
  const out = [];
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flattenChildren(child));
    else out.push(child);
  }
  return out;
}

function makeReactStub(forcedState, patches) {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: flattenChildren(children) };
    },
    useState(initial) {
      return [forcedState === undefined ? (typeof initial === 'function' ? initial() : initial) : forcedState, () => {}];
    },
    useEffect() {},
    ...(patches || {})
  };
}

function loadClient(state) {
  const entry = captureEntry();
  const exports = entry.factory((name) => {
    if (name === 'react') return makeReactStub(state);
    throw new Error('factory 请求了未声明的模块：' + name);
  });
  return { entry, exports };
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.children);
}

function findAll(node, predicate, out) {
  const acc = out || [];
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  for (const child of node.children) findAll(child, predicate, acc);
  return acc;
}

const PLATFORMS = [
  {
    id: 'qq-napcat',
    label: 'QQ（NapCat / OneBot）',
    fields: [
      { key: 'enabled', label: '启用', type: 'boolean' },
      { key: 'qqNapcat.wsUrl', label: 'WebSocket 地址', type: 'text', group: 'basic' }
    ]
  },
  {
    id: 'qq-official',
    label: 'QQ 官方机器人',
    fields: [
      { key: 'enabled', label: '启用', type: 'boolean' },
      { key: 'testTarget', label: '测试消息发给谁', type: 'text', group: 'basic' },
      { key: 'qqOfficial.appId', label: 'AppID', type: 'text', group: 'basic' },
      { key: 'qqOfficial.appSecret', label: 'AppSecret', type: 'password', secret: true, group: 'basic' },
      { key: 'qqOfficial.sandbox', label: '用沙箱', type: 'boolean' }
    ]
  }
];

const OFFICIAL_CONFIG = {
  enabled: false,
  platform: 'qq-official',
  testTarget: '',
  qqOfficial: { appId: '102911163', appSecret: '***', sandbox: true }
};

test('resolveWizardStep: 官方机器人三步各有状态，第一步指向开放平台', () => {
  const { exports } = loadClient();
  const steps = exports.resolveWizardStep({ platform: 'qq-official' });
  assert.equal(steps.length, 3);
  assert.deepEqual(Array.from(steps, (s) => s.id), ['open-platform', 'credentials', 'test-send']);
  assert.deepEqual(Array.from(steps, (s) => s.status), ['todo', 'todo', 'todo']);
  assert.equal(steps[0].url, 'https://q.qq.com/qqbot/#/developer');
  assert.equal(steps[0].statusText, '未做');
  assert.ok(steps[0].text.includes('扫码'), steps[0].text);
  assert.equal(exports.OPEN_PLATFORM_URL, steps[0].url);
});

test('resolveWizardStep: 平台切到个人号时第一步给下载页并提示扫码登录', () => {
  const { exports } = loadClient();
  const steps = exports.resolveWizardStep({ platform: 'qq-napcat' });
  assert.equal(steps[0].url, 'https://github.com/NapNeko/NapCatQQ/releases');
  assert.ok(steps[0].text.includes('扫码'), steps[0].text);
  assert.equal(steps[0].title, '装好 NapCat 并扫码');
  // NapCat 没有 AppID/AppSecret，这一步直接算通过，不装成"没做"
  assert.equal(steps[1].status, 'ok');
  assert.ok(steps[1].text.includes('不用做'), steps[1].text);
});

test('resolveWizardStep: 还没选平台时不给链接，免得把人带错地方', () => {
  const { exports } = loadClient();
  for (const platform of ['', 'wechat']) {
    const steps = exports.resolveWizardStep({ platform });
    assert.equal(steps[0].url, '', '平台没定就不该出现「打开开放平台/6099」');
    assert.equal(steps[0].title, '先选平台');
    assert.ok(steps[0].text.includes('先在上面选'), steps[0].text);
    assert.equal(steps[1].status, 'todo');
  }
});

test('resolveWizardStep: 进行中 / 通过 / 失败三种状态都落到对应一步', () => {
  const { exports } = loadClient();
  const running = exports.resolveWizardStep({ platform: 'qq-official', verifying: true });
  assert.equal(running[1].status, 'running');
  assert.equal(running[1].statusText, '进行中');

  const passed = exports.resolveWizardStep({
    platform: 'qq-official',
    verifyResult: { ok: true, appId: '102911163', sandbox: true }
  });
  assert.equal(passed[1].status, 'ok');
  assert.ok(passed[1].text.includes('✅ 已连通：102911163（沙箱环境）'), passed[1].text);
  assert.equal(passed[0].status, 'ok', '验证通过说明开放平台那一步显然做过了');

  const failed = exports.resolveWizardStep({
    platform: 'qq-official',
    verifyResult: { ok: false, step: 'sandbox', error: '机器人还没发布：把「沙箱环境」打开' }
  });
  assert.equal(failed[1].status, 'failed');
  assert.equal(failed[1].text, '机器人还没发布：把「沙箱环境」打开');
  assert.equal(failed[2].status, 'todo');
});

test('resolveWizardStep: 第三步复述发送结果（含失败原因）', () => {
  const { exports } = loadClient();
  const testing = exports.resolveWizardStep({ platform: 'qq-official', testing: true });
  assert.equal(testing[2].status, 'running');
  const ok = exports.resolveWizardStep({
    platform: 'qq-official',
    verifyResult: { ok: true, appId: '1' },
    testResult: { ok: true, target: '1772538871', chunkCount: 1 }
  });
  assert.equal(ok[2].status, 'ok');
  assert.ok(ok[2].text.includes('✅ 已发送给 1772538871'), ok[2].text);
  const bad = exports.resolveWizardStep({ platform: 'qq-official', testResult: { ok: false, error: '机器人还没启动' } });
  assert.equal(bad[2].status, 'failed');
  assert.ok(bad[2].text.includes('没发出去'), bad[2].text);
});

test('describeVerifyResult: 昵称优先，没有就用 AppID；环境写在括号里', () => {
  const { exports } = loadClient();
  const withNick = exports.describeVerifyResult({ ok: true, nickname: '大龙虾', appId: '102911163', sandbox: true });
  assert.equal(withNick.kind, 'ok');
  assert.equal(withNick.text, '✅ 已连通：大龙虾（沙箱环境）');
  const noNick = exports.describeVerifyResult({ ok: true, appId: '102911163', sandbox: false });
  assert.equal(noNick.text, '✅ 已连通：102911163（正式环境）');
  const failed = exports.describeVerifyResult({ ok: false, step: 'credentials', error: 'AppSecret 不对：去开放平台 → 开发设置 → 重置密钥' });
  assert.equal(failed.kind, 'error');
  assert.equal(failed.step, 'credentials');
  assert.ok(failed.text.includes('重置密钥'), failed.text);
  assert.equal(exports.describeVerifyResult(null).kind, 'error');
});

test('buildVerifyPayload: 空着/掩码就不传，让宿主用已保存的配置', () => {
  const { exports } = loadClient();
  assert.deepEqual(Object.keys(exports.buildVerifyPayload({})), []);
  assert.deepEqual(Object.keys(exports.buildVerifyPayload(undefined)), []);
  // cross-realm 对象比不了原型，只看键和值
  const masked = exports.buildVerifyPayload({
    'qqOfficial.appId': ' 102911163 ',
    'qqOfficial.appSecret': '***',
    'qqOfficial.sandbox': true
  });
  assert.deepEqual(Object.keys(masked), ['appId', 'sandbox']);
  assert.equal(masked.appId, '102911163');
  assert.equal(masked.sandbox, true);
  const filled = exports.buildVerifyPayload({ 'qqOfficial.appId': '1', 'qqOfficial.appSecret': ' real ' });
  assert.deepEqual(Object.keys(filled), ['appId', 'appSecret']);
  assert.equal(filled.appSecret, 'real');
  // 也接受展开后的键名（别的调用方复用同一份契约）
  assert.equal(exports.buildVerifyPayload({ appId: '2', appSecret: 's', sandbox: false }).sandbox, false);
});

test('渲染: 向导卡片在设置页最上面，官方平台给出两个输入框 + 验证按钮', () => {
  const base = loadClient().exports;
  const state = {
    ...base.createInitialState(),
    ...base.snapshotFrom({ platforms: PLATFORMS }, { config: OFFICIAL_CONFIG, configPath: 'X' }),
    loading: false
  };
  const { exports } = loadClient(state);
  const element = exports.DshBotSection({ close: () => {} });
  const text = textOf(element);
  assert.ok(text.includes('连接向导（三步点通）'), text);
  // 「平台」二字在副标题里也有（把各平台消息接给本机 DSH），所以按先序节点顺序比，
  // 而不是拿字符串位置比——要比的是"向导卡片在平台下拉前面"这件事。
  const nodes = findAll(element, () => true);
  const wizardAt = nodes.findIndex((node) => textOf(node).includes('连接向导（三步点通）'));
  const selectAt = nodes.findIndex((node) => node.type === 'select');
  assert.ok(wizardAt >= 0 && selectAt >= 0, '向导卡片与平台下拉都得在');
  assert.ok(wizardAt < selectAt, '向导必须排在平台下拉之前');
  assert.ok(text.includes('去开放平台'), text);
  const anchors = findAll(element, (n) => n.type === 'a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].props.href, 'https://q.qq.com/qqbot/#/developer');
  assert.ok(textOf(anchors[0]).includes('打开开放平台'));
  const password = findAll(element, (n) => n.type === 'input' && n.props.type === 'password');
  assert.equal(password.length, 2, 'AppSecret 输入框 + 字段表里的密钥框');
  assert.ok(findAll(element, (n) => n.type === 'button' && textOf(n) === '验证凭证').length === 1);
  assert.ok(findAll(element, (n) => n.type === 'button' && textOf(n) === '复制链接').length === 1);
  assert.ok(findAll(element, (n) => n.type === 'button' && textOf(n) === '发条测试消息').length === 1);
});

test('渲染: 个人号平台第一步给下载页，且不显示 AppID/AppSecret 输入', () => {
  const base = loadClient().exports;
  const state = {
    ...base.createInitialState(),
    ...base.snapshotFrom({ platforms: PLATFORMS }, { config: { ...OFFICIAL_CONFIG, platform: 'qq-napcat' }, configPath: 'X' }),
    loading: false
  };
  const { exports } = loadClient(state);
  const element = exports.DshBotSection({});
  const anchors = findAll(element, (n) => n.type === 'a');
  assert.equal(anchors[0].props.href, 'https://github.com/NapNeko/NapCatQQ/releases');
  assert.ok(textOf(element).includes('扫码登录'), textOf(element));
  assert.equal(findAll(element, (n) => n.type === 'button' && textOf(n) === '验证凭证').length, 0);
});

// ---- 二维码：宿主下发 SVG 就贴图，没下发就退回占位方块 ----

const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 37 37"><rect x="1" y="1" width="1" height="1"/></svg>';

function stateWithQr(wizardQr) {
  const base = loadClient().exports;
  return {
    ...base.createInitialState(),
    ...base.snapshotFrom({ platforms: PLATFORMS, wizardQr }, { config: OFFICIAL_CONFIG, configPath: 'X' }),
    loading: false
  };
}

function findInjectedSvg(element) {
  return findAll(element, (n) => n.props && n.props.dangerouslySetInnerHTML && typeof n.props.dangerouslySetInnerHTML.__html === 'string');
}

test('渲染: 有 wizardQr 时原样贴出二维码 SVG，「打开开放平台」和「复制链接」都还在', () => {
  const { exports } = loadClient(stateWithQr({ 'qq-official': QR_SVG }));
  const element = exports.DshBotSection({ close: () => {} });

  const injected = findInjectedSvg(element);
  assert.equal(injected.length, 1, '二维码 SVG 必须注入且只注入一次');
  assert.equal(injected[0].props.dangerouslySetInnerHTML.__html, QR_SVG);
  const anchors = findAll(element, (n) => n.type === 'a');
  assert.equal(anchors.length, 1, '扫不了码的人还得能点按钮');
  assert.equal(anchors[0].props.href, 'https://q.qq.com/qqbot/#/developer');
  assert.ok(textOf(anchors[0]).includes('打开开放平台'));
  assert.equal(findAll(element, (n) => n.type === 'button' && textOf(n) === '复制链接').length, 1);
});

test('渲染: 没有 wizardQr 时退回占位方块，不白屏也不报错', () => {
  for (const wizardQr of [undefined, {}, { 'qq-napcat': QR_SVG }]) {
    const { exports } = loadClient(stateWithQr(wizardQr));
    const element = exports.DshBotSection({ close: () => {} });
    assert.equal(findInjectedSvg(element).length, 0, '官方平台不该拿到 NapCat 的二维码');
    const text = textOf(element);
    assert.ok(text.includes('连接向导（三步点通）'), text);
    assert.ok(text.includes('打开开放平台'), text);
    assert.ok(text.includes('https://q.qq.com/qqbot/#/developer'), text);
  }
});

test('snapshotFrom: 不是 SVG、或带脚本/事件属性的下发值直接丢掉', () => {
  const base = loadClient().exports;
  const dirty = base.snapshotFrom(
    {
      platforms: PLATFORMS,
      wizardQr: {
        'qq-official': '<svg onload="alert(1)"></svg>',
        'qq-napcat': '<img src=x onerror=alert(1)>',
        evil: '<svg><script>alert(1)</script></svg>'
      }
    },
    { config: OFFICIAL_CONFIG, configPath: 'X' }
  );
  // client 跑在 vm 上下文里，对象原型与本地不同，只能按 key 比
  assert.deepEqual(Object.keys(dirty.wizardQr), []);
  const good = base.snapshotFrom({ platforms: PLATFORMS, wizardQr: { 'qq-official': '  ' + QR_SVG + '  ' } }, { config: OFFICIAL_CONFIG });
  assert.equal(good.wizardQr['qq-official'], QR_SVG);
});

// ---- 交互：真按按钮、真发请求（有状态假 React） ----

function makeInteractiveReact() {
  const hooks = [];
  const pending = [];
  let cursor = 0;
  return {
    react: {
      createElement(type, props, ...children) {
        return { type, props: props || {}, children: flattenChildren(children) };
      },
      useState(initial) {
        const index = cursor;
        cursor += 1;
        if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
        const hook = hooks[index];
        return [
          hook.value,
          (next) => {
            hook.value = typeof next === 'function' ? next(hook.value) : { ...hook.value, ...next };
          }
        ];
      },
      useEffect(effect) {
        const index = cursor;
        cursor += 1;
        if (!hooks[index]) {
          hooks[index] = { mounted: true };
          pending.push(effect);
        }
      }
    },
    beginRender() {
      cursor = 0;
    },
    takeEffects() {
      return pending.splice(0, pending.length);
    }
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function jsonResponse(payload) {
  return { status: 200, json: async () => payload };
}

function mount(statefulFetch) {
  const entry = captureEntry();
  const fake = makeInteractiveReact();
  const exports = entry.factory((name) => {
    if (name === 'react') return fake.react;
    throw new Error('factory 请求了未声明的模块：' + name);
  });
  const api = exports.createApi(statefulFetch);
  const render = () => {
    fake.beginRender();
    return exports.DshBotSection({ api, close: () => {} });
  };
  return { exports, render, fake };
}

async function settle(fake, render) {
  const first = render();
  for (const effect of fake.takeEffects()) effect();
  await tick();
  return render();
}

function wizardFetch(extra) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    if (url === '/dsh-bot/api/platforms') return jsonResponse({ ok: true, platforms: PLATFORMS });
    if (url === '/dsh-bot/api/config') return jsonResponse({ ok: true, config: OFFICIAL_CONFIG, warnings: [], configPath: 'X' });
    if (url === '/dsh-bot/api/status') return jsonResponse({ ok: true, running: true, enabled: true, platform: 'qq-official', stats: {} });
    return extra(url, init, calls);
  };
  return { impl, calls };
}

test('交互: 点「验证凭证」→ POST /verify-credentials，成功显示已连通', async () => {
  const { impl, calls } = wizardFetch(async (url) => {
    if (url === '/dsh-bot/api/verify-credentials') return jsonResponse({ ok: true, nickname: '大龙虾', appId: '102911163', sandbox: true });
    return jsonResponse({ ok: false, error: '未预期的请求 ' + url });
  });
  const { render, fake } = mount(impl);
  let element = await settle(fake, render);
  findAll(element, (n) => n.type === 'button' && textOf(n) === '验证凭证')[0].props.onClick();
  await tick();
  element = render();

  const verify = calls.filter((c) => c.url === '/dsh-bot/api/verify-credentials').pop();
  assert.ok(verify, '必须打到新接口');
  // 表单里密钥是 ***（表示不修改），所以只把 AppID 和沙箱开关发过去
  assert.deepEqual(verify.body, { appId: '102911163', sandbox: true });
  const text = textOf(element);
  assert.ok(text.includes('✅ 已连通：大龙虾（沙箱环境）'), text);
  assert.equal(text.includes('验证中…'), false);
});

test('交互: 验证失败时把宿主给的人话显示在第 2 步，不说已连通', async () => {
  const { impl } = wizardFetch(async (url) => {
    if (url === '/dsh-bot/api/verify-credentials') {
      return jsonResponse({ ok: false, step: 'sandbox', error: '机器人还没发布：把「沙箱环境」打开，并把自己的号加进体验成员' });
    }
    return jsonResponse({ ok: false, error: '未预期的请求 ' + url });
  });
  const { render, fake } = mount(impl);
  let element = await settle(fake, render);
  findAll(element, (n) => n.type === 'button' && textOf(n) === '验证凭证')[0].props.onClick();
  await tick();
  element = render();
  const text = textOf(element);
  assert.ok(text.includes('机器人还没发布'), text);
  assert.ok(text.includes('体验成员'), text);
  assert.ok(!text.includes('已连通'), text);
  assert.ok(text.includes('失败'), text);
});

test('交互: 第 3 步「发条测试消息」走已有的 POST /test-send', async () => {
  const { impl, calls } = wizardFetch(async (url) => {
    if (url === '/dsh-bot/api/test-send') return jsonResponse({ ok: true, target: '1772538871', chunkCount: 1 });
    return jsonResponse({ ok: false, error: '未预期的请求 ' + url });
  });
  const { render, fake } = mount(impl);
  let element = await settle(fake, render);
  findAll(element, (n) => n.type === 'button' && textOf(n) === '发条测试消息')[0].props.onClick();
  await tick();
  element = render();
  assert.ok(calls.some((c) => c.url === '/dsh-bot/api/test-send'));
  assert.ok(textOf(element).includes('✅ 已发送给 1772538871'), textOf(element));
});

test('交互: 网络全挂时点验证只留一行提示，不发"已连通"', async () => {
  const entry = captureEntry();
  const fake = makeInteractiveReact();
  const exports = entry.factory((name) => {
    if (name === 'react') return fake.react;
    throw new Error('工厂请求了未声明的模块：' + name);
  });
  const api = exports.createApi(async () => {
    throw new Error('ECONNREFUSED');
  });
  const render = () => {
    fake.beginRender();
    return exports.DshBotSection({ api });
  };
  let element = await settle(fake, render);
  // 数据没读到就没有验证按钮：先确认页面是一行可读错误，而不是白屏
  const text = textOf(element);
  assert.ok(text.includes('连接向导'), text);
  assert.ok(text.includes('连不上'), text);
  assert.ok(!text.includes('已连通'), text);
});
