import assert from 'node:assert/strict';

// 启动成功类用例必须带白名单：空白名单会被运行时拒绝启动（安全默认）
function withWhitelist(config) {
  return Object.assign({}, config, { security: Object.assign({}, config.security, { userWhitelist: ['1001'] }) });
}
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  API_PREFIX,
  MAX_BODY_BYTES,
  MAX_TAIL_LINES,
  createApiHandler,
  createApiRoutes
} from '../src/plugin/routes.mjs';
import {
  SECRET_MASK,
  createConfigStore,
  defaultConfig,
  getByPath,
  localDate,
  resolveLogFile
} from '../src/plugin/config-store.mjs';
import { createPlatformAdapter, listPlatforms } from '../src/plugin/platforms.mjs';
import { TEST_MESSAGE_TEXT, createRuntime, coreConfigOf, resolveTestTarget } from '../src/plugin/runtime.mjs';
import { apply, inject, name as pluginName } from '../lib/host.js';
import { createSerialQueue, createSemaphore } from '../src/queue.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIELD_TYPES = ['text', 'password', 'number', 'boolean', 'stringList', 'select'];

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bot-host-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeStore(dir) {
  return createConfigStore({ env: { DSH_BOT_CONFIG: join(dir, 'nested', 'config.json') } });
}

function configFor(rootDir, patch = {}) {

const config = defaultConfig();
  config.storage.rootDir = rootDir;
  return { ...config, ...patch };
}

// ---- 假 req / res：形状对齐 node:http，路由代码只认这些成员 ----

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

async function request(handler, options = {}) {
  const res = fakeRes();
  await handler(fakeReq(options), res);
  assert.equal(res.statusCode, 200, '所有业务错误都必须 HTTP 200');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-type'] ?? '', /application\/json/);
  return { res, json: JSON.parse(res.body || '{}') };
}

const postJson = (path, payload) => ({
  method: 'POST',
  url: API_PREFIX + path,
  headers: { 'content-type': 'application/json' },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload)
});

const getPath = (path) => ({ method: 'GET', url: API_PREFIX + path });

// ---- 假内核模块：注进 runtime，避免单测真的连 WebSocket / 起子进程 ----

function fakeModules(overrides = {}) {
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return logger;
    },
    flush() {
      return Promise.resolve();
    }
  };
  const client = {
    started: 0,
    stopped: 0,
    start() {
      this.started += 1;
    },
    async stop() {
      this.stopped += 1;
    },
    status() {
      return { open: false, lastError: null, attempts: 0 };
    },
    async call() {
      return {};
    }
  };
  const modules = {
    log: { createLogger: () => logger },
    storage: { createStorage: () => ({ saveFromUrl: async () => ({ path: '', bytes: 0 }) }) },
    security: { createGuard: () => ({ decide: () => ({ allow: true, reason: 'ok' }) }) },
    queue: { createSerialQueue, createSemaphore },
    sessions: { createSessionStore: () => ({ get: () => null, set: async () => {} }) },
    pipeline: {
      createPipeline: () => ({
        handleEvent: async () => {},
        stats: () => ({ received: 5, handled: 3, denied: 1, failed: 1, ignored: 2, parseErrors: 0 })
      })
    },
    dsh: { runDsh: async () => ({ ok: true, text: '', sessionId: null }) },
    onebotClient: { createOneBotClient: () => client }
  };
  return { modules: { ...modules, ...overrides }, client, logger };
}

// ---------------------------------------------------------------- 配置存储

test('config-store: 文件缺失时用默认值、给 warning、保存时自动建父目录', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    const view = store.read();
    assert.equal(view.exists, false);
    assert.equal(view.config.enabled, false);
    assert.equal(view.config.platform, 'qq-napcat');
    assert.ok(view.warnings.some((w) => w.includes('配置文件不存在')));

    const saved = await store.save(withWhitelist(configFor(join(dir, 'data'))));
    assert.equal(saved.ok, true);
    const onDisk = JSON.parse(await readFile(store.path, 'utf8'));
    assert.equal(onDisk.storage.rootDir, join(dir, 'data'));
    // 原子写不能留下 .tmp 残尸
    const names = await readdir(join(dir, 'nested'));
    assert.deepEqual(names, ['config.json']);
  });
});

