import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'lib', 'client.js');
const source = readFileSync(clientPath, 'utf8');

// DSH 用 window.__ModuleLoader__.load({id, factory}) 注册惰性工厂，浏览器执行、不转译。
// 测试因此不能 import 这个文件：只能喂一个假 window，把 factory 抓出来手动 materialize。
function captureEntry() {
  const registered = [];
  const warnings = [];
  const win = {
    __ModuleLoader__: {
      load(entry) {
        registered.push(entry);
      }
    }
  };
  const context = vm.createContext({
    window: win,
    console: { warn: (...args) => warnings.push(args.join(' ')), log() {}, error() {} }
  });
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  assert.equal(registered.length, 1, '文件必须且只能注册一个模块');
  return { entry: registered[0], warnings };
}

function materialize(entry, react) {
  return entry.factory((name) => {
    if (name === 'react') return react;
    throw new Error('factory 请求了未声明的模块：' + name);
  });
}

function loadClient(options) {
  const opts = options || {};
  const react = makeReactStub(opts.state, opts.reactPatches);
  const { entry, warnings } = captureEntry();
  return { entry, exports: materialize(entry, react), react, warnings };
}

function flattenChildren(children) {
  const out = [];
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flattenChildren(child));
    else out.push(child);
  }
  return out;
}

// 极简 React 替身：只实现本文件用到的 createElement/useState/useEffect。
function makeReactStub(forcedState, patches) {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: flattenChildren(children) };
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      return [forcedState === undefined ? value : forcedState, () => {}];
    },
    useEffect() {},
    ...(patches || {})
  };
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
    description: '通过 OneBot v11 反向 WebSocket 连接 NapCat',
    fields: [
      { key: 'platform', label: '平台', type: 'select', required: true },
      { key: 'enabled', label: '启用', type: 'boolean' },
      { key: 'storage.rootDir', label: '数据目录', type: 'text', required: true, placeholder: 'E:\\dsh-im-bridge-data' },
      { key: 'security.userWhitelist', label: '用户白名单', type: 'stringList', help: '一行一个 QQ 号' },
      { key: 'security.rateLimitPerMinute', label: '每分钟上限', type: 'number' },
      { key: 'qqNapcat.wsUrl', label: 'WebSocket 地址', type: 'text', required: true },
      { key: 'qqNapcat.accessToken', label: 'AccessToken', type: 'password', secret: true }
    ]
  },
  {
    id: 'qq-official',
    label: 'QQ（官方机器人）',
    description: 'QQ 开放平台',
    fields: [
      { key: 'platform', label: '平台', type: 'select' },
      { key: 'enabled', label: '启用', type: 'boolean' },
      { key: 'storage.rootDir', label: '数据目录', type: 'text' },
      { key: 'security.userWhitelist', label: '用户白名单', type: 'stringList' },
      { key: 'security.rateLimitPerMinute', label: '每分钟上限', type: 'number' },
      { key: 'qqOfficial.appId', label: 'AppID', type: 'text' },
      { key: 'qqOfficial.appSecret', label: 'AppSecret', type: 'password', secret: true }
    ]
  }
];

const CONFIG = {
  enabled: false,
  platform: 'qq-napcat',
  storage: { rootDir: 'E:\\dsh-im-bridge-data', maxFileBytes: 1 },
  security: { userWhitelist: ['10001', '10002'], rateLimitPerMinute: 6 },
  qqNapcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '***' },
  qqOfficial: { appId: '', appSecret: '***' },
  log: { dir: '', level: 'info' }
};

// ---------------- 1. 模块导出形状 ----------------

test('模块按 __ModuleLoader__.load({id, factory}) 注册，id 与包名一致', () => {
  const { entry, exports } = loadClient();
  assert.equal(entry.id, 'dsh-im-bridge');
  assert.equal(typeof entry.factory, 'function');
  assert.equal(typeof exports, 'object');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale']);
});

test('文件里没有 ESM 语法（宿主运行期不转译，只用 require）', () => {
  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    assert.ok(!/^\s*import\s/.test(line), '第 ' + (index + 1) + ' 行出现 import');
    assert.ok(!/^\s*export\s/.test(line), '第 ' + (index + 1) + ' 行出现 export');
  }
  const firstCodeLine = lines.filter((line) => line.trim() && !line.trim().startsWith('//'))[0];
  assert.ok(firstCodeLine.startsWith('window.__ModuleLoader__.load({'), '代码第一行必须直接注册工厂：' + firstCodeLine);
});

// ---------------- 2. apply 注册参数 ----------------

