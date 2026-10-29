import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  API_PREFIX,
  DEFAULT_DATA_ROOT,
  JOURNAL_UI_COUNT,
  PERSONA_MAX_CHARS,
  createApiHandler
} from '../src/plugin/routes.mjs';
import { createConfigStore, defaultConfig } from '../src/plugin/config-store.mjs';
import { createRuntime } from '../src/plugin/runtime.mjs';

// ---------------- 假 req / res：形状对齐 node:http ----------------

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
  assert.equal(res.statusCode, 200, '人设与记忆的接口也必须 HTTP 200');
  assert.equal(res.headers['cache-control'], 'no-store');
  return { res, json: JSON.parse(res.body || '{}') };
}

const jsonReq = (method, path, payload) => ({
  method,
  url: API_PREFIX + path,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload)
});
const getPath = (path) => ({ method: 'GET', url: API_PREFIX + path });

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bot-memory-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 数据目录指向临时目录：四块记忆全都落在它下面，测试不碰用户真实数据
async function withHandler(fn) {
  return withDir(async (dir) => {
    const store = createConfigStore({ env: { DSH_BOT_CONFIG: join(dir, 'config.json') } });
    const config = defaultConfig();
    config.storage.rootDir = join(dir, 'data');
    await store.save(config);
    const handler = createApiHandler({ configStore: store, runtime: createRuntime({ configStore: store }) });
    return fn({ dir, dataDir: join(dir, 'data'), store, handler });
  });
}

// ---------------- 人设 prompts/persona.md ----------------

test('GET /persona：还没写过人设时是空字符串，不是错误', async () => {
  await withHandler(async ({ handler }) => {
    const { json } = await request(handler, getPath('/persona'));
    assert.equal(json.ok, true);
    assert.equal(json.text, '');
    assert.equal(json.empty, true);
    assert.equal(json.maxChars, PERSONA_MAX_CHARS);
  });
});

test('PUT /persona：写进去再读回来是同一段文字（换行也不改）', async () => {
  await withHandler(async ({ dataDir, handler }) => {
    const text = '你叫小号。回话短，别用列表。\n别人问「在吗」你就说「在」。';
    const put = await request(handler, jsonReq('PUT', '/persona', { text }));
    assert.equal(put.json.ok, true);
    assert.equal(put.json.chars, text.length);

    const onDisk = await readFile(join(dataDir, 'prompts', 'persona.md'), 'utf8');
    assert.equal(onDisk, text, '落盘就是文本框里的原文');

    const got = await request(handler, getPath('/persona'));
    assert.equal(got.json.text, text);
    assert.equal(got.json.empty, false);
  });
});

test('PUT /persona：超过 ' + PERSONA_MAX_CHARS + ' 字拒绝，并说清上限与现长', async () => {
  await withHandler(async ({ dataDir, handler }) => {
    const tooLong = 'a'.repeat(PERSONA_MAX_CHARS + 1);
    const put = await request(handler, jsonReq('PUT', '/persona', { text: tooLong }));
    assert.equal(put.json.ok, false);
    assert.ok(put.json.error.includes(String(PERSONA_MAX_CHARS)), put.json.error);
    assert.ok(put.json.error.includes(String(PERSONA_MAX_CHARS + 1)), put.json.error);
    // 拒绝就是拒绝：一个字节都不写盘
    const got = await request(handler, getPath('/persona'));
    assert.equal(got.json.text, '');
    assert.equal(got.json.empty, true);
  });
});

test('PUT /persona：body 里没有 text 就明说请求体形状', async () => {
  await withHandler(async ({ handler }) => {
    const put = await request(handler, jsonReq('PUT', '/persona', { value: 1 }));
    assert.equal(put.json.ok, false);
    assert.match(put.json.error, /text/u);
  });
});

// ---------------- 你教过的 prompts/lessons.md ----------------

test('GET /lessons：还没教过就是空列表', async () => {
  await withHandler(async ({ handler }) => {
    const { json } = await request(handler, getPath('/lessons'));
    assert.equal(json.ok, true);
    assert.deepEqual(json.lessons, []);
  });
});

