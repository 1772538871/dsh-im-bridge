import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

// lib/client.js 是浏览器脚本：喂假 window 抓工厂，再喂假 React 造元素树。
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

// 假 React 按 hook 槽位存状态，否则每次重新渲染都会把组件状态重置回初始值
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

function jsonResponse(payload) {
  return { status: 200, json: async () => payload };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

const PLATFORMS = [
  {
    id: 'qq-napcat',
    label: 'QQ 个人账号',
    description: '本机 NapCat',
    fields: [
      { key: 'enabled', label: '开机自动启动', type: 'boolean', group: 'basic' },
      { key: 'security.userWhitelist', label: '用户白名单', type: 'stringList', group: 'basic' }
    ]
  }
];

const CONFIG = {
  enabled: true,
  platform: 'qq-napcat',
  storage: { rootDir: 'E:\\dsh-im-bridge-data' },
  security: { userWhitelist: ['1772538871'] },
  qqNapcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '***' }
};

const ONE_EXAMPLE = [
  {
    when: '2026-01-02 11:04',
    lines: [
      { speaker: '我', text: '累死了' },
      { speaker: '它', text: '活该，谁让你不睡' }
    ]
  }
];

// 假宿主：示例库是可变的，POST 会像真宿主那样把新的一段排到最前面
function fakeHost(options = {}) {
  const calls = [];
  let examples = Array.isArray(options.examples) ? options.examples : ONE_EXAMPLE;
  const fetchImpl = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    if (url === '/dsh-bot/api/platforms') return jsonResponse({ ok: true, platforms: PLATFORMS });
    if (url === '/dsh-bot/api/config' && method === 'GET') {
      return jsonResponse({ ok: true, config: CONFIG, warnings: [], configPath: 'E:\\cfg\\config.json' });
    }
    if (url === '/dsh-bot/api/status') {
      return jsonResponse({ ok: true, running: true, enabled: true, platform: 'qq-napcat', stats: {} });
    }
    if (url === '/dsh-bot/api/persona' && method === 'GET') return jsonResponse({ ok: true, text: '你叫小号，说话短' });
    if (url === '/dsh-bot/api/lessons' && method === 'GET') {
      return jsonResponse({ ok: true, lessons: [{ index: 0, when: '2026-01-01 10:00', body: '别人骂你别还嘴' }] });
    }
    if (url === '/dsh-bot/api/examples' && method === 'GET') return jsonResponse({ ok: true, examples });
    if (url === '/dsh-bot/api/examples' && method === 'POST') {
      const lines = String((body && body.text) || '')
        .split('\n')
        .filter(Boolean)
        .map((line) => ({
          speaker: line.startsWith('我：') ? '我' : '它',
          text: line.replace(/^(我|它|对方|你)：/u, '')
        }));
      examples = [{ when: '2026-01-03 20:00', lines }].concat(examples);
      return jsonResponse({ ok: true, added: 1, examples });
    }
    if (url === '/dsh-bot/api/examples' && method === 'DELETE') {
      examples = [];
      return jsonResponse({ ok: true, examples });
    }
    if (url === '/dsh-bot/api/journal') {
      return jsonResponse({ ok: true, entries: [{ title: '2026-01-02 09:00', body: '今天聊了天气' }] });
    }
    if (url === '/dsh-bot/api/stickers' && method === 'GET') {
      return jsonResponse({ ok: true, stickers: [{ id: 'aaa111', note: '笑' }], count: 1 });
    }
    if (url === '/dsh-bot/api/control') return jsonResponse({ ok: true, status: { running: true } });
    return jsonResponse({ ok: false, error: '未预期的请求 ' + method + ' ' + url });
  };
  return { calls, fetchImpl };
}

function mountSection(host) {
  const entry = captureEntry();
  const fake = makeInteractiveReact();
  const exports = entry.factory((name) => {
    if (name === 'react') return fake.react;
    throw new Error('工厂请求了未声明的模块：' + name);
  });
  const api = exports.createApi(host.fetchImpl);
  const render = () => {
    fake.beginRender();
    return exports.DshBotSection({ api, close: () => {} });
  };
  return { exports, render, api, fake };
}

async function settle(fake, render, host) {
  const first = render();
  for (const effect of fake.takeEffects()) effect();
  await tick();
  return render();
}

async function openMemory(fake, render) {
  let element = render();
  findButton(element, 'memoryToggle').props.onClick();
  await tick();
  return render();
}

function findButton(element, key) {
  const hit = findAll(element, (node) => node.type === 'button' && node.props.key === key)[0];
  assert.ok(hit, '找不到按钮：' + key + '\n' + textOf(element).slice(0, 400));
  return hit;
}

function examplesBlock(element) {
  const hit = findAll(element, (node) => node.props && node.props.key === 'examples')[0];
  assert.ok(hit, '找不到对话示例这一块\n' + textOf(element).slice(0, 400));
  return hit;
}