test('apply 通过 ctx.slots.inject 注册 settings.section', () => {
  const { exports } = loadClient();
  const injected = [];
  const registrations = [];
  const ctx = {
    slots: {
      inject(name, callback) {
        injected.push(name);
        callback();
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      }
    }
  };
  exports.apply(ctx);
  assert.deepEqual(injected, ['settings.section']);
  assert.equal(registrations.length, 1);
  const { options, component } = registrations[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'dsh-bot');
  assert.equal(typeof options.order, 'number');
  assert.equal(options.order, 120);
  assert.equal(typeof options.label, 'function');
  assert.equal(options.label(), 'dsh bot');
  assert.equal(component, exports.DshBotSection);
});

test('slot 服务缺失时 apply 只告警，不抛异常', () => {
  const { exports, warnings } = loadClient();
  assert.doesNotThrow(() => exports.apply(undefined));
  assert.doesNotThrow(() => exports.apply({}));
  assert.doesNotThrow(() =>
    exports.apply({
      slots: {
        inject() {
          throw new Error('slot 服务未就绪');
        },
        register() {}
      }
    })
  );
  assert.ok(warnings.some((w) => w.includes('dsh-bot')), '必须留下可检索的告警：' + warnings.join('|'));
});

// ---------------- 3. 组件渲染（不抛、能落到元素树） ----------------

test('加载态渲染不抛，且能看到状态行', () => {
  const { exports } = loadClient();
  const element = exports.DshBotSection({ close: () => {} });
  const text = textOf(element);
  assert.equal(element.type, 'div');
  assert.ok(text.includes('正在读取'), text);
  assert.ok(text.includes('dsh bot'), text);
});

test('就绪态渲染出平台下拉、白名单文本域、数据目录、保存按钮', () => {
  const state = {
    ...loadClient().exports.createInitialState(),
    ...loadClient().exports.snapshotFrom({ platforms: PLATFORMS }, { config: CONFIG, configPath: 'E:\\cfg\\config.json' }),
    loading: false
  };
  const { exports } = loadClient({ state });
  const element = exports.DshBotSection({ close: () => {} });
  const text = textOf(element);
  const selects = findAll(element, (n) => n.type === 'select');
  const textareas = findAll(element, (n) => n.type === 'textarea');
  const buttons = findAll(element, (n) => n.type === 'button');
  assert.equal(selects.length, 1, '只有平台下拉：platform/enabled 字段由信封控件接管，不重复渲染');
  assert.equal(selects[0].props.id, 'dsh-bot-platform');
  assert.equal(textareas.length, 1, 'stringList 字段用 textarea');
  assert.equal(textareas[0].props.value, '10001\n10002');
  assert.ok(text.includes('数据目录'), text);
  assert.ok(buttons.some((b) => textOf(b) === '保存'));
  assert.ok(buttons.some((b) => textOf(b) === '启动'));
  assert.ok(buttons.some((b) => textOf(b) === '停止'));
  assert.ok(buttons.some((b) => textOf(b) === '重启'));
  // platform/enabled 由信封控件维护，不应在字段组里重复出现
  const platformLabels = findAll(element, (n) => n.type === 'label').map((n) => textOf(n));
  assert.ok(!platformLabels.some((label) => label === '平台 *'), platformLabels.join('|'));
  assert.ok(text.includes('配置文件：E:\\cfg\\config.json'), text);
});

test('渲染抛异常时退化成一行提示，不白屏', () => {
  const state = {
    ...loadClient().exports.createInitialState(),
    status: { running: false, enabled: false, stats: {} },
    loading: false
  };
  // platforms 故意塞非数组，逼渲染路径里某处失败
  state.platforms = { not: 'an array' };
  const { exports } = loadClient({ state });
  const element = exports.DshBotSection({ close: () => {} });
  assert.equal(element.type, 'div');
  assert.ok(textOf(element).length > 0);
});

test('服务端告警渲染成列表', () => {
  const state = {
    ...loadClient().exports.createInitialState(),
    ...loadClient().exports.snapshotFrom(
      { platforms: PLATFORMS },
      { config: CONFIG, warnings: ['storage.rootDir 落在 C 盘'], configPath: 'x' }
    ),
    loading: false
  };
  const { exports } = loadClient({ state });
  const text = textOf(exports.DshBotSection({}));
  assert.ok(text.includes('配置告警'), text);
  assert.ok(text.includes('落在 C 盘'), text);
});

// ---------------- 4. 网络请求（fetch 注入） ----------------

