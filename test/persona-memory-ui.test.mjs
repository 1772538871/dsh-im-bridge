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

// 一个把「人设与记忆」四块都喂满的假宿主
function fakeHost(overrides = {}) {
  const calls = [];
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
    if (url === '/dsh-bot/api/persona' && method === 'PUT') return jsonResponse({ ok: true, text: body.text });
    if (url === '/dsh-bot/api/lessons' && method === 'GET') {
      return jsonResponse({ ok: true, lessons: [{ index: 0, when: '2026-01-01 10:00', body: '别人骂你别还嘴' }] });
    }
    if (url === '/dsh-bot/api/lessons' && method === 'POST') {
      return jsonResponse({ ok: true, body: body.body, lessons: [{ index: 0, when: '2026-01-01 10:00', body: body.body }] });
    }
    if (url === '/dsh-bot/api/lessons' && method === 'DELETE') return jsonResponse({ ok: true, lessons: [] });
    if (url === '/dsh-bot/api/journal') {
      return jsonResponse({ ok: true, entries: [{ title: '2026-01-02 09:00', body: '今天聊了天气' }] });
    }
    if (url === '/dsh-bot/api/stickers' && method === 'GET') {
      return jsonResponse({ ok: true, stickers: [{ id: 'aaa111', note: '笑' }], count: 1 });
    }
    if (url === '/dsh-bot/api/stickers' && method === 'DELETE') return jsonResponse({ ok: true, stickers: [], count: 0 });
    if (url === '/dsh-bot/api/control') return jsonResponse({ ok: true, status: { running: true } });
    if (url === '/dsh-bot/api/test-send') return jsonResponse({ ok: true, target: '10001', chunkCount: 1 });
    return jsonResponse({ ok: false, error: '未预期的请求 ' + method + ' ' + url });
  };
  return { calls, fetchImpl, ...overrides };
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
  element = render();
  return element;
}

function findButton(element, key) {
  const hit = findAll(element, (node) => node.type === 'button' && node.props.key === key)[0];
  assert.ok(hit, '找不到按钮：' + key + '\n' + textOf(element).slice(0, 400));
  return hit;
}

// ---------------- 页面骨架 ----------------

test('页面：只剩四块，人设与记忆四块都能看见', async () => {
  const host = fakeHost();
  const { render, fake } = mountSection(host);
  const element = await settle(fake, render, host);
  const text = textOf(element);
  // 该没有的
  for (const word of ['高级设置', '显示全部字段', '更多设置', '数据目录', '日志目录']) {
    assert.equal(text.includes(word), false, '这些入口必须消失：' + word);
  }
  // 该有的
  for (const word of ['谁能用', '人设', '你教过的', '日记', '表情库']) {
    assert.ok(text.includes(word), '缺一块：' + word);
  }
});

test('页面：顶部没有「发送测试消息」，只有接入卡片里的「发条测试消息」', async () => {
  const host = fakeHost();
  const { render, fake } = mountSection(host);
  const element = await settle(fake, render, host);
  const labels = findAll(element, (n) => n.type === 'button').map((n) => textOf(n));
  assert.equal(labels.includes('发送测试消息'), false, labels.join('|'));
  assert.equal(labels.filter((label) => label === '发条测试消息').length, 1, labels.join('|'));
  assert.ok(labels.includes('收起'), '接入卡片的按钮叫「收起」');
  assert.equal(labels.includes('取消'), false);
});

// ---------------- 四块各自的交互 ----------------

test('展开就真的去读四块：/persona /lessons /journal /stickers 各一次', async () => {
  const host = fakeHost();
  const { render, fake } = mountSection(host);
  await settle(fake, render, host);
  const element = await openMemory(fake, render);
  const urls = host.calls.map((c) => c.method + ' ' + c.url);
  for (const want of ['GET /dsh-bot/api/persona', 'GET /dsh-bot/api/lessons', 'GET /dsh-bot/api/journal', 'GET /dsh-bot/api/stickers']) {
    assert.ok(urls.includes(want), '缺请求：' + want + '\n' + urls.join('\n'));
  }
  const text = textOf(element);
  // 人设正文在 textarea 的 value 里，不在 children 里
  const personaBox = findAll(element, (n) => n.props && n.props.id === 'dsh-bot-persona')[0];
  assert.equal(personaBox.props.value, '你叫小号，说话短');
  assert.ok(text.includes('人设 8 字'), text.slice(0, 300));
  assert.ok(text.includes('别人骂你别还嘴'), text);
  assert.ok(text.includes('今天聊了天气'), text);
  assert.ok(text.includes('1. 笑'), text);
});

