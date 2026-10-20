import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const KIND_SET = new Set(['text', 'image', 'file', 'record', 'other']);
// 只保留 Windows 与 POSIX 双料非法字符：这些字符一旦进路径，轻则该条消息落盘失败，
// 重则被 .. 带出数据目录。
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function truncateBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let out = buf.subarray(0, Math.max(0, maxBytes)).toString('utf8');
  // 从字符中间截断会留下 U+FFFD，清掉才算“字节安全”
  out = out.replace(/\uFFFD+$/u, '');
  return out;
}

function stripEdgeDots(text) {
  let out = text;
  while (out.startsWith('.') || out.startsWith(' ')) out = out.slice(1);
  while (out.endsWith('.') || out.endsWith(' ')) out = out.slice(0, -1);
  return out;
}

export function sanitizeSegment(input, options) {
  const opts = options || {};
  const maxLength = Number.isFinite(opts.maxLength) && opts.maxLength > 0 ? Math.floor(opts.maxLength) : 64;
  let text = input === undefined || input === null ? '' : String(input);
  text = text.replace(ILLEGAL_CHARS, '');
  // ".." 一律抹掉：仅仅去掉边角的点挡不住 a/../b 里的中间穿越
  text = text.replace(/\.\.+/g, '');
  text = stripEdgeDots(text);
  text = truncateBytes(text, maxLength);
  text = stripEdgeDots(text);
  if (!text) return '_unknown_';
  return text;
}

export function chatKeyOf(chat) {
  const c = chat || {};
  const chatType = c.chatType || c.type || c.kind || 'private';
  if (chatType === 'group') {
    return 'group_' + sanitizeSegment(c.groupId === undefined || c.groupId === null || c.groupId === '' ? 'unknown' : c.groupId);
  }
  return 'private_' + sanitizeSegment(c.userId === undefined || c.userId === null || c.userId === '' ? 'unknown' : c.userId);
}

function formatDatePart(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function normalizeExt(ext, filename) {
  const fromArg = typeof ext === 'string' ? ext.trim().replace(/^\.+/, '') : '';
  const fromName = typeof filename === 'string' ? extname(filename).replace(/^\.+/, '') : '';
  const raw = fromArg || fromName || 'bin';
  const safe = sanitizeSegment(raw.toLowerCase(), { maxLength: 16 });
  return safe === '_unknown_' ? 'bin' : safe;
}

function splitName(filename) {
  const name = typeof filename === 'string' ? filename : '';
  const ext = extname(name);
  const base = ext ? name.slice(0, name.length - ext.length) : name;
  return { base, ext };
}

export function attachmentPath(input) {
  const opts = input || {};
  const rootDir = typeof opts.rootDir === 'string' ? opts.rootDir : '';
  const kindRaw = typeof opts.kind === 'string' ? opts.kind : 'other';
  const kind = KIND_SET.has(kindRaw) ? kindRaw : 'other';
  const ts = Number.isFinite(opts.ts) ? Math.floor(opts.ts) : Date.now();
  const parts = splitName(opts.filename);
  const ext = normalizeExt(opts.ext, opts.filename);
  const safeName = sanitizeSegment(parts.base || 'file');
  const fileName = ts + '-' + kind + '-' + safeName + '.' + ext;
  return join(rootDir, 'media', formatDatePart(ts), chatKeyOf(opts.chat), fileName);
}

export async function ensureDir(p) {
  if (typeof p !== 'string' || !p) return;
  await mkdir(p, { recursive: true });
}