test('config-store: 损坏文件备份成 .corrupt 后从默认值起步，不抛', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(store.path, '{ this is not json ', 'utf8');

    const view = store.read();
    assert.equal(view.corrupt, true);
    assert.equal(view.config.platform, 'qq-napcat');
    assert.ok(view.warnings.some((w) => w.includes('.corrupt')));
    const backup = await readFile(store.path + '.corrupt', 'utf8');
    assert.equal(backup, '{ this is not json ');
  });
});

test('config-store: storage.rootDir 落在 C 盘给 warning，且 secret 掩码往返无损', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    const saved = await store.save(configFor('C:\\dsh-im-bridge-data', { qqNapcat: { ...defaultConfig().qqNapcat, accessToken: 'tok-live' } }));
    assert.equal(saved.ok, true);
    assert.ok(saved.warnings.some((w) => w.includes('C 盘')));

    const live = store.read().config;
    assert.equal(live.qqNapcat.accessToken, 'tok-live');
    const masked = store.mask(live);
    assert.equal(masked.qqNapcat.accessToken, SECRET_MASK);
    assert.equal(store.applySecretMasks(masked, live).qqNapcat.accessToken, 'tok-live');
  });
});

// ---------------------------------------------------------------- GET /config

test('GET /config: 返回掩码后的配置 + warnings + configPath', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    await store.save(
      configFor(join(dir, 'data'), {
        qqNapcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'secret-token', reconnectMinMs: 1000, reconnectMaxMs: 30000 },
        qqOfficial: { appId: 'app-1', appSecret: 'app-secret', sandbox: true }
      })
    );
    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });
    const { json } = await request(handler, getPath('/config'));

    assert.equal(json.ok, true);
    assert.equal(json.config.qqNapcat.accessToken, SECRET_MASK);
    assert.equal(json.config.qqOfficial.appSecret, SECRET_MASK);
    assert.equal(json.config.platform, 'qq-napcat');
    assert.equal(json.configPath, store.path);
    assert.ok(Array.isArray(json.warnings));
    assert.equal(JSON.stringify(json).includes('secret-token'), false, 'GET /config 不得回显明文密钥');
  });
});

// ---------------------------------------------------------------- 平台字段表

test('GET /platforms: 字段表结构合法，secret 标记正确，key 都是真实配置点路径', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });
    const { json } = await request(handler, getPath('/platforms'));

    assert.equal(json.ok, true);
    assert.deepEqual(json.platforms.map((p) => p.id), ['qq-napcat', 'qq-official', 'wechat']);

    const defaults = defaultConfig();
    const seen = new Map();
    for (const platform of json.platforms) {
      assert.equal(typeof platform.label, 'string');
      assert.equal(typeof platform.description, 'string');
      assert.ok(Array.isArray(platform.fields) && platform.fields.length > 0);
      for (const field of platform.fields) {
        // options 是 select 的候选值（契约 §5：前端不写死字段表），其余键仍是封闭集合
        assert.deepEqual(Object.keys(field).filter((key) => key !== 'options').sort(), [
          'group',
          'help',
          'key',
          'label',
          'placeholder',
          'required',
          'secret',
          'type'
        ]);
        assert.ok(['basic', 'advanced'].indexOf(field.group) !== -1, '未知分组：' + field.group + '（' + field.key + '）');
        assert.ok(Array.isArray(field.options), '字段必须带 options 数组（非 select 为空数组）');
        assert.equal(typeof field.label, 'string');
        assert.ok(FIELD_TYPES.includes(field.type), '未知字段类型 ' + field.type);
        assert.equal(typeof field.required, 'boolean');
        assert.equal(typeof field.placeholder, 'string');
        assert.equal(typeof field.help, 'string');
        assert.match(field.key, /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/, '字段 key 必须是点路径：' + field.key);
        assert.notEqual(getByPath(defaults, field.key), undefined, '字段 key 不在配置形状里：' + field.key);
        seen.set(field.key, field.secret);
      }
    }
    assert.equal(seen.get('qqNapcat.accessToken'), true);
    assert.equal(seen.get('qqOfficial.appSecret'), true);
    assert.equal(seen.get('storage.rootDir'), false);

    // createApiRoutes 的形态：kind:'prefix' + path:'/dsh-bot/api'
    const route = createApiRoutes({ configStore: store, runtime: createRuntime({ configStore: store }) });
    assert.equal(route.kind, 'prefix');
    assert.equal(route.path, '/dsh-bot/api');
    assert.equal(API_PREFIX, '/dsh-bot/api');
    assert.equal(typeof route.handler, 'function');
  });
});