async function openExamples(host) {
  const mounted = mountSection(host);
  await settle(mounted.fake, mounted.render, host);
  const element = await openMemory(mounted.fake, mounted.render);
  return { ...mounted, element, block: examplesBlock(element) };
}

// ---------------- 页面这一小节 ----------------

test('对话示例：第五小节，夹在「你教过的」与「日记」之间，6 行文本框 + 两个按钮', async () => {
  const host = fakeHost();
  const { element, block } = await openExamples(host);
  const body = findAll(element, (node) => node.props && node.props.key === 'memoryBody')[0];
  assert.ok(body, '人设与记忆展开后要有正文容器');
  assert.deepEqual(
    body.children.map((node) => node.props.key),
    ['persona', 'lessons', 'examples', 'journal', 'stickers'],
    '顺序就是页面上从上到下的顺序'
  );
  assert.ok(textOf(block).includes('对话示例'), textOf(block).slice(0, 200));
  assert.ok(
    textOf(block).includes('粘贴几段真实对话（我：… / 它：…），它照着学；比写“幽默、毒舌”这种形容词管用。'),
    textOf(block).slice(0, 300)
  );
  const box = findAll(block, (node) => node.props && node.props.id === 'dsh-bot-examples')[0];
  assert.ok(box, '粘贴用的多行文本框');
  assert.equal(box.props.rows, 6);
  assert.deepEqual(
    findAll(block, (node) => node.type === 'button').map((node) => textOf(node)),
    ['存成示例', '清空示例']
  );
});

test('对话示例：列表给时间 + 前两行，多出来的用省略号收住', async () => {
  const host = fakeHost({
    examples: [
      {
        when: '2026-01-02 11:04',
        lines: [
          { speaker: '我', text: '累死了' },
          { speaker: '它', text: '活该，谁让你不睡' },
          { speaker: '我', text: '第三行不该露出来' }
        ]
      }
    ]
  });
  const { block, element } = await openExamples(host);
  const text = textOf(block);
  assert.ok(text.includes('2026-01-02 11:04'), text);
  assert.ok(text.includes('我：累死了'), text);
  assert.ok(text.includes('它：活该，谁让你不睡'), text);
  assert.equal(text.includes('第三行不该露出来'), false, '只显示前两行');
  assert.ok(text.includes('…'), '还有更多行就标出来：' + text);
  // 那段被藏起来的正文在整页里也不该出现
  assert.equal(textOf(element).includes('第三行不该露出来'), false);
});

test('对话示例：粘一段 → 点「存成示例」→ POST /examples，回执说存了几段', async () => {
  const host = fakeHost();
  const { element: first, render } = await openExamples(host);
  const box = findAll(first, (node) => node.props && node.props.id === 'dsh-bot-examples')[0];
  assert.equal(findButton(first, 'exampleSave').props.disabled, true, '空着不让点');
  box.props.onChange({ target: { value: '我：在吗\n它：在' } });
  let element = render();
  findButton(element, 'exampleSave').props.onClick();
  await tick();
  element = render();

  const post = host.calls.filter((call) => call.method === 'POST' && call.url === '/dsh-bot/api/examples').pop();
  assert.ok(post, '存示例要走 POST /examples');
  assert.deepEqual(post.body, { text: '我：在吗\n它：在' });
  assert.ok(textOf(element).includes('已存 2 段示例，下一条消息就按它们说话'), textOf(element).slice(0, 400));
  // 存完文本框清空，免得手一抖又存一遍
  assert.equal(findAll(element, (node) => node.props && node.props.id === 'dsh-bot-examples')[0].props.value, '');
});

test('对话示例：清空要两下，第一下只把按钮改成「再点一次清空」', async () => {
  const host = fakeHost();
  const { element: first, render } = await openExamples(host);
  const deletes = () => host.calls.filter((call) => call.method === 'DELETE' && call.url === '/dsh-bot/api/examples');
  assert.equal(textOf(findButton(first, 'exampleClear')), '清空示例');
  findButton(first, 'exampleClear').props.onClick();
  await tick();
  let element = render();
  assert.equal(deletes().length, 0, '第一下不许真的删');
  assert.equal(textOf(findButton(element, 'exampleClear')), '再点一次清空');
  findButton(element, 'exampleClear').props.onClick();
  await tick();
  element = render();
  assert.equal(deletes().length, 1, '3 秒内再点才真删');
  assert.ok(textOf(element).includes('示例清空了'), textOf(element).slice(0, 400));
  assert.ok(textOf(examplesBlock(element)).includes('还没有'), '清完回到空态');
});

test('对话示例：库里没有时说明白，清空按钮点不动', async () => {
  const host = fakeHost({ examples: [] });
  const { element, block } = await openExamples(host);
  assert.ok(textOf(block).includes('还没有'), textOf(block).slice(0, 200));
  assert.equal(findButton(element, 'exampleClear').props.disabled, true, '没东西可清');
});