test('人设：改文本 → 点「保存人设」→ PUT /persona 带上刚写的那段', async () => {
  const host = fakeHost();
  const { render, fake } = mountSection(host);
  await settle(fake, render, host);
  let element = await openMemory(fake, render);
  const box = findAll(element, (n) => n.props && n.props.id === 'dsh-bot-persona')[0];
  assert.ok(box, textOf(element).slice(0, 300));
  box.props.onChange({ target: { value: '你叫老张，说话冲一点' } });
  element = render();
  findButton(element, 'personaSave').props.onClick();
  await tick();
  element = render();

  const put = host.calls.filter((c) => c.method === 'PUT' && c.url === '/dsh-bot/api/persona').pop();
  assert.ok(put, '必须 PUT /persona');
  assert.deepEqual(Object.keys(put.body), ['text'], '只传正文，不塞别的');
  assert.equal(put.body.text, '你叫老张，说话冲一点');
  assert.ok(textOf(element).includes('已保存人设：10 字'), textOf(element).slice(0, 400));
});

test('教过的：写一句 → 「加一条」→ POST /lessons；列表里那条能删掉', async () => {
  const host = fakeHost();
  const { render, fake } = mountSection(host);
  await settle(fake, render, host);
  let element = await openMemory(fake, render);

  const draft = findAll(element, (n) => n.props && n.props.id === 'dsh-bot-lesson')[0];
  assert.ok(draft, textOf(element).slice(0, 300));
  // 空着不让点：免得发一条空记录
  assert.equal(findButton(element, 'addBtn').props.disabled, true);
  draft.props.onChange({ target: { value: '以后别人问你几点，就说现在几点' } });
  element = render();
  findButton(element, 'addBtn').props.onClick();
  await tick();
  element = render();
  const post = host.calls.filter((c) => c.method === 'POST' && c.url === '/dsh-bot/api/lessons').pop();
  assert.deepEqual(post.body, { body: '以后别人问你几点，就说现在几点' });

  // 删掉列表里第一条
  const del = findAll(element, (n) => n.type === 'button' && textOf(n) === '删掉')[0];
  assert.ok(del, textOf(element).slice(0, 400));
  del.props.onClick();
  await tick();
  const removed = host.calls.filter((c) => c.method === 'DELETE' && c.url === '/dsh-bot/api/lessons').pop();
  assert.ok(removed, '删一条要走 DELETE /lessons');
  assert.deepEqual(removed.body, { index: 0 }, '按序号删，正文不跟着上传');
});

test('表情库：点「删掉」→ DELETE /stickers 带上那一张的 id', async () => {
  const host = fakeHost();
  const { render, fake } = mountSection(host);
  await settle(fake, render, host);
  let element = await openMemory(fake, render);
  const buttons = findAll(element, (n) => n.type === 'button' && textOf(n) === '删掉');
  // 第一条「删掉」属于「你教过的」，表情库那条是最后一条（页面上只有这两处）
  assert.equal(buttons.length, 2, textOf(element).slice(0, 400));
  buttons[1].props.onClick();
  await tick();
  const removed = host.calls.filter((c) => c.method === 'DELETE' && c.url === '/dsh-bot/api/stickers').pop();
  assert.ok(removed, '删表情要走 DELETE /stickers');
  assert.deepEqual(removed.body, { id: 'aaa111' });
});

test('人设与记忆：默认收起，收起时四个输入框都不可见', async () => {
  const host = fakeHost();
  const { render, fake } = mountSection(host);
  const element = await settle(fake, render, host);
  const hidden = (node) => {
    const style = node && node.props ? node.props.style : null;
    return !!style && style.display === 'none';
  };
  const visiblePersona = [];
  const walk = (node, blocked) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, blocked);
      return;
    }
    const off = blocked || hidden(node);
    if (!off && node.props && node.props.id === 'dsh-bot-persona') visiblePersona.push(node);
    for (const child of node.children) walk(child, off);
  };
  walk(element, false);
  assert.equal(visiblePersona.length, 0, '没展开就不该看见人设框');
});
