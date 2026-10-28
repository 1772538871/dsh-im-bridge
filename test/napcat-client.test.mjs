import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

// 浏览器不打包：一个假 window 抓出工厂，再喂假 React。和真浏览器无关。
function captureEntry() {
  const registered = [];
  const win = { __ModuleLoader__: { load: (entry) => registered.push(entry) } };
  const context = vm.createContext({ window: win, console: { warn() {}, log() {}, error() {} } });
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  assert.equal(registered.length, 1);
  return registered[0];
}

function makeReactStub(forcedState) {
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

function loadClient(forcedState) {
  const entry = captureEntry();
  return entry.factory((name) => {
    if (name === 'react') return makeReactStub(forcedState);
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
    description: '本机 NapCat，扫码登录小号',
    fields: [
      { key: 'qqNapcat.wsUrl', label: 'WebSocket 地址', type: 'text', group: 'basic' },
      { key: 'qqNapcat.accessToken', label: 'AccessToken', type: 'password', secret: true, group: 'basic' }
    ]
  },
  { id: 'wechat', label: '微信', description: '还没做完', fields: [] }
];

const CONFIG = {
  enabled: true,
  platform: 'qq-napcat',
  storage: { rootDir: 'E:\\dsh-im-bridge-data' },
  security: { userWhitelist: [] },
  qqNapcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' }
};

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function stateWith(napcat, extra) {
  const base = loadClient();
  return {
    ...base.createInitialState(),
    ...base.snapshotFrom({ platforms: PLATFORMS }, { config: CONFIG, configPath: 'E:\\cfg\\config.json' }),
    loading: false,
    napcat,
    ...(extra || {})
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

// 假定时器：能手动"走一格"，也记录被清掉的 id
function fakeTimers() {
  const registered = [];
  const cleared = [];
  let nextId = 1;
  return {
    registered,
    cleared,
    setInterval(fn, ms) {
      const id = nextId++;
      registered.push({ id, fn, ms });
      return id;
    },
    clearInterval(id) {
      cleared.push(id);
    }
  };
}

const QR_WAITING = '还没生成二维码：先点一键启动，等它出码（一般 5–20 秒）';

function fakeApi(overrides = {}) {
  const status = overrides.status || { ok: true, listening: false, loggedIn: null, homeDir: 'D:\\NapCat' };
  const qr = overrides.qr || { ok: false, error: QR_WAITING };
  const calls = [];
  return {
    calls,
    napcatStatus() {
      calls.push('status');
      return Promise.resolve(status);
    },
    napcatQr() {
      calls.push('qr');
      return Promise.resolve(qr);
    },
    napcatStart() {
      calls.push('start');
      return Promise.resolve(overrides.startResult || { ok: true, pid: 1, launcher: 'launcher.bat' });
    }
  };
}

// ---------------- 1. 视图模型：只认宿主明说过的事 ----------------

test('describeNapcatPanel: 只贴图片类 dataUrl，脏值一律丢掉', () => {
  const { describeNapcatPanel } = loadClient();
  const good = describeNapcatPanel({ status: { ok: true, listening: true }, qr: { ok: true, dataUrl: DATA_URL, mtimeMs: 5 } });
  assert.equal(good.dataUrl, DATA_URL);
  assert.equal(good.mtimeMs, 5);

  for (const dirty of ['javascript:alert(1)', '<svg onload=alert(1)>', 'data:text/html;base64,AAA', '', null]) {
    const panel = describeNapcatPanel({ status: { ok: true, listening: true }, qr: { ok: true, dataUrl: dirty } });
    assert.equal(panel.dataUrl, '', String(dirty) + ' 不该被当成二维码贴出来');
  }
});

test('describeNapcatPanel: 没码时给"先点一键启动"的人话，按钮是「一键启动」', () => {
  const { describeNapcatPanel } = loadClient();
  const panel = describeNapcatPanel({ status: { ok: true, listening: false, loggedIn: null }, qr: { ok: false, error: QR_WAITING } });
  assert.equal(panel.dataUrl, '');
  assert.equal(panel.loggedIn, false);
  assert.equal(panel.listening, false);
  assert.equal(panel.hint, QR_WAITING);
  assert.equal(panel.startLabel, '一键启动');
  assert.equal(panel.refreshLabel, '刷新二维码');
});

test('describeNapcatPanel: 没填安装目录时原样转述宿主那句话，不自己编一句', () => {
  const { describeNapcatPanel } = loadClient();
  const serverText = '还没填 NapCat 安装目录：在高级设置里填一次（例如 D:\\NapCat），之后就只用点启动';
  const panel = describeNapcatPanel({ status: { ok: false, error: serverText, listening: false, loggedIn: null }, qr: null });
  assert.equal(panel.error, serverText);
  assert.equal(panel.hint, serverText);
  assert.equal(panel.loggedIn, false);
  assert.equal(panel.startLabel, '一键启动');
});

test('describeNapcatPanel: 端口通 / 已登录分别给出「已启动 · 扫码登录」与绿色方块文案', () => {
  const { describeNapcatPanel } = loadClient();
  const up = describeNapcatPanel({ status: { ok: true, listening: true, loggedIn: null }, qr: { ok: true, dataUrl: DATA_URL } });
  assert.equal(up.startLabel, '已启动 · 扫码登录');
  assert.equal(up.loggedIn, false);

  const done = describeNapcatPanel({ status: { ok: true, listening: true, loggedIn: true }, qr: { ok: true, dataUrl: DATA_URL } });
  assert.equal(done.loggedIn, true);
  assert.equal(done.loggedInText, '✅ 已扫码登录');
  assert.equal(done.loggedInHint, '下一步：填访问令牌，点检测连接');
});

test('describeNapcatPanel: ok:false 之外的空响应不算"已登录"（绝不编状态）', () => {
  const { describeNapcatPanel } = loadClient();
  for (const input of [undefined, null, {}, { status: null, qr: null }, { status: {}, qr: {} }]) {
    const panel = describeNapcatPanel(input);
    assert.equal(panel.loggedIn, false, JSON.stringify(input));
    assert.equal(panel.listening, false, JSON.stringify(input));
    assert.equal(panel.dataUrl, '', JSON.stringify(input));
  }
});

// ---------------- 2. 一次读 + 轮询器 ----------------

test('readNapcatOnce: 同时拉 status 与 qr，接口抛错也折成 ok:false 人话', async () => {
  const { readNapcatOnce } = loadClient();
  const api = fakeApi({ qr: { ok: true, dataUrl: DATA_URL, mtimeMs: 1000 } });
  const state = await readNapcatOnce(api, () => 2000);
  assert.deepEqual(api.calls, ['status', 'qr']);
  assert.equal(state.status.ok, true);
  assert.equal(state.qr.dataUrl, DATA_URL);
  assert.equal(state.fetchedAt, 2000);
  assert.equal(state.stale, false);

  const broken = {
    napcatStatus() {
      throw new Error('网络断了');
    },
    napcatQr() {
      return Promise.reject(new Error('也断了'));
    }
  };
  const failed = await readNapcatOnce(broken, () => 1);
  assert.equal(failed.status.ok, false);
  assert.match(failed.status.error, /网络断了/);
  assert.equal(failed.qr.ok, false);
  assert.match(failed.qr.error, /也断了/);

  // 老宿主没有这两个方法：照样给出可读结果，不抛
  const empty = await readNapcatOnce({}, () => 1);
  assert.equal(empty.status.ok, false);
  assert.match(empty.status.error, /不支持一键启动/);
});

test('readNapcatOnce: 用注入的时钟判"这张码可能过期了"', async () => {
  const { readNapcatOnce } = loadClient();
  const api = fakeApi({ qr: { ok: true, dataUrl: DATA_URL, mtimeMs: 1000 } });
  assert.equal((await readNapcatOnce(api, () => 1000 + 60000)).stale, false);
  assert.equal((await readNapcatOnce(api, () => 1000 + 200000)).stale, true);
});

test('createNapcatWatcher: 进卡片先拉一次，之后每 3 秒一次', async () => {
  const { createNapcatWatcher } = loadClient();
  const timers = fakeTimers();
  const api = fakeApi({ qr: { ok: true, dataUrl: DATA_URL, mtimeMs: 0 } });
  const seen = [];
  const watcher = createNapcatWatcher({ api, onState: (state) => seen.push(state), setInterval: timers.setInterval, clearInterval: timers.clearInterval, now: () => 5000 });

  watcher.start();
  await flush();
  assert.deepEqual(api.calls, ['status', 'qr'], '进来先拉一次，不等 3 秒');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].qr.ok, true);
  assert.equal(timers.registered.length, 1);
  assert.equal(timers.registered[0].ms, 3000, '轮询间隔必须是 3 秒');

  timers.registered[0].fn();
  await flush();
  assert.deepEqual(api.calls, ['status', 'qr', 'status', 'qr']);
  assert.equal(seen.length, 2);
});

test('createNapcatWatcher: stop() 清掉定时器，之后既不再打接口也不回写界面', async () => {
  const { createNapcatWatcher } = loadClient();
  const timers = fakeTimers();
  const api = fakeApi();
  const seen = [];
  const watcher = createNapcatWatcher({ api, onState: (state) => seen.push(state), setInterval: timers.setInterval, clearInterval: timers.clearInterval });

  watcher.start();
  await flush();
  assert.equal(seen.length, 1);
  watcher.stop();
  assert.deepEqual(timers.cleared, [timers.registered[0].id], '卸载必须清掉那个定时器');

  timers.registered[0].fn();
  await flush();
  assert.equal(api.calls.length, 2, 'stop 之后不许再发请求');
  assert.equal(seen.length, 1, 'stop 之后不许再回写界面');
  assert.equal(watcher.running(), false);
});

test('createNapcatWatcher: 卸载后才回来的响应被丢弃（不会把界面改回旧状态）', async () => {
  const { createNapcatWatcher } = loadClient();
  const timers = fakeTimers();
  const seen = [];
  let release = null;
  const slow = {
    napcatStatus() {
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, listening: true, loggedIn: true });
      });
    },
    napcatQr() {
      return new Promise((resolve) => {
        resolve({ ok: false, error: QR_WAITING });
      });
    }
  };
  const watcher = createNapcatWatcher({ api: slow, onState: (state) => seen.push(state), setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  watcher.start();
  await flush();
  watcher.stop();
  release();
  await flush();
  assert.deepEqual(seen, [], '已经卸载的轮询结果不许再进界面');
});

