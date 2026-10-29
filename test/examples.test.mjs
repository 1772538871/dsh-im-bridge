import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  EXAMPLES_KEEP,
  EXAMPLES_PROMPT_LIMIT,
  EXAMPLES_PROMPT_LINE_CHARS,
  EXAMPLE_MAX_CHARS,
  appendExample,
  clearExamples,
  formatForPrompt,
  readExamples
} from '../src/examples.mjs';
import { API_PREFIX, createApiHandler } from '../src/plugin/routes.mjs';
import { createConfigStore, defaultConfig } from '../src/plugin/config-store.mjs';
import { createRuntime } from '../src/plugin/runtime.mjs';
import { buildPrompt } from '../src/prompt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const promptsFile = 'examples.md';

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bot-examples-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withPrompts(fn) {
  return withDir(async (dir) => {
    await mkdir(path.join(dir, 'prompts'), { recursive: true });
    return fn(dir);
  });
}

// ---------------- 存储与解析 prompts/examples.md ----------------

test('解析：我 / 它 / 对方 / 你 都认，最后只落在两端', async () => {
  await withDir(async (dir) => {
    const added = await appendExample({ rootDir: dir, text: '我：累死了\n它：活该，谁让你不睡', now: 1767000000000 });
    assert.equal(added.ok, true);
    assert.equal(added.added, 1);
    const entries = readExamples({ rootDir: dir });
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].lines, [
      { speaker: '我', text: '累死了' },
      { speaker: '它', text: '活该，谁让你不睡' }
    ]);
    // 对方 / 你 指的是同一头：要学的那个"它"
    await appendExample({ rootDir: dir, text: '对方：在吗\n你：干嘛', now: 1767000060000 });
    assert.deepEqual(readExamples({ rootDir: dir, limit: 1 })[0].lines, [
      { speaker: '它', text: '在吗' },
      { speaker: '它', text: '干嘛' }
    ]);
  });
});

test('解析：一行前缀都没有时按原文原样存，不硬加「我：」', async () => {
  await withDir(async (dir) => {
    await appendExample({ rootDir: dir, text: '他骂我我就笑\n然后不说话', now: 1767000000000 });
    const raw = await readFile(path.join(dir, 'prompts', promptsFile), 'utf8');
    assert.ok(raw.includes('他骂我我就笑\n然后不说话'), raw);
    const entries = readExamples({ rootDir: dir });
    assert.deepEqual(entries[0].lines, [
      { speaker: '', text: '他骂我我就笑' },
      { speaker: '', text: '然后不说话' }
    ]);
    // 没有发言人的行进提示词也一样原样，不替它编一个"我"
    assert.equal(formatForPrompt(entries).split('\n').slice(2).join('\n'), '他骂我我就笑\n然后不说话');
  });
});

test('appendExample：空文本不写文件，并且说人话', async () => {
  await withDir(async (dir) => {
    const result = await appendExample({ rootDir: dir, text: '   \n\t ' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('粘'), result.error);
    assert.deepEqual(readExamples({ rootDir: dir }), []);
  });
});

test('appendExample：超过 ' + EXAMPLE_MAX_CHARS + ' 字拒绝，并念出上限与现长', async () => {
  await withDir(async (dir) => {
    const text = '我：' + '跑'.repeat(EXAMPLE_MAX_CHARS);
    const result = await appendExample({ rootDir: dir, text });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('太长'), result.error);
    assert.ok(result.error.includes(String(EXAMPLE_MAX_CHARS)), result.error);
    assert.ok(result.error.includes(String(text.length)), result.error);
    assert.deepEqual(readExamples({ rootDir: dir }), [], '拒绝就是没落盘');
  });
});

test('库上限：第 ' + (EXAMPLES_KEEP + 1) + ' 段进来就删最旧的，留下的正文一个字都不少', async () => {
  await withDir(async (dir) => {
    const base = 1767000000000;
    for (let i = 0; i < EXAMPLES_KEEP; i += 1) {
      await appendExample({ rootDir: dir, text: '我：第' + i + '段', now: base + i });
    }
    // 这一段比提示词每行的 120 字上限长：裁旧写回时不许被截断
    const long = '我：' + '长'.repeat(300);
    await appendExample({ rootDir: dir, text: long, now: base + 100 });
    await appendExample({ rootDir: dir, text: '我：最后一段', now: base + 101 });

    const all = readExamples({ rootDir: dir, limit: 999 });
    assert.equal(all.length, EXAMPLES_KEEP);
    assert.equal(all[0].lines[0].text, '最后一段');
    assert.equal(all[1].lines[0].text, '长'.repeat(300), '长的那段一个字都不许少');
    assert.equal(all[all.length - 1].lines[0].text, '第2段', '删的是最旧那几段');
    const raw = await readFile(path.join(dir, 'prompts', promptsFile), 'utf8');
    assert.ok(raw.includes(long), '写回的是原文，不是 120 字的截断版');
  });
});

