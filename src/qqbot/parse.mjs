// QQ Bot API v2 事件 → 内核 NormMessage（形状见 CONTRACT.md §2I）。
// 与 OneBot 的差别只有"字段从哪来"：QQ 用 openid，事件类型决定单聊/群聊，附件是自带直链的数组。
import { sanitizeSegment } from '../paths.mjs';

const C2C_CREATE = 'C2C_MESSAGE_CREATE';
const GROUP_AT_CREATE = 'GROUP_AT_MESSAGE_CREATE';
const META_TYPES = new Set(['READY', 'RESUMED']);
const DEFAULT_EXT = { image: 'jpg', record: 'silk', file: 'bin' };

function text(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function baseNameOf(url) {
  const withoutQuery = text(url).replace(/[?#].*$/, '');
  const last = withoutQuery.split(/[\\/]/).pop() ?? '';
  return last;
}

function extFromName(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(text(name));
  return m ? m[1].toLowerCase() : '';
}

function normalizeExt(value) {
  const cleaned = text(value).trim().replace(/^\.+/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return cleaned;
}

function asTime(value) {
  const ms = Date.parse(text(value));
  // 内核里的 time 沿用 OneBot 的秒级 epoch；解析不出来就交 0，让上层自己兜底
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function mediaOfAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const contentType = text(attachment.content_type).trim().toLowerCase();
  const directUrl = text(attachment.url).trim();
  const wavUrl = text(attachment.voice_wav_url).trim();
  const filename = text(attachment.filename).trim();
  const size = Number(attachment.size);

  let type = 'file';
  let url = directUrl;
  let ext = '';
  if (contentType === 'voice') {
    // 平台另给一份 SILK 转好的 WAV：asr 多为 wav/amr 工具，优先用它
    type = 'record';
    url = wavUrl || directUrl;
    ext = wavUrl ? 'wav' : 'silk';
  } else if (contentType.startsWith('image/')) {
    type = 'image';
    ext = normalizeExt(contentType.slice('image/'.length));
  } else if (contentType === 'file') {
    ext = '';
  } else if (contentType.startsWith('video/')) {
    // NormSegment 没有 video，落到 file 让 DSH 至少能在磁盘上看到它
    ext = normalizeExt(contentType.slice('video/'.length));
  }
  if (!url) return null;

  const resolvedFilename = filename || baseNameOf(url) || (type === 'record' ? 'voice.' + (ext || DEFAULT_EXT.record) : '');
  return {
    type,
    url,
    filename: resolvedFilename,
    size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : null,
    contentType: contentType || null,
    ext: ext || extFromName(resolvedFilename) || DEFAULT_EXT[type],
  };
}

/**
 * @param {object} raw 网关下发的完整 payload（含 op/t/d）
 * @param {{appId?: string}} options selfId 取 appId：QQ 事件体里没有"机器人自己的 id"
 */
export function parseQqBotEvent(raw, options = {}) {
  const appId = text(options.appId);
  if (!raw || typeof raw !== 'object') return { kind: 'unknown' };

  const op = Number(raw.op);
  const type = text(raw.t);
  if (!Number.isFinite(op) || type === '') return { kind: 'unknown' };
  if (META_TYPES.has(type)) return { kind: 'meta_event' };
  if (op !== 0) return { kind: 'unknown' };
  if (type !== C2C_CREATE && type !== GROUP_AT_CREATE) return { kind: 'unknown' };

  const d = raw.d && typeof raw.d === 'object' ? raw.d : {};
  const author = d.author && typeof d.author === 'object' ? d.author : {};
  const chatType = type === GROUP_AT_CREATE ? 'group' : 'private';

  const userId = chatType === 'group'
    ? text(author.member_openid) || text(author.id)
    : text(author.user_openid) || text(author.id);
  const groupId = chatType === 'group' ? text(d.group_openid) || null : null;

  const content = text(d.content);
  const segments = [];
  const trimmed = content.trim();
  if (trimmed !== '') segments.push({ type: 'text', data: { text: trimmed } });

  const attachments = Array.isArray(d.attachments) ? d.attachments : [];
  for (const attachment of attachments) {
    const media = mediaOfAttachment(attachment);
    if (!media) continue;
    segments.push({
      type: media.type,
      data: { url: media.url, filename: media.filename, size: media.size, contentType: media.contentType, ext: media.ext },
    });
  }

  // 群事件只在"@了机器人"时才会下发（文档：用户在群里@机器人发送消息时触发），
  // 所以这里直接把 selfId 记为 at 目标，security.mjs 的 groupRequireAt 才不会误杀。
  const atTargets = chatType === 'group' && appId !== '' ? [appId] : [];

  return {
    kind: 'message',
    message: {
      messageId: text(d.id) || text(raw.id) || null,
      chatType,
      userId,
      groupId,
      selfId: appId,
      senderName: text(author.username) || null,
      time: asTime(d.timestamp),
      text: trimmed,
      segments,
      atTargets,
      replyTo: null,
    },
  };
}

export function guessExt(filename, fallback = '') {
  return extFromName(filename) || normalizeExt(fallback);
}

/**
 * 纯函数：QQ 附件事件里一定带直链，所以只回答"下哪个 url、存成什么名字"。
 * 与 onebot/media.mjs 同形，交给 pipeline 的 storage.saveFromUrl 真正落盘。
 */
export function planMedia(segment, options = {}) {
  const seg = segment && typeof segment === 'object' ? segment : {};
  const type = seg.type === 'image' || seg.type === 'record' || seg.type === 'file' ? seg.type : 'other';
  const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
  const url = text(data.url).trim();
  if (type === 'other' || !url) return { needsFetch: false, filename: '', ext: '' };

  const rawName = text(data.filename).trim() || baseNameOf(url) || (type === 'record' ? 'voice' : type);
  const filename = sanitizeSegment(rawName);
  const ext = normalizeExt(data.ext) || extFromName(rawName) || DEFAULT_EXT[type];
  return { needsFetch: true, url, filename, ext };
}

export { META_TYPES, C2C_CREATE, GROUP_AT_CREATE };
