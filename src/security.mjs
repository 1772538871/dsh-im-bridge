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

// 必答词按"字符串包含"匹配，空白与重叠项先剔掉，否则日志里会出现命中空串
function keywordListOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = item === undefined || item === null ? '' : String(item).trim();
    if (text !== '' && out.indexOf(text) === -1) out.push(text);
  }
  return out;
}

function probabilityOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1 ? 1 : n;
}

// 群聊消息的正文：官方机器人事件里没有 text 字段，只有文本消息段
function textOf(msg) {
  const m = msg || {};
  if (typeof m.text === 'string') return m.text;
  const segments = Array.isArray(m.segments) ? m.segments : [];
  const parts = [];
  for (const seg of segments) {
    if (seg && seg.type === 'text' && seg.data && typeof seg.data.text === 'string') parts.push(seg.data.text);
  }
  return parts.join('');
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

  // 拟人层（social）：今天只做"被动接话"——消息来了才掷骰子。
  // 定时主动搭话是另一件事，需要自己的节流与静默判断，不往这里塞。
  const social = config.social || {};
  const mustReplyKeywords = keywordListOf(social.mustReplyKeywords);
  const replyProbability = probabilityOf(social.replyProbability);
  // 概率必须可注入：测试要确定性，生产才用真随机
  const random = typeof opts.random === 'function' ? opts.random : Math.random;

  const hits = new Map();

  const debug = (message) => {
    try {
      if (logger && typeof logger.debug === 'function') logger.debug(message);
    } catch {
      // 日志失败不影响判定
    }
  };

  // 官方机器人事件里没有 QQ 号，只有 openid；被拦下时把它打出来，用户才能把它加进白名单
  let currentUserId = '';

  const notice = (message) => {
    try {
      if (logger && typeof logger.info === 'function') logger.info(message);
    } catch {
      // 记不下来也不能影响判定
    }
  };

  const deny = (reason) => {
    debug('消息被拦截：' + reason);
    if (reason === 'user_not_allowed') notice('发送者不在白名单，已忽略：userId=' + currentUserId + '（把这个值加进 security.userWhitelist 才会放行）');
    return { allow: false, reason };
  };

  return {
    decide(msg, now) {
      const at = Number.isFinite(now) ? now : Date.now();
      const m = msg || {};
      const chatType = m.chatType === 'group' ? 'group' : (m.chatType === 'private' ? 'private' : m.chatType);
      const userId = m.userId === undefined || m.userId === null ? '' : String(m.userId);
      currentUserId = userId;
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
        if (!targeted) {
          // 必答词优先于 groupRequireAt：用户把这些词写进配置，就是"说到它我要在场"
          const hit = mustReplyKeywords.find((keyword) => textOf(m).indexOf(keyword) !== -1);
          if (hit !== undefined) {
            notice('群里出现必答词「' + hit + '」，没 @ 也回：userId=' + userId + ' groupId=' + groupId);
          } else if (replyProbability > 0 && random() < replyProbability) {
            // 概率接话只发生在"本来会被 need_at 拦掉"的这一刻，没有任何定时器参与
            debug('群聊没 @，按 social.replyProbability 接一句：userId=' + userId + ' groupId=' + groupId);
          } else {
            return deny('need_at');
          }
        }
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