// ---------------------------------------------------------------- 字段分组

test('字段分组: basic 只放"新手必须看懂的那几项"，其余全进 advanced', () => {
  const BASIC = {
    'qq-napcat': ['enabled', 'storage.rootDir', 'security.userWhitelist', 'testTarget', 'dsh.binPath', 'dsh.profile', 'qqNapcat.wsUrl', 'qqNapcat.accessToken'],
    'qq-official': ['enabled', 'storage.rootDir', 'security.userWhitelist', 'testTarget', 'dsh.binPath', 'dsh.profile', 'qqOfficial.appId', 'qqOfficial.appSecret']
  };
  for (const platform of listPlatforms()) {
    const basic = platform.fields.filter((field) => field.group === 'basic').map((field) => field.key);
    // 首屏放太多等于没分组：上限 10，超了说明有人往 basic 里乱塞
    assert.ok(basic.length > 0 && basic.length <= 10, platform.id + ' basic 组数量异常：' + basic.length);
    assert.ok(platform.fields.some((field) => field.group === 'advanced'), platform.id + ' 没有 advanced 组，折叠区就是空的');
    if (BASIC[platform.id]) assert.deepEqual(basic.slice().sort(), BASIC[platform.id].slice().sort(), platform.id + ' basic 组变了');
    // 平台专属必填项必须落在 basic：新手第一眼就要填它们
    for (const field of platform.fields) {
      if (/^(qqOfficial\.appId|qqOfficial\.appSecret|qqNapcat\.wsUrl|qqNapcat\.accessToken)$/.test(field.key)) {
        assert.equal(field.group, 'basic', field.key + ' 必须在 basic 组');
      }
    }
  }
  const napcat = listPlatforms().find((p) => p.id === 'qq-napcat');
  const byKey = new Map(napcat.fields.map((field) => [field.key, field]));
  // 调参用的字段一个都不能留在首屏
  for (const key of ['storage.maxFileBytes', 'security.rateLimitPerMinute', 'security.maxConcurrentRuns', 'security.maxPromptChars', 'reply.maxChunkChars', 'asr.args', 'log.level', 'dsh.runner', 'approval.scope']) {
    assert.equal(byKey.get(key).group, 'advanced', key + ' 应该收进高级设置');
  }
  assert.ok(byKey.has('testTarget'), '缺 testTarget 字段');
});

test('resolveTestTarget: 显式 target > 配置 testTarget > 按平台从白名单猜', () => {
  const config = { platform: 'qq-napcat', testTarget: '', security: { userWhitelist: ['abc', '1772538871'] } };
  assert.deepEqual(resolveTestTarget(config, ' 42 '), { ok: true, target: '42', source: 'explicit' });
  assert.deepEqual(resolveTestTarget({ ...config, testTarget: '9527' }, ''), { ok: true, target: '9527', source: 'config' });
  assert.deepEqual(resolveTestTarget(config, ''), { ok: true, target: '1772538871', source: 'whitelist' });
  // 官方机器人只有 openid（≥20 位十六进制），QQ 号在那里不成立
  const official = { platform: 'qq-official', testTarget: '', security: { userWhitelist: ['1772538871', '0123456789abcdef0123456789abcdef'] } };
  assert.deepEqual(resolveTestTarget(official, ''), { ok: true, target: '0123456789abcdef0123456789abcdef', source: 'whitelist' });
  const none = resolveTestTarget({ platform: 'qq-napcat', testTarget: '', security: { userWhitelist: ['abc'] } }, '');
  assert.equal(none.ok, false);
  assert.match(none.error, /测试消息发给谁/);
});

// ---------------------------------------------------------------- POST /test-send

test('POST /test-send: 没启动时 ok:false + 人话，不抛也不发', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    await store.save(withWhitelist(configFor(join(dir, 'data'))));
    const sent = [];
    const { modules } = fakeModules({ onebotSend: { sendReply: async (args) => { sent.push(args); return { sent: 1, failed: 0 }; } } });
    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store, modules }) });

    const { json } = await request(handler, postJson('/test-send', {}));
    assert.equal(json.ok, false);
    assert.match(json.error, /还没启动/);
    assert.equal(sent.length, 0, '没启动就不能真发');
  });
});

