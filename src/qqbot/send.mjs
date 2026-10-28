// 回复发送：切段逻辑与 OneBot 完全一致（复用 chunkText），差别只在协议——
// QQ 被动回复必须带 msg_id，且同一 msg_id 下 msg_seq 必须递增，否则平台按重复消息丢弃。
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { chunkText } from '../onebot/send.mjs';

const DEFAULT_MAX_CHARS = 1500;
// 文档：单聊每个消息最多回复 4 次，群聊最多回复 5 次
const PASSIVE_LIMIT = { private: 4, group: 5 };
// 同一个 msg_id 下 msg_seq 必须严格递增：之前每次回复都从 1 起，
// 第二条卡片被平台判"去重"（40054005）静默丢弃
const seqByMessageId = new Map();
const SEQ_CACHE_LIMIT = 500;
function nextSeq(messageId) {
  const used = seqByMessageId.get(messageId) ?? 0;
  const seq = used + 1;
  seqByMessageId.set(messageId, seq);
  if (seqByMessageId.size > SEQ_CACHE_LIMIT) {
    const oldest = seqByMessageId.keys().next().value;
    if (oldest !== undefined) seqByMessageId.delete(oldest);
  }
  return seq;
}

function warn(logger, message, meta) {
  const fn = logger?.warn;
  if (typeof fn !== 'function') return;
  try {
    fn.call(logger, message, meta);
  } catch {
    /* 日志失败不影响发送 */
  }
}

export function buildTextBody({ text, messageId = '', seq = 1 } = {}) {
  const body = { msg_type: 0, content: typeof text === 'string' ? text : String(text ?? '') };
  if (messageId) {
    body.msg_id = messageId;
    // msg_seq 只在被动回复里有意义（与 msg_id 联合使用），没有 msg_id 时不传
    body.msg_seq = Math.max(1, Math.floor(seq));
  }
  return body;
}

// 实测：被动回复用的 msg_id 会随接收会话失效（40034024「msg_id 无效或越权」），
// 这时退化成主动消息仍能送达，所以回复链路不能因为被动被拒就整条丢掉
function isPassiveRejection(error) {
  const code = Number(error?.code ?? error?.errCode ?? NaN);
  // 40034024 = msg_id 无效或越权；40054005 = 消息被去重（msg_seq 重复）
  if (code === 40034024 || code === 40054005) return true;
  const text = String(error?.message ?? error ?? '');
  return text.includes('msg_id') || text.includes('40034024') || text.includes('去重') || text.includes('40054005');
}

export async function sendQqReply({ client, message, text, config = {}, logger = null } = {}) {
  const wanted = Number(config?.reply?.maxChunkChars);
  const limit = Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_MAX_CHARS;
  const chunks = chunkText(text, limit);

  const chatType = message?.chatType === 'group' ? 'group' : 'private';
  const target = chatType === 'group' ? message?.groupId : message?.userId;
  const messageId = typeof message?.messageId === 'string' ? message.messageId : '';
  const configuredStart = Number(config?.qqbot?.msgSeqStart);
  const startSeq = Number.isFinite(configuredStart) && configuredStart > 0 ? Math.floor(configuredStart) : 1;
  const configuredCap = Number(config?.qqbot?.maxPassiveReplies);
  const cap = Number.isFinite(configuredCap) && configuredCap > 0 ? Math.floor(configuredCap) : PASSIVE_LIMIT[chatType];

  let sent = 0;
  let failed = 0;
  if (chunks.length === 0) return { sent, failed };
  if (!target) {
    // 没有 openid 时调接口只会拿到网关错误，如实计失败更快暴露配置问题
    warn(logger, '缺少发送目标，放弃本轮回复', { chatType, chunks: chunks.length });
    return { sent, failed: chunks.length };
  }
  if (typeof client?.sendMessage !== 'function') {
    warn(logger, 'client 不支持 sendMessage，放弃本轮回复', { chatType });
    return { sent, failed: chunks.length };
  }

  let toSend = chunks;
  if (messageId && chunks.length > cap) {
    // 超出被动回复次数上限的部分平台一定拒绝，提前截断并把损失计入 failed
    toSend = chunks.slice(0, cap);
    failed += chunks.length - toSend.length;
    warn(logger, '回复分段数超过被动回复上限，已截断', { chatType, chunks: chunks.length, cap });
  }

  for (let index = 0; index < toSend.length; index += 1) {
    const body = buildTextBody({ text: toSend[index], messageId, seq: messageId ? nextSeq(messageId) : startSeq + index });
    try {
      await client.sendMessage({ chatType, target, body });
      sent += 1;
    } catch (error) {
      // 被动回复被拒时改走主动消息；单段失败也不能让后面的段一起丢（前面可能已经送达）
      if (messageId !== '' && isPassiveRejection(error)) {
        try {
          await client.sendMessage({ chatType, target, body: buildTextBody({ text: toSend[index] }) });
          sent += 1;
          warn(logger, '被动回复被拒，已改用主动消息送达', { index: index + 1, error: String(error?.message ?? error).slice(0, 200) });
          continue;
        } catch (fallbackError) {
          warn(logger, 'QQ Bot 发送失败（主动消息也失败）', { index: index + 1, error: String(fallbackError?.message ?? fallbackError).slice(0, 200) });
        }
      }
      failed += 1;
      warn(logger, 'QQ Bot 发送失败', { index: index + 1, total: toSend.length, error: String(error?.message ?? error) });
    }
  }
  return { sent, failed };
}

