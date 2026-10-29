import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { API_PREFIX, createApiHandler } from '../src/plugin/routes.mjs';
import { DEFAULT_CONFIG, createConfigStore, defaultConfig, normalizeConfig } from '../src/plugin/config-store.mjs';
import { createPlatformAdapter, listPlatforms } from '../src/plugin/platforms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bot-wechat-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeStore(dir) {
  return createConfigStore({ env: { DSH_BOT_CONFIG: join(dir, 'nested', 'config.json') } });
}

function configWith(rootDir, patch = {}) {
  const config = defaultConfig();
  config.storage.rootDir = rootDir;
  config.security.userWhitelist = ['wxid_self'];
  return { ...config, ...patch };
}

// ---- 假 req / res：形状对齐 node:http，路由只认这些成员 ----
function fakeReq({ method = 'GET', url = API_PREFIX + '/status', headers = {}, body = '' } = {}) {
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
    writeHead(code, extra) {
      this.statusCode = code;
      Object.assign(this.headers, extra || {});
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

async function request(handler, options = {}) {
  const res = fakeRes();
  await handler(fakeReq(options), res);
  assert.equal(res.statusCode, 200, '业务失败也必须 HTTP 200（契约 §3）');
  return { res, json: JSON.parse(res.body || '{}') };
}

const fakeRuntime = { status: () => ({ running: false, platform: 'wechat', stats: {} }) };

// ---- 设置页：抓 lib/client.js 的模块工厂，喂假 window/react（与 plugin-layout 同一套手法） ----
const clientSource = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

function loadClient(forcedState) {
  const registered = [];
  const win = { __ModuleLoader__: { load: (entry) => registered.push(entry) } };
  const context = vm.createContext({ window: win, console: { warn() {}, log() {}, error() {} } });
  vm.runInContext(clientSource, context, { filename: 'lib/client.js' });
  assert.equal(registered.length, 1);
  const react = {
    createElement(type, props, ...children) {
      const flat = [];
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child);
        else flat.push(child);
      }
      return { type, props: props || {}, children: flat };
    },
    useState(initial) {
      return [forcedState === undefined ? (typeof initial === 'function' ? initial() : initial) : forcedState, () => {}];
    },
    useEffect() {}
  };
  return registered[0].factory((name) => {
    if (name === 'react') return react;
    throw new Error('factory 请求了未声明的模块：' + name);
  });
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
    label: 'QQ 个人账号',
    description: 'OneBot v11',
    fields: [
      { key: 'enabled', label: '启用', type: 'boolean', group: 'basic' },
      { key: 'storage.rootDir', label: '数据目录', type: 'text', group: 'basic' },
      { key: 'qqNapcat.wsUrl', label: 'WebSocket 地址', type: 'text', group: 'basic' }
    ]
  },
  {
    id: 'wechat',
    label: '微信个人号',
    description: '本机桥 + 微信客户端扫码登录',
    fields: [
      { key: 'enabled', label: '启用', type: 'boolean', group: 'basic' },
      { key: 'storage.rootDir', label: '数据目录', type: 'text', group: 'basic' },
      { key: 'wechat.bridgeUrl', label: '微信桥地址', type: 'text', group: 'basic', required: true },
      { key: 'security.userWhitelist', label: '谁能用', type: 'stringList', group: 'basic', placeholder: '' },
      { key: 'wechat.pollMs', label: '多久问一次桥', type: 'number', group: 'advanced' }
    ]
  }
];

const CONFIG = {
  enabled: true,
  platform: 'wechat',
  storage: { rootDir: 'E:\\dsh-im-bridge-data' },
  security: { userWhitelist: ['wxid_self'] },
  wechat: { bridgeUrl: 'http://127.0.0.1:19100', pollMs: 1000 }
};