function recordingFetch(handlers) {
  const calls = [];
  const queue = (handlers || []).slice();
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 0 ? queue.shift() : { status: 200, json: async () => ({ ok: true }) };
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  return { impl, calls };
}

test('GET /platforms、GET /config、GET /status 打对 URL 且不带 body', async () => {
  const { impl, calls } = recordingFetch([
    { status: 200, json: async () => ({ ok: true, platforms: PLATFORMS }) },
    { status: 200, json: async () => ({ ok: true, config: CONFIG, warnings: [], configPath: 'E:\\cfg\\config.json' }) },
    { status: 200, json: async () => ({ ok: true, running: false, enabled: false, stats: {} }) }
  ]);
  const { exports } = loadClient();
  const api = exports.createApi(impl);
  const platforms = await api.platforms();
  const config = await api.config();
  const status = await api.status();
  assert.deepEqual(
    calls.map((c) => c.url),
    ['/dsh-bot/api/platforms', '/dsh-bot/api/config', '/dsh-bot/api/status']
  );
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.body, undefined, 'GET 不许带 body');
    assert.equal(call.init.cache, 'no-store');
  }
  assert.equal(platforms.platforms.length, 2);
  assert.equal(config.configPath, 'E:\\cfg\\config.json');
  assert.equal(status.ok, true);
});

test('POST /config 的 body 是 {config}，POST /control 的 body 是 {action}', async () => {
  const { impl, calls } = recordingFetch([
    { status: 200, json: async () => ({ ok: true, config: CONFIG, warnings: [] }) },
    { status: 200, json: async () => ({ ok: true, status: { running: true } }) }
  ]);
  const { exports } = loadClient();
  const api = exports.createApi(impl);
  await api.save(CONFIG);
  await api.control('start');
  assert.equal(calls[0].url, '/dsh-bot/api/config');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { config: CONFIG });
  assert.equal(calls[1].url, '/dsh-bot/api/control');
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), { action: 'start' });
});

test('保存被服务端拒绝时带出 problems 列表', async () => {
  const { impl } = recordingFetch([
    { status: 200, json: async () => ({ ok: false, error: '配置校验失败', problems: ['storage.rootDir 必填', 'qqNapcat.wsUrl 必须以 ws:// 开头'] }) }
  ]);
  const { exports } = loadClient();
  const api = exports.createApi(impl);
  await assert.rejects(api.save({}), (err) => {
    assert.ok(err.message.includes('配置校验失败'), err.message);
    assert.deepEqual(Array.from(err.problems), ['storage.rootDir 必填', 'qqNapcat.wsUrl 必须以 ws:// 开头']);
    return true;
  });
});

test('网络/协议失败都变成一行可读错误，不抛原始异常', async () => {
  const { exports } = loadClient();
  const cases = [
    [
      async () => {
        throw new Error('ECONNREFUSED');
      },
      '连不上'
    ],
    [async () => ({ status: 502, json: async () => ({}) }), 'HTTP 502'],
    [
      async () => ({
        status: 200,
        json: async () => {
          throw new Error('Unexpected token <');
        }
      }),
      '不是合法 JSON'
    ],
    [async () => ({ status: 200, json: async () => 'nope' }), '不是 JSON 对象']
  ];
  for (const [impl, expected] of cases) {
    const api = exports.createApi(impl);
    await assert.rejects(api.config(), (err) => {
      assert.ok(err.message.includes(expected), err.message + ' 缺少 ' + expected);
      assert.ok(!err.message.includes('at '), '不允许把 stack 塞进提示：' + err.message);
      return true;
    });
  }
});

test('status 返回 ok:false 时按失败处理', async () => {
  const { impl } = recordingFetch([{ status: 200, json: async () => ({ ok: false, error: '运行时未就绪' }) }]);
  const { exports } = loadClient();
  await assert.rejects(exports.createApi(impl).status(), /运行时未就绪/);
});

// ---------------- 5. 纯函数：字段表 -> 表单 -> config ----------------

test('formFromConfig 把点路径配置摊平成表单值', () => {
  const { exports } = loadClient();
  const fields = exports.mergeFields(exports.normalizePlatforms(PLATFORMS), 'qq-napcat');
  const form = exports.formFromConfig(CONFIG, fields);
  assert.equal(form['storage.rootDir'], 'E:\\dsh-im-bridge-data');
  assert.equal(form['security.userWhitelist'], '10001\n10002');
  assert.equal(form['security.rateLimitPerMinute'], '6');
  assert.equal(form['qqNapcat.wsUrl'], 'ws://127.0.0.1:3001');
  assert.equal(form['qqNapcat.accessToken'], '***', 'secret 字段必须以 *** 回显');
  // platform 字段本身也走点路径（host 下发时），与信封控件写的是同一个键
  assert.equal(form.platform, 'qq-napcat');
  assert.equal(form.enabled, false);
});

