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

/** 读整份 lessons.md 用的切法：head 是第一条之前的说明文字，必须原样留着。 */
function splitLessonFile(text) {
  const normalized = String(text === undefined || text === null ? '' : text).replace(/\r\n?/gu, '\n');
  const head = [];
  const blocks = [];
  let current = null;
  for (const line of normalized.split('\n')) {
    if (/^## /u.test(line)) {
      current = { heading: line, lines: [] };
      blocks.push(current);
      continue;
    }
    if (current === null) head.push(line);
    else current.lines.push(line);
  }
  return { head, blocks };
}

/** 设置页「你教过的」：整份列表，正文一个字都不截（截断的是注入用的 readLessonsTail）。 */
export function readLessons({ dataDir = '', fsImpl = null } = {}) {
  const dir = typeof dataDir === 'string' ? dataDir.trim() : '';
  if (dir === '') return { ok: false, error: '还没有数据目录（storage.rootDir 为空）', lessons: [] };
  const read = fsImpl && typeof fsImpl.readFileSync === 'function' ? fsImpl.readFileSync : readFileSync;
  let raw = '';
  try {
    raw = read(join(dir, 'prompts', LESSON_FILE), 'utf8');
  } catch {
    // 一条都还没教过是常态：空列表，不是错误
    return { ok: true, lessons: [], empty: true };
  }
  const { blocks } = splitLessonFile(raw);
  const lessons = blocks.map((block, index) => ({
    index,
    when: String(block.heading).replace(/^##\s*/u, '').trim(),
    body: block.lines.join('\n').trim()
  }));
  return { ok: true, lessons };
}

/**
 * 删掉第 index 条，其余原样写回。
 * 这里绝不能借 readLessonsTail 重写：它把正文截到 200 字，写回去等于把用户教过的话削掉。
 * 所以解析与重写都留在本模块，逐块搬原始标题与正文行。
 */
export async function deleteLessonAt({ dataDir = '', index = 0, fsImpl = null } = {}) {
  const dir = typeof dataDir === 'string' ? dataDir.trim() : '';
  if (dir === '') return { ok: false, error: '还没有数据目录（storage.rootDir 为空），删不了' };
  const wanted = Number(index);
  if (!Number.isInteger(wanted) || wanted < 0) return { ok: false, error: '要删第几条？给一个从 0 开始的序号' };
  const file = join(dir, 'prompts', LESSON_FILE);
  const read = fsImpl && typeof fsImpl.readFileSync === 'function' ? fsImpl.readFileSync : readFileSync;
  const write = fsImpl && typeof fsImpl.writeFile === 'function' ? fsImpl.writeFile : fsp.writeFile;
  let raw = '';
  try {
    raw = read(file, 'utf8');
  } catch {
    return { ok: false, error: '还没有 lessons.md：一条都没教过，没有可删的' };
  }
  const { head, blocks } = splitLessonFile(raw);
  if (blocks.length === 0) return { ok: false, error: '文件里还没有任何一条，没有可删的' };
  if (wanted >= blocks.length) return { ok: false, error: '一共只有 ' + blocks.length + ' 条，没有第 ' + (wanted + 1) + ' 条' };
  const removed = blocks[wanted];
  const kept = blocks.filter((_, i) => i !== wanted);
  const parts = [];
  if (head.some((line) => line.trim() !== '')) parts.push(head.join('\n'));
  for (const block of kept) parts.push(block.heading + '\n' + block.lines.join('\n'));
  const next = parts.join('\n');
  try {
    await write(file, next, 'utf8');
  } catch (error) {
    return { ok: false, error: '写回 lessons.md 失败：' + String(error?.message ?? error) };
  }
  const view = readLessons({ dataDir: dir, fsImpl });
  return {
    ok: true,
    removed: {
      when: String(removed.heading).replace(/^##\s*/u, '').trim(),
      body: removed.lines.join('\n').trim()
    },
    lessons: view.ok ? view.lessons : []
  };
}