test('wechat 配置：DEFAULT_CONFIG 有默认桥地址与轮询间隔，normalize 会校验并钳住下限', () => {
  assert.deepEqual(DEFAULT_CONFIG.wechat, { bridgeUrl: 'http://127.0.0.1:19100', pollMs: 1000 });

  return withDir(async (dir) => {
    const store = makeStore(dir);
    const ok = store.read();
    assert.equal(ok.config.wechat.bridgeUrl, 'http://127.0.0.1:19100');
    assert.equal(ok.config.wechat.pollMs, 1000);
    assert.deepEqual(ok.problems, []);

    // 桥地址写错形态直接拦住保存
    const saved = await store.save(configWith(join(dir, 'data'), { wechat: { bridgeUrl: 'ws://127.0.0.1:19100', pollMs: 1000 } }));
    assert.equal(saved.ok, false);
    assert.ok(saved.problems.some((p) => p.includes('wechat.bridgeUrl')), JSON.stringify(saved.problems));

    // 轮询太密：读时按问题+默认 1000 处理（与其他 readInt(min) 字段同一套语义），保存据此拒绝
    const tooFast = normalizeConfig({ ...configWith(join(dir, 'data')), wechat: { bridgeUrl: 'http://127.0.0.1:19100', pollMs: 50 } });
    assert.equal(tooFast.config.wechat.pollMs, 1000);
    assert.ok(tooFast.problems.some((p) => p.includes('wechat.pollMs')), JSON.stringify(tooFast.problems));

    // 换个端口的桥地址原样存下来（不做任何"帮你改"的加工）
    const kept = await store.save(configWith(join(dir, 'data'), { wechat: { bridgeUrl: 'http://127.0.0.1:19200/', pollMs: 500 } }));
    assert.equal(kept.ok, true);
    assert.equal(kept.config.wechat.pollMs, 500);
    assert.equal(kept.config.wechat.bridgeUrl, 'http://127.0.0.1:19200/');
  });
});

test('wechat 平台卡片：字段表里有桥地址（basic、必填）与轮询间隔，文案不再说未实现', () => {
  const wechat = listPlatforms().find((p) => p.id === 'wechat');
  assert.equal(wechat.label, '微信个人号');
  assert.match(wechat.description, /扫码登录由微信客户端完成/);
  assert.equal(/未实现|即将支持/.test(wechat.label + wechat.description), false);
  const byKey = new Map(wechat.fields.map((field) => [field.key, field]));
  assert.equal(byKey.get('wechat.bridgeUrl').group, 'basic');
  assert.equal(byKey.get('wechat.bridgeUrl').required, true);
  assert.equal(byKey.get('wechat.pollMs').type, 'number');
});

test('wechat 适配器装配：缺模块报"尚未就绪"，注入了就按 deps 透传给 pipeline', async () => {
  const notReady = createPlatformAdapter({ platform: 'wechat', coreConfig: defaultConfig(), modules: {} });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.error, '平台适配器尚未就绪');

  const calls = [];
  const built = createPlatformAdapter({
    platform: 'wechat',
    coreConfig: { ...defaultConfig(), wechat: { bridgeUrl: 'http://127.0.0.1:19200', pollMs: 500 } },
    modules: {
      wechatAdapter: {
        createWechatAdapter({ baseUrl, pollMs }) {
          calls.push({ baseUrl, pollMs });
          return {
            client: { tag: 'client' },
            deps: { parseEvent: () => ({ kind: 'unknown' }) },
            async start(onEvent) {
              calls.push({ start: typeof onEvent });
              return { ok: true };
            },
            async stop() {
              calls.push({ stop: true });
              return { ok: true };
            },
            status() {
              return { platform: 'wechat', running: true };
            },
            async send(args) {
              calls.push({ send: args });
              return { ok: true };
            }
          };
        }
      }
    }
  });
  assert.equal(built.ok, true);
  assert.equal(built.adapter.platform, 'wechat');
  assert.equal(calls[0].baseUrl, 'http://127.0.0.1:19200');
  assert.equal(calls[0].pollMs, 500);
  await built.adapter.start(() => {});
  assert.equal(calls[1].start, 'function');
  assert.equal(built.adapter.status().running, true);
  assert.deepEqual(await built.adapter.send({ to: 'wxid_a', text: 'hi' }), { ok: true });
  await built.adapter.stop();
  assert.equal(calls[calls.length - 1].stop, true);
});

