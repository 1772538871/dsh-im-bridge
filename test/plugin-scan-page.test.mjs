import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

// 浏览器脚本不转译：假 window 抓工厂，假 React 造元素树，假 navigator 记剪贴板。
function captureEntry(clipboard) {
  const registered = [];
  const win = { __ModuleLoader__: { load: (entry) => registered.push(entry) } };
  const context = vm.createContext({
    window: win,
    console: { warn() {}, log() {}, error() {} },
    navigator: { clipboard }
  });
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  assert.equal(registered.length, 1);
  return registered[0];
}

function makeReact(forcedState) {
  return {
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
}

function loadClient(forcedState, clipboard) {
  return captureEntry(clipboard).factory((name) => {
    if (name === 'react') return makeReact(forcedState);
    throw new Error('factory 请求了未声明的模块：' + name);
  });
}

// 带真状态的挂载：setState 直接改当前状态，render() 就地把新状态渲染一遍。
// useEffect 只跑首轮（等价于 deps 不变的组件），于是轮询器/初始拉取这类副作用也能被验到，
// 而且 unmount() 会把它们清掉——不清掉的定时器会把整个测试进程吊住。
function mount(initial, api, clipboard) {
  let current = initial;
  const pending = [];
  const cleanups = [];
  let rendered = 0;
  const react = {
    createElement(type, props, ...children) {
      const flat = [];
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child);
        else flat.push(child);
      }
      return { type, props: props || {}, children: flat };
    },
    useState() {
      return [
        current,
        (next) => {
          current = typeof next === 'function' ? next(current) : { ...current, ...next };
        }
      ];
    },
    useEffect(fn) {
      pending.push(fn);
    }
  };
  const exports = captureEntry(clipboard).factory((name) => {
    if (name === 'react') return react;
    throw new Error('factory 请求了未声明的模块：' + name);
  });
  // 没被点名的接口一律"永不返回"：状态由夹具给定，异步回调不许偷偷改写它
  const idle = () => new Promise(() => {});
  const fullApi = {
    platforms: idle,
    config: idle,
    status: idle,
    napcatStatus: idle,
    napcatQr: idle,
    napcatStart: idle,
    napcatOpenWebui: idle,
    save: idle,
    ...api
  };
  function render() {
    const element = exports.DshBotSection({ api: fullApi, close: () => {} });
    rendered += 1;
    if (rendered === 1) {
      while (pending.length > 0) {
        const cleanup = pending.shift()();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
    } else {
      pending.length = 0;
    }
    return element;
  }
  return {
    exports,
    render,
    unmount() {
      while (cleanups.length > 0) cleanups.pop()();
    },
    get state() {
      return current;
    }
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

function invisible(node) {
  const style = node && node.props ? node.props.style : null;
  return !!style && (style.display === 'none' || style.visibility === 'hidden');
}

function findVisible(node, predicate, out) {
  const acc = out || [];
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findVisible(child, predicate, acc);
    return acc;
  }
  if (invisible(node)) return acc;
  if (predicate(node)) acc.push(node);
  for (const child of node.children) findVisible(child, predicate, acc);
  return acc;
}

function visibleText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join('');
  if (invisible(node)) return '';
  return visibleText(node.children);
}