test('POST /test-send: 启动后发一句测试消息，返回 target 与 chunkCount', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    await store.save(withWhitelist(configFor(join(dir, 'data'))));
    const sent = [];
    const { modules } = fakeModules({
      onebotSend: {
        sendReply: async (args) => {
          sent.push(args);
          return { sent: 2, failed: 0 };
        }
      }
    });
    const runtime = createRuntime({ configStore: store, modules });
    const handler = createApiHandler({ configStore: store, runtime });
    await request(handler, postJson('/control', { action: 'start' }));

    const auto = await request(handler, postJson('/test-send', {}));
    assert.equal(auto.json.ok, true, JSON.stringify(auto.json));
    assert.equal(auto.json.target, '1001', '没给 target 时按平台从白名单里猜一个 QQ 号');
    assert.equal(auto.json.chunkCount, 2);
    assert.equal(sent.length, 1);
    // 私聊 + 固定文案：群聊要 @ 才送达，测试消息不该逼用户先建群
    assert.deepEqual(sent[0].message, { chatType: 'private', userId: '1001' });
    assert.equal(sent[0].text, TEST_MESSAGE_TEXT);

    const explicit = await request(handler, postJson('/test-send', { target: ' 1002 ' }));
    assert.equal(explicit.json.ok, true);
    assert.equal(explicit.json.target, '1002');
    assert.equal(sent[1].message.userId, '1002');

    await request(handler, postJson('/control', { action: 'stop' }));
  });
});

test('POST /test-send: 白名单里没有能用的号时 ok:false，并说清该改哪', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    // 白名单非空才能启动，但里面没有一个纯数字（NapCat 只认 QQ 号）
    await store.save(configFor(join(dir, 'data'), { security: { ...defaultConfig().security, userWhitelist: ['not-a-number'] } }));
    const sent = [];
    const { modules } = fakeModules({ onebotSend: { sendReply: async (args) => { sent.push(args); return { sent: 1, failed: 0 }; } } });
    const runtime = createRuntime({ configStore: store, modules });
    const handler = createApiHandler({ configStore: store, runtime });
    const started = await request(handler, postJson('/control', { action: 'start' }));
    assert.equal(started.json.ok, true);

    const { json } = await request(handler, postJson('/test-send', {}));
    assert.equal(json.ok, false);
    assert.match(json.error, /测试消息发给谁/);
    assert.equal(sent.length, 0);

    // 发不出去时也不能假装成功：明确报 ok:false
    const failing = fakeModules({ onebotSend: { sendReply: async () => ({ sent: 0, failed: 1 }) } });
    const runtime2 = createRuntime({ configStore: store, modules: failing.modules });
    const handler2 = createApiHandler({ configStore: store, runtime: runtime2 });
    await request(handler2, postJson('/control', { action: 'start' }));
    const failed = await request(handler2, postJson('/test-send', { target: '1003' }));
    assert.equal(failed.json.ok, false);
    assert.match(failed.json.error, /发不出去/);
  });
});

// ---------------------------------------------------------------- POST /config

test('POST /config: 合法配置落盘，响应里密钥掩码', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });
    const payload = configFor(join(dir, 'data'), {
      qqNapcat: { ...defaultConfig().qqNapcat, accessToken: 'tok-1' }
    });

    const { json } = await request(handler, postJson('/config', { config: payload }));
    assert.equal(json.ok, true);
    assert.equal(json.config.qqNapcat.accessToken, SECRET_MASK);
    assert.ok(Array.isArray(json.warnings));

    const onDisk = JSON.parse(await readFile(store.path, 'utf8'));
    assert.equal(onDisk.qqNapcat.accessToken, 'tok-1');
    assert.equal(onDisk.storage.rootDir, join(dir, 'data'));
  });
});