test('buildForm 补上 platform/enabled 信封字段', () => {
  const { exports } = loadClient();
  const form = exports.buildForm(CONFIG, [], 'qq-napcat');
  assert.equal(form.platform, 'qq-napcat');
  assert.equal(form.enabled, false);
  assert.equal(exports.buildForm({ ...CONFIG, enabled: true }, [], 'qq-official').enabled, true);
  assert.equal(exports.buildForm(CONFIG, [], 'qq-official').platform, 'qq-official');
});

test('buildConfig 把表单改动写回点路径，未下发字段原样保留', () => {
  const { exports } = loadClient();
  const fields = exports.mergeFields(exports.normalizePlatforms(PLATFORMS), 'qq-napcat');
  const form = {
    ...exports.formFromConfig(CONFIG, fields),
    platform: 'qq-napcat',
    enabled: true,
    'storage.rootDir': 'E:\\new-root',
    'security.userWhitelist': '  20002 \n\n20002\n, 20003\n',
    'security.rateLimitPerMinute': '12',
    'qqNapcat.wsUrl': 'ws://127.0.0.1:3999'
  };
  const next = exports.buildConfig(CONFIG, fields, form);
  assert.equal(next.storage.rootDir, 'E:\\new-root');
  assert.deepEqual(Array.from(next.security.userWhitelist), ['20002', '20003'], '去空行、去重、拆逗号');
  assert.equal(next.security.rateLimitPerMinute, 12);
  assert.equal(typeof next.security.rateLimitPerMinute, 'number');
  assert.equal(next.qqNapcat.wsUrl, 'ws://127.0.0.1:3999');
  assert.equal(next.enabled, true);
  assert.equal(next.platform, 'qq-napcat');
  // 没有出现在字段表里的配置项必须原封不动
  assert.equal(next.storage.maxFileBytes, 1);
  assert.equal(next.log.level, 'info');
  // 原对象不能被改动
  assert.equal(CONFIG.security.rateLimitPerMinute, 6);
});

test('未修改的密码提交 "***"，不会被真的写进配置', () => {
  const { exports } = loadClient();
  const fields = exports.mergeFields(exports.normalizePlatforms(PLATFORMS), 'qq-napcat');
  const form = { ...exports.formFromConfig(CONFIG, fields), platform: 'qq-napcat', enabled: false };
  const untouched = exports.buildConfig(CONFIG, fields, form);
  assert.equal(untouched.qqNapcat.accessToken, '***', '"***" 表示不修改，原值（此处被掩码）不能被覆盖成字面量');

  const filled = exports.buildConfig({ ...CONFIG, qqNapcat: { wsUrl: 'ws://x', accessToken: '***' } }, fields, {
    ...form,
    'qqNapcat.accessToken': 'real-token'
  });
  assert.equal(filled.qqNapcat.accessToken, 'real-token');

  const cleared = exports.buildConfig(CONFIG, fields, { ...form, 'qqNapcat.accessToken': '' });
  assert.equal(cleared.qqNapcat.accessToken, '', '显式清空要能落下去');
});

test('number 字段留空时保持原值，不变成 0', () => {
  const { exports } = loadClient();
  const fields = exports.normalizePlatforms(PLATFORMS)[0].fields;
  const next = exports.buildConfig(CONFIG, fields, { 'security.rateLimitPerMinute': '', platform: 'qq-napcat', enabled: false });
  assert.equal(next.security.rateLimitPerMinute, 6);
});

test('boolean 字段被写成真正的布尔值', () => {
  const { exports } = loadClient();
  const fields = exports.normalizePlatforms([{ id: 'w', fields: [{ key: 'security.allowGroup', type: 'boolean' }] }])[0].fields;
  const on = exports.buildConfig({ security: { allowGroup: false } }, fields, { 'security.allowGroup': true });
  assert.equal(on.security.allowGroup, true);
  const off = exports.buildConfig({ security: { allowGroup: true } }, fields, { 'security.allowGroup': false });
  assert.equal(off.security.allowGroup, false);
});

