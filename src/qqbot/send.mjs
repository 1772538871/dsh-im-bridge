// 回复发送：切段逻辑与 OneBot 完全一致（复用 chunkText），差别只在协议——
// QQ 被动回复必须带 msg_id，且同一 msg_id 下 msg_seq 必须递增，否则平台按重复消息丢弃。
import { chunkText } from '../onebot/send.mjs';

const DEFAULT_MAX_CHARS = 1500;
// 文档：单聊每个消息最多回复 4 次，群聊最多回复 5 次
const PASSIVE_LIMIT = { private: 4, group: 5 };

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
    const body = buildTextBody({ text: toSend[index], messageId, seq: startSeq + index });
    try {
      await client.sendMessage({ chatType, target, body });
      sent += 1;
    } catch (error) {
      failed += 1;
      // 单段失败不能让后面的段一起丢：长回复里前面可能已经送达
      warn(logger, 'QQ Bot 发送失败', { index: index + 1, total: toSend.length, error: String(error?.message ?? error) });
    }
  }
  return { sent, failed };
}
