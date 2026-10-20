const WINDOW_MS = 60 * 1000;
const ALL_AT = 'all';

function atTargetsOf(msg) {
  const targets = Array.isArray(msg && msg.atTargets) ? msg.atTargets : [];
  if (targets.length > 0) return targets.map((t) => String(t));
  const segments = Array.isArray(msg && msg.segments) ? msg.segments : [];
  const out = [];
  for (const seg of segments) {
    if (seg && seg.type === 'at' && seg.data && seg.data.qq !== undefined && seg.data.qq !== null) {
      out.push(String(seg.data.qq));
    }
  }
  return out;
}

function listOf(value) {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

export function createGuard(options) {
  const opts = options || {};
  const config = opts.config || {};
  const logger = opts.logger;
  const sec = config.security || {};

  const userWhitelist = listOf(sec.userWhitelist);
  const groupWhitelist = listOf(sec.groupWhitelist);
  const allowPrivate = sec.allowPrivate !== false;
  const allowGroup = sec.allowGroup !== false;
  const groupRequireAt = sec.groupRequireAt !== false;
  const rateLimitPerMinute = Number.isFinite(sec.rateLimitPerMinute) ? Math.floor(sec.rateLimitPerMinute) : 6;

  const hits = new Map();

  const debug = (message) => {
    try {
      if (logger && typeof logger.debug === 'function') logger.debug(message);
    } catch {
      // 日志失败不影响判定
    }
  };

  const deny = (reason) => {
    debug('消息被拦截：' + reason);
    return { allow: false, reason };
  };

  return {
    decide(msg, now) {
      const at = Number.isFinite(now) ? now : Date.now();
      const m = msg || {};
      const chatType = m.chatType === 'group' ? 'group' : (m.chatType === 'private' ? 'private' : m.chatType);
      const userId = m.userId === undefined || m.userId === null ? '' : String(m.userId);
      const groupId = m.groupId === undefined || m.groupId === null ? '' : String(m.groupId);

      // 判定顺序即优先级，reason 是 pipeline 的日志短码，不得改动字面量
      if (chatType === 'private') {
        if (!allowPrivate) return deny('chat_type_disabled');
      } else if (chatType === 'group') {
        if (!allowGroup) return deny('chat_type_disabled');
      } else {
        return deny('chat_type_disabled');
      }

      // 群聊里 userWhitelist 为空表示“不按人管”，只按群白名单管；一旦配了人就必须命中
      if (chatType === 'private') {
        if (userWhitelist.length > 0 && userWhitelist.indexOf(userId) === -1) return deny('user_not_allowed');
      } else if (userWhitelist.length > 0 && userWhitelist.indexOf(userId) === -1) {
        return deny('user_not_allowed');
      }

      if (chatType === 'group' && groupWhitelist.length > 0 && groupWhitelist.indexOf(groupId) === -1) {
        return deny('group_not_allowed');
      }

      if (chatType === 'group' && groupRequireAt) {
        const targets = atTargetsOf(m);
        const selfId = m.selfId === undefined || m.selfId === null ? '' : String(m.selfId);
        const targeted = targets.indexOf(ALL_AT) !== -1 || (selfId !== '' && targets.indexOf(selfId) !== -1);
        if (!targeted) return deny('need_at');
      }

      if (rateLimitPerMinute > 0) {
        const key = userId || 'unknown';
        const recent = (hits.get(key) || []).filter((t) => at - t < WINDOW_MS);
        if (recent.length >= rateLimitPerMinute) {
          hits.set(key, recent);
          return deny('rate_limited');
        }
        recent.push(at);
        hits.set(key, recent);
      }

      return { allow: true, reason: 'ok' };
    }
  };
}