test('mergeFields 把多平台共有的字段提到前面，平台私有字段留在后面', () => {
  const { exports } = loadClient();
  const platforms = exports.normalizePlatforms(PLATFORMS);
  const napcat = exports.mergeFields(platforms, 'qq-napcat').map((f) => f.key);
  assert.deepEqual(napcat.slice(0, 5), [
    'platform',
    'enabled',
    'storage.rootDir',
    'security.userWhitelist',
    'security.rateLimitPerMinute'
  ]);
  assert.deepEqual(napcat.slice(5), ['qqNapcat.wsUrl', 'qqNapcat.accessToken']);
  const official = exports.mergeFields(platforms, 'qq-official').map((f) => f.key);
  assert.deepEqual(official.slice(5), ['qqOfficial.appId', 'qqOfficial.appSecret']);
  assert.deepEqual(Array.from(exports.mergeFields([], 'x')), []);
});

test('switchPlatformForm 保留公共字段的已改输入，换上新平台的私有字段', () => {
  const { exports } = loadClient();
  const platforms = exports.normalizePlatforms(PLATFORMS);
  const fields = exports.mergeFields(platforms, 'qq-napcat');
  const state = {
    platforms,
    config: CONFIG,
    platformId: 'qq-napcat',
    fields,
    form: {
      ...exports.buildForm(CONFIG, fields, 'qq-napcat'),
      'security.userWhitelist': '30003',
      'qqNapcat.wsUrl': 'ws://edited'
    }
  };
  const next = exports.switchPlatformForm(state, 'qq-official');
  assert.equal(next.platformId, 'qq-official');
  assert.equal(next.form.platform, 'qq-official');
  assert.equal(next.form['security.userWhitelist'], '30003', '公共字段的编辑不能被切平台清掉');
  assert.equal(next.form['qqOfficial.appId'], '');
  assert.equal(next.form['qqNapcat.wsUrl'], undefined, '平台私有字段在新平台的字段表里不存在');
  assert.ok(next.fields.some((f) => f.key === 'qqOfficial.appId'));
  assert.ok(!next.fields.some((f) => f.key === 'qqNapcat.wsUrl'));
});

test('groupFields 只分 basic / advanced 两组，basic 在前', () => {
  const { exports } = loadClient();
  const fields = exports.groupFields([
    { key: 'storage.maxFileBytes', type: 'number', group: 'advanced' },
    { key: 'enabled', type: 'boolean', group: 'basic' },
    { key: 'storage.rootDir', type: 'text', group: 'basic' },
    { key: 'log.level', type: 'select', group: 'advanced' }
  ]);
  assert.deepEqual(Array.from(fields, (g) => g.group), ['basic', 'advanced']);
  assert.deepEqual(Array.from(fields[0].fields, (f) => f.key), ['enabled', 'storage.rootDir']);
  assert.deepEqual(Array.from(fields[1].fields, (f) => f.key), ['storage.maxFileBytes', 'log.level']);
  assert.equal(fields[0].title, '常用设置');
  assert.match(fields[1].title, /高级设置/);
  // 空组不能留下一个空标题
  assert.deepEqual(Array.from(exports.groupFields([{ key: 'a', group: 'basic' }]), (g) => g.group), ['basic']);
  assert.deepEqual(Array.from(exports.groupFields([])), []);
});

test('老版本 host 不下发 group 时整体当 basic 渲染，不把整页塞进折叠区', () => {
  const { exports } = loadClient();
  const normalized = exports.normalizePlatforms(PLATFORMS)[0].fields;
  assert.ok(normalized.every((field) => field.group === 'advanced'), '缺省值是 advanced（新字段默认不进首屏）');
  assert.deepEqual(Array.from(exports.groupFields(normalized), (g) => g.group), ['basic']);
  // 非法分组名同样落到 advanced，而不是丢字段
  assert.equal(exports.normalizeField({ key: 'x', group: '白名单' }).group, 'advanced');
  assert.equal(exports.normalizeField({ key: 'x', group: 'BASIC' }).group, 'basic');
});

test('buildTestSendPayload 留空不传 target，填了就 trim 后带上', () => {
  const { exports } = loadClient();
  // 跨 realm 的对象比较不了原型，只看 key
  assert.deepEqual(Object.keys(exports.buildTestSendPayload('')), []);
  assert.deepEqual(Object.keys(exports.buildTestSendPayload('   ')), []);
  assert.deepEqual(Object.keys(exports.buildTestSendPayload(undefined)), []);
  const filled = exports.buildTestSendPayload(' 1772538871 ');
  assert.deepEqual(Object.keys(filled), ['target']);
  assert.equal(filled.target, '1772538871');
});

