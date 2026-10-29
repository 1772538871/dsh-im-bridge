import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 人格与日记都放在 <数据目录>/prompts/ 下，和角色卡同一个抽屉：
// 用户打开目录就能看见"它记住了什么、它想把自己改成什么样"。
export const PROMPTS_DIR_NAME = 'prompts';
export const PERSONA_FILE = 'persona.md';
export const JOURNAL_FILE = 'journal.md';
export const SUGGESTED_FILE = 'persona.suggested.md';
export const PERSONA_BACKUP_FILE = 'persona.bak.md';

// 提示词里只带最后两条、每条最多 300 字：日记只会越写越长，
// 全量塞进去是为了"记住"而毁掉"这一轮还看得清"。
export const JOURNAL_TAIL_COUNT = 2;
export const JOURNAL_TAIL_CHARS = 300;
// 一次微调最多 5 行：人格卡是给模型每轮读的，改到 20 行就等于没改
export const SUGGESTION_MAX_LINES = 5;

const FIELD_KEY_BULLET = /^\s*[-*·]\s*([^：:]{1,20})[：:]/u;
const FIELD_KEY_HEADING = /^#\s+(\S.*)$/u;

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function textOf(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function normalizeNewlines(value) {
  return textOf(value).replace(/\r\n?/gu, '\n');
}

/** 数据目录 → prompts 目录；没有数据目录就返回空串（调用方据此跳过一切落盘）。 */
export function promptsDirOf(rootDir) {
  const root = textOf(rootDir).trim();
  return root === '' ? '' : join(root, PROMPTS_DIR_NAME);
}

/** 日记条目的时间戳：只到分钟，人看日记不需要秒。 */
export function journalStamp(when = new Date()) {
  const date = when instanceof Date ? when : new Date(when);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return (
    safe.getFullYear() +
    '-' +
    pad2(safe.getMonth() + 1) +
    '-' +
    pad2(safe.getDate()) +
    ' ' +
    pad2(safe.getHours()) +
    ':' +
    pad2(safe.getMinutes())
  );
}

/** 按 `## 标题` 切条：日记只追加，所以"切条"就是"切历史"。 */
export function splitJournalEntries(text) {
  const entries = [];
  let current = null;
  for (const line of normalizeNewlines(text).split('\n')) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) {
      current = { title: heading[1], lines: [] };
      entries.push(current);
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  return entries.map((entry) => {
    const body = entry.lines.join('\n').trim();
    return { title: entry.title, body, text: body === '' ? '## ' + entry.title : '## ' + entry.title + '\n' + body };
  });
}

/** 取最后 N 条日记，每条截到 maxChars（超了补省略号）。空文件 → 空数组。 */
export function journalTailOf(text, { count = JOURNAL_TAIL_COUNT, maxChars = JOURNAL_TAIL_CHARS } = {}) {
  const limit = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (limit === 0) return [];
  const entries = splitJournalEntries(text);
  const tail = entries.slice(Math.max(0, entries.length - limit));
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  return tail.map((entry) => {
    if (cap === 0 || entry.text.length <= cap) return entry.text;
    return entry.text.slice(0, cap).replace(/\s+$/u, '') + '…';
  });
}

/**
 * 同步读日记尾巴（提示词组装用）：读不到 / 目录没配都返回空数组。
 * 日记读失败绝不能让整轮对话拼不出提示词。
 */
export function readJournalTail({ promptsDir = '', readText = null, count = JOURNAL_TAIL_COUNT, maxChars = JOURNAL_TAIL_CHARS } = {}) {
  const dir = textOf(promptsDir).trim();
  if (dir === '') return [];
  const reader = typeof readText === 'function' ? readText : (file) => readFileSync(file, 'utf8');
  let raw = '';
  try {
    raw = textOf(reader(join(dir, JOURNAL_FILE)));
  } catch {
    return [];
  }
  return journalTailOf(raw, { count, maxChars });
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** 日记正文：去掉模型顺手带的标题和首尾空行，中间空行压成一行。 */
export function cleanEntryBody(body) {
  const kept = [];
  for (const line of normalizeNewlines(body).split('\n')) {
    if (/^#{1,3}\s*/u.test(line)) continue;
    kept.push(line.replace(/\s+$/u, ''));
  }
  return kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

/** 追加一条日记。只追加，永远不改历史条目。 */
export async function appendJournalEntry({ promptsDir = '', body = '', now = new Date() } = {}) {
  const dir = textOf(promptsDir).trim();
  if (dir === '') return { ok: false, reason: '没有数据目录（storage.rootDir 为空）' };
  const text = cleanEntryBody(body);
  if (text === '') return { ok: false, reason: '日记内容为空' };
  try {
    await mkdir(dir, { recursive: true });
    const stamp = journalStamp(now);
    const filePath = join(dir, JOURNAL_FILE);
    // 用户可能自己手写过这个文件，末行未必留空行：补一个，别让新条目黏在上一句后面
    const existing = textOf(await readOptional(filePath));
    const gap = existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    await appendFile(filePath, gap + '## ' + stamp + '\n' + text + '\n\n', 'utf8');
    const lines = text.split('\n').filter((line) => line.trim() !== '').length;
    return { ok: true, path: join(dir, JOURNAL_FILE), stamp, lines };
  } catch (error) {
    return { ok: false, reason: error && error.message ? String(error.message) : String(error) };
  }
}

/** 人格建议整份覆盖：它表达的是"这一轮想怎么改"，累积多条只会越改越乱。 */
export async function writeSuggestedPersona({ promptsDir = '', text = '' } = {}) {
  const dir = textOf(promptsDir).trim();
  if (dir === '') return { ok: false, reason: '没有数据目录（storage.rootDir 为空）' };
  const body = normalizeNewlines(text).trim();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, SUGGESTED_FILE), body === '' ? '' : body + '\n', 'utf8');
    const lines = body === '' ? 0 : body.split('\n').filter((line) => line.trim() !== '').length;
    return { ok: true, path: join(dir, SUGGESTED_FILE), lines, empty: body === '' };
  } catch (error) {
    return { ok: false, reason: error && error.message ? String(error.message) : String(error) };
  }
}

export async function readSuggestedPersona({ promptsDir = '' } = {}) {
  const dir = textOf(promptsDir).trim();
  if (dir === '') return '';
  return textOf(await readOptional(join(dir, SUGGESTED_FILE)));
}

export async function readPersona({ promptsDir = '' } = {}) {
  const dir = textOf(promptsDir).trim();
  if (dir === '') return '';
  return textOf(await readOptional(join(dir, PERSONA_FILE)));
}

/** 一行属于哪个"字段"：`# 角色名` 和 `- 说话风格：…` 都算，其余行算散记（永不互相覆盖）。 */
export function fieldKeyOf(line) {
  const source = textOf(line);
  const heading = FIELD_KEY_HEADING.exec(source);
  if (heading !== null) return '#' + heading[1].trim();
  const bullet = FIELD_KEY_BULLET.exec(source);
  if (bullet !== null) return 'field:' + bullet[1].trim();
  return '';
}

/**
 * 人格合并：同名字段替换、新字段追加，其余内容（用户自己写的备注、注释）一个字都不动。
 * 整份覆盖会把用户手写的人格抹掉，那是最不能接受的一种"聪明"。
 */
export function mergePersonaText({ personaText = '', suggestionText = '' } = {}) {
  const personaLines = normalizeNewlines(personaText).split('\n');
  const suggestionLines = normalizeNewlines(suggestionText)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  let replaced = 0;
  const appended = [];
  for (const line of suggestionLines) {
    const key = fieldKeyOf(line);
    if (key !== '') {
      const index = personaLines.findIndex((existing) => fieldKeyOf(existing) === key);
      if (index !== -1) {
        if (personaLines[index].trim() !== line) {
          personaLines[index] = line;
          replaced += 1;
        }
        continue;
      }
    } else if (personaLines.some((existing) => existing.trim() === line)) {
      continue; // 同一句话已经在了，不重复追加
    }
    appended.push(line);
  }

  const base = personaLines.join('\n').replace(/\s+$/u, '');
  const tail = appended.join('\n');
  const merged = tail === '' ? base + '\n' : (base === '' ? '' : base + '\n') + tail + '\n';
  return { text: merged, replaced, appended: appended.length, changed: replaced + appended.length };
}

/**
 * /采纳：先备份 persona.md 再覆盖，合并走字段规则。
 * 备份一定先落盘——写一半失败时用户手里还有原件。
 */
export async function adoptSuggestedPersona({ promptsDir = '' } = {}) {
  const dir = textOf(promptsDir).trim();
  if (dir === '') return { ok: false, reason: 'no-dir' };
  const suggestion = textOf(await readOptional(join(dir, SUGGESTED_FILE)));
  if (suggestion.trim() === '') return { ok: false, reason: 'empty' };
  const persona = textOf(await readOptional(join(dir, PERSONA_FILE)));
  const merged = mergePersonaText({ personaText: persona, suggestionText: suggestion });
  if (merged.changed === 0) return { ok: true, ...merged, backupPath: '', path: join(dir, PERSONA_FILE) };
  const backupPath = join(dir, PERSONA_BACKUP_FILE);
  try {
    await writeFile(backupPath, persona, 'utf8');
    await writeFile(join(dir, PERSONA_FILE), merged.text, 'utf8');
  } catch (error) {
    return { ok: false, reason: error && error.message ? String(error.message) : String(error) };
  }
  return { ok: true, ...merged, backupPath, path: join(dir, PERSONA_FILE) };
}

function sectionsOf(text) {
  const sections = [{ title: '', lines: [] }];
  let current = sections[0];
  for (const line of normalizeNewlines(text).split('\n')) {
    const heading = /^#{1,3}\s*(.+?)\s*$/u.exec(line);
    if (heading !== null) {
      current = { title: heading[1], lines: [] };
      sections.push(current);
      continue;
    }
    current.lines.push(line);
  }
  return sections;
}

/**
 * 内省输出解析：只认 `## 日记` 和 `## 人格微调` 两段。
 * 微调只收"字段行"（- 名称：值 / # 标题）：散文一旦并进人格卡就成了噪音。
 */
export function parseIntrospection(replyText) {
  const sections = sectionsOf(replyText);
  const diarySection = sections.find((section) => /日记/u.test(section.title)) ?? null;
  const suggestSection = sections.find((section) => /人格|微调/u.test(section.title)) ?? null;

  const diary = diarySection === null ? '' : cleanEntryBody(diarySection.lines.join('\n'));
  const candidates = suggestSection === null ? [] : suggestSection.lines.map((line) => line.trim());
  const fields = [];
  const seen = new Set();
  for (const line of candidates) {
    if (line === '' || fieldKeyOf(line) === '') continue;
    const key = fieldKeyOf(line);
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push(line);
    if (fields.length >= SUGGESTION_MAX_LINES) break;
  }

  return {
    diary,
    diaryLines: diary === '' ? 0 : diary.split('\n').filter((line) => line.trim() !== '').length,
    suggestion: fields.join('\n'),
    suggestionLines: fields,
  };
}

function cardBodyOf(personaText) {
  return normalizeNewlines(personaText)
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim();
}

const TURN_TEXT_CHARS = 400;

/**
 * 内省提示词：这是"一个人复盘"，不是"接着聊天"。
 * 独立成一条，是因为普通对话提示词里每一条要求（发 QQ、用 ·、简洁）都会把它拉回客服腔。
 */
export function buildIntrospectionPrompt({ recent = [], persona = '', journal = [], now = new Date() } = {}) {
  const lines = [
    '现在没有人跟你说话：你在自己一个人的时候回过头看刚才那一段。',
    '不要扮演用户，也不要替用户说话；只写你自己的日记，和你对自己人格的微调。',
    '不要复述对话原文（别抄句子），也别编造没发生的事；用你自己的话写。',
    '',
    '只输出下面两段，别写别的话：',
    '## 日记',
    '（3–5 行，第一人称，写你刚才真实的感受、哪儿卡住了、下次想怎么做）',
    '## 人格微调',
    '（最多 5 行，每行一条改写建议，写成「- 说话风格：少用感叹号」这种字段行；这次没什么要改就留空）',
  ];

  const card = cardBodyOf(persona);
  if (card !== '') lines.push('', '[我现在的角色卡]', card);

  const tail = Array.isArray(journal) ? journal.filter((item) => textOf(item).trim() !== '') : [];
  if (tail.length > 0) lines.push('', '[最近写下的日记]', tail.join('\n\n'));

  const turns = Array.isArray(recent) ? recent : [];
  if (turns.length > 0) {
    lines.push('', '[刚才这些对话]', '现在是 ' + journalStamp(now) + '，一共 ' + turns.length + ' 轮：');
    for (const turn of turns) {
      const user = textOf(turn && turn.user).replace(/\s+/gu, ' ').trim();
      const assistant = textOf(turn && turn.assistant).replace(/\s+/gu, ' ').trim();
      if (user !== '') lines.push('对方：' + user.slice(0, TURN_TEXT_CHARS));
      if (assistant !== '') lines.push('我：' + assistant.slice(0, TURN_TEXT_CHARS));
    }
  } else {
    lines.push('', '[刚才这些对话]', '（还没有可回顾的对话，就写一句"今天还没聊上"，人格微调留空）');
  }

  return lines.join('\n');
}