// 富媒体消息的 msg_type 固定 7；file_type 按内容分类（1=图片、4=文件）
const FILE_TYPE_IMAGE = 1;
const FILE_TYPE_FILE = 4;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function qqFileTypeOf(filename) {
  return IMAGE_EXT.test(String(filename ?? '')) ? FILE_TYPE_IMAGE : FILE_TYPE_FILE;
}

function pickFileInfo(uploaded) {
  const raw = uploaded?.file_info ?? uploaded?.data?.file_info ?? '';
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 出站文件：先上传拿 file_info，再发 msg_type=7 的富媒体消息。
 * 被动回复仍要带 msg_id + 递增 msg_seq，否则平台按重复消息静默丢掉。
 */
export async function sendQqFile({ client, message, path: filePath = '', config = {}, logger = null } = {}) {
  const wanted = typeof filePath === 'string' ? filePath.trim() : '';
  const chatType = message?.chatType === 'group' ? 'group' : 'private';
  const target = chatType === 'group' ? message?.groupId : message?.userId;

  if (wanted === '') {
    warn(logger, '发文件缺少路径', { chatType });
    return { sent: 0, failed: 1 };
  }
  if (!target) {
    warn(logger, '缺少发送目标，放弃发文件', { chatType });
    return { sent: 0, failed: 1 };
  }
  if (typeof client?.uploadFileContent !== 'function' || typeof client?.sendMessage !== 'function') {
    warn(logger, 'client 不支持富媒体上传，放弃发文件', { chatType });
    return { sent: 0, failed: 1 };
  }

  const name = basename(wanted);
  let bytes = null;
  try {
    bytes = await readFile(wanted);
  } catch (error) {
    warn(logger, '读不到要发的文件', { path: wanted, error: String(error?.message ?? error) });
    return { sent: 0, failed: 1 };
  }

  let fileInfo = '';
  try {
    const uploaded = await client.uploadFileContent({
      chatType,
      target,
      fileType: qqFileTypeOf(name),
      filename: name,
      bytes,
    });
    fileInfo = pickFileInfo(uploaded);
  } catch (error) {
    warn(logger, 'QQ 富媒体上传失败', { path: wanted, error: String(error?.message ?? error) });
    return { sent: 0, failed: 1 };
  }
  if (!fileInfo) {
    warn(logger, 'QQ 富媒体上传没有返回 file_info', { path: wanted });
    return { sent: 0, failed: 1 };
  }

  const messageId = typeof message?.messageId === 'string' ? message.messageId : '';
  const body = { msg_type: 7, media: { file_info: fileInfo } };
  if (messageId) {
    body.msg_id = messageId;
    body.msg_seq = nextSeq(messageId);
  }

  try {
    await client.sendMessage({ chatType, target, body });
    return { sent: 1, failed: 0 };
  } catch (error) {
    // 被动回复的 msg_id 会过期，被拒时退化成主动消息再发一次，别让文件直接丢
    if (messageId && isPassiveRejection(error)) {
      try {
        await client.sendMessage({ chatType, target, body: { msg_type: 7, media: { file_info: fileInfo } } });
        warn(logger, '富媒体被动回复被拒，已改用主动消息送达', { error: String(error?.message ?? error).slice(0, 200) });
        return { sent: 1, failed: 0 };
      } catch (fallbackError) {
        warn(logger, 'QQ Bot 发文件失败（主动消息也失败）', { error: String(fallbackError?.message ?? fallbackError).slice(0, 200) });
        return { sent: 0, failed: 1 };
      }
    }
    warn(logger, 'QQ Bot 发文件失败', { error: String(error?.message ?? error).slice(0, 200) });
    return { sent: 0, failed: 1 };
  }
}
