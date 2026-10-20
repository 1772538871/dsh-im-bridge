// 纯函数媒体规划：只回答"要不要下载、该调哪个 OneBot API"，绝不发请求。
// 真正的落地由 pipeline 交给 storage.saveFromUrl。
const DEFAULT_EXT = { image: 'jpg', file: 'bin', record: 'amr' };

// 文件名要做成安全路径片段；实现以 A 的 paths.mjs 为准（契约 §C）。
// A 模块与 B 并行开发、可能还没落盘，所以用顶层 await 动态引入 + 等价退化实现，
// 这样 planMedia 仍能保持同步签名。
let sanitizeName = null;
try {
  const paths = await import('../paths.mjs');
  if (typeof paths.sanitizeSegment === 'function') sanitizeName = paths.sanitizeSegment;
} catch {
  sanitizeName = null;
}

function fallbackSanitize(input, { maxLength = 64 } = {}) {
  let out = String(input ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '');
  out = out.replace(/\.{2,}/g, '.');
  out = out.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!out) return '_unknown_';
  let kept = '';
  for (const ch of out) {
    if (Buffer.byteLength(kept + ch, 'utf8') > maxLength) break;
    kept += ch;
  }
  kept = (kept || out.slice(0, maxLength)).replace(/^[.\s]+|[.\s]+$/g, '');
  return kept || '_unknown_';
}

if (!sanitizeName) sanitizeName = fallbackSanitize;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function baseNameOf(value) {
  const s = text(value);
  if (!s) return '';
  const withoutQuery = s.replace(/[?#].*$/, '');
  return withoutQuery.split(/[\\/]/).pop() ?? '';
}

function safeName(value) {
  const s = text(value);
  if (!s) return '';
  try {
    return sanitizeName(s) || '';
  } catch {
    return fallbackSanitize(s);
  }
}

export function guessExt(filename, fallback = '') {
  const base = baseNameOf(filename);
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  if (m) return m[1].toLowerCase();
  return text(fallback).replace(/^\./, '').toLowerCase();
}

function extOf(value, fallback) {
  const ext = guessExt(value, fallback) || fallback;
  return String(ext).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'bin';
}

export function planMedia(segment, { chatType = 'private' } = {}) {
  const seg = segment && typeof segment === 'object' ? segment : {};
  const type = typeof seg.type === 'string' ? seg.type : 'other';
  const data = seg.data && typeof seg.data === 'object' ? seg.data : {};

  const url = text(data.url);
  const rawFile = text(data.file);
  const rawName = text(data.name) || text(data.filename);
  const fileId = text(data.file_id);

  if (type === 'image') {
    const filename = safeName(rawName || rawFile || baseNameOf(url) || 'image');
    const ext = extOf(filename || url, DEFAULT_EXT.image);
    if (url) return { needsFetch: true, url, filename, ext };
    // 没有直接 url：需要先调 get_image 换一个可下载地址。
    const params = fileId ? { file_id: fileId } : rawFile ? { file: rawFile } : {};
    if (!Object.keys(params).length) return { needsFetch: false, filename, ext };
    const plan = { needsFetch: true, filename, ext, callSpec: { action: 'get_image', params } };
    if (fileId) plan.fileId = fileId;
    return plan;
  }

  if (type === 'file') {
    const filename = safeName(rawName || rawFile || baseNameOf(url) || 'file');
    const ext = extOf(filename || url, DEFAULT_EXT.file);
    if (url) return { needsFetch: true, url, filename, ext };
    const params = {};
    if (rawFile) params.file = rawFile;
    if (fileId) params.file_id = fileId;
    // 群文件接口还要 group_id/busid；它们来自事件而非单段数据，调用方缺什么补什么。
    if (text(data.group_id)) params.group_id = text(data.group_id);
    if (data.busid !== undefined && data.busid !== null && data.busid !== '') params.busid = data.busid;
    if (!Object.keys(params).length) return { needsFetch: false, filename, ext };
    const plan = {
      needsFetch: true,
      filename,
      ext,
      callSpec: { action: chatType === 'group' ? 'get_group_file_url' : 'get_private_file_url', params },
    };
    if (fileId) plan.fileId = fileId;
    return plan;
  }

  if (type === 'record') {
    const filename = safeName(rawFile || rawName || baseNameOf(url) || 'record');
    // 语音默认 amr：NapCat 的 record 段经常只有 file，没有扩展名信息。
    const ext = extOf(filename || url, DEFAULT_EXT.record);
    if (url) return { needsFetch: true, url, filename, ext };
    const params = {};
    if (rawFile) params.file = rawFile;
    if (fileId) params.file_id = fileId;
    if (!Object.keys(params).length) return { needsFetch: false, filename, ext };
    const plan = { needsFetch: true, filename, ext, callSpec: { action: 'get_record', params } };
    if (fileId) plan.fileId = fileId;
    return plan;
  }

  return { needsFetch: false, filename: '', ext: '' };
}
