// CQ 码 / 数组消息 → 归一化事件。只做解析，不做任何过滤（白名单在 security.mjs）。

const CQ_CODE = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g;
const KNOWN_SEGMENT_TYPES = new Set(['text', 'image', 'file', 'record', 'at', 'reply', 'face']);

// CQ 规定 &amp; 必须最后还原，否则 "&amp;#91;" 会被误当成 "["。
function unescapeCq(value) {
  return String(value ?? '')
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

function parseParams(tail) {
  const data = {};
  if (!tail) return data;
  for (const pair of tail.slice(1).split(',')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) {
      data[unescapeCq(pair)] = '';
      continue;
    }
    data[unescapeCq(pair.slice(0, eq))] = unescapeCq(pair.slice(eq + 1));
  }
  return data;
}

function makeSegment(type, data) {
  if (KNOWN_SEGMENT_TYPES.has(type)) {
    if (type === 'text') return { type: 'text', data: { ...data, text: String(data.text ?? '') } };
    return { type, data };
  }
  // 未知类型保留原文，调用方（pipeline）自己决定是否降级成文字说明。
  return { type: 'other', data: { ...data, cqType: type } };
}

function segmentsFromCqString(input) {
  const segments = [];
  const text = String(input);
  const re = new RegExp(CQ_CODE.source, 'g');
  let cursor = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: 'text', data: { text: unescapeCq(text.slice(cursor, match.index)) } });
    }
    segments.push(makeSegment(match[1], parseParams(match[2])));
    cursor = re.lastIndex;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', data: { text: unescapeCq(text.slice(cursor)) } });
  }
  return segments;
}

function segmentsFromArray(input) {
  const segments = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const type = typeof item.type === 'string' && item.type ? item.type : 'other';
    const data = item.data && typeof item.data === 'object' ? { ...item.data } : {};
    segments.push(makeSegment(type, data));
  }
  return segments;
}

function toSegments(message) {
  if (Array.isArray(message)) return segmentsFromArray(message);
  if (typeof message === 'string') return segmentsFromCqString(message);
  if (message && typeof message === 'object') return segmentsFromArray([message]);
  if (typeof message === 'number') return segmentsFromCqString(String(message));
  return [];
}

function asString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function asTime(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function kindOf(postType) {
  if (postType === 'message') return 'message';
  if (postType === 'meta_event') return 'meta_event';
  if (postType === 'notice') return 'notice';
  if (postType === 'request') return 'request';
  return 'unknown';
}

export function parseEvent(raw) {
  if (!raw || typeof raw !== 'object') return { kind: 'unknown' };
  const kind = kindOf(raw.post_type);
  if (kind !== 'message') return { kind };

  const segments = toSegments(raw.message ?? raw.raw_message);
  const textParts = [];
  const atTargets = [];
  let replyTo = null;
  for (const seg of segments) {
    if (seg.type === 'text') textParts.push(seg.data.text ?? '');
    else if (seg.type === 'at') atTargets.push(String(seg.data.qq ?? ''));
    else if (seg.type === 'reply' && replyTo === null) replyTo = asString(seg.data.id);
  }

  const sender = raw.sender && typeof raw.sender === 'object' ? raw.sender : {};
  const chatType = raw.message_type === 'group' ? 'group' : 'private';

  const message = {
    messageId: asString(raw.message_id),
    chatType,
    userId: asString(raw.user_id ?? sender.user_id) ?? '',
    groupId: chatType === 'group' ? asString(raw.group_id) : null,
    selfId: asString(raw.self_id) ?? '',
    senderName: asString(sender.card) ?? asString(sender.nickname),
    time: asTime(raw.time),
    text: textParts.join(''),
    segments,
    atTargets,
    replyTo,
  };

  return { kind, message };
}