test('describeTestResult 成功说清发给谁，失败给出人话原因', () => {
  const { exports } = loadClient();
  const ok = exports.describeTestResult({ ok: true, target: '1772538871', chunkCount: 1 });
  assert.equal(ok.kind, 'ok');
  assert.ok(ok.text.includes('已发送给 1772538871'), ok.text);
  assert.ok(!ok.text.includes('分 '), ok.text);
  const chunked = exports.describeTestResult({ ok: true, target: 'abc', chunkCount: 3 });
  assert.ok(chunked.text.includes('分 3 条'), chunked.text);
  const failed = exports.describeTestResult({ ok: false, error: '机器人还没启动：先点「启动」' });
  assert.equal(failed.kind, 'error');
  assert.ok(failed.text.includes('没发出去'), failed.text);
  assert.ok(failed.text.includes('先点「启动」'), failed.text);
  assert.equal(exports.describeTestResult(null).kind, 'error');
});

test('snapshotFrom 选用配置里的平台，非法值退回第一个平台', () => {
  const { exports } = loadClient();
  const ok = exports.snapshotFrom({ platforms: PLATFORMS }, { config: CONFIG, configPath: 'p', warnings: ['w'] });
  assert.equal(ok.platformId, 'qq-napcat');
  assert.equal(ok.configPath, 'p');
  assert.deepEqual(Array.from(ok.warnings), ['w']);
  const bad = exports.snapshotFrom({ platforms: PLATFORMS }, { config: { ...CONFIG, platform: 'wechat' } });
  assert.equal(bad.platformId, 'qq-napcat');
  const empty = exports.snapshotFrom(undefined, undefined);
  assert.equal(empty.platformId, '');
  assert.deepEqual(Array.from(empty.fields), []);
});

test('statusLine 把 running/enabled/stats/lastError 说成一句人话', () => {
  const { exports } = loadClient();
  const line = exports.statusLine({ running: true, enabled: true, platform: 'qq-napcat', stats: { received: 5, handled: 4, denied: 1, failed: 0 } });
  assert.ok(line.includes('运行中'), line);
  assert.ok(line.includes('启用开'), line);
  assert.ok(line.includes('收到 5'), line);
  assert.ok(line.includes('平台 qq-napcat'), line);
  const withError = exports.statusLine({ running: false, enabled: false, stats: {}, lastError: 'ws 断开' });
  assert.ok(withError.includes('已停止'), withError);
  assert.ok(withError.includes('最近错误：ws 断开'), withError);
  assert.ok(exports.statusLine(null).includes('未知'));
});

test('describeError 压成一行且截断超长信息', () => {
  const { exports } = loadClient();
  assert.equal(exports.describeError(new Error('a\nb\n  c')), 'a b c');
  assert.equal(exports.describeError('  '), '未知错误');
  assert.equal(exports.describeError(null), '未知错误');
  const long = exports.describeError('x'.repeat(1000));
  assert.ok(long.length <= 301, String(long.length));
  assert.ok(long.endsWith('…'));
});

test('textToList / listToText 往返一致，且能容忍聊天窗口里粘出来的分隔符', () => {
  const { exports } = loadClient();
  assert.deepEqual(Array.from(exports.textToList('1\n2\r\n 3 \n1')), ['1', '2', '3']);
  assert.deepEqual(Array.from(exports.textToList('1，2；3;4')), ['1', '2', '3', '4']);
  assert.equal(exports.listToText(['a', 'b']), 'a\nb');
  assert.equal(exports.listToText(undefined), '');
  assert.deepEqual(Array.from(exports.textToList('')), []);
});

test('dotGet / dotSet 走点路径且不改原对象', () => {
  const { exports } = loadClient();
  assert.equal(exports.dotGet({ a: { b: { c: 3 } } }, 'a.b.c'), 3);
  assert.equal(exports.dotGet({ a: {} }, 'a.b.c', 'dflt'), 'dflt');
  assert.equal(exports.dotGet(null, 'a', 'dflt'), 'dflt');
  const before = { a: { b: 1 }, keep: 2 };
  const after = exports.dotSet(before, 'a.b', 9);
  assert.equal(after.a.b, 9);
  assert.equal(before.a.b, 1);
  assert.equal(after.keep, 2);
  const created = exports.dotSet({}, 'x.y.z', 1);
  assert.equal(created.x.y.z, 1);
});
// ---------------- 6. 端到端交互（有状态假 React：真按按钮、真发请求） ----------------

