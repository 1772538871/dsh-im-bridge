import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { commandStickerListText, parseCommand } from '../src/commands.mjs';
import { createPipeline } from '../src/pipeline.mjs';
import { buildPrompt } from '../src/prompt.mjs';
import {
  NO_STICKER_NOTE,
  addSticker,
  imageFormOf,
  listStickers,
  pickStickersForPrompt,
  readStickerIndex,
  removeSticker,
} from '../src/stickers.mjs';

const CHAT_KEY = 'private_10001';

// ---------------------------------------------------------------- 素材

async function tempRoot(prefix = 'dsh-im-stickers-') {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 一张"GIF 形状"的图：只要能过魔数判定即可，测试不解析帧。 */
function gifBytes(marker = 'A', header = 'GIF89a') {
  return Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from([0x01, 0x00, 0x01, 0x00]), Buffer.from(';' + marker, 'latin1')]);
}

function pngBytes(marker = 'A') {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(marker, 'latin1')]);
}

function webpBytes({ animated = false, marker = 'A' } = {}) {
  const riff = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBP', 'latin1')]);
  const body = animated
    ? Buffer.concat([Buffer.from('VP8X', 'latin1'), Buffer.from('ANIM', 'latin1'), Buffer.from(marker, 'latin1')])
    : Buffer.concat([Buffer.from('VP8 ', 'latin1'), Buffer.from(marker, 'latin1')]);
  return Buffer.concat([riff, body]);
}