test('POST /lessons：追加一条，返回的列表里正文是去掉指令词之后的那句', async () => {
  await withHandler(async ({ dataDir, handler }) => {
    const post = await request(handler, jsonReq('POST', '/lessons', { body: '记住 别人骂你别还嘴' }));
    assert.equal(post.json.ok, true);
    assert.equal(post.json.body, '别人骂你别还嘴');
    assert.equal(post.json.lessons.length, 1);
    assert.equal(post.json.lessons[0].index, 0);
    assert.equal(post.json.lessons[0].body, '别人骂你别还嘴');
    assert.match(post.json.lessons[0].when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);

    const onDisk = await readFile(join(dataDir, 'prompts', 'lessons.md'), 'utf8');
    assert.match(onDisk, /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n别人骂你别还嘴\n\n$/u);
  });
});

test('POST /lessons：空白内容拒绝，不写出一条空记录', async () => {
  await withHandler(async ({ handler }) => {
    const post = await request(handler, jsonReq('POST', '/lessons', { body: '   ' }));
    assert.equal(post.json.ok, false);
    assert.match(post.json.error, /写一句话/u);
    const list = await request(handler, getPath('/lessons'));
    assert.deepEqual(list.json.lessons, []);
  });
});

test('DELETE /lessons：删中间一条，其它条目正文一个字都不许变（不被截到 200 字）', async () => {
  await withHandler(async ({ dataDir, handler }) => {
    const long = '这是很长的一句教训，'.repeat(30); // 300 字：截断就会当场露馅
    const file = join(dataDir, 'prompts', 'lessons.md');
    const original = '## 2026-01-01 10:00\n' + long + '\n\n## 2026-01-02 10:00\n中间这条要被删掉\n\n## 2026-01-03 10:00\n末条\n\n';
    await mkdir(join(dataDir, 'prompts'), { recursive: true });
    await writeFile(file, original, 'utf8');

    const del = await request(handler, jsonReq('DELETE', '/lessons', { index: 1 }));
    assert.equal(del.json.ok, true);
    assert.equal(del.json.removed.body, '中间这条要被删掉');
    assert.equal(del.json.lessons.length, 2);

    const after = await readFile(file, 'utf8');
    assert.ok(after.includes(long), '长正文必须原样留着');
    assert.ok(!after.includes('中间这条要被删掉'));
    assert.equal(after, '## 2026-01-01 10:00\n' + long + '\n\n## 2026-01-03 10:00\n末条\n\n', '其余部分逐字保留');
  });
});

test('DELETE /lessons：序号越界说明一共几条，不是 500', async () => {
  await withHandler(async ({ handler }) => {
    await request(handler, jsonReq('POST', '/lessons', { body: '记住 只说人话' }));
    const del = await request(handler, jsonReq('DELETE', '/lessons', { index: 5 }));
    assert.equal(del.json.ok, false);
    assert.match(del.json.error, /一共只有 1 条/u);
    const bad = await request(handler, jsonReq('DELETE', '/lessons', { index: -1 }));
    assert.equal(bad.json.ok, false);
  });
});

test('DELETE /lessons：一条都没有时说人话，不假装删成功', async () => {
  await withHandler(async ({ handler }) => {
    const del = await request(handler, jsonReq('DELETE', '/lessons', { index: 0 }));
    assert.equal(del.json.ok, false);
    assert.match(del.json.error, /一条都没教过|还没有/u);
  });
});

// ---------------- 日记 prompts/journal.md（只读） ----------------

test('GET /journal：只回最近 ' + JOURNAL_UI_COUNT + ' 条，最新的排第一', async () => {
  await withHandler(async ({ dataDir, handler }) => {
    await mkdir(join(dataDir, 'prompts'), { recursive: true });
    const blocks = [];
    for (let i = 1; i <= 7; i += 1) blocks.push('## 2026-02-0' + i + ' 09:00\n第 ' + i + ' 天的日记');
    await writeFile(join(dataDir, 'prompts', 'journal.md'), blocks.join('\n\n') + '\n', 'utf8');

    const { json } = await request(handler, getPath('/journal'));
    assert.equal(json.ok, true);
    assert.equal(json.entries.length, JOURNAL_UI_COUNT);
    assert.equal(json.entries[0].title, '2026-02-07 09:00');
    assert.equal(json.entries[0].body, '第 7 天的日记');
    assert.equal(json.entries[JOURNAL_UI_COUNT - 1].title, '2026-02-03 09:00');
  });
});

