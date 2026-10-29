import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACK_TONES,
  DEFAULT_ACK_TONE,
  PHRASE_MAX_CHARS,
  createPipeline,
  pickLine,
  toneLines,
  toneOf,
} from '../src/pipeline.mjs';
import {
  JOURNAL_FILE,
  PERSONA_BACKUP_FILE,
  PERSONA_FILE,
  SUGGESTED_FILE,
  adoptSuggestedPersona,
  appendJournalEntry,
  buildIntrospectionPrompt,
  journalTailOf,
  mergePersonaText,
  parseIntrospection,
  readSuggestedPersona,
  splitJournalEntries,
  writeSuggestedPersona,
} from '../src/journal.mjs';
import { JOURNAL_SECTION_TITLE, buildPrompt } from '../src/prompt.mjs';
import { commandAdoptMissingText, commandHelpText, commandJournalDoneText, parseCommand } from '../src/commands.mjs';

const TONE_IDS = Object.keys(ACK_TONES);
// 第一轮的 sessionId 也是 null（还没绑定），只能靠提示词认出内省那一次
const isIntrospection = (call) => typeof call.prompt === 'string' && call.prompt.includes('不要扮演用户');
const MACHINE_TALK = /预计|已用|秒|立刻|发结果|分钟|·|•|^\s*[-*+]/u;

async function makeDataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-persona-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makePromptsDir(t) {
  const dir = await makeDataDir(t);
  const prompts = join(dir, 'prompts');
  await mkdir(prompts, { recursive: true });
  return { dir, prompts };
}