async function writeImage(root, name, bytes) {
  const dir = join(root, 'media');
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

// ---------------------------------------------------------------- 入库

test('addSticker：复制而不是移动，原图还在，索引字段齐全', async () => {
  const root = await tempRoot();
  const source = await writeImage(root, 'a.gif', gifBytes('one'));

  const outcome = await addSticker({ rootDir: root, sourcePath: source, note: '开心', from: CHAT_KEY, now: 1000 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.duplicated, false);
  assert.equal(outcome.count, 1);

  // 原附件必须原封不动：它还要照常交给 DSH 读
  assert.deepEqual(await readFile(source), gifBytes('one'));
  const entries = readStickerIndex({ rootDir: root });
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.deepEqual(Object.keys(entry).sort(), ['addedAt', 'animated', 'ext', 'file', 'from', 'hash', 'id', 'note', 'source']);
  assert.equal(entry.addedAt, 1000);
  assert.equal(entry.note, '开心');
  assert.equal(entry.from, CHAT_KEY);
  assert.equal(entry.source, 'command');
  assert.match(entry.file, /^stk-1000-[0-9a-f]{4}\.gif$/u);
  assert.match(entry.id, /^[0-9a-f]{12}$/u);
  assert.deepEqual(await readFile(join(root, 'stickers', entry.file)), gifBytes('one'));
  // 索引落在 <rootDir>/stickers/index.json
  assert.ok((await readdir(join(root, 'stickers'))).includes(entry.file));
});

test('addSticker：源文件不存在时给人话失败，索引里不留空条目', async () => {
  const root = await tempRoot();
  const outcome = await addSticker({ rootDir: root, sourcePath: join(root, 'media', 'nope.gif'), note: '鬼脸' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /找不到这张图/u);
  assert.deepEqual(readStickerIndex({ rootDir: root }), []);
  assert.deepEqual(await readdir(join(root, 'stickers')).catch(() => []), []);
});

test('addSticker：备注为空写成「无备注」，超长备注截断', async () => {
  const root = await tempRoot();
  const first = await addSticker({ rootDir: root, sourcePath: await writeImage(root, 'a.gif', gifBytes('A')), note: '   ' });
  assert.equal(first.entry.note, NO_STICKER_NOTE);

  const second = await addSticker({ rootDir: root, sourcePath: await writeImage(root, 'b.png', pngBytes('B')), note: '长'.repeat(100) });
  assert.ok(second.entry.note.length <= 61, second.entry.note);
  assert.equal(second.entry.note.endsWith('…'), true);
});

test('addSticker：索引坏了当空库，下一次收藏会把索引重建出来', async () => {
  const root = await tempRoot();
  const dir = join(root, 'stickers');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.json'), '{"entries": [ 这不是 JSON', 'utf8');

  assert.deepEqual(readStickerIndex({ rootDir: root }), []);
  assert.equal(listStickers({ rootDir: root }).length, 0);

  const outcome = await addSticker({ rootDir: root, sourcePath: await writeImage(root, 'a.gif', gifBytes('A')), note: '坏了也照收' });
  assert.equal(outcome.ok, true);
  assert.deepEqual(readStickerIndex({ rootDir: root }).map((entry) => entry.note), ['坏了也照收']);
});

test('addSticker：同一张图两次只入一条（hash 去重），回执报它在库里的序号', async () => {
  const root = await tempRoot();
  const source = await writeImage(root, 'a.gif', gifBytes('dup'));

  const first = await addSticker({ rootDir: root, sourcePath: source, note: '第一次', now: 1000 });
  assert.equal(first.duplicated, false);
  const again = await addSticker({ rootDir: root, sourcePath: source, note: '第二次', now: 2000 });
  assert.equal(again.ok, true);
  assert.equal(again.duplicated, true);
  assert.equal(again.count, 1);
  assert.equal(again.position, 1);
  // 库里留的是第一次那条：重复收藏不会偷偷改备注
  assert.equal(again.entry.note, '第一次');
  assert.equal(readStickerIndex({ rootDir: root }).length, 1);
});

test('addSticker：GIF 原样入库（魔数不变、没被转码），ext=gif animated=true', async () => {
  const root = await tempRoot();
  const bytes = gifBytes('keepme');
  const source = await writeImage(root, '动图.gif', bytes);

  const outcome = await addSticker({ rootDir: root, sourcePath: source, note: '转圈' });
  assert.equal(outcome.entry.ext, 'gif');
  assert.equal(outcome.entry.animated, true);

  const stored = await readFile(join(root, 'stickers', outcome.entry.file));
  assert.equal(stored.subarray(0, 6).toString('latin1'), 'GIF89a');
  assert.deepEqual(stored, bytes, 'GIF 必须逐字节原样，转成 PNG 动图就死了');
});

test('imageFormOf：靠字节判定动图，不靠扩展名', () => {
  assert.deepEqual(imageFormOf(gifBytes('x', 'GIF87a'), 'a.png'), { ext: 'png', animated: true });
  assert.deepEqual(imageFormOf(gifBytes('x', 'GIF89a'), 'a.gif'), { ext: 'gif', animated: true });
  assert.deepEqual(imageFormOf(webpBytes({ animated: true }), 'a.webp'), { ext: 'webp', animated: true });
  assert.deepEqual(imageFormOf(webpBytes({ animated: false }), 'a.webp'), { ext: 'webp', animated: false });
  assert.deepEqual(imageFormOf(pngBytes('x'), 'a.png'), { ext: 'png', animated: false });
  assert.deepEqual(imageFormOf(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'a.jpg'), { ext: 'jpg', animated: false });
  assert.deepEqual(imageFormOf(Buffer.from('nonsense', 'latin1'), 'a.bin'), { ext: 'bin', animated: false });
});

// ---------------------------------------------------------------- 列表 / 删除

test('listStickers：新的在前，limit 生效', async () => {
  const root = await tempRoot();
  for (const [index, marker] of ['一', '二', '三'].entries()) {
    await addSticker({
      rootDir: root,
      sourcePath: await writeImage(root, marker + '.png', pngBytes(marker)),
      note: marker,
      now: 1000 + index * 1000,
    });
  }
  assert.deepEqual(listStickers({ rootDir: root }).map((item) => item.note), ['三', '二', '一']);
  assert.deepEqual(listStickers({ rootDir: root, limit: 2 }).map((item) => item.note), ['三', '二']);
  // 列表里带绝对路径，/表情 与提示词用的是同一份
  assert.ok(listStickers({ rootDir: root })[0].path.startsWith(join(root, 'stickers')));
  assert.deepEqual(listStickers({ rootDir: '' }), []);
});

test('removeSticker：删条目同时删文件，剩余张数正确；id 前缀也能删', async () => {
  const root = await tempRoot();
  const first = await addSticker({ rootDir: root, sourcePath: await writeImage(root, 'a.gif', gifBytes('A')), note: '留下的' });
  const second = await addSticker({ rootDir: root, sourcePath: await writeImage(root, 'b.gif', gifBytes('B')), note: '删掉的' });

  const removed = await removeSticker({ rootDir: root, id: second.entry.id.slice(0, 6) });
  assert.equal(removed.ok, true);
  assert.equal(removed.count, 1);
  assert.deepEqual(readStickerIndex({ rootDir: root }).map((entry) => entry.note), ['留下的']);
  await assert.rejects(readFile(join(root, 'stickers', second.entry.file)), /ENOENT/u);
  assert.ok((await readFile(join(root, 'stickers', first.entry.file))).length > 0);
});

test('removeSticker：不存在的 id 给人话失败，不误删别的', async () => {
  const root = await tempRoot();
  await addSticker({ rootDir: root, sourcePath: await writeImage(root, 'a.gif', gifBytes('A')), note: '还在' });
  const missed = await removeSticker({ rootDir: root, id: 'zzzzzz' });
  assert.equal(missed.ok, false);
  assert.match(missed.error, /库里没有这一张/u);
  assert.equal(readStickerIndex({ rootDir: root }).length, 1);
});

// ---------------------------------------------------------------- 提示词

test('pickStickersForPrompt：备注截断、limit 生效、死链跳过', async () => {
  const root = await tempRoot();
  const long = await addSticker({
    rootDir: root,
    sourcePath: await writeImage(root, 'a.png', pngBytes('A')),
    note: '一二三四五六七八九十甲乙丙丁',
    now: 2000,
  });
  const gone = await addSticker({ rootDir: root, sourcePath: await writeImage(root, 'b.png', pngBytes('B')), note: '这张文件没了', now: 1500 });

  const picked = pickStickersForPrompt({ rootDir: root, noteMaxChars: 5 });
  assert.equal(picked.length, 2);
  assert.equal(picked[0].note, '一二三四五…');
  assert.equal(picked[0].path, join(root, 'stickers', long.entry.file));
  assert.equal(pickStickersForPrompt({ rootDir: root, limit: 1 }).length, 1);

  // 文件被手动删掉：条目还在，但不该出现在提示词里（发死链等于白写一行标记）
  await unlink(join(root, 'stickers', gone.entry.file));
  const afterGone = pickStickersForPrompt({ rootDir: root, noteMaxChars: 5 });
  assert.equal(afterGone.length, 1);
  assert.equal(afterGone[0].note, '一二三四五…');
  assert.equal(afterGone[0].path, join(root, 'stickers', long.entry.file));
  assert.deepEqual(pickStickersForPrompt({ rootDir: '' }), []);
});

test('提示词：[表情库] 段带操作说明、动图标记与绝对路径', async () => {
  const root = await tempRoot();
  const still = await addSticker({ rootDir: root, sourcePath: await writeImage(root, 'a.png', pngBytes('A')), note: '无语', now: 1000 });
  const moving = await addSticker({ rootDir: root, sourcePath: await writeImage(root, 'b.gif', gifBytes('B')), note: '转圈', now: 2000 });

  const prompt = buildPrompt({ config: { storage: { rootDir: root } }, message: { chatType: 'private', userId: '1', text: '在吗' } });
  assert.ok(prompt.includes('[表情库]'), prompt);
  assert.ok(prompt.includes('[[sendimage: <路径>]]'), prompt);
  assert.ok(prompt.includes('不合适就别发'), prompt);
  assert.ok(prompt.includes('- [动图] 备注：转圈 → ' + join(root, 'stickers', moving.entry.file)), prompt);
  assert.ok(prompt.includes('- 备注：无语 → ' + join(root, 'stickers', still.entry.file)), prompt);
  // 表情库排在用户消息前面：要发就发在这一轮
  assert.ok(prompt.indexOf('[表情库]') < prompt.indexOf('[用户消息]'), prompt);
});

test('提示词：库为空时整段不出现，与没有表情库时逐字一致', async () => {
  const bare = await tempRoot();
  const withEmptyLibrary = await tempRoot();
  await mkdir(join(withEmptyLibrary, 'stickers'), { recursive: true });
  await writeFile(join(withEmptyLibrary, 'stickers', 'index.json'), '[]\n', 'utf8');

  const message = { chatType: 'private', userId: '1', text: '在吗' };
  const alpha = buildPrompt({ config: { storage: { rootDir: bare } }, message });
  const beta = buildPrompt({ config: { storage: { rootDir: withEmptyLibrary } }, message });
  assert.equal(beta, alpha);
  assert.equal(alpha.includes('[表情库]'), false);
});

// ---------------------------------------------------------------- 命令解析与文案

test('commands：/收藏 /存表情 /表情 /删表情 都认，参数跟着走', () => {
  assert.deepEqual(parseCommand('/收藏 开心'), { name: 'collect', args: '开心' });
  assert.deepEqual(parseCommand('/存表情'), { name: 'collect', args: '' });
  assert.deepEqual(parseCommand('/表情'), { name: 'stickerList', args: '' });
  assert.deepEqual(parseCommand('/删表情 2'), { name: 'stickerRemove', args: '2' });
  assert.equal(parseCommand('/收藏夹'), null);
});

test('commands：列表文案是「序号. 备注 · id前6位」，空库说人话', () => {
  const text = commandStickerListText([
    { id: 'a1b2c3d4e5f6', note: '开心' },
    { id: 'ffeeddccbbaa', note: '' },
  ]);
  assert.equal(text.split('\n')[0], '1. 开心 · a1b2c3');
  assert.equal(text.split('\n')[1], '2. 无备注 · ffeedd');
  assert.match(text, /\/删表情/u);
  assert.match(commandStickerListText([]), /表情库还是空的/u);
});

// ---------------------------------------------------------------- pipeline 接线

function makeSessions() {
  const map = new Map();
  return {
    map,
    get: (key) => map.get(key),
    async set(key, value) {
      map.set(key, value);
    },
    async clear(key) {
      map.delete(key);
    },
    all: () => Object.fromEntries(map),
  };
}

function messageOf({ text = '', images = [] } = {}) {
  return {
    messageId: '1',
    chatType: 'private',
    userId: '10001',
    text,
    segments: [...(text === '' ? [] : [{ type: 'text', data: { text } }]), ...images.map((item) => ({ type: 'image', data: item.data ?? {} }))],
    atTargets: [],
  };
}

function makeHarness({ rootDir, images = [], runDshResult = { ok: true, text: 'ANSWER', sessionId: 'session-new' } }) {
  const sent = [];
  const runCalls = [];
  const savedPaths = images.map((item) => item.path);
  let cursor = 0;
  const pipeline = createPipeline({
    config: {
      platform: 'qq-napcat',
      dsh: { runner: 'headless', cwd: 'E:\\dsh\\proj' },
      storage: { rootDir },
      reply: { errorPrefix: '[bridge] ', maxChunkChars: 1500 },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    client: { isOpen: () => true, async call() { return { status: 'ok', retcode: 0, data: {} }; } },
    storage: {
      rootDir,
      async saveFromUrl() {
        const path = savedPaths[cursor];
        cursor += 1;
        if (path === undefined) throw new Error('没有可落地的图');
        return { path, bytes: 1, sha256: 'sha' };
      },
    },
    guard: { decide: () => ({ allow: true, reason: 'ok' }) },
    serial: { async run(key, fn) { return await fn(); }, pending: () => 0, size: () => 0 },
    semaphore: { async withPermit(fn) { return await fn(); }, active: () => 0 },
    sessions: makeSessions(),
    runDsh: async (args) => {
      runCalls.push(args);
      return runDshResult;
    },
    deps: {
      parseEvent: (raw) => raw.parsed,
      planMedia: () => ({ needsFetch: true, url: 'http://example.invalid/a.gif', filename: 'a.gif', ext: 'gif' }),
      sendReply: async ({ text }) => {
        sent.push(text);
        return { sent: 1, failed: 0 };
      },
      chatKeyOf: () => CHAT_KEY,
      transcribe: async () => ({ ok: false, text: '', reason: 'not_configured' }),
    },
  });
  return { pipeline, sent, runCalls };
}

function eventOf(message) {
  return { parsed: { kind: 'message', message } };
}

test('pipeline /收藏：收下这条会话最近一张图，回执报第几张与备注', async () => {
  const root = await tempRoot();
  const image = await writeImage(root, 'a.gif', gifBytes('chat'));
  const h = makeHarness({ rootDir: root, images: [{ path: image, data: { sub_type: 1 } }] });

  await h.pipeline.handleEvent(eventOf(messageOf({ text: '/收藏 笑死我了', images: [{ path: image, data: { sub_type: 1 } }] })));

  assert.equal(h.runCalls.length, 0, '命令不该进 DSH');
  assert.deepEqual(h.sent, ['收下了（第 1 张）：笑死我了']);
  assert.deepEqual(readStickerIndex({ rootDir: root }).map((entry) => entry.note), ['笑死我了']);
});

test('pipeline /收藏：备注为空写「无备注」，没有最近的图时给人话', async () => {
  const root = await tempRoot();
  const image = await writeImage(root, 'a.png', pngBytes('chat'));
  const h = makeHarness({ rootDir: root, images: [{ path: image }] });

  await h.pipeline.handleEvent(eventOf(messageOf({ text: '/存表情', images: [{ path: image }] })));
  assert.equal(h.sent[0], '收下了（第 1 张）：无备注');

  // 新会话没发过图：不能凭空收一张
  const other = makeHarness({ rootDir: root });
  await other.pipeline.handleEvent(eventOf(messageOf({ text: '/收藏 这张' })));
  assert.match(other.sent[0], /还没收到过图/u);
});

test('pipeline /收藏：同一张图再收一次说「已经收过了」', async () => {
  const root = await tempRoot();
  const image = await writeImage(root, 'a.gif', gifBytes('same'));
  const h = makeHarness({ rootDir: root, images: [{ path: image }, { path: image }] });

  await h.pipeline.handleEvent(eventOf(messageOf({ text: '/收藏 第一次', images: [{ path: image }] })));
  await h.pipeline.handleEvent(eventOf(messageOf({ text: '/收藏 第二次', images: [{ path: image }] })));

  assert.deepEqual(h.sent, ['收下了（第 1 张）：第一次', '这张已经收过了（第 1 张）：第一次']);
  assert.equal(readStickerIndex({ rootDir: root }).length, 1);
});

test('pipeline /表情：按「序号. 备注 · id前6位」列出最近 10 张', async () => {
  const root = await tempRoot();
  const ids = [];
  for (let index = 0; index < 12; index += 1) {
    const added = await addSticker({
      rootDir: root,
      sourcePath: await writeImage(root, 's' + index + '.png', pngBytes('S' + index)),
      note: '表情' + index,
      now: 1000 + index,
    });
    ids.push(added.entry.id);
  }

  const h = makeHarness({ rootDir: root });
  await h.pipeline.handleEvent(eventOf(messageOf({ text: '/表情' })));

  const lines = h.sent[0].split('\n');
  assert.equal(lines.length, 11, h.sent[0]); // 10 条 + 一行提示
  assert.equal(lines[0], '1. 表情11 · ' + ids[11].slice(0, 6));
  assert.equal(lines[9], '10. 表情2 · ' + ids[2].slice(0, 6));
});

test('pipeline /删表情：按序号删掉并回执剩余张数', async () => {
  const root = await tempRoot();
  await addSticker({ rootDir: root, sourcePath: await writeImage(root, 'a.png', pngBytes('A')), note: '旧的', now: 1000 });
  await addSticker({ rootDir: root, sourcePath: await writeImage(root, 'b.png', pngBytes('B')), note: '新的', now: 2000 });

  const h = makeHarness({ rootDir: root });
  await h.pipeline.handleEvent(eventOf(messageOf({ text: '/删表情 1' })));
  assert.deepEqual(h.sent, ['删掉了：新的（库里还剩 1 张）']);
  assert.deepEqual(readStickerIndex({ rootDir: root }).map((entry) => entry.note), ['旧的']);

  await h.pipeline.handleEvent(eventOf(messageOf({ text: '/删表情 9' })));
  assert.match(h.sent[1], /库里没有这一张/u);
  await h.pipeline.handleEvent(eventOf(messageOf({ text: '/删表情' })));
  assert.match(h.sent[2], /要删哪一张/u);
});

test('pipeline 自动收藏：被标成表情包且带文字才收，没文字只留在 media', async () => {
  const root = await tempRoot();
  const marked = await writeImage(root, 'a.gif', gifBytes('auto'));
  const plain = await writeImage(root, 'b.png', pngBytes('plain'));

  const quiet = makeHarness({ rootDir: root, images: [{ path: marked, data: { sub_type: 1 } }] });
  await quiet.pipeline.handleEvent(eventOf(messageOf({ images: [{ path: marked, data: { sub_type: 1 } }] })));
  assert.equal(quiet.runCalls.length, 1);
  assert.equal(readStickerIndex({ rootDir: root }).length, 0, '没有备注不自动收');

  const noisy = makeHarness({ rootDir: root, images: [{ path: plain }] });
  await noisy.pipeline.handleEvent(eventOf(messageOf({ text: '你看这个', images: [{ path: plain }] })));
  assert.equal(readStickerIndex({ rootDir: root }).length, 0, '没被标成表情包的图不自动收');

  const auto = makeHarness({ rootDir: root, images: [{ path: marked, data: { sub_type: 1 } }] });
  await auto.pipeline.handleEvent(eventOf(messageOf({ text: '哈哈哈', images: [{ path: marked, data: { sub_type: 1 } }] })));
  assert.deepEqual(readStickerIndex({ rootDir: root }).map((entry) => [entry.note, entry.source]), [['哈哈哈', 'auto']]);
});

test('pipeline 自动收藏：summary 里带「表情」也认（NapCat 写 [动画表情]）', async () => {
  const root = await tempRoot();
  const image = await writeImage(root, 'a.gif', gifBytes('summary'));
  const h = makeHarness({ rootDir: root, images: [{ path: image, data: { summary: '[动画表情]' } }] });

  await h.pipeline.handleEvent(eventOf(messageOf({ text: '无语', images: [{ path: image, data: { summary: '[动画表情]' } }] })));

  const [entry] = readStickerIndex({ rootDir: root });
  assert.equal(entry.note, '无语');
  assert.equal(entry.animated, true);
  // 顺手收藏不抢回复：这一轮照常交给 DSH
  assert.equal(h.runCalls.length, 1);
  assert.deepEqual(h.sent, ['ANSWER']);
});