test('GET /wechat/status：桥通且已登录时说清是谁，桥没起来时给人话错误，都是 HTTP 200', () =>
  withDir(async (dir) => {
    const store = makeStore(dir);
    await store.save(configWith(join(dir, 'data')));

    const connected = createApiHandler({
      configStore: store,
      runtime: fakeRuntime,
      fetchImpl: async (url) => {
        assert.equal(url, 'http://127.0.0.1:19100/status');
        return {
          status: 200,
          async json() {
            return { ok: true, loggedIn: true, selfWxid: 'wxid_self', nickname: '小号', received: 3 };
          }
        };
      }
    });
    const ok = await request(connected, { method: 'GET', url: API_PREFIX + '/wechat/status' });
    assert.deepEqual(ok.json, {
      ok: true,
      bridgeUrl: 'http://127.0.0.1:19100',
      loggedIn: true,
      selfWxid: 'wxid_self',
      nickname: '小号',
      received: 3
    });

    const refused = createApiHandler({
      configStore: store,
      runtime: fakeRuntime,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:19100');
      }
    });
    const bad = await request(refused, { method: 'GET', url: API_PREFIX + '/wechat/status' });
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.error, /连不上微信桥/);
    assert.match(bad.json.error, /ECONNREFUSED/);

    // 桥活着、微信没登录：loggedIn:false + 桥给的那句人话，页面据此说"还没登录"
    const notLogged = createApiHandler({
      configStore: store,
      runtime: fakeRuntime,
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return { ok: true, loggedIn: false, error: '没有找到 wcferry 这个 Python 包' };
        }
      })
    });
    const pending = await request(notLogged, { method: 'GET', url: API_PREFIX + '/wechat/status' });
    assert.equal(pending.json.ok, true);
    assert.equal(pending.json.loggedIn, false);
    assert.match(pending.json.error, /wcferry/);

    const wrongMethod = await request(connected, { method: 'POST', url: API_PREFIX + '/wechat/status' });
    assert.equal(wrongMethod.json.ok, false);
    assert.match(wrongMethod.json.error, /只接受 GET/);
  }));

test('describeWechatStatus：已连接带上昵称，未登录/连不上各说人话，没检测过不编结论', () => {
  const { describeWechatStatus } = loadClient();
  assert.deepEqual(JSON.parse(JSON.stringify(describeWechatStatus(null))), {
    ok: false,
    loggedIn: false,
    name: '',
    text: '还没检测过：点「检测连接」问一下微信桥'
  });
  const ok = describeWechatStatus({ ok: true, loggedIn: true, selfWxid: 'wxid_self', nickname: '小号' });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '已连接：小号');
  // 昵称拿不到就退回 wxid，绝不能显示"已连接："后面空着
  assert.equal(describeWechatStatus({ ok: true, loggedIn: true, selfWxid: 'wxid_self', nickname: '' }).text, '已连接：wxid_self');
  const notLogged = describeWechatStatus({ ok: true, loggedIn: false, error: '没有找到 wcferry' });
  assert.equal(notLogged.ok, false);
  assert.match(notLogged.text, /还没登录/);
  assert.match(notLogged.text, /wcferry/);
  const down = describeWechatStatus({ ok: false, error: '连不上微信桥 http://127.0.0.1:19100' });
  assert.equal(down.ok, false);
  assert.match(down.text, /连不上微信桥/);
});

test('设置页：微信卡片可选、有「检测连接」，接入卡片写明扫码登录由微信客户端完成', () => {
  const exports = loadClient();
  const cards = exports.platformCards(PLATFORMS, 'wechat');
  const wechatCard = cards.find((card) => card.id === 'wechat');
  assert.equal(wechatCard.disabled, false, '微信已经接了，卡片必须能点');
  assert.equal(wechatCard.badge, '');
  assert.equal(wechatCard.selected, true);

  const base = exports.createInitialState();
  const snap = exports.snapshotFrom({ platforms: PLATFORMS }, { config: CONFIG, configPath: 'E:\\cfg\\config.json', warnings: [] });
  const state = { ...base, ...snap, loading: false, status: { running: false, enabled: true, platform: 'wechat' }, statusAt: Date.now() };
  const forced = loadClient(state);
  const element = forced.DshBotSection({ close: () => {} });
  const text = textOf(element);
  assert.ok(text.includes('扫码登录由微信客户端完成'), text);
  assert.ok(text.includes('微信桥地址') || text.includes('http://127.0.0.1:19100'), text);
  const labels = findAll(element, (n) => n.type === 'button').map((n) => textOf(n));
  assert.ok(labels.includes('检测连接'), '微信卡片必须有检测连接按钮：' + labels.join('|'));
  assert.equal(text.includes('即将支持'), false, '微信不该再标"即将支持"');
  assert.equal(text.includes('未实现'), false);
});

test('设置页的接口层：「检测连接」走 /wechat/status，不是直连 127.0.0.1', async () => {
  const { createApi } = loadClient();
  const seen = [];
  const api = createApi(async (url, init) => {
    seen.push({ url, method: init.method });
    return {
      status: 200,
      async json() {
        return { ok: true, loggedIn: true, selfWxid: 'wxid_self', nickname: '小号' };
      }
    };
  }, '/dsh-bot/api');
  const payload = await api.wechatStatus();
  assert.equal(seen[0].url, '/dsh-bot/api/wechat/status');
  assert.equal(seen[0].method, 'GET');
  assert.equal(payload.nickname, '小号');
});