function makeLogger(warnings) {
  const logger = {
    info() {},
    warn(message, meta) {
      warnings.push({ message, meta });
    },
    error() {},
    debug() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function makePipeline({
  dataDir = '',
  reply = {},
  journal = {},
  text = '你好',
  segments = null,
  mediaPlan = null,
  random = 0.5,
  runDsh,
} = {}) {
  const sent = [];
  const runCalls = [];
  const warnings = [];
  const pipeline = createPipeline({
    config: {
      dsh: { cwd: 'E:/work', runner: 'inprocess', newSessionPerMessage: false },
      storage: { rootDir: dataDir, maxFileBytes: 1 << 20 },
      security: { userWhitelist: [], allowPrivate: true, allowGroup: true, groupRequireAt: false },
      reply: { maxChunkChars: 1500, errorPrefix: '[b] ', ack: false, ackMinSeconds: 0, progressEveryMs: 0, progressMax: 0, ...reply },
      journal,
    },
    logger: makeLogger(warnings),
    client: {
      async call() {
        return { data: { url: 'https://example.test/a.png' } };
      },
    },
    storage: {
      rootDir: dataDir,
      maxFileBytes: 1 << 20,
      async saveFromUrl() {
        return { path: 'E:/tmp/saved.png', bytes: 12 };
      },
    },
    guard: { decide: () => ({ allow: true, reason: 'ok' }) },
    serial: { async run(_key, fn) { return await fn(); }, pending: () => 0, size: () => 0 },
    semaphore: { async withPermit(fn) { return await fn(); }, active: () => 0 },
    sessions: { get: async () => null, set: async () => {}, clear: async () => {} },
    runDsh: async (args) => {
      runCalls.push(args);
      return await runDsh(args);
    },
    deps: {
      parseEvent: () => ({
        kind: 'message',
        message: {
          messageId: 'M1',
          chatType: 'private',
          userId: 'u1',
          groupId: null,
          selfId: '0',
          text,
          segments: segments ?? [{ type: 'text', data: { text } }],
          atTargets: [],
          replyTo: null,
        },
      }),
      planMedia: () => mediaPlan,
      sendReply: async ({ text: out }) => {
        sent.push(out);
        return { sent: 1, failed: 0 };
      },
      chatKeyOf: () => 'private_u1',
      random,
    },
  });
  return { pipeline, sent, runCalls, warnings };
}

// ---------------------------------------------------------------- 句池

test('句池：两套口吻的三组句子都够用，每句不超过 12 字', () => {
  for (const tone of TONE_IDS) {
    const pools = ACK_TONES[tone];
    assert.ok(pools.short.length >= 6, tone + ' 短任务池至少 6 句');
    assert.ok(pools.long.length >= 6, tone + ' 长任务池至少 6 句');
    assert.ok(pools.progress.length >= 4, tone + ' 进度池至少 4 句');
    for (const kind of ['short', 'long', 'progress']) {
      assert.equal(new Set(pools[kind]).size, pools[kind].length, tone + '/' + kind + ' 池内有重复句');
      for (const line of pools[kind]) {
        assert.equal(typeof line, 'string');
        assert.ok(line.length <= PHRASE_MAX_CHARS, tone + '/' + kind + ' 超过 12 字：' + line);
      }
    }
  }
});

test('句池：不带项目符号，也不提预计/秒数这类机器话', () => {
  for (const tone of TONE_IDS) {
    for (const kind of ['short', 'long', 'progress']) {
      for (const line of ACK_TONES[tone][kind]) {
        assert.equal(MACHINE_TALK.test(line), false, tone + '/' + kind + ' 有机器味：' + line);
        assert.equal(/\d/u.test(line), false, tone + '/' + kind + ' 带数字：' + line);
      }
    }
  }
});

test('口吻：default 是 casual，大小写与写错都能认', () => {
  assert.equal(DEFAULT_ACK_TONE, 'casual');
  assert.equal(toneOf('casual'), 'casual');
  assert.equal(toneOf('PLAIN'), 'plain');
  assert.equal(toneOf('听起来很狠'), 'casual');
  assert.equal(toneOf(undefined), 'casual');
  assert.equal(toneLines('plain', 'short'), ACK_TONES.plain.short);
  assert.equal(toneLines('乱写', 'progress'), ACK_TONES.casual.progress);
});

test('抽句：随机源被卡死也不会连说两句一样', () => {
  const list = ACK_TONES.casual.short;
  let previous = null;
  for (let i = 0; i < 30; i += 1) {
    const line = pickLine(list, { random: () => 0, previous });
    assert.notEqual(line, previous);
    assert.ok(list.includes(line));
    previous = line;
  }
});

test('抽句：最多重抽 3 次，之后退一句保证不同', () => {
  const list = ['第一句', '第二句', '第三句'];
  let calls = 0;
  const line = pickLine(list, {
    random: () => {
      calls += 1;
      return 0;
    },
    previous: '第一句',
    maxTries: 3,
  });
  assert.equal(calls, 3);
  assert.equal(line, '第二句');
});

test('抽句：随机值越界、坏掉、空池都不炸', () => {
  const list = ['甲', '乙'];
  assert.ok(list.includes(pickLine(list, { random: () => 1 })));
  assert.ok(list.includes(pickLine(list, { random: () => -1 })));
  assert.ok(list.includes(pickLine(list, { random: () => Number.NaN })));
  assert.equal(pickLine([], { previous: '' }), '');
});

// ---------------------------------------------------------------- 回执 / 进度

test('回执：ack 关掉时一条都不发（长任务也不发）', async () => {
  const h = makePipeline({
    text: '帮我整理全部资料',
    reply: { ack: false },
    runDsh: async () => ({ ok: true, text: '结果', sessionId: 'S1' }),
  });
  await h.pipeline.handleEvent({});
  assert.deepEqual(h.sent, ['结果']);
});

test('回执：短任务只说一句，不报附件也不报时间', async () => {
  const h = makePipeline({
    text: '你好',
    reply: { ack: true, ackMinSeconds: 0 },
    runDsh: async () => ({ ok: true, text: '结果', sessionId: 'S1' }),
  });
  await h.pipeline.handleEvent({});
  assert.equal(h.sent[0].includes('\n'), false, h.sent[0]);
  assert.equal(/收到|附件/u.test(h.sent[0]), false, h.sent[0]);
  assert.ok(ACK_TONES.casual.short.includes(h.sent[0]), h.sent[0]);
});

test('回执：长任务才捎一句话说附件，而且不再拼项目符号', async () => {
  const h = makePipeline({
    text: '帮我整理全部资料',
    reply: { ack: true, ackMinSeconds: 0 },
    segments: [{ type: 'image', data: { url: 'https://example.test/a.png' } }],
    mediaPlan: { url: 'https://example.test/a.png', filename: 'a.png' },
    runDsh: async () => ({ ok: true, text: '结果', sessionId: 'S1' }),
  });
  await h.pipeline.handleEvent({});
  const lines = h.sent[0].split('\n');
  assert.equal(lines.length, 2, h.sent[0]);
  assert.ok(ACK_TONES.casual.long.includes(lines[0]), lines[0]);
  assert.equal(lines[1], '收到 1 张图片');
  assert.equal(h.sent[0].includes('·'), false, h.sent[0]);
});

test('回执：同一聊天连着两轮不会说同一句（随机源卡死也一样）', async () => {
  const h = makePipeline({
    reply: { ack: true, ackMinSeconds: 0 },
    random: () => 0,
    runDsh: async () => ({ ok: true, text: '结果', sessionId: 'S1' }),
  });
  await h.pipeline.handleEvent({});
  await h.pipeline.handleEvent({});
  const acks = h.sent.filter((item) => ACK_TONES.casual.short.includes(item));
  assert.equal(acks.length, 2, JSON.stringify(h.sent));
  assert.notEqual(acks[0], acks[1]);
});

test('回执：ackTone=plain 时换成中性句池', async () => {
  const h = makePipeline({
    reply: { ack: true, ackMinSeconds: 0, ackTone: 'plain' },
    runDsh: async () => ({ ok: true, text: '结果', sessionId: 'S1' }),
  });
  await h.pipeline.handleEvent({});
  assert.ok(ACK_TONES.plain.short.includes(h.sent[0]), h.sent[0]);
});

test('进度：补报的句子来自进度池、不带秒数，两次不一样', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const h = makePipeline({
    text: '帮我读三本书',
    reply: { ack: true, ackMinSeconds: 0, progressEveryMs: 10000, progressMax: 2 },
    random: () => 0,
    runDsh: () => pending,
  });
  const done = h.pipeline.handleEvent({});
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10000);
  await new Promise((resolve) => setImmediate(resolve));
  release({ ok: true, text: '好了', sessionId: 'S1' });
  await done;
  await new Promise((resolve) => setImmediate(resolve));

  const progress = h.sent.filter((item) => ACK_TONES.casual.progress.includes(item));
  assert.equal(progress.length, 2, JSON.stringify(h.sent));
  assert.notEqual(progress[0], progress[1]);
  for (const line of progress) assert.equal(/\d/u.test(line), false, line);
  assert.equal(h.sent.some((item) => /已用|还在处理/u.test(item)), false, JSON.stringify(h.sent));
});