// 假 React 必须按 hook 槽位保存状态，否则重新渲染会把组件状态重置成初始值。
function makeInteractiveReact() {
  const hooks = [];
  const pending = [];
  let cursor = 0;
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: flattenChildren(children) };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      const hook = hooks[index];
      const set = (next) => {
        hook.value = typeof next === 'function' ? next(hook.value) : { ...hook.value, ...next };
      };
      return [hook.value, set];
    },
    useEffect(effect) {
      const index = cursor;
      cursor += 1;
      if (!hooks[index]) {
        hooks[index] = { mounted: true };
        pending.push(effect);
      }
      return undefined;
    }
  };
  return {
    react,
    beginRender() {
      cursor = 0;
    },
    takeEffects() {
      return pending.splice(0, pending.length);
    }
  };
}

function jsonResponse(payload) {
  return { status: 200, json: async () => payload };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function mountSection(fetchImpl) {
  const { entry } = captureEntry();
  const fake = makeInteractiveReact();
  const exports = materialize(entry, fake.react);
  const api = exports.createApi(fetchImpl);
  const render = () => {
    fake.beginRender();
    return exports.DshBotSection({ api, close: () => {} });
  };
  return { exports, render, api, fake };
}

async function settle(fake, render) {
  // 先渲染再跑 effect：effect 是渲染期登记的，顺序反了就一条也跑不起来。
  const first = render();
  for (const effect of fake.takeEffects()) effect();
  await tick();
  return render();
}

test('交互：读配置 → 改白名单/启用 → 点保存，POST body 是 {config}', async () => {
  const calls = [];
  let lastSave = null;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const method = init.method;
    if (url === '/dsh-bot/api/platforms') return jsonResponse({ ok: true, platforms: PLATFORMS });
    if (url === '/dsh-bot/api/config' && method === 'GET') {
      return jsonResponse({ ok: true, config: CONFIG, warnings: ['storage.rootDir 落在 C 盘'], configPath: 'E:\\cfg\\config.json' });
    }
    if (url === '/dsh-bot/api/status') {
      return jsonResponse({ ok: true, running: false, enabled: false, platform: 'qq-napcat', stats: { received: 0, handled: 0, denied: 0, failed: 0 } });
    }
    if (url === '/dsh-bot/api/config' && method === 'POST') {
      lastSave = JSON.parse(init.body);
      return jsonResponse({ ok: true, config: lastSave.config, warnings: [], configPath: 'E:\\cfg\\config.json' });
    }
    if (url === '/dsh-bot/api/control') {
      return jsonResponse({ ok: true, status: { running: true, enabled: true, platform: 'qq-napcat', stats: { received: 2, handled: 2, denied: 0, failed: 0 } } });
    }
    return jsonResponse({ ok: false, error: '未预期的请求 ' + method + ' ' + url });
  };

  const { render, fake } = mountSection(fetchImpl);
  let element = await settle(fake, render);
  assert.ok(textOf(element).includes('已停止'), textOf(element));
  assert.ok(textOf(element).includes('数据目录'), '字段来自 host 下发的字段表');

  findAll(element, (n) => n.type === 'textarea')[0].props.onChange({ target: { value: '20002\n20003' } });
  findAll(element, (n) => n.type === 'input' && n.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } });
  element = render();
  findAll(element, (n) => n.type === 'button' && textOf(n) === '保存')[0].props.onClick();
  await tick();
  element = render();

  assert.ok(textOf(element).includes('已保存'), textOf(element));
  assert.equal(lastSave !== null, true);
  assert.deepEqual(Array.from(lastSave.config.security.userWhitelist), ['20002', '20003']);
  assert.equal(lastSave.config.enabled, true);
  assert.equal(lastSave.config.qqNapcat.accessToken, '***', '未修改的密码原样往返，不被前端覆盖');
  assert.equal(lastSave.config.storage.maxFileBytes, 1, '字段表外的配置项必须原样带回');

  findAll(element, (n) => n.type === 'button' && textOf(n) === '停止')[0].props.onClick();
  await tick();
  element = render();
  assert.ok(textOf(element).includes('已停止'), textOf(element));
  const control = calls.filter((c) => c.url === '/dsh-bot/api/control').pop();
  assert.equal(JSON.parse(control.init.body).action, 'stop');
});