test('readExamples：新的在前，limit 默认 ' + EXAMPLES_PROMPT_LIMIT + ' 段', async () => {
  await withDir(async (dir) => {
    const base = 1767000000000;
    for (let i = 0; i < 8; i += 1) await appendExample({ rootDir: dir, text: '我：第' + i + '段', now: base + i });
    const list = readExamples({ rootDir: dir });
    assert.equal(list.length, EXAMPLES_PROMPT_LIMIT);
    assert.deepEqual(
      list.map((entry) => entry.lines[0].text),
      ['第7段', '第6段', '第5段', '第4段', '第3段', '第2段']
    );
    assert.equal(readExamples({ rootDir: dir, limit: 2 }).length, 2);
  });
});

test('readExamples：每行按 maxCharsPerLine 截断，只影响读出来的那份', async () => {
  await withDir(async (dir) => {
    await appendExample({ rootDir: dir, text: '我：' + '字'.repeat(200), now: 1767000000000 });
    const capped = readExamples({ rootDir: dir, maxCharsPerLine: EXAMPLES_PROMPT_LINE_CHARS });
    assert.equal(capped[0].lines[0].text.length, EXAMPLES_PROMPT_LINE_CHARS);
    assert.equal(readExamples({ rootDir: dir })[0].lines[0].text.length, 200, '库里还是全的');
  });
});

test('readExamples：没目录 / 没文件 / 文件不是分段格式都当空库，永不抛', async () => {
  assert.deepEqual(readExamples({ rootDir: '' }), []);
  assert.deepEqual(readExamples({ rootDir: 'E:\\不存在的目录-xyz' }), []);
  await withPrompts(async (dir) => {
    await writeFile(path.join(dir, 'prompts', promptsFile), '这不是分段格式，只是一段乱写的东西', 'utf8');
    assert.deepEqual(readExamples({ rootDir: dir }), []);
    assert.equal(formatForPrompt(readExamples({ rootDir: dir })), '');
  });
});

test('formatForPrompt：空库返回空串，整段不该出现', () => {
  assert.equal(formatForPrompt([]), '');
  assert.equal(formatForPrompt(null), '');
  assert.equal(formatForPrompt([{ when: '2026-01-02 11:04', lines: [] }]), '');
});

test('formatForPrompt：标题 + 说明 + 逐行「我：/它：」', () => {
  const text = formatForPrompt([
    {
      when: '2026-01-02 11:04',
      lines: [
        { speaker: '我', text: '累死了' },
        { speaker: '它', text: '活该，谁让你不睡' }
      ]
    }
  ]);
  assert.equal(
    text,
    '[对话示例]\n' +
      '下面是我和我兄弟真实聊天时的样子，你回话要像这些例子里的“它”，不要解释这些例子：\n' +
      '我：累死了\n' +
      '它：活该，谁让你不睡'
  );
  assert.equal(text.includes('2026-01-02'), false, '时间戳留在页面上，不进提示词');
});

test('clearExamples：删掉整个文件，本来就没有也算清空成功', async () => {
  await withDir(async (dir) => {
    await appendExample({ rootDir: dir, text: '我：累死了', now: 1767000000000 });
    assert.equal(readExamples({ rootDir: dir }).length, 1);
    assert.deepEqual(await clearExamples({ rootDir: dir }), { ok: true });
    assert.deepEqual(readExamples({ rootDir: dir }), []);
    assert.deepEqual(await clearExamples({ rootDir: dir }), { ok: true });
  });
});

// ---------------- 宿主路由 /dsh-bot/api/examples ----------------

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

async function call(handler, options = {}) {
  const res = fakeRes();
  await handler(fakeReq(options), res);
  assert.equal(res.statusCode, 200, '对话示例的接口也必须 HTTP 200');
  assert.equal(res.headers['cache-control'], 'no-store');
  return JSON.parse(res.body || '{}');
}

const jsonReq = (method, path, payload) => ({
  method,
  url: API_PREFIX + path,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload)
});
const getPath = (path) => ({ method: 'GET', url: API_PREFIX + path });

async function withHandler(fn) {
  return withDir(async (dir) => {
    const store = createConfigStore({ env: { DSH_BOT_CONFIG: path.join(dir, 'config.json') } });
    const config = defaultConfig();
    config.storage.rootDir = path.join(dir, 'data');
    await store.save(config);
    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });
    return fn({ dir, dataDir: path.join(dir, 'data'), handler });
  });
}

test('GET /examples：还没存过就是空列表（不是错误）', async () => {
  await withHandler(async ({ handler }) => {
    const json = await call(handler, getPath('/examples'));
    assert.equal(json.ok, true);
    assert.deepEqual(json.examples, []);
  });
});

test('POST /examples：存一段就回新的在前列表，added 是这次加了几段', async () => {
  await withHandler(async ({ handler }) => {
    const first = await call(handler, jsonReq('POST', '/examples', { text: '我：累死了\n它：活该，谁让你不睡' }));
    assert.equal(first.ok, true);
    assert.equal(first.added, 1);
    assert.equal(first.examples.length, 1);
    assert.deepEqual(first.examples[0].lines, [
      { speaker: '我', text: '累死了' },
      { speaker: '它', text: '活该，谁让你不睡' }
    ]);
    const second = await call(handler, jsonReq('POST', '/examples', { text: '我：在吗\n它：在' }));
    assert.deepEqual(
      second.examples.map((entry) => entry.lines[0].text),
      ['在吗', '累死了'],
      '新的排前面'
    );
  });
});

