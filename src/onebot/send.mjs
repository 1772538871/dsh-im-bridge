// 回复切分与发送：QQ 单条消息有长度上限，必须先切段，再逐段发。

const DEFAULT_MAX_CHARS = 1500;
// 句末标点（中英文）之后切一刀；零宽前瞻保证标点留在前一段里。
const SENTENCE_END = /(?<=[。！？；.?!;])/;

function splitBlocks(input, re) {
  const parts = input.split(re);
  const blocks = [];
  let lead = '';
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 1) {
      lead = parts[i];
      continue;
    }
    blocks.push({ text: parts[i], lead });
    lead = '';
  }
  return blocks;
}

function hardCut(input, limit) {
  const out = [];
  let start = 0;
  while (start < input.length) {
    let end = Math.min(start + limit, input.length);
    const code = input.charCodeAt(end - 1);
    // 硬切不能把 emoji 的代理对劈成两半
    if (end < input.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    if (end <= start) end = Math.min(start + limit, input.length);
    out.push(input.slice(start, end));
    start = end;
  }
  return out;
}

// 把超长文本拆成"每片都不超过 limit"的原子片，片与片之间记住原始分隔符（lead），
// 这样合并时能还原换行，只有跨 chunk 边界的那一个分隔符会被丢掉。
function atomize(input, limit, out, lead) {
  if (!input) return;
  if (input.length <= limit) {
    out.push({ text: input, lead });
    return;
  }

  const rows = splitBlocks(input, /(\n+)/);
  if (rows.length > 1) {
    rows.forEach((row, i) => atomize(row.text, limit, out, i === 0 ? lead : row.lead));
    return;
  }

  const sentences = input.split(SENTENCE_END).filter((s) => s !== '');
  if (sentences.length > 1) {
    sentences.forEach((sentence, i) => {
      if (sentence.length <= limit) {
        out.push({ text: sentence, lead: i === 0 ? lead : '' });
        return;
      }
      hardCut(sentence, limit).forEach((piece, j) => out.push({ text: piece, lead: i === 0 && j === 0 ? lead : '' }));
    });
    return;
  }

  hardCut(input, limit).forEach((piece, i) => out.push({ text: piece, lead: i === 0 ? lead : '' }));
}

export function chunkText(text, maxChars) {
  if (text === null || text === undefined) return [];
  const source = typeof text === 'string' ? text : String(text);
  if (!source.trim()) return [];

  const wanted = Number(maxChars);
  const limit = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : DEFAULT_MAX_CHARS;

  const atoms = [];
  // 优先级：空行分段 > 换行 > 句末标点 > 硬切
  splitBlocks(source, /(\n{2,})/).forEach((para, i) => atomize(para.text, limit, atoms, i === 0 ? '' : para.lead));

  const chunks = [];
  let current = '';
  for (const atom of atoms) {
    if (!atom.text) continue;
    if (current && (current + atom.lead + atom.text).length <= limit) {
      current = current + atom.lead + atom.text;
      continue;
    }
    if (current) {
      const trimmed = current.trim();
      if (trimmed) chunks.push(trimmed);
    }
    current = atom.text;
  }
  const tail = current.trim();
  if (tail) chunks.push(tail);
  return chunks;
}

export function buildMessagePayload(text) {
  // 数组分段形态：文本里的 [CQ:...] 是字面量，不会被任何实现当成 CQ 码展开。
  return [{ type: 'text', data: { text: typeof text === 'string' ? text : String(text ?? '') } }];
}

function warn(logger, message, meta) {
  const fn = logger?.warn;
  if (typeof fn !== 'function') return;
  try {
    fn.call(logger, message, meta);
  } catch {
    // 日志失败不影响发送
  }
}

export async function sendReply({ client, message, text, config = {}, logger = null } = {}) {
  const wanted = Number(config?.reply?.maxChunkChars);
  const limit = Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_MAX_CHARS;
  const chunks = chunkText(text, limit);

  const chatType = message?.chatType === 'group' ? 'group' : 'private';
  const action = chatType === 'group' ? 'send_group_msg' : 'send_private_msg';
  const targetRaw = chatType === 'group' ? message?.groupId : message?.userId;
  const target = String(targetRaw ?? '');

  let sent = 0;
  let failed = 0;
  if (!chunks.length) return { sent, failed };
  if (!target) {
    // 没有对话目标时调 API 只会拿到实现相关的报错，直接如实计失败。
    warn(logger, '缺少发送目标，放弃本轮回复', { chatType, chunks: chunks.length });
    return { sent, failed: chunks.length };
  }

  for (let i = 0; i < chunks.length; i += 1) {
    const payload = buildMessagePayload(chunks[i]);
    const params = chatType === 'group' ? { group_id: target, message: payload } : { user_id: target, message: payload };
    try {
      await client.call(action, params);
      sent += 1;
    } catch (err) {
      failed += 1;
      // 单段失败不能让剩余段一起丢：长回复里前面的段可能已经送达。
      warn(logger, `${action} 发送失败`, { index: i + 1, total: chunks.length, error: String(err?.message ?? err) });
    }
  }
  return { sent, failed };
}
