import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 表情库：只存文件 + 一份索引，不碰 DSH 的会话数据。
// 发送沿用出站图片的既有通道（[[sendimage: 绝对路径]]），所以这里唯一的责任是"把图原样留住"。
export const STICKERS_DIR_NAME = 'stickers';
export const STICKER_INDEX_FILE = 'index.json';
export const NO_STICKER_NOTE = '无备注';
// 提示词里最多带 12 条：再多就挤占角色卡和日记的位置，模型也挑不过来
export const PROMPT_STICKER_LIMIT = 12;
export const PROMPT_NOTE_MAX_CHARS = 20;
// 列表与回执里给人看的条数
export const LIST_STICKER_LIMIT = 10;

// 表情包是"一句话就能发出去的小图"：超过这个尺寸的更像正经图片，收进库里只会撑大提示词
const MAX_STICKER_BYTES = 8 * 1024 * 1024;
// 备注要能进提示词的一行，长了会把库撑成小作文
const NOTE_MAX_CHARS = 60;
// WebP 的 ANIM 块可能不在最前面，读一小段头就够判定了
const HEADER_BYTES = 4096;
const KNOWN_IMAGE_EXT = new Set(['gif', 'png', 'jpg', 'jpeg', 'webp']);

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function messageOf(error) {
  return error && error.message ? String(error.message) : String(error);
}

/** 数据目录 → stickers 目录；没有数据目录就返回空串（调用方据此整体跳过）。 */
export function stickersDirOf(rootDir) {
  const root = textOf(rootDir);
  return root === '' ? '' : join(root, STICKERS_DIR_NAME);
}

function syncReadOf(fsImpl) {
  return fsImpl && typeof fsImpl.readFileSync === 'function' ? fsImpl.readFileSync : readFileSync;
}

function existsOf(fsImpl) {
  return fsImpl && typeof fsImpl.existsSync === 'function' ? fsImpl.existsSync : existsSync;
}

function asyncIoOf(fsImpl) {
  const io = fsImpl && typeof fsImpl === 'object' ? fsImpl : {};
  return {
    mkdir: typeof io.mkdir === 'function' ? io.mkdir : mkdir,
    copyFile: typeof io.copyFile === 'function' ? io.copyFile : copyFile,
    readFile: typeof io.readFile === 'function' ? io.readFile : readFile,
    writeFile: typeof io.writeFile === 'function' ? io.writeFile : writeFile,
    rename: typeof io.rename === 'function' ? io.rename : rename,
    unlink: typeof io.unlink === 'function' ? io.unlink : unlink,
    stat: typeof io.stat === 'function' ? io.stat : stat
  };
}

/**
 * 只看字节，不看扩展名：QQ 里同一张图可能叫 xxx.gif 也可能叫 1A2B.image。
 * animated 只认 GIF 头与 WebP 的 ANIM 块——猜错的代价是"说它是动图却发出去不动"。
 */
export function imageFormOf(header, filename = '') {
  const buf = Buffer.isBuffer(header) ? header : Buffer.from(header ?? '');
  const named = /\.([A-Za-z0-9]{1,5})$/u.exec(String(filename ?? ''));
  const namedExt = named === null ? '' : named[1].toLowerCase();
  const extFromName = KNOWN_IMAGE_EXT.has(namedExt) ? namedExt : '';

  const gifHead = buf.length >= 6 ? buf.subarray(0, 6).toString('latin1') : '';
  if (gifHead === 'GIF87a' || gifHead === 'GIF89a') {
    return { ext: extFromName || 'gif', animated: true };
  }
  if (buf.length >= 4 && buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') {
    return { ext: extFromName || 'png', animated: false };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    // 动图 WebP 一定有 ANIM 块（VP8X 里也会置位），静图没有
    return { ext: extFromName || 'webp', animated: buf.includes('ANIM') };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: extFromName || 'jpg', animated: false };
  }
  return { ext: extFromName || 'bin', animated: false };
}