function buttonByText(element, label, onlyVisible) {
  const found = onlyVisible ? findVisible : findAll;
  return found(element, (node) => node.type === 'button' && textOf(node) === label)[0] || null;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

const PLATFORMS = [
  {
    id: 'qq-napcat',
    label: 'QQ 个人账号',
    description: '本机 NapCat，扫码登录小号',
    fields: [
      { key: 'qqNapcat.wsUrl', label: 'WebSocket 地址', type: 'text', group: 'basic' },
      { key: 'qqNapcat.accessToken', label: 'AccessToken', type: 'password', secret: true, group: 'basic' },
      { key: 'storage.rootDir', label: '数据目录', type: 'text', group: 'basic' },
      { key: 'security.userWhitelist', label: '用户白名单', type: 'stringList', group: 'basic' },
      { key: 'dsh.runner', label: '干活方式', type: 'select', options: ['headless', 'sdk'], group: 'advanced' }
    ]
  },
  {
    id: 'qq-official',
    label: 'QQ 官方机器人',
    description: 'QQ 开放平台',
    fields: [
      { key: 'qqOfficial.appId', label: 'AppID', type: 'text', group: 'basic' },
      { key: 'qqOfficial.appSecret', label: 'AppSecret', type: 'password', secret: true, group: 'basic' },
      { key: 'storage.rootDir', label: '数据目录', type: 'text', group: 'basic' },
      { key: 'security.userWhitelist', label: '用户白名单', type: 'stringList', group: 'basic' }
    ]
  }
];

const CONFIG = {
  enabled: false,
  platform: 'qq-napcat',
  storage: { rootDir: 'E:\\dsh-im-bridge-data' },
  security: { userWhitelist: ['1772538871'] },
  qqNapcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' }
};

const UIN = '2484026025';
const TOKEN = '49a78cfeb241';
const ONE_BOT = { wsUrl: 'ws://127.0.0.1:3001', token: TOKEN, name: 'dsh-bridge' };

function baseState(extra) {
  const exports = loadClient();
  return {
    ...exports.createInitialState(),
    ...exports.snapshotFrom({ platforms: PLATFORMS }, { config: CONFIG, configPath: 'E:\\cfg\\config.json' }),
    loading: false,
    ...(extra || {})
  };
}

function loggedInNapcat(extra) {
  return {
    status: { ok: true, listening: true, loggedIn: true, account: UIN, onebot: ONE_BOT },
    qr: { ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mtimeMs: 1 },
    fetchedAt: 1,
    stale: false,
    ...(extra || {})
  };
}

// ---------------- 1. 账号显示：两态 ----------------

test('账号文案: 探测到小号就写进绿框，读不到账号就如实说不知道', () => {
  const { describeNapcatPanel } = loadClient();
  const known = describeNapcatPanel(loggedInNapcat());
  assert.equal(known.loggedInText, '✅ 已扫码登录', 'loggedInText 保持原契约不变');
  assert.equal(known.loggedInAccountText, '✅ 已扫码登录：' + UIN);
  assert.equal(known.account, UIN);

  const unknown = describeNapcatPanel({ status: { ok: true, listening: true, loggedIn: true }, qr: null });
  assert.equal(unknown.account, '');
  assert.equal(unknown.loggedInAccountText, '✅ 已扫码登录（账号未知）');

  // 宿主 ok:false 时那一栏根本不该被当真
  const failed = describeNapcatPanel({ status: { ok: false, error: '炸了', account: UIN }, qr: null });
  assert.equal(failed.account, '');
});

test('账号文案: 个人号卡片渲染出「✅ 已扫码登录：2484026025」', () => {
  const exports = loadClient(baseState({ napcat: loggedInNapcat() }));
  const text = textOf(exports.DshBotSection({ close: () => {} }));
  assert.ok(text.includes('✅ 已扫码登录：' + UIN), text);
});

// ---------------- 2. WebSocket 行与自动回填 ----------------

test('ws 行: NapCat 探测到的优先，没探测到就用配置里的地址', () => {
  const { napcatWsLine } = loadClient();
  assert.equal(napcatWsLine(loggedInNapcat(), 'ws://127.0.0.1:3001'), 'WebSocket  ws://127.0.0.1:3001');
  const probed = { status: { ok: true, listening: true, loggedIn: true, onebot: { wsUrl: 'ws://127.0.0.1:3009', token: 't' } } };
  assert.equal(napcatWsLine(probed, 'ws://127.0.0.1:3001'), 'WebSocket  ws://127.0.0.1:3009');
  assert.equal(napcatWsLine({ status: { ok: true } }, ''), '', '两边都没有就整行不写');
});

test('自动回填: 只有空着或不一样才填，一样就返回 null', () => {
  const { onebotFormPatch } = loadClient();
  assert.deepEqual(
    { ...onebotFormPatch(loggedInNapcat(), {}) },
    { 'qqNapcat.wsUrl': 'ws://127.0.0.1:3001', 'qqNapcat.accessToken': TOKEN },
    '空表单两个都填'
  );
  assert.deepEqual(
    { ...onebotFormPatch(loggedInNapcat(), { 'qqNapcat.wsUrl': 'ws://127.0.0.1:3000', 'qqNapcat.accessToken': 'old' }) },
    { 'qqNapcat.wsUrl': 'ws://127.0.0.1:3001', 'qqNapcat.accessToken': TOKEN },
    '不一样就覆盖'
  );
  assert.equal(
    onebotFormPatch(loggedInNapcat(), { 'qqNapcat.wsUrl': 'ws://127.0.0.1:3001', 'qqNapcat.accessToken': TOKEN }),
    null,
    '已经一致就什么都不用做'
  );
  assert.equal(onebotFormPatch({ status: { ok: true, listening: true, loggedIn: true } }, {}), null, '没探测到 onebot 就不填');
});

test('自动回填: 刷新一次就把端口/令牌填进表单，只填不保存', async () => {
  const saves = [];
  const api = {
    napcatStatus: () => Promise.resolve({ ok: true, listening: true, loggedIn: true, account: UIN, onebot: ONE_BOT }),
    napcatQr: () => Promise.resolve({ ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mtimeMs: 1 }),
    save: (payload) => {
      saves.push(payload);
      return Promise.resolve({ ok: true, config: payload });
    }
  };
  const mounted = mount(baseState({ napcat: { status: null, qr: null, fetchedAt: 0, stale: false } }), api);
  let element = mounted.render();
  buttonByText(element, '刷新二维码', false).props.onClick();
  await tick();
  element = mounted.render();
  assert.equal(mounted.state.form['qqNapcat.wsUrl'], 'ws://127.0.0.1:3001');
  assert.equal(mounted.state.form['qqNapcat.accessToken'], TOKEN, '真令牌直接填进表单');
  assert.ok(textOf(element).includes('已从 NapCat 自动读取端口与令牌'), textOf(element));
  assert.equal(saves.length, 0, '自动填不等于自动保存');
  assert.equal(mounted.state.config.qqNapcat.accessToken, '', '配置本身一个字节都没动');
});

test('轮询: 进场第一次拉取就回填端口/令牌，并且其它状态一个都没被顶掉', async () => {
  const api = {
    napcatStatus: () => Promise.resolve({ ok: true, listening: true, loggedIn: true, account: UIN, onebot: ONE_BOT }),
    napcatQr: () => Promise.resolve({ ok: false, error: '还没生成二维码' })
  };
  const mounted = mount(baseState({ napcat: { status: null, qr: null, fetchedAt: 0, stale: false } }), api);
  mounted.render();
  await tick();
  const element = mounted.render();
  mounted.unmount();

  assert.equal(mounted.state.napcat.status.account, UIN, '轮询结果进了状态');
  assert.equal(mounted.state.form['qqNapcat.accessToken'], TOKEN, '令牌被自动填进表单');
  // 合并写回：一次轮询不许把页面其它状态换成只剩 napcat 的对象
  assert.equal(mounted.state.platforms.length, 2, '平台列表还在');
  assert.equal(mounted.state.config.storage.rootDir, 'E:\\dsh-im-bridge-data', '配置还在');
  assert.equal(mounted.state.platformId, 'qq-napcat');
  assert.ok(textOf(element).includes('已从 NapCat 自动读取端口与令牌'));
});

// ---------------- 3. 更多设置 ----------------

test('更多设置: 默认收起，页面上看不到任何字段输入框', () => {
  const exports = loadClient(baseState());
  const element = exports.DshBotSection({ close: () => {} });
  const text = visibleText(element);
  assert.ok(text.includes('更多设置'), text);
  assert.ok(buttonByText(element, '修改配置', true), '收起态要给一个能改配置的入口');
  const inputs = findVisible(element, (node) => typeof node.props.id === 'string' && node.props.id.indexOf('dsh-bot-field-') === 0);
  assert.equal(inputs.length, 0, '收起时字段表不可见');
  assert.equal(findVisible(element, (node) => node.props.id === 'dsh-bot-platform').length, 0);
});

test('更多设置: 展开后先只给常用三项，勾「显示全部字段」才出现完整表', () => {
  const mounted = mount(baseState(), {});
  let element = mounted.render();
  buttonByText(element, '修改配置', true).props.onClick();
  element = mounted.render();
  assert.equal(mounted.state.showManualFields, true);
  const text = visibleText(element);
  assert.ok(text.includes('数据目录'), text);
  assert.ok(text.includes('用户白名单'), text);
  assert.equal(text.includes('干活方式'), false, 'advanced 字段还得再勾一次才出现');
  assert.ok(buttonByText(element, '保存', true), '展开后才有保存');

  const toggle = findAll(element, (node) => node.type === 'label' && textOf(node).includes('显示全部字段（排查用）'))[0];
  findAll(toggle, (node) => node.type === 'input')[0].props.onChange({ target: { checked: true } });
  element = mounted.render();
  assert.equal(mounted.state.showAllFields, true);
  assert.ok(visibleText(element).includes('干活方式'), '勾上之后完整字段表出现');
  assert.ok(buttonByText(element, '收起', true), '展开态必须能收回去');
});

test('保存: payload 带上自动回填的地址与令牌，platform 仍是个人号', async () => {
  const saves = [];
  const api = {
    napcatStatus: () => Promise.resolve({ ok: true, listening: true, loggedIn: true, account: UIN, onebot: ONE_BOT }),
    napcatQr: () => Promise.resolve({ ok: false, error: '还没生成二维码' }),
    save: (payload) => {
      saves.push(payload);
      return Promise.resolve({ ok: true, config: payload, configPath: 'E:\\cfg\\config.json' });
    }
  };
  const mounted = mount(
    baseState({
      showManualFields: true,
      napcat: { status: { ok: true, listening: true, loggedIn: true, account: UIN, onebot: ONE_BOT }, qr: null, fetchedAt: 0, stale: false }
    }),
    api
  );
  mounted.render();
  buttonByText(mounted.render(), '保存', true).props.onClick();
  await tick();
  assert.equal(saves.length, 1);
  const payload = saves[0];
  assert.equal(payload.platform, 'qq-napcat');
  assert.equal(payload.qqNapcat.wsUrl, 'ws://127.0.0.1:3001');
  assert.equal(payload.qqNapcat.accessToken, '', '配置里那个空令牌不会被前端凭空改写');
  assert.deepEqual(Array.from(payload.security.userWhitelist), ['1772538871']);
});

// ---------------- 4. 打开 NapCat 面板 + 令牌 ----------------

test('面板按钮: 已登录写「打开 NapCat 面板」，未登录写「先扫码登录」', () => {
  const loggedIn = loadClient(baseState({ napcat: loggedInNapcat() }));
  assert.ok(buttonByText(loggedIn.DshBotSection({ close: () => {} }), '打开 NapCat 面板', false));

  const waiting = loadClient(baseState({ napcat: { status: { ok: true, listening: false, loggedIn: null }, qr: null, fetchedAt: 0, stale: false } }));
  assert.ok(buttonByText(waiting.DshBotSection({ close: () => {} }), '打开 NapCat 面板（先扫码登录）', false));
});

test('令牌: 已登录时把令牌摆出来，点「复制令牌」就进剪贴板', () => {
  const copied = [];
  const clipboard = {
    writeText(text) {
      copied.push(text);
      return Promise.resolve();
    }
  };
  const exports = loadClient(baseState({ napcat: loggedInNapcat() }), clipboard);
  const element = exports.DshBotSection({ close: () => {} });
  assert.ok(textOf(element).includes('令牌 ' + TOKEN), textOf(element));
  buttonByText(element, '复制令牌', false).props.onClick();
  assert.deepEqual(copied, [TOKEN]);
});

test('打开面板: 走 /napcat/open-webui，成功后给「已打开（令牌已复制）」+ 下一步引导', async () => {
  const copied = [];
  const clipboard = {
    writeText(text) {
      copied.push(text);
      return Promise.resolve();
    }
  };
  const calls = [];
  const api = {
    napcatOpenWebui() {
      calls.push('open');
      return Promise.resolve({ ok: true, url: 'http://127.0.0.1:6099/', token: TOKEN, opened: true });
    }
  };
  const mounted = mount(baseState({ napcat: loggedInNapcat() }), api, clipboard);
  let element = mounted.render();
  buttonByText(element, '打开 NapCat 面板', false).props.onClick();
  await tick();
  element = mounted.render();
  const text = textOf(element);
  assert.deepEqual(calls, ['open']);
  assert.ok(text.includes('已打开 NapCat 面板（令牌已复制）'), text);
  assert.ok(text.includes('在面板里「网络配置 → 添加 WebSocket 服务器」，端口填 3001，保存后这里会自动读到。'), text);
  assert.deepEqual(copied, [TOKEN], '打开的同时把令牌写进剪贴板');
});

test('打开面板: 宿主说打不开就照实说，仍把地址带出来', async () => {
  const api = {
    napcatOpenWebui: () => Promise.resolve({ ok: false, url: 'http://127.0.0.1:6099/', token: '', opened: false, error: '没法自动打开浏览器：EPERM' })
  };
  const mounted = mount(baseState({ napcat: loggedInNapcat() }), api);
  let element = mounted.render();
  buttonByText(element, '打开 NapCat 面板', false).props.onClick();
  await tick();
  element = mounted.render();
  const text = textOf(element);
  assert.ok(text.includes('没法自动打开浏览器'), text);
  assert.equal(text.includes('已打开 NapCat 面板'), false);
});

test('api: 第五条 NapCat 接口的路径与方法是 POST /napcat/open-webui', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([init.method, url]);
    return { status: 200, json: async () => ({ ok: true, opened: true, token: 't' }) };
  };
  const { createApi } = loadClient();
  const api = createApi(fetchImpl);
  const result = await api.napcatOpenWebui();
  assert.equal(result.opened, true);
  assert.deepEqual(calls, [['POST', '/dsh-bot/api/napcat/open-webui']]);
});
