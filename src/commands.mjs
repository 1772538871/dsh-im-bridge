import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

// 命令只吃杠开头的一行；中文同义词是刚需——QQ 里打 /新会话 比切输入法打 /new 顺手
const COMMANDS = new Map([
  ['new', 'new'],
  ['新会话', 'new'],
  ['status', 'status'],
  ['状态', 'status'],
  ['export', 'export'],
  ['导出', 'export'],
  ['help', 'help'],
  ['帮助', 'help'],
  // 人格那一套：日记是它自己写的，采纳才轮到它改自己
  ['日记', 'journal'],
  ['写日记', 'journal'],
  ['采纳', 'adopt']
]);

const ROLE_TITLE = { user: '用户', assistant: 'DSH' };
const SAFE_CWD_CHAR = /^[A-Za-z0-9._-]$/;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function messageOf(error) {
  return error && error.message ? String(error.message) : String(error);
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatDateTime(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function formatStamp(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

/** 解析一行命令；不是命令（或者是不认识的命令）一律返回 null，让它照常走 DSH。 */
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  // 中文输入法打出的是全角斜杠：不认它，用户会以为命令坏了
  const normalized = trimmed.startsWith('／') ? '/' + trimmed.slice(1) : trimmed;
  if (!normalized.startsWith('/')) return null;
  const rest = normalized.slice(1).trim();
  if (rest === '') return null;
  const parts = rest.split(/\s+/);
  const name = COMMANDS.get(parts[0].toLowerCase());
  if (!name) return null;
  return { name, args: parts.slice(1).join(' ').trim() };
}

/** 会话 id 前 8 位。先去 session- 前缀，否则每个人看到的都是同一个 "session-"。 */
export function shortSessionId(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (id === '') return '';
  const body = id.startsWith('session-') ? id.slice('session-'.length) : id;
  return body.slice(0, 8);
}

export function commandHelpText({ sessionId = null } = {}) {
  const id = shortSessionId(sessionId);
  return [
    '可用命令（发在 QQ 里，不送进 DSH）：',
    '/new 开新会话 · /status 看状态 · /export 导出历史 · /日记 让它写日记 · /采纳 应用人格建议 · /help 看这张表',
    '中文同义词：/新会话 /状态 /导出 /帮助；/写日记 等同 /日记',
    id === '' ? '当前会话：还没建（发一句话就有了）' : '当前会话：' + id
  ].join('\n');
}

export function commandNewSessionText(previousSessionId = null) {
  const old = shortSessionId(previousSessionId);
  return old === '' ? '已开新会话，下一条消息开始生效。' : '已开新会话，下一条消息开始生效（上一次是 ' + old + '）。';
}

function durationText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '还没跑过';
  if (ms < 1000) return Math.round(ms) + ' 毫秒';
  return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' 秒';
}

export function commandStatusText({
  platform = 'unknown',
  runner = 'headless',
  sessionId = null,
  lastDurationMs = null,
  approvalPending = 0,
  questionPending = 0
} = {}) {
  const id = shortSessionId(sessionId);
  const lines = [
    '平台 ' + platform + ' · 跑法 ' + runner,
    '会话 ' + (id === '' ? '还没建（发一句话就有了）' : id),
    '最近一轮 ' + durationText(lastDurationMs)
  ];
  const waiting = [];
  if (Number(approvalPending) > 0) waiting.push('审批 ' + Math.floor(approvalPending) + ' 个');
  if (Number(questionPending) > 0) waiting.push('提问 ' + Math.floor(questionPending) + ' 个');
  // 没有挂起就不出现这一行：状态里最怕"没东西也在报"
  if (waiting.length > 0) lines.push('正在等：' + waiting.join(' · '));
  return lines.join('\n');
}

/** /日记 的回执：说了几行日记、提了几条建议，下一句永远是"发 /采纳 就应用"。 */
export function commandJournalDoneText({ diaryLines = 0, suggestionLines = 0 } = {}) {
  const diary = Number(diaryLines) > 0 ? '日记 +' + Math.floor(diaryLines) + ' 行' : '这次没写进日记';
  if (Number(suggestionLines) > 0) {
    return '写好了，' + diary + '；人格建议 ' + Math.floor(suggestionLines) + ' 条，发 /采纳 就应用。';
  }
  return '写好了，' + diary + '；这次没有想改自己的地方。';
}

/** 功能型提示：写不成要说清原因，别为了"像人"把它含糊掉。 */
export function commandJournalFailedText(reason) {
  return '这次日记没写成：' + (reason === undefined || reason === null || reason === '' ? '原因不明' : String(reason));
}

export function commandAdoptDoneText({ replaced = 0, appended = 0, backupPath = '' } = {}) {
  const oldCount = Math.floor(Number(replaced) || 0);
  const newCount = Math.floor(Number(appended) || 0);
  if (oldCount + newCount === 0) return '人格卡没有要改的地方，一个字都没动。';
  // 只说真的发生过的动作：念一句"新增 0 行"就又回到报表腔了
  const parts = [];
  if (oldCount > 0) parts.push('替换 ' + oldCount + ' 行');
  if (newCount > 0) parts.push('新增 ' + newCount + ' 行');
  const lines = ['改好了：' + parts.join('，') + '。'];
  if (typeof backupPath === 'string' && backupPath !== '') lines.push('改之前的版本备份在：' + backupPath);
  return lines.join('\n');
}

export function commandAdoptMissingText() {
  return '还没有可采纳的人格建议：先发 /日记，我写一篇给你看看。';
}

export function commandExportDoneText({ path = '', count = 0 } = {}) {
  return '已导出 ' + count + ' 条消息：\n' + path;
}

export function commandExportFailedText(reason) {
  return '这次没导出成：' + (reason === undefined || reason === null || reason === '' ? '原因不明' : String(reason));
}

export function defaultDshHome(env = process.env) {
  const fromEnv = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh');
}

/**
 * DSH 的会话目录名：cwd 逐字符编码，[A-Za-z0-9._-] 原样保留，
 * 其余 ASCII 换 "-"（连续的只留一个，"C:\" 就成了 "C-"），
 * 非 ASCII 换 "~XXXX"（码点的 4 位大写十六进制），两头各包 "--"。
 * 实测：E:\dsh\dsh-bot-msg → --E-dsh-dsh-bot-msg--；C:\ → --C---；
 *      E:\每日信息合集 → --E-~6BCF~65E5~4FE1~606F~5408~96C6--
 */
export function encodeCwdSegment(cwd) {
  let out = '';
  let dashed = false;
  for (const ch of String(cwd === undefined || cwd === null ? '' : cwd)) {
    if (SAFE_CWD_CHAR.test(ch)) {
      out += ch;
      dashed = false;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      dashed = false;
      continue;
    }
    if (!dashed) {
      out += '-';
      dashed = true;
    }
  }
  return '--' + out + '--';
}

function logPathIn(dir, sessionId) {
  return join(dir, sessionId, 'session.v4.jsonl.zstd');
}

/**
 * 先按 cwd 编码直算，算不出来再扫一遍 sessions 根目录。
 * 编码规则哪天跟着 DSH 版本变了，扫一遍仍然找得到，不至于让 /export 直接报废。
 */
export function findSessionLog({ dshHome = '', cwd = '', sessionId = '' } = {}) {
  const home = typeof dshHome === 'string' && dshHome !== '' ? dshHome : defaultDshHome();
  const id = typeof sessionId === 'string' ? sessionId : '';
  if (home === '' || id === '') return '';
  const root = join(home, 'sessions');
  if (typeof cwd === 'string' && cwd !== '') {
    const direct = logPathIn(join(root, encodeCwdSegment(cwd)), id);
    if (existsSync(direct)) return direct;
  }
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return '';
  }
  for (const dir of dirs) {
    const candidate = logPathIn(join(root, dir), id);
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * 会话文件是"每次 append 一帧"的多帧 zstd，而 zstdDecompressSync 只解第一帧就返回，
 * 所以必须按魔数切帧逐帧解。压缩数据里也可能正好出现魔数，
 * 这时切出来的那段解不开——把尾巴并到下一帧重试，直到解成功。
 */
export function decodeZstdFrames(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  const starts = [];
  let at = buf.indexOf(ZSTD_MAGIC);
  while (at !== -1) {
    starts.push(at);
    at = buf.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length);
  }
  if (starts.length === 0) throw new Error('文件头不是 zstd 帧');
  const frames = [];
  let index = 0;
  while (index < starts.length) {
    let decoded = null;
    let next = index + 1;
    while (next <= starts.length) {
      const end = next < starts.length ? starts[next] : buf.length;
      try {
        decoded = zstdDecompressSync(buf.subarray(starts[index], end));
        break;
      } catch {
        next += 1;
      }
    }
    // 这一帧彻底解不开：交出已解出的部分，别把整份历史一起丢掉
    if (decoded === null) break;
    frames.push(decoded);
    index = next;
  }
  if (frames.length === 0) throw new Error('一帧都没解开');
  return Buffer.concat(frames);
}

function textOfEvent(event) {
  const data = (event && event.data) || {};
  // user/message 的内容在 data 上，assistant/message 多包了一层 data.message
  const blocks = Array.isArray(data.content)
    ? data.content
    : Array.isArray(data.message && data.message.content)
      ? data.message.content
      : [];
  let out = '';
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out.trim();
}

/** 只看 user/message 与 assistant/message 的文字块；工具调用、思考不进导出。 */
export function parseSessionLog(text) {
  const meta = {};
  const messages = [];
  for (const line of String(text === undefined || text === null ? '' : text).split('\n')) {
    if (line.trim() === '') continue;
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'session') {
      Object.assign(meta, event);
      continue;
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    // "工作目录切换"这类提示也是 user/message，但不是用户说的话，导出里不该出现
    if (event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'working-directory') continue;
    const body = textOfEvent(event);
    if (body === '') continue;
    messages.push({ role: event.type === 'user/message' ? 'user' : 'assistant', text: body, at: Number.isFinite(event.time) ? event.time : null });
  }
  return { meta, messages };
}

export function decodeSessionLog(buffer) {
  return parseSessionLog(decodeZstdFrames(buffer).toString('utf8'));
}

export function buildHistoryMarkdown({ sessionId = '', cwd = '', messages = [], now = Date.now() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const lines = [
    '# DSH 会话导出',
    '',
    '- 会话：' + (sessionId === '' ? '(未知)' : sessionId),
    '- 工作目录：' + (cwd === '' ? '(未知)' : cwd),
    '- 导出时间：' + formatDateTime(now),
    '- 消息条数：' + list.length,
    '',
    '---'
  ];
  for (const item of list) {
    lines.push('', '## ' + (ROLE_TITLE[item && item.role] ?? String(item && item.role)), '', String((item && item.text) ?? ''));
  }
  lines.push('');
  return lines.join('\n');
}

/** 导出成 markdown 并落盘；失败一律返回人话，不抛——它要直接被发进 QQ。 */
export async function exportSessionMarkdown({
  dshHome = '',
  cwd = '',
  sessionId = '',
  outDir = '',
  now = () => Date.now()
} = {}) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (id === '') return { ok: false, message: '这个会话还没开始，没有历史可以导出。' };
  if (typeof outDir !== 'string' || outDir === '') return { ok: false, message: '没配置数据目录（storage.rootDir），不知道导出到哪。' };
  const source = findSessionLog({ dshHome, cwd, sessionId: id });
  if (source === '') return { ok: false, message: '找不到这个会话的日志文件（DSH 可能还没落盘）。' };
  let buffer;
  try {
    buffer = await readFile(source);
  } catch (error) {
    return { ok: false, message: '读不了会话日志：' + messageOf(error) };
  }
  let parsed;
  try {
    parsed = decodeSessionLog(buffer);
  } catch (error) {
    return { ok: false, message: '会话日志解不开（' + messageOf(error) + '）' };
  }
  if (parsed.messages.length === 0) return { ok: false, message: '这个会话里还没有能导出的对话内容。' };
  const at = now();
  const target = join(outDir, id + '-' + formatStamp(at) + '.md');
  const markdown = buildHistoryMarkdown({
    sessionId: id,
    cwd: typeof parsed.meta.cwd === 'string' && parsed.meta.cwd !== '' ? parsed.meta.cwd : cwd,
    messages: parsed.messages,
    now: at
  });
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(target, markdown, 'utf8');
  } catch (error) {
    return { ok: false, message: '写导出文件失败：' + messageOf(error) };
  }
  return { ok: true, path: target, count: parsed.messages.length, source };
}
