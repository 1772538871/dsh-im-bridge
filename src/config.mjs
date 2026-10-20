import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const CONFIG_NAME = 'bridge.config.json';
const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

const DEFAULTS = {
  onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', reconnectMinMs: 1000, reconnectMaxMs: 30000 },
  dsh: { profile: 'im-bridge', timeoutMs: 300000, permissionMode: 'workspace-write' },
  storage: { maxFileBytes: 104857600, retentionDays: 30 },
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
  reply: { maxChunkChars: 1500, errorPrefix: '[bridge] ', showSessionId: false },
  asr: { command: '', args: [], timeoutMs: 60000 },
  log: { level: 'info' }
};

export class ConfigError extends Error {
  constructor(problems, filePath = '') {
    const list = (Array.isArray(problems) ? problems : [String(problems === undefined ? '未知配置错误' : problems)]).filter(Boolean);
    super('配置错误' + (filePath ? '（' + filePath + '）' : '') + '：\n- ' + list.join('\n- '));
    this.name = 'ConfigError';
    this.problems = list;
    if (filePath) this.filePath = filePath;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isOnCDrive(p) {
  if (typeof p !== 'string' || p.length < 3) return false;
  if (p[1] !== ':') return false;
  const d = p[0];
  return d === 'C' || d === 'c';
}

function isAbsolutePath(p) {
  return isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

// 配置文件允许注释与尾逗号：手写配置里 "为什么这么配" 比 JSON 的纯净更有价值，
// 而 ws:// 这类字符串里的双斜杠必须原样保留，所以只能逐字符扫描而不能用正则。
function stripJsonComments(text) {
  const src = String(text);
  const n = src.length;
  let out = '';
  let i = 0;
  let inString = false;
  while (i < n) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += src[i + 1] === undefined ? '' : src[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      let closing = false;
      while (j < n) {
        const d = src[j];
        if (d === ' ' || d === '\t' || d === '\r' || d === '\n') {
          j += 1;
          continue;
        }
        if (d === '/' && src[j + 1] === '/') {
          while (j < n && src[j] !== '\n') j += 1;
          continue;
        }
        if (d === '/' && src[j + 1] === '*') {
          j += 2;
          while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
          j += 2;
          continue;
        }
        closing = d === '}' || d === ']';
        break;
      }
      if (closing) {
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

// dsh 的入口没有稳定约定（本机是 lib/bin.js），只能按候选表探测；
// 探测不到就留空，交给 --check 报错，而不是猜一个可能跑错的路径。
function findDshBin(env, warnings) {
  const fromEnv = typeof env.DSH_BIN === 'string' ? env.DSH_BIN.trim() : '';
  if (fromEnv) {
    if (existsSync(fromEnv)) return resolve(fromEnv);
    warnings.push('环境变量 DSH_BIN 指向的路径不存在：' + fromEnv + '（已忽略，继续自动查找）');
  }
  const home = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const roots = [];
  if (home) {
    roots.push(resolve(home, '..', 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
    roots.push(join(home, 'node_modules', '@deepseek-ai', 'dsh'));
  }
  // npm 全局安装常把包放在 node 可执行文件旁边，顺手探一下，省得用户再配 DSH_BIN
  roots.push(join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'));
  const rels = ['lib/bin.js', 'bin/dsh.mjs', 'bin/dsh.js', 'cli.mjs', 'index.mjs'];
  for (const r of roots) {
    for (const rel of rels) {
      const p = join(r, rel);
      if (existsSync(p)) return p;
    }
  }
  return '';
}

function normalize(raw, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const baseDir = opts.baseDir || process.cwd();
  const problems = [];
  const warnings = [];

  let src = raw;
  if (!isPlainObject(src)) {
    problems.push('配置文件根节点必须是 JSON 对象，当前为 ' + JSON.stringify(src));
    src = {};
  }

  const section = (key) => {
    const v = src[key];
    if (v === undefined || v === null) return {};
    if (!isPlainObject(v)) {
      problems.push(key + ' 必须是对象，当前为 ' + JSON.stringify(v));
      return {};
    }
    return v;
  };

  const num = (rawObj, name, key, def, min) => {
    const v = rawObj[key];
    if (v === undefined || v === null) return def;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      problems.push(name + '.' + key + ' 必须是数字，当前为 ' + JSON.stringify(v));
      return def;
    }
    if (n < min) {
      problems.push(name + '.' + key + ' 不能小于 ' + min + '，当前为 ' + n);
      return def;
    }
    return Math.floor(n);
  };

  const bool = (rawObj, name, key, def) => {
    const v = rawObj[key];
    if (v === undefined || v === null) return def;
    if (typeof v === 'boolean') return v;
    problems.push(name + '.' + key + ' 必须是 true/false，当前为 ' + JSON.stringify(v));
    return def;
  };

  const text = (rawObj, name, key, def) => {
    const v = rawObj[key];
    if (v === undefined || v === null) return def;
    if (typeof v !== 'string') {
      problems.push(name + '.' + key + ' 必须是字符串，当前为 ' + JSON.stringify(v));
      return def;
    }
    return v;
  };

  const list = (rawObj, name, key, def) => {
    const v = rawObj[key];
    if (v === undefined || v === null) return def.slice();
    if (!Array.isArray(v)) {
      problems.push(name + '.' + key + ' 必须是数组，当前为 ' + JSON.stringify(v));
      return def.slice();
    }
    const out = [];
    for (const item of v) {
      const s = typeof item === 'string' ? item.trim() : (typeof item === 'number' ? String(item) : '');
      if (!s) {
        problems.push(name + '.' + key + ' 含空值或非字符串项，已忽略该项');
        continue;
      }
      out.push(s);
    }
    return out;
  };

  const absPath = (rawObj, name, key, fallback) => {
    const raw0 = rawObj[key];
    if (raw0 === undefined || raw0 === null) return fallback;
    if (typeof raw0 !== 'string') {
      problems.push(name + '.' + key + ' 必须是字符串路径，当前为 ' + JSON.stringify(raw0));
      return fallback;
    }
    const v = raw0.trim();
    if (!v) return fallback;
    if (isAbsolutePath(v)) return resolve(v);
    const abs = resolve(baseDir, v);
    warnings.push(name + ' 是相对路径 ' + v + '，已按配置文件所在目录解析为 ' + abs);
    return abs;
  };

  const onebotRaw = section('onebot');
  const dshRaw = section('dsh');
  const storageRaw = section('storage');
  const securityRaw = section('security');
  const replyRaw = section('reply');
  const asrRaw = section('asr');
  const logRaw = section('log');

  const wsUrl = text(onebotRaw, 'onebot', 'wsUrl', DEFAULTS.onebot.wsUrl).trim();
  if (!/^wss?:\/\//i.test(wsUrl)) {
    problems.push('onebot.wsUrl 必须以 ws:// 或 wss:// 开头，当前为 ' + JSON.stringify(wsUrl));
  }

  const rootDir = absPath(storageRaw, 'storage', 'rootDir', '');
  if (!rootDir) {
    problems.push('storage.rootDir 必填：需要一个绝对路径（例如 E:\\dsh-im-bridge-data）');
  }

  const logDir = absPath(logRaw, 'log', 'dir', rootDir ? join(rootDir, 'logs') : '');
  const workspaceFallback = rootDir ? join(rootDir, 'workspace') : '';
  const dshCwd = absPath(dshRaw, 'dsh', 'cwd', workspaceFallback);
  const nodePath = absPath(dshRaw, 'dsh', 'nodePath', process.execPath);
  let binPath = absPath(dshRaw, 'dsh', 'binPath', '');
  if (!binPath) binPath = findDshBin(env, warnings);
  if (!binPath) {
    warnings.push('dsh.binPath 未能确定：请设置环境变量 DSH_BIN 或在配置里写 dsh.binPath 的绝对路径；--check 会判定为错误');
  }

  const profile = text(dshRaw, 'dsh', 'profile', DEFAULTS.dsh.profile).trim();
  if (!profile) problems.push('dsh.profile 不能为空');

  const permissionMode = text(dshRaw, 'dsh', 'permissionMode', DEFAULTS.dsh.permissionMode).trim();
  if (PERMISSION_MODES.indexOf(permissionMode) === -1) {
    problems.push('dsh.permissionMode 必须是 ' + PERMISSION_MODES.join(' / ') + ' 之一，当前为 ' + JSON.stringify(permissionMode));
  }

  const dshEnv = {};
  if (dshRaw.env !== undefined && dshRaw.env !== null) {
    if (!isPlainObject(dshRaw.env)) {
      problems.push('dsh.env 必须是对象，当前为 ' + JSON.stringify(dshRaw.env));
    } else {
      for (const k of Object.keys(dshRaw.env)) {
        const v = dshRaw.env[k];
        if (v === undefined || v === null) continue;
        dshEnv[k] = typeof v === 'string' ? v : String(v);
      }
    }
  }

  const logLevel = text(logRaw, 'log', 'level', DEFAULTS.log.level).trim();
  if (LOG_LEVELS.indexOf(logLevel) === -1) {
    problems.push('log.level 必须是 ' + LOG_LEVELS.join(' / ') + ' 之一，当前为 ' + JSON.stringify(logLevel));
  }

  const config = {
    onebot: {
      wsUrl,
      accessToken: text(onebotRaw, 'onebot', 'accessToken', DEFAULTS.onebot.accessToken),
      reconnectMinMs: num(onebotRaw, 'onebot', 'reconnectMinMs', DEFAULTS.onebot.reconnectMinMs, 0),
      reconnectMaxMs: num(onebotRaw, 'onebot', 'reconnectMaxMs', DEFAULTS.onebot.reconnectMaxMs, 0)
    },
    dsh: {
      nodePath,
      binPath,
      profile,
      cwd: dshCwd,
      timeoutMs: num(dshRaw, 'dsh', 'timeoutMs', DEFAULTS.dsh.timeoutMs, 1000),
      permissionMode,
      env: dshEnv
    },
    storage: {
      rootDir,
      maxFileBytes: num(storageRaw, 'storage', 'maxFileBytes', DEFAULTS.storage.maxFileBytes, 1),
      retentionDays: num(storageRaw, 'storage', 'retentionDays', DEFAULTS.storage.retentionDays, 1)
    },
    security: {
      userWhitelist: list(securityRaw, 'security', 'userWhitelist', DEFAULTS.security.userWhitelist),
      groupWhitelist: list(securityRaw, 'security', 'groupWhitelist', DEFAULTS.security.groupWhitelist),
      allowPrivate: bool(securityRaw, 'security', 'allowPrivate', DEFAULTS.security.allowPrivate),
      allowGroup: bool(securityRaw, 'security', 'allowGroup', DEFAULTS.security.allowGroup),
      groupRequireAt: bool(securityRaw, 'security', 'groupRequireAt', DEFAULTS.security.groupRequireAt),
      rateLimitPerMinute: num(securityRaw, 'security', 'rateLimitPerMinute', DEFAULTS.security.rateLimitPerMinute, 0),
      maxConcurrentRuns: num(securityRaw, 'security', 'maxConcurrentRuns', DEFAULTS.security.maxConcurrentRuns, 1),
      maxPromptChars: num(securityRaw, 'security', 'maxPromptChars', DEFAULTS.security.maxPromptChars, 1)
    },
    reply: {
      maxChunkChars: num(replyRaw, 'reply', 'maxChunkChars', DEFAULTS.reply.maxChunkChars, 1),
      errorPrefix: text(replyRaw, 'reply', 'errorPrefix', DEFAULTS.reply.errorPrefix),
      showSessionId: bool(replyRaw, 'reply', 'showSessionId', DEFAULTS.reply.showSessionId)
    },
    asr: {
      command: text(asrRaw, 'asr', 'command', DEFAULTS.asr.command),
      args: list(asrRaw, 'asr', 'args', DEFAULTS.asr.args),
      timeoutMs: num(asrRaw, 'asr', 'timeoutMs', DEFAULTS.asr.timeoutMs, 1000)
    },
    log: {
      dir: logDir,
      level: logLevel
    }
  };

  // 用户规则：产线数据不进 C 盘，命中只告警不阻断（有人确实只在 C 盘上有可写目录）。
  if (isOnCDrive(rootDir)) {
    warnings.push('storage.rootDir 落在 C 盘：' + rootDir + '，不符合“产线数据不进 C 盘”的规则，建议改到 D:/E: 盘的绝对路径');
  }
  if (logDir && isOnCDrive(logDir)) {
    warnings.push('log.dir 落在 C 盘：' + logDir + '，不符合“产线数据不进 C 盘”的规则，建议改到 D:/E: 盘的绝对路径');
  }

  return { config, warnings, problems };
}

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function onOff(v) {
  return v ? '开' : '关';
}

function count(v) {
  return Array.isArray(v) ? v.length : 0;
}

export function resolveConfigPath(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  if (typeof opts.filePath === 'string' && opts.filePath.trim()) return resolve(opts.filePath.trim());
  if (typeof env.DSH_BRIDGE_CONFIG === 'string' && env.DSH_BRIDGE_CONFIG.trim()) {
    return resolve(env.DSH_BRIDGE_CONFIG.trim());
  }
  return resolve(process.cwd(), CONFIG_NAME);
}

export function loadConfig(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const filePath = resolveConfigPath({ filePath: opts.filePath, env });
  if (!existsSync(filePath)) {
    throw new ConfigError(['配置文件不存在：' + filePath + '（用 --config 或环境变量 DSH_BRIDGE_CONFIG 指定）'], filePath);
  }
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(['配置文件读取失败：' + (err && err.message ? err.message : String(err))], filePath);
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let raw;
  try {
    raw = JSON.parse(stripJsonComments(body));
  } catch (err) {
    throw new ConfigError(['配置文件不是合法 JSON：' + (err && err.message ? err.message : String(err))], filePath);
  }
  const norm = normalize(raw, { env, baseDir: dirname(filePath) });
  if (norm.problems.length > 0) throw new ConfigError(norm.problems, filePath);
  return { config: norm.config, warnings: norm.warnings, filePath };
}

export function validateConfig(raw, options) {
  const opts = options || {};
  const norm = normalize(raw, { env: opts.env || process.env, baseDir: opts.baseDir || process.cwd() });
  const problems = norm.problems.slice();
  const { config } = norm;
  if (!config.dsh.binPath) {
    problems.push('dsh.binPath 为空：找不到 dsh 入口，请设置环境变量 DSH_BIN 或在配置里写 dsh.binPath 的绝对路径');
  } else if (!existsSync(config.dsh.binPath)) {
    problems.push('dsh.binPath 指向的文件不存在：' + config.dsh.binPath);
  }
  if (config.dsh.nodePath && !existsSync(config.dsh.nodePath)) {
    problems.push('dsh.nodePath 指向的文件不存在：' + config.dsh.nodePath);
  }
  return { ok: problems.length === 0, problems, config };
}

export function formatConfigSummary(config) {
  const c = config || {};
  const ob = c.onebot || {};
  const dsh = c.dsh || {};
  const st = c.storage || {};
  const sec = c.security || {};
  const rp = c.reply || {};
  const lg = c.log || {};
  const asr = c.asr || {};
  const lines = [];
  lines.push('dsh-im-bridge 配置摘要');
  lines.push('  OneBot    : ' + ob.wsUrl + '（accessToken ' + (ob.accessToken ? '已配置' : '未配置') + '，重连 ' + ob.reconnectMinMs + '-' + ob.reconnectMaxMs + 'ms）');
  lines.push('  dsh 入口  : node=' + (dsh.nodePath || '(未配置)'));
  lines.push('              bin =' + (dsh.binPath || '(未配置)'));
  lines.push('  dsh 参数  : profile=' + dsh.profile + '，permissionMode=' + dsh.permissionMode + '，超时=' + Math.round((dsh.timeoutMs || 0) / 1000) + 's');
  lines.push('  工作目录  : ' + (dsh.cwd || '(未配置)'));
  lines.push('  数据目录  : ' + (st.rootDir || '(未配置)') + '（单文件上限 ' + formatBytes(st.maxFileBytes) + '，保留 ' + st.retentionDays + ' 天）');
  lines.push('  日志      : ' + (lg.dir || '(仅 stderr)') + '（level=' + lg.level + '）');
  lines.push('  聊天开关  : 私聊=' + onOff(sec.allowPrivate) + '，群聊=' + onOff(sec.allowGroup) + '，群内需 @=' + onOff(sec.groupRequireAt));
  lines.push('  白名单    : 用户 ' + count(sec.userWhitelist) + ' 个，群 ' + count(sec.groupWhitelist) + ' 个');
  lines.push('  并发/限流 : 最大并发 ' + sec.maxConcurrentRuns + '，每人每分钟 ' + sec.rateLimitPerMinute + ' 条，prompt 上限 ' + sec.maxPromptChars + ' 字符');
  lines.push('  回复      : 每段 ' + rp.maxChunkChars + ' 字符，错误前缀 ' + JSON.stringify(rp.errorPrefix) + '，显示会话 id=' + onOff(rp.showSessionId));
  lines.push('  语音识别  : ' + (asr.command ? asr.command + ' ' + (asr.args || []).join(' ') : '(未配置)'));
  return lines.join('\n');
}