test('createNapcatWatcher: 两个调用都失败时 onState 仍拿到 {ok:false}，轮询不崩', async () => {
  const { createNapcatWatcher } = loadClient();
  const timers = fakeTimers();
  const seen = [];
  const watcher = createNapcatWatcher({
    api: {
      napcatStatus() {
        throw new Error('炸了');
      },
      napcatQr() {
        throw new Error('也炸了');
      }
    },
    onState: (state) => seen.push(state),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval
  });
  watcher.start();
  await flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status.ok, false);
  assert.equal(seen[0].qr.ok, false);
});

// ---------------- 3. 网络层：四条接口 ----------------

function recordingFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift() || { ok: true };
    return {
      status: 200,
      json: async () => next
    };
  };
  return { impl, calls };
}

test('api: 四条 NapCat 接口的路径与方法，ok:false 不抛错', async () => {
  const wire = recordingFetch([
    { ok: true, listening: true, loggedIn: null },
    { ok: true, dataUrl: DATA_URL },
    { ok: false, error: '还没填 NapCat 安装目录：在高级设置里填一次（例如 D:\\NapCat），之后就只用点启动' },
    { ok: true }
  ]);
  const { createApi } = loadClient();
  const api = createApi(wire.impl);

  assert.equal((await api.napcatStatus()).listening, true);
  assert.equal((await api.napcatQr()).dataUrl, DATA_URL);
  const started = await api.napcatStart();
  assert.equal(started.ok, false, '启动失败是正常结果，不许抛');
  assert.match(started.error, /还没填 NapCat 安装目录/);
  assert.equal((await api.napcatStop()).ok, true);

  assert.deepEqual(
    wire.calls.map((c) => [c.init.method, c.url]),
    [
      ['GET', '/dsh-bot/api/napcat/status'],
      ['GET', '/dsh-bot/api/napcat/qr'],
      ['POST', '/dsh-bot/api/napcat/start'],
      ['POST', '/dsh-bot/api/napcat/stop']
    ]
  );
});

