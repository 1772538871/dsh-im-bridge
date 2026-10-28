import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

// 插件自有配置：不进 profile patch，也没有 DSH 原生 configForms 依赖（契约 §0/§2）。
export const PLATFORM_IDS = ['qq-napcat', 'qq-official', 'wechat'];
export const SECRET_FIELDS = ['qqNapcat.accessToken', 'qqOfficial.appSecret'];
export const SECRET_MASK = '***';

const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
// headless=每条消息起一个 dsh 进程（稳，单次 ~5.3s）；sdk=常驻一个进程走 JSON-RPC（~1.2s/轮）；
// inprocess=直接在 DSH 主进程里建 Agent（最快，而且能把审批请求转发到 IM，但依赖 DSH 内部服务）
export const DSH_RUNNERS = ['headless', 'sdk', 'inprocess'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

export const DEFAULT_CONFIG = {
  enabled: false,
  platform: 'qq-napcat',
  // 「发送测试消息」的收件人。留空不是"发不出去"，而是让运行时按平台从白名单里猜一个，
  // 这样新手不必为了点一下测试按钮多填一项。
  testTarget: '',
  storage: { rootDir: 'E:\\dsh-im-bridge-data', maxFileBytes: 104857600, retentionDays: 30 },
  security: {
    userWhitelist: [],
    groupWhitelist: [],
    allowPrivate: true,
    allowGroup: true,
    groupRequireAt: true,
    rateLimitPerMinute: 6,
    maxConcurrentRuns: 2,
    maxPromptChars: 8000
  },
  reply: {
    maxChunkChars: 1500,
    errorPrefix: '[bridge] ',
    showSessionId: false,
    ack: true,
    progressEveryMs: 45000,
    progressMax: 2,
    // 拟人层：发送前按字数停顿（0=不等），封顶 3 秒，只作用于最终回复
    sendDelayMs: 0,
    sendDelayMaxMs: 3000,
    // 0=不限。超了先截断再分段，免得把被动回复次数用光
    maxReplyChars: 0
  },
  // 拟人层：群里没 @ 也接话。今天只做被动触发（消息到了才判断），没有定时器
  social: { mustReplyKeywords: [], replyProbability: 0 },
  // 只对 inprocess 有意义：把 DSH 的审批请求转发到 IM，超时按拒绝处理（5 分钟）
  approval: { enabled: true, timeoutMs: 300000, scope: 'own', chatKey: '' },
  // 只对 inprocess 有意义：把 DSH 的提问（ask_user_question 卡片）转发到 IM，超时按跳过处理，
  // 等多久跟审批共用 approval.timeoutMs——用户对"它会等我多久"只该记一个数字
  questions: { enabled: true },
  asr: { command: '', args: [], timeoutMs: 60000 },
  log: { dir: '', level: 'info' },
  qqNapcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', reconnectMinMs: 1000, reconnectMaxMs: 30000 },
  qqOfficial: { appId: '', appSecret: '', sandbox: true },
  dsh: {
    nodePath: '',
    binPath: '',
    profile: 'im-bridge',
    agentPreset: '',
    cwd: '',
    // 开启后每轮结束释放会话写句柄，网页才能点开这条会话看到历史
    releaseOnIdle: false,
    newSessionPerMessage: false,
    timeoutMs: 300000,
    permissionMode: 'workspace-write',
    // 默认保持 headless：不动现有行为，用户显式切到 sdk 才走常驻进程
    runner: 'headless',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high'
  }
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function defaultConfig() {
  return clone(DEFAULT_CONFIG);
}

function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

function isAbsolutePath(value) {
  if (typeof value !== 'string' || value === '') return false;
  return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isOnCDrive(value) {
  return typeof value === 'string' && /^[cC]:[\\/]/.test(value);
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

export function localDate(now = Date.now()) {
  const d = new Date(now);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/**
 * 配置路径：DSH_BOT_CONFIG 优先，其次 <DSH_HOME>/dsh-bot/config.json。
 * DSH_HOME 本身由 DSH 注入，缺省回落到 ~/.dsh（本机即 C:\\Users\\admin\\.dsh）。
 */
export function resolveConfigPath({ env = process.env, homeDir = '' } = {}) {
  const explicit = typeof env.DSH_BOT_CONFIG === 'string' ? env.DSH_BOT_CONFIG.trim() : '';
  if (explicit) return resolve(explicit);
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const home = fromEnv || homeDir || join(homedir(), '.dsh');
  return resolve(join(home, 'dsh-bot', 'config.json'));
}

/** 点路径读写：字段表（platforms.mjs）与掩码逻辑共用同一套 key 语法。 */
export function getByPath(source, dotted) {
  let cursor = source;
  for (const part of String(dotted).split('.')) {
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = cursor[part];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

function setByPath(target, dotted, value) {
  const parts = String(dotted).split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

/** GET /config 用：非空密钥一律换成 ***，空值原样保留（前端才知道"尚未配置"）。 */
export function maskSecrets(config) {
  const out = clone(isPlainObject(config) ? config : {});
  for (const path of SECRET_FIELDS) {
    const value = getByPath(out, path);
    if (typeof value === 'string' && value !== '') setByPath(out, path, SECRET_MASK);
  }
  return out;
}

/** POST /config 用：*** 表示"不修改"，用磁盘上的现值填回。 */
export function mergeSecretMasks(incoming, current) {
  const out = clone(isPlainObject(incoming) ? incoming : {});
  for (const path of SECRET_FIELDS) {
    const value = getByPath(out, path);
    if (value === SECRET_MASK) {
      const kept = getByPath(current, path);
      setByPath(out, path, typeof kept === 'string' ? kept : '');
    }
  }
  return out;
}

export function resolveLogDir(config) {
  const configured = isPlainObject(config?.log) && typeof config.log.dir === 'string' ? config.log.dir.trim() : '';
  if (configured) return configured;
  const rootDir = isPlainObject(config?.storage) && typeof config.storage.rootDir === 'string' ? config.storage.rootDir : '';
  return rootDir ? join(rootDir, 'logs') : '';
}

/**
 * /logs/tail 的落点判定（纯函数，便于单测）：日志目录必须落在 <rootDir>/logs 之内，
 * 任何配置或参数带来的越界都在这里被挡下，调用方拿到 ok:false 后只回 200+{ok:false}。
 */
export function resolveLogFile(config, { file = '', now = Date.now() } = {}) {
  const rootDir = isPlainObject(config?.storage) && typeof config.storage.rootDir === 'string' ? config.storage.rootDir : '';
  if (!rootDir) return { ok: false, error: '未配置 storage.rootDir，无法定位日志目录' };
  const logRoot = resolve(rootDir, 'logs');
  const logDir = resolve(resolveLogDir(config) || logRoot);
  const within = (target) => {
    const abs = resolve(target);
    return abs === logRoot || abs.startsWith(logRoot + sep);
  };
  if (!within(logDir)) return { ok: false, error: '日志目录不在 ' + logRoot + ' 下，拒绝读取' };
  const name = typeof file === 'string' ? file.trim() : '';
  if (name !== '' && (name.includes('..') || name.includes('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name))) {
    return { ok: false, error: '非法的日志文件名：' + name };
  }
  const target = name === '' ? resolve(logDir, 'bridge-' + localDate(now) + '.log') : resolve(logDir, name);
  if (!within(target)) return { ok: false, error: '路径越界，拒绝读取：' + target };
  return { ok: true, file: target, dir: logDir, root: logRoot };
}

/**
 * 归一化 = 合并默认值 + 逐字段校验。永远返回可用的 config：
 * 校验失败只进 problems（POST 时据其拒盘），读取路径绝不因为一个坏字段整体不可用。
 */
export function normalizeConfig(raw, options = {}) {
  const baseDir = typeof options.baseDir === 'string' && options.baseDir !== '' ? options.baseDir : process.cwd();
  const problems = [];
  const warnings = [];
  const src = isPlainObject(raw) ? raw : {};

  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    problems.push('配置根节点必须是 JSON 对象，当前为 ' + JSON.stringify(raw));
  }

  const section = (key) => {
    const value = src[key];
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) {
      problems.push(key + ' 必须是对象，当前为 ' + JSON.stringify(value));
      return {};
    }
    return value;
  };

  const readBool = (obj, name, key, def) => {
    const value = obj[key];
    if (value === undefined || value === null) return def;
    if (typeof value !== 'boolean') {
      problems.push(name + ' 必须是 true/false，当前为 ' + JSON.stringify(value));
      return def;
    }
    return value;
  };

  const readInt = (obj, name, key, def, min) => {
    const value = obj[key];
    if (value === undefined || value === null || value === '') return def;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      problems.push(name + ' 必须是数字，当前为 ' + JSON.stringify(value));
      return def;
    }
    if (n < min) {
      problems.push(name + ' 不能小于 ' + min + '，当前为 ' + n);
      return def;
    }
    return Math.floor(n);
  };

  const readText = (obj, name, key, def, trim = false) => {
    const value = obj[key];
    if (value === undefined || value === null) return def;
    if (typeof value !== 'string') {
      problems.push(name + ' 必须是字符串，当前为 ' + JSON.stringify(value));
      return def;
    }
    return trim ? value.trim() : value;
  };

  // 概率用浮点，不能用 readInt（它会把 0.3 压成 0，等于把功能悄悄关掉）
  const readProbability = (obj, name, key, def) => {
    const value = obj[key];
    if (value === undefined || value === null || value === '') return def;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      problems.push(name + ' 必须是 0~1 之间的数字，当前为 ' + JSON.stringify(value));
      return def;
    }
    if (n < 0 || n > 1) {
      problems.push(name + ' 必须在 0~1 之间，当前为 ' + n);
      return def;
    }
    return n;
  };

  const readList = (obj, name, key, def) => {
    const value = obj[key];
    if (value === undefined || value === null) return def.slice();
    if (!Array.isArray(value)) {
      problems.push(name + ' 必须是数组，当前为 ' + JSON.stringify(value));
      return def.slice();
    }
    const out = [];
    for (const item of value) {
      if (typeof item === 'number' && Number.isFinite(item)) {
        out.push(String(item));
        continue;
      }
      if (typeof item !== 'string') {
        problems.push(name + ' 只能是字符串数组，已忽略 ' + JSON.stringify(item));
        continue;
      }
      const text = item.trim();
      // 前端"一行一个 QQ 号"的多行框清空后常留空行，空值直接丢弃而不是报错
      if (text !== '') out.push(text);
    }
    return out;
  };

  const readPath = (obj, name, key, def) => {
    const value = obj[key];
    if (value === undefined || value === null || value === '') return def;
    if (typeof value !== 'string') {
      problems.push(name + ' 必须是字符串路径，当前为 ' + JSON.stringify(value));
      return def;
    }
    const text = value.trim();
    if (text === '') return def;
    if (isAbsolutePath(text)) return resolve(text);
    const abs = resolve(baseDir, text);
    warnings.push(name + ' 是相对路径 ' + text + '，已按配置文件所在目录解析为 ' + abs);
    return abs;
  };

  const storageRaw = section('storage');
  const securityRaw = section('security');
  const replyRaw = section('reply');
  const socialRaw = section('social');
  const approvalRaw = section('approval');
  const questionsRaw = section('questions');
  const asrRaw = section('asr');
  const logRaw = section('log');
  const napcatRaw = section('qqNapcat');
  const officialRaw = section('qqOfficial');
  const dshRaw = section('dsh');

  const platform = readText(src, 'platform', 'platform', DEFAULT_CONFIG.platform, true);
  if (PLATFORM_IDS.indexOf(platform) === -1) {
    problems.push('platform 必须是 ' + PLATFORM_IDS.join(' / ') + ' 之一，当前为 ' + JSON.stringify(platform));
  }

  // 新装没有文件时也给出契约 §2 里的默认数据目录，用户只需改这一个字段就能跑起来
  const rootDir = readPath(storageRaw, 'storage.rootDir', 'rootDir', DEFAULT_CONFIG.storage.rootDir);
  if (!rootDir) {
    problems.push('storage.rootDir 必填：需要一个绝对路径（例如 E:\\dsh-im-bridge-data）');
  }
  const logDir = readPath(logRaw, 'log.dir', 'dir', '');
  const logLevel = readText(logRaw, 'log.level', 'level', DEFAULT_CONFIG.log.level, true);
  if (LOG_LEVELS.indexOf(logLevel) === -1) {
    problems.push('log.level 必须是 ' + LOG_LEVELS.join(' / ') + ' 之一，当前为 ' + JSON.stringify(logLevel));
  }

  const wsUrl = readText(napcatRaw, 'qqNapcat.wsUrl', 'wsUrl', DEFAULT_CONFIG.qqNapcat.wsUrl, true);
  if (!/^wss?:\/\//i.test(wsUrl)) {
    problems.push('qqNapcat.wsUrl 必须以 ws:// 或 wss:// 开头，当前为 ' + JSON.stringify(wsUrl));
  }

  const profile = readText(dshRaw, 'dsh.profile', 'profile', DEFAULT_CONFIG.dsh.profile, true);
  if (!profile) problems.push('dsh.profile 不能为空');

  const runner = readText(dshRaw, 'dsh.runner', 'runner', DEFAULT_CONFIG.dsh.runner, true);
  if (DSH_RUNNERS.indexOf(runner) === -1) {
    problems.push('dsh.runner 必须是 ' + DSH_RUNNERS.join(' / ') + ' 之一，当前为 ' + JSON.stringify(runner));
  }

  // provider/model 只在 sdk 模式下用，但空值同样是配置错误：sdk 模式会拿它去握手
  const provider = readText(dshRaw, 'dsh.provider', 'provider', DEFAULT_CONFIG.dsh.provider, true);
  if (provider === '') problems.push('dsh.provider 不能为空（例如 deepseek-official）');
  const model = readText(dshRaw, 'dsh.model', 'model', DEFAULT_CONFIG.dsh.model, true);
  if (model === '') problems.push('dsh.model 不能为空（例如 deepseek-flash）');
  const reasoningEffort = readText(dshRaw, 'dsh.reasoningEffort', 'reasoningEffort', DEFAULT_CONFIG.dsh.reasoningEffort, true);

  let permissionMode = readText(dshRaw, 'dsh.permissionMode', 'permissionMode', DEFAULT_CONFIG.dsh.permissionMode, true);
  if (PERMISSION_MODES.indexOf(permissionMode) === -1) {
    problems.push('dsh.permissionMode 必须是 ' + PERMISSION_MODES.join(' / ') + ' 之一，当前为 ' + JSON.stringify(permissionMode));
    permissionMode = DEFAULT_CONFIG.dsh.permissionMode;
  } else if (permissionMode === 'danger-full-access') {
    // 契约 §0：bot 永远只拿 workspace-write，配置里出现更高权限一律拒绝
    problems.push('dsh.permissionMode 不允许 danger-full-access：bot 只允许 read-only / workspace-write');
    permissionMode = DEFAULT_CONFIG.dsh.permissionMode;
  }

  const config = {
    enabled: readBool(src, 'enabled', 'enabled', DEFAULT_CONFIG.enabled),
    platform: PLATFORM_IDS.indexOf(platform) === -1 ? DEFAULT_CONFIG.platform : platform,
    testTarget: readText(src, 'testTarget', 'testTarget', DEFAULT_CONFIG.testTarget, true),
    storage: {
      rootDir,
      maxFileBytes: readInt(storageRaw, 'storage.maxFileBytes', 'maxFileBytes', DEFAULT_CONFIG.storage.maxFileBytes, 1),
      retentionDays: readInt(storageRaw, 'storage.retentionDays', 'retentionDays', DEFAULT_CONFIG.storage.retentionDays, 1)
    },
    security: {
      userWhitelist: readList(securityRaw, 'security.userWhitelist', 'userWhitelist', DEFAULT_CONFIG.security.userWhitelist),
      groupWhitelist: readList(securityRaw, 'security.groupWhitelist', 'groupWhitelist', DEFAULT_CONFIG.security.groupWhitelist),
      allowPrivate: readBool(securityRaw, 'security.allowPrivate', 'allowPrivate', DEFAULT_CONFIG.security.allowPrivate),
      allowGroup: readBool(securityRaw, 'security.allowGroup', 'allowGroup', DEFAULT_CONFIG.security.allowGroup),
      groupRequireAt: readBool(securityRaw, 'security.groupRequireAt', 'groupRequireAt', DEFAULT_CONFIG.security.groupRequireAt),
      rateLimitPerMinute: readInt(securityRaw, 'security.rateLimitPerMinute', 'rateLimitPerMinute', DEFAULT_CONFIG.security.rateLimitPerMinute, 0),
      maxConcurrentRuns: readInt(securityRaw, 'security.maxConcurrentRuns', 'maxConcurrentRuns', DEFAULT_CONFIG.security.maxConcurrentRuns, 1),
      maxPromptChars: readInt(securityRaw, 'security.maxPromptChars', 'maxPromptChars', DEFAULT_CONFIG.security.maxPromptChars, 1)
    },
    reply: {
      maxChunkChars: readInt(replyRaw, 'reply.maxChunkChars', 'maxChunkChars', DEFAULT_CONFIG.reply.maxChunkChars, 1),
      errorPrefix: readText(replyRaw, 'reply.errorPrefix', 'errorPrefix', DEFAULT_CONFIG.reply.errorPrefix),
      showSessionId: readBool(replyRaw, 'reply.showSessionId', 'showSessionId', DEFAULT_CONFIG.reply.showSessionId),
      ack: readBool(replyRaw, 'reply.ack', 'ack', DEFAULT_CONFIG.reply.ack),
      progressEveryMs: readInt(replyRaw, 'reply.progressEveryMs', 'progressEveryMs', DEFAULT_CONFIG.reply.progressEveryMs, 0),
      progressMax: readInt(replyRaw, 'reply.progressMax', 'progressMax', DEFAULT_CONFIG.reply.progressMax, 0),
      sendDelayMs: readInt(replyRaw, 'reply.sendDelayMs', 'sendDelayMs', DEFAULT_CONFIG.reply.sendDelayMs, 0),
      sendDelayMaxMs: readInt(replyRaw, 'reply.sendDelayMaxMs', 'sendDelayMaxMs', DEFAULT_CONFIG.reply.sendDelayMaxMs, 0),
      maxReplyChars: readInt(replyRaw, 'reply.maxReplyChars', 'maxReplyChars', DEFAULT_CONFIG.reply.maxReplyChars, 0)
    },
    social: {
      mustReplyKeywords: readList(socialRaw, 'social.mustReplyKeywords', 'mustReplyKeywords', DEFAULT_CONFIG.social.mustReplyKeywords),
      replyProbability: readProbability(
        socialRaw,
        'social.replyProbability',
        'replyProbability',
        DEFAULT_CONFIG.social.replyProbability
      )
    },
    approval: {
      enabled: readBool(approvalRaw, 'approval.enabled', 'enabled', DEFAULT_CONFIG.approval.enabled),
      // 低于 10 秒的等待窗口没有意义：用户还没看清问题就已经超时了
      timeoutMs: readInt(approvalRaw, 'approval.timeoutMs', 'timeoutMs', DEFAULT_CONFIG.approval.timeoutMs, 10000),
      scope: readText(approvalRaw, 'approval.scope', 'scope', DEFAULT_CONFIG.approval.scope) === 'all' ? 'all' : 'own',
      chatKey: readText(approvalRaw, 'approval.chatKey', 'chatKey', DEFAULT_CONFIG.approval.chatKey)
    },
    questions: {
      enabled: readBool(questionsRaw, 'questions.enabled', 'enabled', DEFAULT_CONFIG.questions.enabled)
    },
    asr: {
      command: readText(asrRaw, 'asr.command', 'command', DEFAULT_CONFIG.asr.command),
      args: readList(asrRaw, 'asr.args', 'args', DEFAULT_CONFIG.asr.args),
      timeoutMs: readInt(asrRaw, 'asr.timeoutMs', 'timeoutMs', DEFAULT_CONFIG.asr.timeoutMs, 1000)
    },
    log: { dir: logDir, level: LOG_LEVELS.indexOf(logLevel) === -1 ? DEFAULT_CONFIG.log.level : logLevel },
    qqNapcat: {
      wsUrl,
      accessToken: readText(napcatRaw, 'qqNapcat.accessToken', 'accessToken', DEFAULT_CONFIG.qqNapcat.accessToken),
      reconnectMinMs: readInt(napcatRaw, 'qqNapcat.reconnectMinMs', 'reconnectMinMs', DEFAULT_CONFIG.qqNapcat.reconnectMinMs, 0),
      reconnectMaxMs: readInt(napcatRaw, 'qqNapcat.reconnectMaxMs', 'reconnectMaxMs', DEFAULT_CONFIG.qqNapcat.reconnectMaxMs, 0)
    },
    qqOfficial: {
      appId: readText(officialRaw, 'qqOfficial.appId', 'appId', DEFAULT_CONFIG.qqOfficial.appId, true),
      appSecret: readText(officialRaw, 'qqOfficial.appSecret', 'appSecret', DEFAULT_CONFIG.qqOfficial.appSecret, true),
      sandbox: readBool(officialRaw, 'qqOfficial.sandbox', 'sandbox', DEFAULT_CONFIG.qqOfficial.sandbox)
    },
    dsh: { releaseOnIdle: false,
      nodePath: readPath(dshRaw, 'dsh.nodePath', 'nodePath', DEFAULT_CONFIG.dsh.nodePath),
      binPath: readPath(dshRaw, 'dsh.binPath', 'binPath', DEFAULT_CONFIG.dsh.binPath),
      profile,
      agentPreset: readText(dshRaw, 'dsh.agentPreset', 'agentPreset', ''),
      cwd: readPath(dshRaw, 'dsh.cwd', 'cwd', ''),
      timeoutMs: readInt(dshRaw, 'dsh.timeoutMs', 'timeoutMs', DEFAULT_CONFIG.dsh.timeoutMs, 1000),
      permissionMode,
      runner: DSH_RUNNERS.indexOf(runner) === -1 ? DEFAULT_CONFIG.dsh.runner : runner,
      provider,
      model,
      reasoningEffort
    }
  };

  // 用户规则：产线数据不进 C 盘，只告警不阻断
  if (isOnCDrive(config.storage.rootDir)) {
    warnings.push('storage.rootDir 落在 C 盘：' + config.storage.rootDir + '，不符合"产线数据不进 C 盘"的规则，建议改到 D:/E: 盘的绝对路径');
  }
  if (isOnCDrive(config.log.dir)) {
    warnings.push('log.dir 落在 C 盘：' + config.log.dir + '，不符合"产线数据不进 C 盘"的规则，建议改到 D:/E: 盘的绝对路径');
  }

  // 安全底线：核心库对空白名单的语义是"不按人管"（放行所有人），插件层必须在这里给出可见警告
  if (config.security.userWhitelist.length === 0 && config.security.groupWhitelist.length === 0) {
    warnings.push('白名单为空：启动会被拒绝。至少填写你自己的 QQ 号（security.userWhitelist），否则任何人给机器人发消息都能驱动本机 DSH');
  }

  return { config, problems, warnings };
}

export function createConfigStore({ env = process.env, filePath = '', homeDir = '', logger = null } = {}) {
  const configPath = typeof filePath === 'string' && filePath.trim() !== '' ? resolve(filePath.trim()) : resolveConfigPath({ env, homeDir });

  const warn = (message) => {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(message);
    } catch {
      // 日志失败不能影响配置读取
    }
  };

  /** 每次读盘：settings 页可能手改文件，缓存只会带来"改了不生效"的迷惑。 */
  function read() {
    const warnings = [];
    let raw = {};
    let corrupt = false;
    const exists = existsSync(configPath);

    if (!exists) {
      warnings.push('配置文件不存在，已使用默认值（保存后自动创建）：' + configPath);
    } else {
      let text = '';
      let readFailed = false;
      try {
        text = readFileSync(configPath, 'utf8');
      } catch (error) {
        readFailed = true;
        warnings.push('配置文件读取失败（' + errorText(error) + '），本次按默认值运行：' + configPath);
      }
      if (!readFailed) {
        const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
        try {
          const parsed = JSON.parse(body);
          if (!isPlainObject(parsed)) throw new Error('根节点不是对象');
          raw = parsed;
        } catch (error) {
          corrupt = true;
          const backup = configPath + '.corrupt';
          try {
            copyFileSync(configPath, backup);
            warnings.push('配置文件已损坏（' + errorText(error) + '），已备份到 ' + backup + '，本次从默认值起步');
          } catch (copyError) {
            warnings.push('配置文件已损坏且备份失败（' + errorText(copyError) + '），本次从默认值起步');
          }
          raw = {};
        }
      }
    }

    const norm = normalizeConfig(raw, { baseDir: dirname(configPath), env });
    return {
      config: norm.config,
      warnings: warnings.concat(norm.warnings),
      problems: norm.problems,
      configPath,
      exists,
      corrupt
    };
  }

  async function save(raw) {
    const norm = normalizeConfig(raw, { baseDir: dirname(configPath), env });
    if (norm.problems.length > 0) {
      return { ok: false, error: '配置校验失败', problems: norm.problems, configPath };
    }
    const payload = JSON.stringify(norm.config, null, 2) + '\n';
    const tmp = configPath + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
    try {
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(tmp, payload, 'utf8');
      // tmp + rename：设置页连续保存时，读到的永远是一份完整 JSON
      await rename(tmp, configPath);
    } catch (error) {
      try {
        await unlink(tmp);
      } catch {
        // 临时文件可能根本没建出来
      }
      warn('dsh-bot 配置写入失败：' + errorText(error));
      return { ok: false, error: '写入配置文件失败：' + errorText(error), configPath };
    }
    return { ok: true, config: norm.config, warnings: norm.warnings, configPath };
  }

  return {
    path: configPath,
    read,
    save,
    mask: maskSecrets,
    applySecretMasks: mergeSecretMasks,
    defaults: defaultConfig
  };
}