test('POST /examples：空文本拒绝，不写出一条空记录', async () => {
  await withHandler(async ({ handler }) => {
    const json = await call(handler, jsonReq('POST', '/examples', { text: '   ' }));
    assert.equal(json.ok, false);
    assert.ok(json.error.includes('粘'), json.error);
    const after = await call(handler, getPath('/examples'));
    assert.deepEqual(after.examples, []);
  });
});

test('POST /examples：超过 ' + EXAMPLE_MAX_CHARS + ' 字拒绝，并说清上限', async () => {
  await withHandler(async ({ handler }) => {
    const text = '我：' + '跑'.repeat(EXAMPLE_MAX_CHARS);
    const json = await call(handler, jsonReq('POST', '/examples', { text }));
    assert.equal(json.ok, false);
    assert.ok(json.error.includes(String(EXAMPLE_MAX_CHARS)), json.error);
    const after = await call(handler, getPath('/examples'));
    assert.deepEqual(after.examples, []);
  });
});

test('DELETE /examples：清空整个文件，列表跟着变空', async () => {
  await withHandler(async ({ dataDir, handler }) => {
    await call(handler, jsonReq('POST', '/examples', { text: '我：累死了\n它：活该' }));
    const json = await call(handler, { method: 'DELETE', url: API_PREFIX + '/examples' });
    assert.equal(json.ok, true);
    assert.deepEqual(json.examples, []);
    await assert.rejects(readFile(path.join(dataDir, 'prompts', promptsFile), 'utf8'), '文件整个删掉');
  });
});

// ---------------- 提示词注入 ----------------

test('提示词：[对话示例] 排在「用户教过的」之后、「最近日记」之前', async () => {
  await withPrompts(async (dir) => {
    await writeFile(path.join(dir, 'prompts', 'persona.md'), '你叫小号，说话短\n', 'utf8');
    await writeFile(path.join(dir, 'prompts', 'lessons.md'), '## 2026-01-01 10:00\n别人骂你别还嘴\n\n', 'utf8');
    await writeFile(path.join(dir, 'prompts', promptsFile), '## 2026-01-02 11:04\n我：累死了\n它：活该，谁让你不睡\n\n', 'utf8');
    await writeFile(path.join(dir, 'prompts', 'journal.md'), '## 2026-01-02 09:00\n今天聊了天气\n', 'utf8');
    const prompt = buildPrompt({ config: { storage: { rootDir: dir } }, message: { text: '在吗' }, dataDir: dir });
    assert.ok(prompt.includes('[对话示例]'), prompt);
    assert.ok(prompt.indexOf('[用户教过的]') < prompt.indexOf('[对话示例]'), prompt);
    assert.ok(prompt.indexOf('[对话示例]') < prompt.indexOf('[最近日记]'), prompt);
    assert.ok(prompt.indexOf('[对话示例]') < prompt.indexOf('[用户消息]'), prompt);
    assert.ok(prompt.includes('我：累死了\n它：活该，谁让你不睡'), prompt);
  });
});

test('提示词：示例库空时 [对话示例] 整段不出现，与旧行为逐字一致', async () => {
  await withPrompts(async (dir) => {
    await writeFile(path.join(dir, 'prompts', 'persona.md'), '你叫小号，说话短\n', 'utf8');
    const prompt = buildPrompt({ config: { storage: { rootDir: dir } }, message: { text: '在吗' }, dataDir: dir });
    assert.equal(prompt.includes('[对话示例]'), false, prompt);
    assert.ok(prompt.startsWith('[角色设定]\n你叫小号，说话短\n\n[用户消息]\n'), prompt.slice(0, 160));
  });
});

// ---------------- 设置页的接口层 ----------------

function loadClient() {
  const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');
  const registered = [];
  const win = { __ModuleLoader__: { load: (entry) => registered.push(entry) } };
  const context = vm.createContext({ window: win, console: { warn() {}, log() {}, error() {} } });
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  assert.equal(registered.length, 1);
  return registered[0];
}

test('设置页的接口层：examples / addExample / clearExamples 打的是 /examples', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push({ method, url, body: init && init.body ? JSON.parse(init.body) : null });
    if (method === 'POST') return { status: 200, json: async () => ({ ok: true, added: 1, examples: [] }) };
    return { status: 200, json: async () => ({ ok: true, examples: [] }) };
  };
  const reactStub = { createElement() {}, useState() {}, useEffect() {} };
  const api = loadClient().factory(() => reactStub).createApi(fetchImpl);
  await api.examples();
  await api.addExample('我：累死了');
  await api.clearExamples();
  assert.deepEqual(
    calls.map((item) => item.method + ' ' + item.url),
    ['GET /dsh-bot/api/examples', 'POST /dsh-bot/api/examples', 'DELETE /dsh-bot/api/examples']
  );
  assert.deepEqual(calls[1].body, { text: '我：累死了' }, '只传正文，不塞别的');
});