test('交互：保存被拒 → 页面显示 problems，不显示成功', async () => {
  const fetchImpl = async (url, init) => {
    if (url === '/dsh-bot/api/platforms') return jsonResponse({ ok: true, platforms: PLATFORMS });
    if (url === '/dsh-bot/api/config' && init.method === 'GET') return jsonResponse({ ok: true, config: CONFIG, warnings: [], configPath: 'p' });
    if (url === '/dsh-bot/api/status') return jsonResponse({ ok: true, running: false, enabled: false, stats: {} });
    return jsonResponse({ ok: false, error: '配置校验失败', problems: ['storage.rootDir 必填', 'qqNapcat.wsUrl 必须以 ws:// 开头'] });
  };
  const { render, fake } = mountSection(fetchImpl);
  let element = await settle(fake, render);
  findAll(element, (n) => n.type === 'button' && textOf(n) === '保存')[0].props.onClick();
  await tick();
  element = render();
  const text = textOf(element);
  assert.ok(text.includes('保存失败'), text);
  assert.ok(text.includes('storage.rootDir 必填'), text);
  assert.ok(text.includes('qqNapcat.wsUrl 必须以 ws:// 开头'), text);
  assert.ok(!text.includes('已保存'), text);
});

test('交互：切平台后字段表跟着换，公共字段的编辑保留', async () => {
  const fetchImpl = async (url) => {
    if (url === '/dsh-bot/api/platforms') return jsonResponse({ ok: true, platforms: PLATFORMS });
    if (url === '/dsh-bot/api/config') return jsonResponse({ ok: true, config: CONFIG, warnings: [], configPath: 'p' });
    return jsonResponse({ ok: true, running: false, enabled: false, stats: {} });
  };
  const { render, fake } = mountSection(fetchImpl);
  let element = await settle(fake, render);
  findAll(element, (n) => n.type === 'textarea')[0].props.onChange({ target: { value: '30003' } });
  element = render();
  findAll(element, (n) => n.type === 'select')[0].props.onChange({ target: { value: 'qq-official' } });
  element = render();
  const text = textOf(element);
  assert.ok(text.includes('AppID'), text);
  assert.ok(!text.includes('WebSocket 地址'), text);
  assert.equal(findAll(element, (n) => n.type === 'textarea')[0].props.value, '30003');
});

test('交互：网络全挂时页面是一行提示，不是白屏', async () => {
  const { render, fake } = mountSection(async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:3080');
  });
  const element = await settle(fake, render);
  const text = textOf(element);
  assert.ok(text.includes('连不上 dsh-im-bridge 服务'), text);
  assert.ok(text.includes('ECONNREFUSED'), text);
});

test('交互：点「发送测试消息」→ POST /test-send，成功显示发给谁', async () => {
  let lastTest = null;
  const fetchImpl = async (url, init) => {
    if (url === '/dsh-bot/api/platforms') return jsonResponse({ ok: true, platforms: PLATFORMS });
    if (url === '/dsh-bot/api/config') return jsonResponse({ ok: true, config: CONFIG, warnings: [], configPath: 'p' });
    if (url === '/dsh-bot/api/test-send') {
      lastTest = JSON.parse((init && init.body) || '{}');
      return jsonResponse({ ok: true, target: '10001', chunkCount: 1 });
    }
    return jsonResponse({ ok: true, running: true, enabled: true, platform: 'qq-napcat', stats: {} });
  };
  const { render, fake } = mountSection(fetchImpl);
  let element = await settle(fake, render);
  findAll(element, (n) => n.type === 'button' && textOf(n) === '发送测试消息')[0].props.onClick();
  await tick();
  element = render();
  assert.ok(textOf(element).includes('已发送给 10001'), textOf(element));
  assert.deepEqual(lastTest, {}, '没填「测试消息发给谁」就不传 target，让宿主按平台自己挑');
});

test('交互：测试消息发不出去时显示人话原因，不说"已发送"', async () => {
  const fetchImpl = async (url) => {
    if (url === '/dsh-bot/api/platforms') return jsonResponse({ ok: true, platforms: PLATFORMS });
    if (url === '/dsh-bot/api/config') return jsonResponse({ ok: true, config: CONFIG, warnings: [], configPath: 'p' });
    if (url === '/dsh-bot/api/test-send') return jsonResponse({ ok: false, error: '机器人还没启动：先点「启动」' });
    return jsonResponse({ ok: true, running: false, enabled: false, stats: {} });
  };
  const { render, fake } = mountSection(fetchImpl);
  let element = await settle(fake, render);
  findAll(element, (n) => n.type === 'button' && textOf(n) === '发送测试消息')[0].props.onClick();
  await tick();
  element = render();
  const text = textOf(element);
  assert.ok(text.includes('没发出去'), text);
  assert.ok(text.includes('先点「启动」'), text);
  assert.ok(!text.includes('已发送'), text);
});