// ---------------- 4. 渲染：方块里放什么 ----------------

function renderNapcat(napcat, extra) {
  const exports = loadClient(stateWith(napcat, extra));
  return { exports, element: exports.DshBotSection({ api: fakeApi(), close: () => {} }) };
}

test('渲染: 有码就贴 <img src=dataUrl>，下方一行小字说明有效期', () => {
  const { element } = renderNapcat({
    status: { ok: true, listening: true, loggedIn: false },
    qr: { ok: true, dataUrl: DATA_URL, mtimeMs: 1 }
  });
  const images = findAll(element, (n) => n.type === 'img');
  assert.equal(images.length, 1, '二维码只该有一个 img');
  assert.equal(images[0].props.src, DATA_URL);
  assert.equal(images[0].props.alt, 'NapCat 登录二维码');
  const text = textOf(element);
  assert.ok(text.includes('二维码有效期约 2 分钟，过期点「刷新二维码」'), text);
  // 方块仍只有一个 220px 的框，换进换出不跳版
  assert.equal(findAll(element, (n) => n.props && n.props.style && n.props.style.width === '220px').length, 1);
  // 方块上方：已启动 + 刷新二维码
  const labels = findAll(element, (n) => n.type === 'button').map((n) => textOf(n));
  assert.ok(labels.includes('已启动 · 扫码登录'), labels.join('|'));
  assert.ok(labels.includes('刷新二维码'), labels.join('|'));
});