// ---------------------------------------------------------------- 日记文件

test('日记：连写两条，两条都还在（只追加）', async (t) => {
  const { prompts } = await makePromptsDir(t);
  const first = await appendJournalEntry({ promptsDir: prompts, body: '今天第一次记', now: new Date(2026, 0, 2, 9, 5) });
  const second = await appendJournalEntry({ promptsDir: prompts, body: '今天第二次记', now: new Date(2026, 0, 2, 21, 40) });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const text = await readFile(join(prompts, JOURNAL_FILE), 'utf8');
  assert.ok(text.includes('今天第一次记'), text);
  assert.ok(text.includes('今天第二次记'), text);
  assert.match(text, /^## 2026-01-02 09:05$/m);
  assert.match(text, /^## 2026-01-02 21:40$/m);
});

test('日记：标题是 ## 时间，模型顺手带的标题被剥掉，行数照实报', async (t) => {
  const { prompts } = await makePromptsDir(t);
  const written = await appendJournalEntry({
    promptsDir: prompts,
    body: '## 随便写的标题\n今天被催了三次\n下次先问清楚',
    now: new Date(2026, 0, 3, 10, 0),
  });
  assert.equal(written.ok, true);
  assert.equal(written.lines, 2);
  assert.match(written.stamp, /^2026-01-03 10:00$/u);

  const text = await readFile(join(prompts, JOURNAL_FILE), 'utf8');
  assert.equal(text.includes('随便写的标题'), false, text);
  assert.match(text, /^## 2026-01-03 10:00$/m);
  assert.ok(text.includes('今天被催了三次'));
});

test('日记：追加到用户手写的文件时补一个空行，不粘在上一句后面', async (t) => {
  const { prompts } = await makePromptsDir(t);
  await writeFile(join(prompts, JOURNAL_FILE), '## 2026-01-01 08:00\n手写的一条，末尾没有空行', 'utf8');
  await appendJournalEntry({ promptsDir: prompts, body: '新写的一条', now: new Date(2026, 0, 5, 7, 30) });

  const text = await readFile(join(prompts, JOURNAL_FILE), 'utf8');
  assert.ok(text.includes('末尾没有空行\n\n## 2026-01-05 07:30\n新写的一条'), JSON.stringify(text));
  assert.equal(splitJournalEntries(text).length, 2);
});

test('日记：尾巴只取最后两条，每条截到 300 字', () => {
  const text = [
    '## 2026-01-01 10:00',
    '第一条',
    '## 2026-01-02 10:00',
    '第二条',
    '## 2026-01-03 10:00',
    '第三条',
  ].join('\n');
  const tail = journalTailOf(text, { count: 2, maxChars: 300 });
  assert.equal(tail.length, 2);
  assert.ok(tail[0].includes('第二条'), tail[0]);
  assert.ok(tail[1].includes('第三条'), tail[1]);

  const long = '## 2026-01-04 10:00\n' + 'x'.repeat(400);
  const cut = journalTailOf(long, { count: 1, maxChars: 300 });
  assert.equal(cut[0].length, 301);
  assert.ok(cut[0].endsWith('…'));
});

test('人格建议：整份覆盖，上一轮的建议不会留下来', async (t) => {
  const { prompts } = await makePromptsDir(t);
  await writeSuggestedPersona({ promptsDir: prompts, text: '- 说话风格：上一轮的建议' });
  await writeSuggestedPersona({ promptsDir: prompts, text: '- 说话风格：这一轮的建议' });
  const text = await readSuggestedPersona({ promptsDir: prompts });
  assert.ok(text.includes('这一轮的建议'), text);
  assert.equal(text.includes('上一轮的建议'), false, text);
});

test('采纳：先留 persona.bak.md，再同名字段替换', async (t) => {
  const { prompts } = await makePromptsDir(t);
  const persona = ['<!-- 我自己的备注，别动 -->', '# 小桥', '- 说话风格：很正式', '- 背景设定：住在城里', '自己随手记的一句', ''].join('\n');
  await writeFile(join(prompts, PERSONA_FILE), persona, 'utf8');
  await writeFile(join(prompts, SUGGESTED_FILE), '- 说话风格：更像群里的人\n', 'utf8');

  const outcome = await adoptSuggestedPersona({ promptsDir: prompts });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.replaced, 1);
  assert.equal(outcome.appended, 0);

  const merged = await readFile(join(prompts, PERSONA_FILE), 'utf8');
  assert.ok(merged.includes('- 说话风格：更像群里的人'), merged);
  assert.equal(merged.includes('很正式'), false, merged);
  assert.ok(merged.includes('- 背景设定：住在城里'), merged);
  assert.ok(merged.includes('自己随手记的一句'), merged);
  assert.ok(merged.includes('我自己的备注，别动'), merged);

  const backup = await readFile(join(prompts, PERSONA_BACKUP_FILE), 'utf8');
  assert.equal(backup, persona);
});

test('采纳：新字段追加在末尾，已有的散记一条不丢', () => {
  const merged = mergePersonaText({
    personaText: '# 小桥\n- 说话风格：短\n自己写的备注\n',
    suggestionText: '- 语气强度：偶尔损一句\n- 说话风格：短',
  });
  assert.equal(merged.replaced, 0);
  assert.equal(merged.appended, 1);
  assert.equal(merged.changed, 1);
  assert.ok(merged.text.startsWith('# 小桥\n- 说话风格：短\n自己写的备注\n'), merged.text);
  assert.ok(merged.text.endsWith('- 语气强度：偶尔损一句\n'), merged.text);
});

test('采纳：没有建议文件就说清楚，persona 一个字不动', async (t) => {
  const { prompts } = await makePromptsDir(t);
  const persona = '# 小桥\n- 说话风格：短\n';
  await writeFile(join(prompts, PERSONA_FILE), persona, 'utf8');
  const outcome = await adoptSuggestedPersona({ promptsDir: prompts });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'empty');
  assert.equal(await readFile(join(prompts, PERSONA_FILE), 'utf8'), persona);
  assert.equal(existsSync(join(prompts, PERSONA_BACKUP_FILE)), false);
  assert.match(commandAdoptMissingText(), /\/日记/u);
});

// ---------------------------------------------------------------- 提示词

test('提示词：日记排在角色卡之后，只带最后两条', async (t) => {
  const { dir, prompts } = await makePromptsDir(t);
  await writeFile(join(prompts, PERSONA_FILE), '# 小桥\n- 说话风格：短\n', 'utf8');
  await writeFile(
    join(prompts, JOURNAL_FILE),
    ['## 2026-01-01 10:00', '第一条日记', '## 2026-01-02 10:00', '第二条日记', '## 2026-01-03 10:00', '第三条日记'].join('\n'),
    'utf8',
  );

  const prompt = buildPrompt({ config: { storage: { rootDir: dir } }, message: { text: '在吗' } });
  const personaAt = prompt.indexOf('[角色设定]');
  const journalAt = prompt.indexOf(JOURNAL_SECTION_TITLE);
  assert.ok(personaAt !== -1, prompt);
  assert.ok(journalAt > personaAt, prompt);
  assert.ok(journalAt < prompt.indexOf('[用户消息]'), prompt);
  assert.ok(prompt.includes('第三条日记') && prompt.includes('第二条日记'), prompt);
  assert.equal(prompt.includes('第一条日记'), false, prompt);
});

test('提示词：没有日记就不加这一段（与之前逐字一致）', async (t) => {
  const { dir, prompts } = await makePromptsDir(t);
  await writeFile(join(prompts, PERSONA_FILE), '# 小桥\n- 说话风格：短\n', 'utf8');

  const prompt = buildPrompt({ config: { storage: { rootDir: dir } }, message: { text: '在吗' } });
  assert.ok(prompt.startsWith('[角色设定]'), prompt);
  assert.equal(prompt.includes(JOURNAL_SECTION_TITLE), false, prompt);

  const empty = await makeDataDir(t);
  const plain = buildPrompt({ config: { storage: { rootDir: empty } }, message: { text: '在吗' } });
  assert.ok(plain.startsWith('你正在通过 QQ 与用户对话'), plain);
  assert.equal(plain.includes(JOURNAL_SECTION_TITLE), false, plain);
});

// ---------------------------------------------------------------- 内省

test('内省解析：日记与建议分开，建议只收字段行、最多 5 行', () => {
  const reply = [
    '## 日记',
    '今天被催了三次',
    '下次先把话问清楚',
    '',
    '## 人格微调',
    '- 说话风格：少用感叹号',
    '- 语气强度：偶尔损一句',
    '其实我觉得还行（这行是散文，不该进人格卡）',
    '- 标点习惯：多用逗号',
    '- 语气强度：重复的字段只留一次',
    '- 多余字段一：甲',
    '- 多余字段二：乙',
  ].join('\n');
  const parsed = parseIntrospection(reply);
  assert.equal(parsed.diaryLines, 2);
  assert.ok(parsed.diary.includes('今天被催了三次'), parsed.diary);
  assert.equal(parsed.suggestion.includes('其实我觉得还行'), false, parsed.suggestion);
  assert.equal(parsed.suggestionLines.length, 5);
  assert.equal(parsed.suggestionLines.filter((line) => line.startsWith('- 语气强度')).length, 1);
});

test('内省提示词：写明不扮演用户、不复述原文，并带上最近的对话', () => {
  const prompt = buildIntrospectionPrompt({
    recent: [{ user: '帮我读三本书', assistant: '行吧，我看看' }],
    persona: '# 小桥\n- 说话风格：短',
    journal: ['## 2026-01-01 10:00\n昨天有点累'],
    now: new Date(2026, 0, 4, 8, 30),
  });
  assert.ok(prompt.includes('不要扮演用户'), prompt);
  assert.ok(prompt.includes('别抄句子'), prompt);
  assert.ok(prompt.includes('## 日记') && prompt.includes('## 人格微调'), prompt);
  assert.ok(prompt.includes('帮我读三本书'), prompt);
  assert.ok(prompt.includes('昨天有点累'), prompt);
  assert.ok(prompt.includes('2026-01-04 08:30'), prompt);
});

// ---------------------------------------------------------------- 命令与自动日记

test('命令：/日记 /写日记 /采纳 都认，帮助里也写了', () => {
  assert.deepEqual(parseCommand('/日记'), { name: 'journal', args: '' });
  assert.deepEqual(parseCommand('/写日记'), { name: 'journal', args: '' });
  assert.deepEqual(parseCommand('/采纳'), { name: 'adopt', args: '' });
  const help = commandHelpText({ sessionId: null });
  assert.ok(help.includes('/日记') && help.includes('/采纳'), help);
  assert.ok(help.split('\n').length <= 4, help);
  assert.match(commandJournalDoneText({ diaryLines: 3, suggestionLines: 2 }), /日记 \+3 行；人格建议 2 条/u);
  assert.match(commandJournalDoneText({ diaryLines: 3, suggestionLines: 0 }), /没有想改自己的地方/u);
});

test('/日记：真跑一次内省，日记落盘、建议覆盖、回执说人话', async (t) => {
  const { dir } = await makePromptsDir(t);
  const introspection = [
    '## 日记',
    '今天被催了三次，还是先把话说清楚',
    '下次别急着应',
    '写下来反而清楚了',
    '## 人格微调',
    '- 说话风格：少用感叹号',
  ].join('\n');
  const h = makePipeline({
    dataDir: dir,
    text: '/日记',
    runDsh: async () => ({ ok: true, text: introspection, sessionId: 'SJ' }),
  });
  await h.pipeline.handleEvent({});

  const journalText = await readFile(join(dir, 'prompts', JOURNAL_FILE), 'utf8');
  assert.ok(journalText.includes('今天被催了三次'), journalText);
  assert.match(journalText, /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
  const suggested = await readFile(join(dir, 'prompts', SUGGESTED_FILE), 'utf8');
  assert.ok(suggested.includes('- 说话风格：少用感叹号'), suggested);

  const receipt = h.sent.at(-1);
  assert.match(receipt, /日记 \+3 行/u);
  assert.match(receipt, /人格建议 1 条/u);
  assert.ok(receipt.includes('/采纳'), receipt);

  assert.equal(h.runCalls.length, 1);
  assert.equal(h.runCalls[0].sessionId, null);
  assert.ok(h.runCalls[0].prompt.includes('不要扮演用户'), h.runCalls[0].prompt);
});

test('/采纳：合并人格、留备份，回执照实说改了几行', async (t) => {
  const { dir, prompts } = await makePromptsDir(t);
  const persona = '# 小桥\n- 说话风格：很正式\n- 背景设定：住在城里\n';
  await writeFile(join(prompts, PERSONA_FILE), persona, 'utf8');
  await writeFile(join(prompts, SUGGESTED_FILE), '- 说话风格：更像群里的人\n- 语气强度：偶尔损一句\n', 'utf8');

  const h = makePipeline({
    dataDir: dir,
    text: '/采纳',
    runDsh: async () => {
      throw new Error('/采纳 不该跑模型');
    },
  });
  await h.pipeline.handleEvent({});
  assert.equal(h.runCalls.length, 0);

  const merged = await readFile(join(prompts, PERSONA_FILE), 'utf8');
  assert.ok(merged.includes('- 说话风格：更像群里的人'), merged);
  assert.ok(merged.includes('- 语气强度：偶尔损一句'), merged);
  assert.ok(merged.includes('- 背景设定：住在城里'), merged);

  const receipt = h.sent.at(-1);
  assert.match(receipt, /替换 1 行/u);
  assert.match(receipt, /新增 1 行/u);
  assert.ok(receipt.includes('persona.bak.md'), receipt);
  assert.equal(await readFile(join(prompts, PERSONA_BACKUP_FILE), 'utf8'), persona);
});

test('everyTurns=1：回复发出后自动内省，只落文件不打扰用户', async (t) => {
  const { dir } = await makePromptsDir(t);
  const h = makePipeline({
    dataDir: dir,
    journal: { everyTurns: 1 },
    runDsh: async (call) =>
      isIntrospection(call)
        ? { ok: true, text: '## 日记\n这轮聊得还行\n## 人格微调\n', sessionId: 'SJ' }
        : { ok: true, text: 'ANSWER', sessionId: 'S1' },
  });
  await h.pipeline.handleEvent({});
  assert.deepEqual(h.sent, ['ANSWER']);
  await h.pipeline.settle();

  const journalText = await readFile(join(dir, 'prompts', JOURNAL_FILE), 'utf8');
  assert.ok(journalText.includes('这轮聊得还行'), journalText);
  assert.deepEqual(h.sent, ['ANSWER'], '自动日记不该多发一条消息');
  assert.equal(h.runCalls.length, 2);
});

test('everyTurns=2：第一轮不写、第二轮才写', async (t) => {
  const { dir } = await makePromptsDir(t);
  const h = makePipeline({
    dataDir: dir,
    journal: { everyTurns: 2 },
    runDsh: async (call) =>
      isIntrospection(call) ? { ok: true, text: '## 日记\n第二轮才该写\n' } : { ok: true, text: 'ANSWER', sessionId: 'S1' },
  });
  await h.pipeline.handleEvent({});
  await h.pipeline.settle();
  assert.equal(existsSync(join(dir, 'prompts', JOURNAL_FILE)), false);

  await h.pipeline.handleEvent({});
  await h.pipeline.settle();
  const journalText = await readFile(join(dir, 'prompts', JOURNAL_FILE), 'utf8');
  assert.ok(journalText.includes('第二轮才该写'), journalText);
  assert.equal(h.runCalls.filter(isIntrospection).length, 1);
});

test('everyTurns 失败：只记 warn，用户照常拿到结果、日记不写', async (t) => {
  const { dir } = await makePromptsDir(t);
  const h = makePipeline({
    dataDir: dir,
    journal: { everyTurns: 1 },
    runDsh: async (call) => (isIntrospection(call) ? { ok: false, reason: 'timeout' } : { ok: true, text: 'ANSWER', sessionId: 'S1' }),
  });
  await h.pipeline.handleEvent({});
  await h.pipeline.settle();

  assert.deepEqual(h.sent, ['ANSWER']);
  assert.equal(existsSync(join(dir, 'prompts', JOURNAL_FILE)), false);
  assert.ok(
    h.warnings.some((item) => String(item.message).includes('自动写日记没成功')),
    JSON.stringify(h.warnings),
  );
});