test('POST /config: 校验失败时 ok:false + problems，且不落盘', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    await store.save(withWhitelist(configFor(join(dir, 'data'))));
    const before = await readFile(store.path, 'utf8');

    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });
    const bad = configFor(join(dir, 'data'), {
      platform: 'telegram',
      enabled: 'yes',
      qqNapcat: { ...defaultConfig().qqNapcat, wsUrl: 'http://nope' }
    });

    const { json } = await request(handler, postJson('/config', { config: bad }));
    assert.equal(json.ok, false);
    assert.equal(typeof json.error, 'string');
    assert.ok(json.problems.length >= 3);
    assert.ok(json.problems.some((p) => p.includes('platform')));
    assert.ok(json.problems.some((p) => p.includes('enabled')));
    assert.ok(json.problems.some((p) => p.includes('wsUrl')));
    assert.equal(await readFile(store.path, 'utf8'), before, '校验失败不得写盘');
  });
});

test('POST /config: secret 收到 "***" 表示不修改，收到新值则替换', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    await store.save(
      configFor(join(dir, 'data'), {
        qqNapcat: { ...defaultConfig().qqNapcat, accessToken: 'keep-me' },
        qqOfficial: { appId: 'app-1', appSecret: 'keep-secret', sandbox: false }
      })
    );
    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });

    const roundTrip = store.read().config;
    const masked = store.mask(roundTrip);
    masked.enabled = true;
    const first = await request(handler, postJson('/config', { config: masked }));
    assert.equal(first.json.ok, true);
    let onDisk = JSON.parse(await readFile(store.path, 'utf8'));
    assert.equal(onDisk.qqNapcat.accessToken, 'keep-me');
    assert.equal(onDisk.qqOfficial.appSecret, 'keep-secret');
    assert.equal(onDisk.enabled, true);

    const next = store.mask(onDisk);
    next.qqNapcat.accessToken = 'brand-new';
    const second = await request(handler, postJson('/config', { config: next }));
    assert.equal(second.json.ok, true);
    onDisk = JSON.parse(await readFile(store.path, 'utf8'));
    assert.equal(onDisk.qqNapcat.accessToken, 'brand-new');
    assert.equal(onDisk.qqOfficial.appSecret, 'keep-secret');
  });
});

test('POST /config: 非 JSON content-type、坏 JSON、超过 64KB、缺 config 都拒绝且不抛', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });

    const wrongType = await request(handler, { method: 'POST', url: API_PREFIX + '/config', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(wrongType.json.ok, false);

    const broken = await request(handler, postJson('/config', '{"config": '));
    assert.equal(broken.json.ok, false);
    assert.match(broken.json.error, /JSON/);

    const huge = await request(handler, postJson('/config', { config: { pad: 'x'.repeat(MAX_BODY_BYTES + 1024) } }));
    assert.equal(huge.json.ok, false);
    assert.match(huge.json.error, /上限/);

    const missing = await request(handler, postJson('/config', { nope: true }));
    assert.equal(missing.json.ok, false);
    assert.match(missing.json.error, /config/);
  });
});

// ---------------------------------------------------------------- GET /status

test('GET /status: 未运行时形态完整，stats 只有契约里的四个计数', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    await store.save(configFor(join(dir, 'data'), { enabled: true }));
    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });

    const { json } = await request(handler, getPath('/status'));
    assert.equal(json.ok, true);
    for (const key of ['enabled', 'running', 'platform', 'since', 'lastError']) {
      assert.ok(key in json, '缺少字段 ' + key);
    }
    assert.equal(json.enabled, true);
    assert.equal(json.running, false);
    assert.equal(json.since, null);
    assert.equal(json.platform, 'qq-napcat');
    assert.deepEqual(Object.keys(json.stats).sort(), ['denied', 'failed', 'handled', 'received']);
    assert.deepEqual(json.stats, { received: 0, handled: 0, denied: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------- POST /control

test('POST /control: start/stop/restart 幂等，running 与 stats 跟着真实运行时走', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    await store.save(withWhitelist(configFor(join(dir, 'data'))));
    const { modules, client } = fakeModules();
    const runtime = createRuntime({ configStore: store, modules });
    const handler = createApiHandler({ configStore: store, runtime });

    const stopIdle = await request(handler, postJson('/control', { action: 'stop' }));
    assert.equal(stopIdle.json.ok, true);
    assert.equal(stopIdle.json.status.running, false);
    const stopAgain = await request(handler, postJson('/control', { action: 'stop' }));
    assert.equal(stopAgain.json.ok, true);

    const started = await request(handler, postJson('/control', { action: 'start' }));
    assert.equal(started.json.ok, true);
    assert.equal(started.json.status.running, true);
    assert.equal(typeof started.json.status.since, 'number');
    assert.deepEqual(started.json.status.stats, { received: 5, handled: 3, denied: 1, failed: 1 });

    const twice = await request(handler, postJson('/control', { action: 'start' }));
    assert.equal(twice.json.ok, true);
    assert.equal(client.started, 1, '重复 start 不得再起一个适配器');

    const restarted = await request(handler, postJson('/control', { action: 'restart' }));
    assert.equal(restarted.json.ok, true);
    assert.equal(restarted.json.status.running, true);
    assert.equal(client.started, 2);

    const stopped = await request(handler, postJson('/control', { action: 'stop' }));
    assert.equal(stopped.json.ok, true);
    assert.equal(stopped.json.status.running, false);
    assert.equal(client.stopped, 2);

    const status = await request(handler, getPath('/status'));
    assert.equal(status.json.running, false);
    assert.deepEqual(status.json.stats, { received: 0, handled: 0, denied: 0, failed: 0 });
  });
});