function normalizeNote(note) {
  const flat = typeof note === 'string' ? note.replace(/\s+/gu, ' ').trim() : '';
  if (flat === '') return NO_STICKER_NOTE;
  return flat.length > NOTE_MAX_CHARS ? flat.slice(0, NOTE_MAX_CHARS) + '…' : flat;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = textOf(raw.id);
  const file = textOf(raw.file);
  if (id === '' || file === '') return null;
  return {
    id,
    file,
    note: typeof raw.note === 'string' && raw.note.trim() !== '' ? raw.note : NO_STICKER_NOTE,
    addedAt: Number.isFinite(Number(raw.addedAt)) ? Number(raw.addedAt) : 0,
    source: textOf(raw.source),
    from: typeof raw.from === 'string' ? raw.from : '',
    ext: textOf(raw.ext),
    animated: raw.animated === true,
    hash: textOf(raw.hash)
  };
}

/**
 * 读索引（同步：提示词拼装在同步路径上）。
 * 索引坏了/读不了都当空库：库结构坏掉不该让"每一条消息"都跟着失败。
 */
export function readStickerIndex({ rootDir = '', fsImpl = null } = {}) {
  const dir = stickersDirOf(rootDir);
  if (dir === '') return [];
  let raw = '';
  try {
    raw = syncReadOf(fsImpl)(join(dir, STICKER_INDEX_FILE), 'utf8');
  } catch {
    return [];
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw ?? ''));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
  const entries = [];
  for (const item of list) {
    const entry = normalizeEntry(item);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** 新的在前；addedAt 相同时后写入的在前（同一毫秒连收两张也不会乱序）。 */
function sortedEntries(entries, dir) {
  return entries
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => b.entry.addedAt - a.entry.addedAt || b.order - a.order)
    .map((item) => ({ ...item.entry, path: dir === '' ? '' : join(dir, item.entry.file) }));
}

export function listStickers({ rootDir = '', limit = 0, fsImpl = null } = {}) {
  const dir = stickersDirOf(rootDir);
  if (dir === '') return [];
  const all = sortedEntries(readStickerIndex({ rootDir, fsImpl }), dir);
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
  return cap === 0 ? all : all.slice(0, cap);
}

async function writeIndex({ dir, entries, io }) {
  const target = join(dir, STICKER_INDEX_FILE);
  // 先写临时文件再改名：中途断电最多留下一份 .tmp，索引本身永远是完整的 JSON。
  // 名字带随机尾巴：两个会话同时收藏时不会抢同一个 .tmp（抢输了 rename 会 ENOENT）
  const tmp = target + '.' + randomBytes(4).toString('hex') + '.tmp';
  await io.writeFile(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  await io.rename(tmp, target);
}

/**
 * 收一张表情。复制而不是移动：原附件还要照常交给 DSH 读。
 * 同一个文件内容（sha256 前 16 位）只入一条，重复时把已有的那张报回去。
 */
export async function addSticker({
  rootDir = '',
  sourcePath = '',
  note = '',
  from = '',
  source = 'command',
  now = Date.now(),
  fsImpl = null
} = {}) {
  const dir = stickersDirOf(rootDir);
  if (dir === '') return { ok: false, error: '没有数据目录（storage.rootDir 为空），收藏不了' };

  const src = typeof sourcePath === 'string' ? sourcePath.trim() : '';
  if (src === '') return { ok: false, error: '没有图片来源' };

  const io = asyncIoOf(fsImpl);
  let bytes = null;
  try {
    const info = await io.stat(src);
    if (typeof info?.isFile === 'function' && !info.isFile()) throw new Error('not a file');
    if (Number(info?.size) > MAX_STICKER_BYTES) {
      return { ok: false, error: '这张图太大（超过 8 MB），不收了' };
    }
    const raw = await io.readFile(src);
    bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? '');
  } catch (error) {
    return { ok: false, error: '找不到这张图了（可能已经被清理）：' + src };
  }

  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const entries = readStickerIndex({ rootDir, fsImpl });
  const duplicated = entries.find((entry) => entry.hash === hash);
  if (duplicated !== undefined) {
    // 位置 = /表情 里的序号，用户看到"已经收过了"就能直接 /删表情 删掉它
    const ordered = sortedEntries(entries, dir);
    const position = ordered.findIndex((entry) => entry.id === duplicated.id) + 1;
    return { ok: true, duplicated: true, entry: { ...duplicated, path: join(dir, duplicated.file) }, count: entries.length, position };
  }

  const form = imageFormOf(bytes, src);
  const addedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const id = randomBytes(6).toString('hex');
  const file = 'stk-' + addedAt + '-' + randomBytes(2).toString('hex') + '.' + form.ext;
  const entry = {
    id,
    file,
    note: normalizeNote(note),
    addedAt,
    source: textOf(source) || 'command',
    from: typeof from === 'string' ? from : '',
    ext: form.ext,
    animated: form.animated === true,
    hash
  };
  const target = join(dir, file);

  try {
    await io.mkdir(dir, { recursive: true });
    await io.copyFile(src, target);
  } catch (error) {
    return { ok: false, error: '把这张图存进库里失败：' + messageOf(error) };
  }

  entries.push(entry);
  try {
    await writeIndex({ dir, entries, io });
  } catch (error) {
    // 索引没写成：把刚复制的文件收掉，免得留下一张库里看不见的孤儿
    try {
      await io.unlink(target);
    } catch {
      /* 收不掉就算了，索引才是唯一的真源 */
    }
    return { ok: false, error: '写表情库索引失败：' + messageOf(error) };
  }

  return { ok: true, duplicated: false, entry: { ...entry, path: target }, count: entries.length, position: 1 };
}

