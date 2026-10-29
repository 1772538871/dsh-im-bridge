import { readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { timestampOf } from './lessons.mjs';

/**
 * 对话示例（few-shot）：用户粘进来的真实聊天记录，每轮拼进提示词当少样本。
 * 给例子比写"幽默、毒舌"这类形容词有效——形容词描述风格，例子直接示范风格。
 * 文件是 append-only 的分段格式，每段两位发言人；库空时提示词与之前逐字一致。
 */
export const EXAMPLES_FILE = 'examples.md';
// 单段上限：粘一整屏聊天记录也会把上下文挤爆，所以按段设一条硬线
export const EXAMPLE_MAX_CHARS = 2000;
// 库里最多留 20 段：留得太多，最近几段反而被稀释
export const EXAMPLES_KEEP = 20;
// 每轮最多注入 6 段、每行最多 120 字：示例是陪衬，不是正文
export const EXAMPLES_PROMPT_LIMIT = 6;
export const EXAMPLES_PROMPT_LINE_CHARS = 120;
export const EXAMPLES_SECTION_TITLE = '[对话示例]';
export const EXAMPLES_PROMPT_HINT =
  '下面是我和我兄弟真实聊天时的样子，你回话要像这些例子里的“它”，不要解释这些例子：';

// 发言人前缀：我 = 用户这头，它 / 对方 / 你 = 要学的"它"那头。
// 只在行首认，正文中间出现的"我："不算发言标记。
const SPEAKER_PATTERN = /^(我|它|对方|你)[ \t]*[：:][ \t]*/u;
const MY_SIDE = '我';
const OTHER_SIDE = '它';

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/** 不管用户写成"对方"还是"你"，都落回这两端：提示词里只出现 我 / 它。 */
function speakerSide(label) {
  return label === '我' ? MY_SIDE : OTHER_SIDE;
}

/** 一行怎么落回文件：没有前缀的行（用户粘来的纯文本）原样存，不硬加"我："。 */
function renderLine(line) {
  const speaker = textOf(line && line.speaker);
  const body = textOf(line && line.text);
  return speaker === '' ? body : speaker + '：' + body;
}

/** 用户粘来的原文 -> 分段里的行；一行都没认出发言人时，整段按原文原样存。 */
function linesOfPaste(text) {
  const out = [];
  for (const raw of text.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const hit = SPEAKER_PATTERN.exec(line);
    if (!hit) {
      out.push({ speaker: '', text: line });
      continue;
    }
    out.push({ speaker: speakerSide(hit[1]), text: line.slice(hit[0].length).trim() });
  }
  return out.filter((line) => line.text !== '');
}

/**
 * 整份文件的切法：只认行首的 "## 时间戳"，段内每行按前缀归到两端。
 * 全程保留原文，一个字都不截——裁旧时要靠它原样写回，绝不能拿截断过的读取重写文件。
 */
function parseExamples(text) {
  const entries = [];
  let current = null;
  for (const raw of String(text === undefined || text === null ? '' : text).replace(/\r\n?/gu, '\n').split('\n')) {
    if (/^## /u.test(raw)) {
      current = { when: raw.replace(/^##\s*/u, '').trim(), lines: [] };
      entries.push(current);
      continue;
    }
    if (current === null || raw.trim() === '') continue;
    const line = raw.trim();
    const hit = SPEAKER_PATTERN.exec(line);
    if (!hit) {
      current.lines.push({ speaker: '', text: line });
      continue;
    }
    current.lines.push({ speaker: speakerSide(hit[1]), text: line.slice(hit[0].length).trim() });
  }
  return entries.filter((entry) => entry.lines.length > 0);
}

/** 库超过 EXAMPLES_KEEP 段就删最旧的几段；写回用的全是原文，不是截断版。 */
async function keepLatest(dir) {
  const file = join(dir, 'prompts', EXAMPLES_FILE);
  let raw = '';
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return { ok: true };
  }
  const entries = parseExamples(raw);
  if (entries.length <= EXAMPLES_KEEP) return { ok: true };
  const kept = entries.slice(-EXAMPLES_KEEP);
  const next = kept.map((entry) => '## ' + entry.when + '\n' + entry.lines.map(renderLine).join('\n') + '\n').join('\n');
  try {
    await fsp.writeFile(file, next, 'utf8');
  } catch (error) {
    return { ok: false, error: 'examples.md 写回失败：' + String(error?.message ?? error) };
  }
  return { ok: true, dropped: entries.length - kept.length };
}

/** 追加一段：带时间戳的二级标题 + 原文；粘太长或空内容都不写文件。 */
export async function appendExample({ rootDir = '', text = '', now = Date.now() } = {}) {
  const dir = typeof rootDir === 'string' ? rootDir.trim() : '';
  const body = typeof text === 'string' ? text.trim() : '';
  if (dir === '') return { ok: false, added: 0, error: '还没有数据目录（storage.rootDir 为空），存不下示例' };
  if (body === '') return { ok: false, added: 0, error: '先把几段对话粘进来再点「存成示例」' };
  if (body.length > EXAMPLE_MAX_CHARS) {
    return {
      ok: false,
      added: 0,
      error: '这段对话太长了：最多 ' + EXAMPLE_MAX_CHARS + ' 字，现在 ' + body.length + ' 字。拆成两段再存。'
    };
  }
  const lines = linesOfPaste(body);
  if (lines.length === 0) return { ok: false, added: 0, error: '这段对话里没有可存的内容' };
  const entry = '## ' + timestampOf(now) + '\n' + lines.map(renderLine).join('\n') + '\n\n';
  try {
    await fsp.mkdir(join(dir, 'prompts'), { recursive: true });
    await fsp.appendFile(join(dir, 'prompts', EXAMPLES_FILE), entry, 'utf8');
  } catch (error) {
    return { ok: false, added: 0, error: '写 examples.md 失败：' + String(error?.message ?? error) };
  }
  // 裁旧失败不影响"这一段已经存进去了"：返回成功，把问题挂在 warning 上说人话
  const trimmed = await keepLatest(dir);
  return trimmed.ok ? { ok: true, added: 1 } : { ok: true, added: 1, warning: trimmed.error };
}

/**
 * 读最近 limit 段（新的在前），每行按 maxCharsPerLine 截断——只给拼提示词与页面列表用。
 * 文件不存在、读不动、内容不合法一律当空库返回，绝不抛。
 */
export function readExamples({ rootDir = '', limit = EXAMPLES_PROMPT_LIMIT, maxCharsPerLine = 0, fsImpl = null } = {}) {
  const dir = typeof rootDir === 'string' ? rootDir.trim() : '';
  if (dir === '') return [];
  const read = fsImpl && typeof fsImpl.readFileSync === 'function' ? fsImpl.readFileSync : readFileSync;
  let raw = '';
  try {
    raw = read(join(dir, 'prompts', EXAMPLES_FILE), 'utf8');
  } catch {
    return [];
  }
  let entries;
  try {
    entries = parseExamples(raw);
  } catch {
    return [];
  }
  const want = Number.isInteger(limit) && limit > 0 ? limit : EXAMPLES_PROMPT_LIMIT;
  const cap = Number.isFinite(maxCharsPerLine) && maxCharsPerLine > 0 ? maxCharsPerLine : 0;
  return entries
    .slice(-want)
    .reverse()
    .map((entry) => ({
      when: entry.when,
      lines: entry.lines.map((line) => ({ speaker: line.speaker, text: cap > 0 ? line.text.slice(0, cap) : line.text }))
    }));
}

/** 拼成提示词片段：库空时返回空串，调用方据此整段不出现。 */
export function formatForPrompt(entries) {
  const blocks = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const lines = (Array.isArray(entry && entry.lines) ? entry.lines : []).map(renderLine).filter((line) => line !== '');
    if (lines.length > 0) blocks.push(lines.join('\n'));
  }
  if (blocks.length === 0) return '';
  return EXAMPLES_SECTION_TITLE + '\n' + EXAMPLES_PROMPT_HINT + '\n' + blocks.join('\n\n');
}

/** 清空整个 examples.md；文件本来就不在也算清空成功。 */
export async function clearExamples({ rootDir = '' } = {}) {
  const dir = typeof rootDir === 'string' ? rootDir.trim() : '';
  if (dir === '') return { ok: false, error: '还没有数据目录（storage.rootDir 为空），清不了' };
  try {
    await fsp.rm(join(dir, 'prompts', EXAMPLES_FILE), { force: true });
  } catch (error) {
    return { ok: false, error: '清空 examples.md 失败：' + String(error?.message ?? error) };
  }
  return { ok: true };
}