test('POST /control: wechat 明确报"未实现"，qq-official 缺适配器报"尚未就绪"，都不抛', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    await store.save(withWhitelist(configFor(join(dir, 'data'), { platform: 'wechat' })));
    const { modules } = fakeModules();
    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store, modules }) });

    const { json } = await request(handler, postJson('/control', { action: 'start' }));
    assert.equal(json.ok, false);
    assert.match(json.error, /未实现/);
    assert.deepEqual(Object.keys(json).sort(), ['error', 'ok']);

    const notReady = createPlatformAdapter({ platform: 'qq-official', coreConfig: coreConfigOf(store.read().config), modules: {} });
    assert.equal(notReady.ok, false);
    assert.equal(notReady.error, '平台适配器尚未就绪');

    // 适配器在、但 AppID/Secret 没配：提前报清楚，而不是安静地一直连不上
    const missingCreds = createPlatformAdapter({
      platform: 'qq-official',
      coreConfig: coreConfigOf(defaultConfig()),
      modules: {
        qqbotAdapter: {
          createQqBotAdapter: () => ({ start() {}, stop() {}, client: {}, deps: {} }),
          qqBotProblems: () => ['qqbot.appId 为空']
        }
      }
    });
    assert.equal(missingCreds.ok, false);
    assert.match(missingCreds.error, /配置不完整.*appId/);

    const ready = createPlatformAdapter({
      platform: 'qq-official',
      coreConfig: coreConfigOf(defaultConfig()),
      modules: {
        qqbotAdapter: {
          createQqBotAdapter: () => ({ start() {}, stop() {}, client: {}, deps: { parseEvent: () => {} } }),
          qqBotProblems: () => []
        }
      }
    });
    assert.equal(ready.ok, true);
    assert.equal(ready.adapter.platform, 'qq-official');
    const unknown = createPlatformAdapter({ platform: 'telegram', coreConfig: {}, modules: {} });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /未知平台/);

    const badAction = await request(handler, postJson('/control', { action: 'explode' }));
    assert.equal(badAction.json.ok, false);
    assert.match(badAction.json.error, /start \/ stop \/ restart/);
  });
});

// ---------------------------------------------------------------- GET /logs/tail

test('GET /logs/tail: 读当前日志尾部，lines 上限 500', async () => {
  await withDir(async (dir) => {
    const rootDir = join(dir, 'data');
    const store = makeStore(dir);
    await store.save(configFor(rootDir));
    const logDir = join(rootDir, 'logs');
    await mkdir(logDir, { recursive: true });
    const rows = Array.from({ length: 620 }, (_, i) => 'line-' + i);
    await writeFile(join(logDir, 'bridge-' + localDate() + '.log'), rows.join('\n') + '\n', 'utf8');

    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });
    const dflt = await request(handler, getPath('/logs/tail'));
    assert.equal(dflt.json.ok, true);
    assert.equal(dflt.json.lines.length, 100);
    assert.equal(dflt.json.lines[dflt.json.lines.length - 1], 'line-619');

    const capped = await request(handler, getPath('/logs/tail?lines=9999'));
    assert.equal(capped.json.lines.length, MAX_TAIL_LINES);

    const three = await request(handler, getPath('/logs/tail?lines=3'));
    assert.deepEqual(three.json.lines, ['line-617', 'line-618', 'line-619']);

    const missingDay = await request(handler, getPath('/logs/tail?file=bridge-1999-01-01.log'));
    assert.equal(missingDay.json.ok, true);
    assert.deepEqual(missingDay.json.lines, []);
  });
});