/** 删一张：file 用相对 stickers 目录的名字，只删库里那份，不动用户原来的附件。 */
export async function removeSticker({ rootDir = '', id = '', fsImpl = null } = {}) {
  const dir = stickersDirOf(rootDir);
  if (dir === '') return { ok: false, error: '没有数据目录（storage.rootDir 为空），删不了' };
  const key = typeof id === 'string' ? id.trim() : '';
  if (key === '') return { ok: false, error: '要删哪一张？' };

  const entries = readStickerIndex({ rootDir, fsImpl });
  let hit = entries.find((entry) => entry.id === key) ?? null;
  if (hit === null && key.length >= 4) {
    const lower = key.toLowerCase();
    const hits = entries.filter((entry) => entry.id.startsWith(lower));
    if (hits.length > 1) return { ok: false, error: '这个 id 前缀对上了不止一张，多写几位' };
    hit = hits[0] ?? null;
  }
  if (hit === null) return { ok: false, error: '库里没有这一张：' + key };

  const kept = entries.filter((entry) => entry.id !== hit.id);
  const io = asyncIoOf(fsImpl);
  try {
    await io.unlink(join(dir, hit.file));
  } catch {
    /* 文件早就没了也算删成功：索引是唯一的真源 */
  }
  try {
    await writeIndex({ dir, entries: kept, io });
  } catch (error) {
    return { ok: false, error: '写表情库索引失败：' + messageOf(error) };
  }
  return { ok: true, entry: { ...hit, path: join(dir, hit.file) }, count: kept.length };
}

/**
 * 提示词用的紧凑列表（同步）：只给"备注 + 绝对路径"，模型据此决定发不发。
 * 文件已经不在了的条目跳过——发一张死链等于让模型白写一行标记。
 */
export function pickStickersForPrompt({
  rootDir = '',
  limit = PROMPT_STICKER_LIMIT,
  noteMaxChars = PROMPT_NOTE_MAX_CHARS,
  fsImpl = null
} = {}) {
  const dir = stickersDirOf(rootDir);
  if (dir === '') return [];
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : PROMPT_STICKER_LIMIT;
  const noteCap =
    Number.isFinite(Number(noteMaxChars)) && Number(noteMaxChars) > 0 ? Math.floor(Number(noteMaxChars)) : PROMPT_NOTE_MAX_CHARS;
  const exists = existsOf(fsImpl);
  const picked = [];
  for (const entry of listStickers({ rootDir, fsImpl })) {
    if (picked.length >= cap) break;
    const path = join(dir, entry.file);
    let alive = false;
    try {
      alive = exists(path) === true;
    } catch {
      alive = false;
    }
    if (!alive) continue;
    const note = entry.note.length > noteCap ? entry.note.slice(0, noteCap) + '…' : entry.note;
    picked.push({ id: entry.id, note, path, animated: entry.animated === true });
  }
  return picked;
}