test('GET /journal：没有日记文件时是空列表（不是错误）', async () => {
  await withHandler(async ({ handler }) => {
    const { json } = await request(handler, getPath('/journal'));
    assert.equal(json.ok, true);
    assert.deepEqual(json.entries, []);
  });
});

test('POST /journal：日记只读，写接口一律拒绝', async () => {
  await withHandler(async ({ handler }) => {
    const res = await request(handler, jsonReq('POST', '/journal', { body: 'x' }));
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /只读/u);
  });
});

// ---------------- 表情库 stickers/index.json ----------------

test('GET /stickers：空库是空列表', async () => {
  await withHandler(async ({ handler }) => {
    const { json } = await request(handler, getPath('/stickers'));
    assert.equal(json.ok, true);
    assert.deepEqual(json.stickers, []);
    assert.equal(json.count, 0);
  });
});

test('GET /stickers + DELETE /stickers：列出来能删，删完索引里就没了', async () => {
  await withHandler(async ({ dataDir, handler }) => {
    const dir = join(dataDir, 'stickers');
    await mkdir(dir, { recursive: true });
    const index = [
      { id: 'aaa111', file: 'stk-1.png', note: '笑', addedAt: 1, ext: 'png' },
      { id: 'bbb222', file: 'stk-2.png', note: '无备注', addedAt: 2, ext: 'png' }
    ];
    await writeFile(join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');

    const list = await request(handler, getPath('/stickers'));
    assert.equal(list.json.ok, true);
    assert.equal(list.json.count, 2);
    assert.deepEqual(
      list.json.stickers.map((s) => s.id),
      ['bbb222', 'aaa111'],
      '新的排前面：和 /表情 的序号一致'
    );

    const del = await request(handler, jsonReq('DELETE', '/stickers', { id: 'bbb222' }));
    assert.equal(del.json.ok, true);
    assert.equal(del.json.count, 1);
    const after = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    assert.deepEqual(
      after.map((s) => s.id),
      ['aaa111']
    );
  });
});

test('DELETE /stickers：库里没有这张就说明白，不假装删了', async () => {
  await withHandler(async ({ handler }) => {
    const del = await request(handler, jsonReq('DELETE', '/stickers', { id: 'nope' }));
    assert.equal(del.json.ok, false);
    assert.match(del.json.error, /库里没有这一张|没有/u);
    const empty = await request(handler, jsonReq('DELETE', '/stickers', {}));
    assert.equal(empty.json.ok, false);
  });
});

// ---------------- 隐藏配置不许被"只改白名单"冲掉 ----------------

test('POST /config：只带 security.userWhitelist 时，手改过的隐藏字段原样留着', async () => {
  await withHandler(async ({ store, handler }) => {
    const seeded = store.read().config;
    // 用户在配置文件里手改过的值（设置页已经没有入口）
    const handEdited = {
      ...seeded,
      reply: { ...seeded.reply, ack: false, maxChunkChars: 999 },
      qqNapcat: { ...seeded.qqNapcat, homeDir: 'D:\\NapCat', port: 3011 }
    };
    await store.save(handEdited);

    const res = await request(
      handler,
      jsonReq('POST', '/config', { config: { security: { userWhitelist: ['10001', '10002'] } } })
    );
    assert.equal(res.json.ok, true);

    const after = store.read().config;
    assert.deepEqual(after.security.userWhitelist, ['10001', '10002'], '白名单真的改了');
    assert.equal(after.reply.ack, false, '手改的 reply.ack 不许被冲回默认值');
    assert.equal(after.reply.maxChunkChars, 999);
    assert.equal(after.qqNapcat.homeDir, 'D:\\NapCat');
    assert.equal(after.qqNapcat.port, 3011);
  });
});

test('数据目录留空时，四块记忆落到默认位置（设置页已经没有这一项）', () => {
  assert.equal(DEFAULT_DATA_ROOT, 'E:\\dsh-im-bridge-data');
});