test('GET /logs/tail: 越界（日志目录在 rootDir/logs 之外、文件名带 ..、绝对路径）一律 200 + ok:false', async () => {
  await withDir(async (dir) => {
    const rootDir = join(dir, 'data');
    const store = makeStore(dir);
    await store.save(configFor(rootDir, { log: { dir: join(dir, 'elsewhere'), level: 'info' } }));
    await mkdir(join(dir, 'elsewhere'), { recursive: true });
    await writeFile(join(dir, 'elsewhere', 'bridge-' + localDate() + '.log'), 'outside\n', 'utf8');

    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });
    const outside = await request(handler, getPath('/logs/tail'));
    assert.equal(outside.json.ok, false);
    assert.match(outside.json.error, /拒绝读取/);
    assert.equal(JSON.stringify(outside.json).includes('outside'), false);

    const traversal = await request(handler, getPath('/logs/tail?file=../../secret.txt'));
    assert.equal(traversal.json.ok, false);

    const absolute = await request(handler, getPath('/logs/tail?file=' + encodeURIComponent(join(dir, 'elsewhere', 'bridge.log'))));
    assert.equal(absolute.json.ok, false);

    // 纯函数层面也钉住：目录穿越在任何一行配置下都出不去
    const base = resolveLogFile({ storage: { rootDir }, log: { dir: '' } }, { file: '..\\..\\x.log' });
    assert.equal(base.ok, false);
    const inside = resolveLogFile({ storage: { rootDir }, log: { dir: '' } }, { file: 'bridge-2020-01-01.log' });
    assert.equal(inside.ok, true);
    assert.ok(inside.file.startsWith(join(rootDir, 'logs')));
  });
});

// ---------------------------------------------------------------- 其它路由

test('路由: 未知接口、错误方法都返回 200 + {ok:false,error}', async () => {
  await withDir(async (dir) => {
    const store = makeStore(dir);
    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });

    const unknown = await request(handler, getPath('/nope'));
    assert.equal(unknown.json.ok, false);
    assert.match(unknown.json.error, /未知接口/);

    const wrongMethod = await request(handler, { method: 'GET', url: API_PREFIX + '/control' });
    assert.equal(wrongMethod.json.ok, false);
    assert.match(wrongMethod.json.error, /只接受 POST/);

    const notUnderPrefix = await request(handler, { method: 'GET', url: '/api/other' });
    assert.equal(notUnderPrefix.json.ok, false);

    const badUrl = await request(handler, { method: 'GET', url: API_PREFIX + '/status?x=%E0%A4%A' });
    assert.equal(badUrl.json.ok, true, '非法 query 不该影响 status');
  });
});

// ---------------------------------------------------------------- apply / 宿主半边

function fakeCtx({ webServer, logger } = {}) {
  const registered = [];
  const disposers = [];
  return {
    logger: logger ?? { info() {}, warn() {}, error() {}, debug() {} },
    webServer,
    effect(callback) {
      const disposer = callback();
      disposers.push(disposer);
      return disposer;
    },
    _registered: registered,
    _disposers: disposers
  };
}

function fakeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {
        route.disposed = true;
      };
    }
  };
}

test('lib/host.js: name/inject 契约值', () => {
  assert.equal(pluginName, 'dsh-bot');
  assert.deepEqual(inject, ['webServer']);
});

test('apply: ctx.webServer 为 undefined 时不抛，整体降级', async () => {
  await withDir(async (dir) => {
    const warnings = [];
    const ctx = fakeCtx({ logger: { info() {}, warn: (m) => warnings.push(String(m)), error() {}, debug() {} } });
    const handle = apply(ctx, { env: { DSH_BOT_CONFIG: join(dir, 'config.json') } });
    assert.equal(handle.degraded, true);
    assert.equal(handle.route, null);
    assert.ok(warnings.some((w) => w.includes('webServer')));

    // ctx 完全没有 webServer 成员、连 get 都没有时也必须安静降级
    const bare = apply({ logger: { info() {}, warn() {}, error() {}, debug() {} } }, { env: { DSH_BOT_CONFIG: join(dir, 'config.json') } });
    assert.equal(bare.degraded, true);
  });
});