test('渲染: 拿不到码退回占位（下载链接 + 人话），不白屏也不空方块', () => {
  const { element } = renderNapcat({ status: { ok: true, listening: false, loggedIn: null }, qr: { ok: false, error: QR_WAITING } });
  assert.equal(findAll(element, (n) => n.type === 'img').length, 0);
  const text = textOf(element);
  assert.ok(text.includes(QR_WAITING), text);
  assert.ok(text.includes('连接向导（三步点通）'), text);
  const anchors = findAll(element, (n) => n.type === 'a');
  assert.equal(anchors[0].props.href, 'https://github.com/NapNeko/NapCatQQ/releases');
  const labels = findAll(element, (n) => n.type === 'button').map((n) => textOf(n));
  assert.ok(labels.includes('一键启动'), labels.join('|'));
});

test('渲染: 已扫码登录 -> 方块变绿，并说清下一步是填令牌', () => {
  const { element } = renderNapcat({
    status: { ok: true, listening: true, loggedIn: true },
    qr: { ok: true, dataUrl: DATA_URL, mtimeMs: 1 }
  });
  const text = textOf(element);
  assert.ok(text.includes('✅ 已扫码登录'), text);
  assert.ok(text.includes('下一步：填访问令牌，点检测连接'), text);
  assert.equal(findAll(element, (n) => n.type === 'img').length, 0, '登录后不该再贴那张过期二维码');
  const squares = findAll(element, (n) => n.props && n.props.style && n.props.style.width === '220px');
  assert.equal(squares.length, 1);
  assert.match(String(squares[0].props.style.background), /34,197,94/, '已登录必须是绿色底');
});

test('渲染: 已登录时卡片顶上的状态也跟着变，不会一边绿一边还挂着"等待扫码"', () => {
  const { element } = renderNapcat({ status: { ok: true, listening: true, loggedIn: true }, qr: { ok: true, dataUrl: DATA_URL } });
  const text = textOf(element);
  assert.ok(text.includes('等待用小号扫码登录') === false, '已登录后顶上不许再写等待扫码：' + text);
  assert.ok(text.includes('已扫码登录'), text);
});

test('渲染: 没配置安装目录时把宿主那句话摆在方块里，引导去填目录', () => {
  const serverText = '还没填 NapCat 安装目录：在高级设置里填一次（例如 D:\\NapCat），之后就只用点启动';
  const { element } = renderNapcat({ status: { ok: false, error: serverText }, qr: { ok: false, error: serverText } });
  const text = textOf(element);
  assert.ok(text.includes(serverText), text);
  assert.equal(findAll(element, (n) => n.type === 'img').length, 0);
});

test('渲染: 点「一键启动」会真的调 /napcat/start', async () => {
  const api = fakeApi();
  const exports = loadClient(stateWith({ status: null, qr: null }));
  const element = exports.DshBotSection({ api, close: () => {} });
  const startButton = findAll(element, (n) => n.type === 'button' && textOf(n) === '一键启动')[0];
  assert.ok(startButton, '必须有「一键启动」按钮');
  startButton.props.onClick();
  await flush();
  assert.ok(api.calls.includes('start'), api.calls.join('|'));
});
