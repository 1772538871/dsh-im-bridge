import { readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

/** 用户"手把手教"的条目：和日记分开存，因为它要每轮都进上下文，不能太长。 */
export const LESSON_FILE = 'lessons.md';
export const LESSON_TAIL_COUNT = 12;
export const LESSON_MAX_CHARS = 200;

// 这些话是在教我，不是让我干活
const TEACH_PATTERN = /^(记住|记一下|记好|教你(一下)?|我教你|你要记住|以后(你)?要|以后(你)?别|下次(你)?(就)?(这样)?(回|说)|这种时候(你)?(就)?(说|回)|正确的(回法|说法)是)/u;

export function isTeaching(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value === '') return false;
  return TEACH_PATTERN.test(value);
}

/** 只保留"教了什么"：把开头那句指令词去掉，剩下的才是要背的内容。 */
export function lessonBody(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value === '') return '';
  return value.replace(TEACH_PATTERN, '').replace(/^[：:，,\s]+/u, '').trim();
}

export function timestampOf(now) {
  const date = new Date(typeof now === 'number' ? now : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** 追加一条：带时间戳的二级标题 + 一行正文。文件不存在就建。 */
export async function appendLesson({ dataDir = '', text = '', now = Date.now() } = {}) {
  const dir = typeof dataDir === 'string' ? dataDir.trim() : '';
  const body = lessonBody(text);
  if (dir === '' || body === '') return { ok: false, error: '没有可记的内容' };
  const file = join(dir, 'prompts', LESSON_FILE);
  const entry = '## ' + timestampOf(now) + '\n' + body + '\n\n';
  try {
    await fsp.mkdir(join(dir, 'prompts'), { recursive: true });
    await fsp.appendFile(file, entry, 'utf8');
    return { ok: true, file, body };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 取最后 N 条（每条正文截断），供提示词注入。读不到就返回空数组。 */
export function readLessonsTail({ dataDir = '', count = LESSON_TAIL_COUNT, maxChars = LESSON_MAX_CHARS, fsImpl = null } = {}) {
  const dir = typeof dataDir === 'string' ? dataDir.trim() : '';
  if (dir === '') return [];
  const read = fsImpl && typeof fsImpl.readFileSync === 'function' ? fsImpl.readFileSync : readFileSync;
  let raw = '';
  try {
    raw = read(join(dir, 'prompts', LESSON_FILE), 'utf8');
  } catch {
    return [];
  }
  const blocks = String(raw).split(/^## /mu).slice(1);
  const out = [];
  for (const block of blocks.slice(-count)) {
    const lines = block.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const when = lines.shift() ?? '';
    const body = lines.join(' ').slice(0, maxChars);
    if (body !== '') out.push({ when, body });
  }
  return out;
}