test('apply: 注册 kind:prefix 路由，卸载时停运行时并注销路由', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'config.json');
    const store = createConfigStore({ env: { DSH_BOT_CONFIG: file } });
    await store.save(withWhitelist(configFor(join(dir, 'data'), { platform: 'wechat' })));
    const webServer = fakeWebServer();
    const ctx = fakeCtx({ webServer });

    const handle = apply(ctx, { env: { DSH_BOT_CONFIG: file } });
    assert.equal(webServer.routes.length, 1);
    assert.equal(webServer.routes[0].kind, 'prefix');
    assert.equal(webServer.routes[0].path, '/dsh-bot/api');

    // 让运行时进入"启动失败但被吞掉"的状态，再确认卸载不抛
    const started = await handle.runtime.start();
    assert.equal(started.ok, false);
    assert.match(started.error, /未实现/);

    await handle.dispose();
    assert.equal(webServer.routes[0].disposed, true);
    assert.equal(handle.runtime.isRunning(), false);
    await handle.teardown();
    assert.equal(handle.runtime.isRunning(), false);
  });
});

test('apply: 路由注册抛错也不冒泡到 DSH 启动流程', async () => {
  await withDir(async (dir) => {
    const warnings = [];
    const ctx = fakeCtx({
      webServer: {
        register() {
          throw new Error('webserver: duplicate prefix route "/dsh-bot/api"');
        }
      },
      logger: { info() {}, warn: (m) => warnings.push(String(m)), error() {}, debug() {} }
    });
    assert.doesNotThrow(() => apply(ctx, { env: { DSH_BOT_CONFIG: join(dir, 'config.json') } }));
    assert.ok(warnings.some((w) => w.includes('降级')));
  });
});

test('apply: enabled=true 时异步自启，失败只记录 lastError 不抛出', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'config.json');
    const store = createConfigStore({ env: { DSH_BOT_CONFIG: file } });
    await store.save(withWhitelist(configFor(join(dir, 'data'), { enabled: true, platform: 'wechat' })));
    const ctx = fakeCtx({ webServer: fakeWebServer() });

    const handle = apply(ctx, { env: { DSH_BOT_CONFIG: file } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(handle.runtime.isRunning(), false);
    assert.match(handle.runtime.status().lastError ?? '', /未实现/);
    await handle.teardown();
  });
});

// ---------------------------------------------------------------- 插件清单

test('package.json / cordis.patch.yml 与契约 §1 逐字一致', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-im-bridge');
  // 版本号会被显式提升，断言形状而不是字面量，避免每次发版都要改测试
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(pkg.dsh.compatibility?.dshReleases?.['0.2.1-rc.2'] === 'compatible', '必须声明已验证的 DSH 版本');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/host.js');
  assert.deepEqual(pkg.exports, { '.': './lib/host.js', './client': './lib/client.js', './package.json': './package.json' });
  assert.deepEqual(pkg.dsh.engines, { dsh: '>=0.2.1-rc.2' });
  assert.deepEqual(pkg.dsh.bundle, { patch: './cordis.patch.yml' });
  assert.deepEqual(pkg.dsh.client, { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] });
  assert.deepEqual(pkg.bin, { 'dsh-im-bridge': 'bin/bridge.mjs', 'dsh-im-qqbot': 'bin/qqbot.mjs' });
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.scripts.test, 'node --test');

  const yml = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(yml, /- insert:/);
  assert.match(yml, /id:\s*dsh-bot\n/);
  assert.match(yml, /name:\s*'dsh-im-bridge'/);
  assert.match(yml, /config:\s*\{\}/);
});

test('listPlatforms: wechat 明确标注未实现，qq-official 有 appId/appSecret', () => {
  const platforms = listPlatforms();
  const wechat = platforms.find((p) => p.id === 'wechat');
  assert.match(wechat.description, /未实现/);
  const official = platforms.find((p) => p.id === 'qq-official');
  const keys = official.fields.map((f) => f.key);
  assert.ok(keys.includes('qqOfficial.appId'));
  assert.ok(keys.includes('qqOfficial.appSecret'));
  const napcat = platforms.find((p) => p.id === 'qq-napcat');
  assert.ok(napcat.fields.map((f) => f.key).includes('qqNapcat.wsUrl'));
});
