import { readFile } from 'node:fs/promises';
import { SECRET_MASK, maskSecrets, mergeSecretMasks, resolveLogFile } from './config-store.mjs';
import { listPlatforms } from './platforms.mjs';
import { ensureDataLayout } from './data-layout.mjs';
import { createNapcatLauncher } from './napcat-launcher.mjs';
import { encodeQr, qrToSvg } from '../../lib/qr.js';
import { createTokenProvider } from '../qqbot/auth.mjs';
import { createQqBotClient } from '../qqbot/client.mjs';

export const API_PREFIX = '/dsh-bot/api';
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_TAIL_LINES = 500;
const DEFAULT_TAIL_LINES = 100;
const CONTROL_ACTIONS = ['start', 'stop', 'restart'];
// token 接口只在正式域提供（沙箱域实测 404），网关二次确认才跟着 sandbox 开关走沙箱域
export const TOKEN_API_BASE = 'https://api.bot.qq.com';
export const SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';
// 向导卡「扫码」块的二维码内容：必须是真能在手机上打开的那个地址
export const WIZARD_QR_TARGETS = {
  'qq-official': 'https://q.qq.com/qqbot/#/developer',
  'qq-napcat': 'https://github.com/NapNeko/NapCatQQ/releases'
};

// 二维码在宿主侧算好随 /platforms 下发：lib/client.js 是单文件包，引不到 lib/qr.js。
// 单个平台编码失败就省略该键——二维码坏了不该把整个设置页的接口拖成 500。
export function buildWizardQr(targets) {
  const out = {};
  for (const [platform, url] of Object.entries(targets)) {
    try {
      out[platform] = qrToSvg(encodeQr(url).modules, { size: 200, margin: 4 });
    } catch {
      // 省略该键：前端会退回占位方块
    }
  }
  return out;
}

// 错误文案里要念出人话平台名：用户点的是「QQ 个人账号」，不该看到 qq-napcat
export function platformLabelOf(id) {
  const wanted = textOf(id);
  const hit = listPlatforms().filter((item) => item.id === wanted)[0];
  return (hit && textOf(hit.label)) || wanted || '未知平台';
}

// 「测试消息只能从正在运行的平台发」：两个平台名都按实际替换，其余一个字的语气都不改
export function testPlatformConflictText(runningId, requestedId) {
  return (
    '测试消息只能从正在运行的平台发。你现在跑的是「' +
    platformLabelOf(runningId) +
    '」，想用小号发就先在左边选「' +
    platformLabelOf(requestedId) +
    '」、保存并启动，再点这里。'
  );
}

let wizardQrCache = null;

export function wizardQrPayload() {
  if (wizardQrCache === null) wizardQrCache = buildWizardQr(WIZARD_QR_TARGETS);
  return wizardQrCache;
}

function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

// 契约 §3：任何异常都 HTTP 200 + {ok:false,error}，前端只按 ok 分支，不看状态码
function sendJson(res, payload) {
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(200, headers);
  } else if (res && typeof res.setHeader === 'function') {
    for (const key of Object.keys(headers)) res.setHeader(key, headers[key]);
    if ('statusCode' in res) res.statusCode = 200;
  }
  if (res && typeof res.end === 'function') res.end(body);
}

async function readBody(req, limit) {
  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      // 先看长度再入栈：64KB 上限必须能挡住任意大的流，而不是读完再说
      if (size > limit) return { ok: false, error: '请求体超过上限 ' + limit + ' 字节' };
      chunks.push(buf);
    }
    return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
  }
  if (req && typeof req.body === 'string') {
    const text = req.body;
    if (Buffer.byteLength(text, 'utf8') > limit) return { ok: false, error: '请求体超过上限 ' + limit + ' 字节' };
    return { ok: true, text };
  }
  return { ok: true, text: '' };
}

async function readJson(req) {
  const body = await readBody(req, MAX_BODY_BYTES);
  if (!body.ok) return { ok: false, error: body.error };
  const text = body.text.trim();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: '请求体不是合法 JSON：' + errorText(error) };
  }
}

function suffixOf(pathname) {
  const path = String(pathname ?? '');
  if (path === API_PREFIX || path === API_PREFIX + '/') return '/';
  if (!path.startsWith(API_PREFIX + '/')) return null;
  const rest = path.slice(API_PREFIX.length);
  return rest.length > 1 && rest.endsWith('/') ? rest.slice(0, -1) : rest;
}

function tailCount(url) {
  const raw = Number(url.searchParams.get('lines') ?? DEFAULT_TAIL_LINES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TAIL_LINES;
  return Math.min(Math.floor(raw), MAX_TAIL_LINES);
}

// ---------------- 「连接向导」第 2 步：验证凭证 ----------------
// 向导要的是"能不能真的换到 token、网关认不认"，所以这里只做两件真事，
// 不写配置、不启动运行时：拿 token（正式域）+ 拉一次 /gateway（跟着 sandbox 走）。

export const MSG_SECRET_WRONG = 'AppSecret 不对：去开放平台 → 开发设置 → 重置密钥';
export const MSG_UNPUBLISHED = '机器人还没发布：把「沙箱环境」打开，并把自己的号加进体验成员';
const MSG_APPID_EMPTY = 'AppID 没填：去开放平台 → 开发设置 → 复制机器人 AppID';
const MSG_SECRET_EMPTY = 'AppSecret 没填：去开放平台 → 开发设置 → 重置密钥，把新密钥填进来';
// 网关侧的"环境不匹配"错误：未上线机器人在正式网关会 close/报这些码
const ENV_ERROR_CODES = new Set([4903, 4904, 4914, 4915]);
const AUTH_ERROR_CODES = new Set([11241, 11243]);

function textOf(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function fail(step, error) {
  return { ok: false, step, error };
}

function codeOf(error) {
  const code = Number(error && error.code);
  return Number.isFinite(code) && code > 0 ? code : null;
}

function statusOf(error) {
  const status = Number(error && error.status);
  return Number.isFinite(status) ? status : null;
}

/**
 * 昵称只是锦上添花：网关响应里顺手有就带上，没有就整个 key 省掉。
 * 不为它多打一个接口、更不因此判定验证失败。
 */
export function nicknameOf(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.bot && payload.bot.username,
    payload.bot && payload.bot.nickname,
    payload.data && payload.data.bot && payload.data.bot.username,
    payload.d && payload.d.bot && payload.d.bot.username,
    payload.username,
    payload.nickname
  ];
  for (const raw of candidates) {
    const value = textOf(raw);
    if (value !== '') return value;
  }
  return '';
}

// token 阶段的失败分两类：开放平台明确回了业务码（凭证问题），或根本没连上（网络问题）。
// 混成一类会让"网线没插"的人跑去重置密钥，白折腾一轮。
function tokenFailure(error) {
  const code = codeOf(error);
  const message = textOf(error && error.message) || '未知错误';
  if (code !== null) return fail('credentials', MSG_SECRET_WRONG + '（开放平台返回错误码 ' + code + '）');
  if (message.includes('access_token') || message.includes('不是 JSON')) {
    return fail('credentials', MSG_SECRET_WRONG + '（开放平台没给出 access_token：' + message + '）');
  }
  return fail('unknown', '连不上 QQ 开放平台：' + message + '；先确认这台电脑能上网（或代理可用），再点一次');
}

function gatewayFailure(error, sandbox) {
  const code = codeOf(error);
  const status = statusOf(error);
  const message = textOf(error && error.message) || '未知错误';
  if (status === 401 || status === 403 || (code !== null && AUTH_ERROR_CODES.has(code))) {
    return fail('credentials', MSG_SECRET_WRONG);
  }
  if (status === 404 || (code !== null && ENV_ERROR_CODES.has(code))) {
    const detail = code !== null ? '错误码 ' + code : 'HTTP ' + status;
    return fail('sandbox', MSG_UNPUBLISHED + '（' + detail + (sandbox === true ? '，沙箱域' : '，正式域') + '）');
  }
  const detail = code !== null ? '错误码 ' + code : status !== null && status > 0 ? 'HTTP ' + status : message;
  return fail('gateway', '网关连不上：' + detail + '；确认机器人状态和「沙箱环境」开关一致后再试');
}

/**
 * 纯逻辑 + 注入 fetch：HTTP 恒 200 由调用方负责，这里只回 {ok, ...}。
 * 成功 = {ok:true, nickname?, appId, sandbox}；失败 = {ok:false, step, error}，step ∈ credentials|sandbox|gateway|unknown。
 */
export async function verifyQqBotCredentials({
  appId = '',
  appSecret = '',
  sandbox = false,
  fetchImpl = globalThis.fetch
} = {}) {
  const id = textOf(appId);
  const secret = textOf(appSecret);
  if (id === '') return fail('credentials', MSG_APPID_EMPTY);
  if (secret === '') return fail('credentials', MSG_SECRET_EMPTY);
  // 新的 provider 实例 = 没有缓存，force 只是把"每次验证都真的问一次平台"写实
  const provider = createTokenProvider({ appId: id, clientSecret: secret, apiBase: TOKEN_API_BASE, fetchImpl });
  try {
    await provider.getToken({ force: true });
  } catch (error) {
    return tokenFailure(error);
  }

  const base = sandbox === true ? SANDBOX_API_BASE : TOKEN_API_BASE;
  let gatewayUrl = '';
  let nickname = '';
  try {
    const client = createQqBotClient({ config: { apiBase: base }, tokenProvider: provider, fetchImpl });
    const gateway = await client.getGateway();
    gatewayUrl = textOf(gateway && gateway.url);
    nickname = nicknameOf(gateway && gateway.raw);
  } catch (error) {
    return gatewayFailure(error, sandbox === true);
  }
  if (gatewayUrl === '') {
    return fail('gateway', '网关没给出接入地址：机器人可能还没上线，确认机器人状态和「沙箱环境」开关一致后再试');
  }

  const result = { ok: true, appId: id, sandbox: sandbox === true };
  if (nickname !== '') result.nickname = nickname;
  return result;
}

export function createApiHandler({ configStore, runtime, logger = null, now = () => Date.now(), fetchImpl, launcher = null } = {}) {
  if (!configStore || typeof configStore.read !== 'function') throw new Error('createApiHandler: 需要 configStore');
  if (!runtime || typeof runtime.status !== 'function') throw new Error('createApiHandler: 需要 runtime');

  // 一键启动的宿主半边：默认懒建一个进程级单例（自己拉起的 pid 必须跨请求记着，
  // 每请求新建一个就等于每次都重新拉起 NapCat）。测试注入假件，绝不真的去 spawn。
  let napcatLauncher = launcher;
  function launcherForNapcat() {
    if (napcatLauncher === null) {
      napcatLauncher = createNapcatLauncher({ config: () => configStore.read().config, logger, now });
    }
    return napcatLauncher;
  }

  // 「正在跑的是哪个平台」只有一个来源：适配器是按哪个平台建的。
  // 拿不到（老宿主或测试里的假件没有这个方法）才退回 status().platform。
  function runningPlatformOf() {
    if (typeof runtime.runningPlatform === 'function') {
      try {
        return textOf(runtime.runningPlatform());
      } catch {
        return '';
      }
    }
    const view = typeof runtime.status === 'function' ? runtime.status() : null;
    return textOf(view && view.platform);
  }

  const warn = (message, extra) => {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(message, extra);
    } catch {
      // 日志失败不能影响接口响应
    }
  };

  function getConfigView() {
    const view = configStore.read();
    // 磁盘上校验不过的值不会让接口失败，但必须让用户看见，所以并进 warnings
    const problems = Array.isArray(view.problems) ? view.problems : [];
    const warnings = (Array.isArray(view.warnings) ? view.warnings : []).concat(
      problems.map((problem) => '配置项有问题（仍按默认值运行）：' + problem)
    );
    return { config: view.config, warnings, configPath: view.configPath };
  }

  async function postConfig(req, res) {
    const type = String(req?.headers?.['content-type'] ?? '').toLowerCase();
    if (!type.includes('application/json')) {
      return sendJson(res, { ok: false, error: 'content-type 必须是 application/json' });
    }
    const body = await readJson(req);
    if (!body.ok) return sendJson(res, { ok: false, error: body.error });
    const incoming = body.value && typeof body.value === 'object' ? body.value.config : undefined;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return sendJson(res, { ok: false, error: '请求体必须是 {config:{...}}' });
    }
    const current = configStore.read();
    const merged = mergeSecretMasks(incoming, current.config);
    const saved = await configStore.save(merged);
    if (!saved.ok) {
      return sendJson(res, { ok: false, error: saved.error ?? '配置校验失败', problems: saved.problems ?? [] });
    }
    // 保存成功就顺手把数据目录分层建好：用户不该为了 prompts/ 这种目录自己动手 mkdir。
    // 这里不检查返回值——建目录失败只该 warn，不能让"保存成功"变成一个报错。
    await ensureDataLayout({ rootDir: saved.config?.storage?.rootDir ?? '', logger });
    return sendJson(res, { ok: true, config: maskSecrets(saved.config), warnings: saved.warnings ?? [] });
  }

  async function postControl(req, res) {
    const type = String(req?.headers?.['content-type'] ?? '').toLowerCase();
    if (!type.includes('application/json')) {
      return sendJson(res, { ok: false, error: 'content-type 必须是 application/json' });
    }
    const body = await readJson(req);
    if (!body.ok) return sendJson(res, { ok: false, error: body.error });
    const action = body.value && typeof body.value === 'object' ? body.value.action : undefined;
    if (CONTROL_ACTIONS.indexOf(action) === -1) {
      return sendJson(res, { ok: false, error: 'action 必须是 ' + CONTROL_ACTIONS.join(' / ') });
    }
    const result = await runtime[action]();
    if (result && result.ok) {
      return sendJson(res, { ok: true, status: result.status ?? runtime.status() });
    }
    return sendJson(res, { ok: false, error: (result && result.error) || action + ' 失败' });
  }

  // 设置页的「发送测试消息」：结果一律 HTTP 200 + {ok}，前端只按 ok 分支（契约 §3）
  async function postTestSend(req, res) {
    const type = String(req?.headers?.['content-type'] ?? '').toLowerCase();
    if (!type.includes('application/json')) {
      return sendJson(res, { ok: false, error: 'content-type 必须是 application/json' });
    }
    const body = await readJson(req);
    if (!body.ok) return sendJson(res, { ok: false, error: body.error });
    const value = body.value && typeof body.value === 'object' ? body.value : {};
    const target = value.target;
    if (target !== undefined && target !== null && typeof target !== 'string') {
      return sendJson(res, { ok: false, error: 'target 必须是字符串（要发给谁），或干脆不传' });
    }
    if (value.platform !== undefined && value.platform !== null && typeof value.platform !== 'string') {
      return sendJson(res, { ok: false, error: 'platform 必须是字符串（平台 id），或干脆不传' });
    }
    if (typeof runtime.sendTest !== 'function') {
      return sendJson(res, { ok: false, error: '当前宿主版本不支持发送测试消息' });
    }
    // 只肯从正在跑的那个平台发：用户点了哪张卡片就传哪个 platform，对不上就明说，
    // 不拿另一个号替他发一条——那正是「测试消息发到官方机器人上」的旧毛病。
    const requested = textOf(value.platform) || textOf(configStore.read().config?.platform);
    const running = runningPlatformOf();
    if (running !== '' && requested !== '' && requested !== running) {
      return sendJson(res, { ok: false, error: testPlatformConflictText(running, requested) });
    }
    const result = await runtime.sendTest(target ?? '');
    if (result && result.ok) {
      const platform = running || requested;
      return sendJson(res, { ok: true, target: result.target, chunkCount: result.chunkCount, ...(platform === '' ? {} : { platform }) });
    }
    return sendJson(res, { ok: false, error: (result && result.error) || '发送测试消息失败' });
  }


  // 「连接向导」第 2 步：body 里带的就是向导输入框里的值，没带的用已保存配置兜底，
  // 于是用户既能"先验证再保存"，也不必把已经存过的密钥重打一遍。
  async function postVerifyCredentials(req, res) {
    const type = String(req?.headers?.['content-type'] ?? '').toLowerCase();
    if (!type.includes('application/json')) {
      return sendJson(res, { ok: false, error: 'content-type 必须是 application/json' });
    }
    const body = await readJson(req);
    if (!body.ok) return sendJson(res, { ok: false, error: body.error });
    const value = body.value && typeof body.value === 'object' && !Array.isArray(body.value) ? body.value : {};
    for (const key of ['appId', 'appSecret']) {
      if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') {
        return sendJson(res, { ok: false, error: key + ' 必须是字符串' });
      }
    }
    if (value.sandbox !== undefined && value.sandbox !== null && typeof value.sandbox !== 'boolean') {
      return sendJson(res, { ok: false, error: 'sandbox 必须是 true/false' });
    }

    const saved = configStore.read().config ?? {};
    const official = saved.qqOfficial ?? {};
    const incomingSecret = textOf(value.appSecret);
    const result = await verifyQqBotCredentials({
      appId: textOf(value.appId) || textOf(official.appId),
      // *** 是掩码，不是密钥：拿它去换 token 只会换回一条假错误
      appSecret: incomingSecret !== '' && incomingSecret !== SECRET_MASK ? incomingSecret : textOf(official.appSecret),
      sandbox: typeof value.sandbox === 'boolean' ? value.sandbox : official.sandbox === true,
      fetchImpl
    });
    return sendJson(res, result);
  }

  // 一键启动/二维码这四条：结果全部是"宿主自己的人话"，连异常也翻译成 ok:false，
  // 于是前端永远只按 ok 分支，HTTP 层始终 200（契约 §3）。
  async function napcatCall(method, res) {
    let result;
    try {
      const api = launcherForNapcat();
      if (!api || typeof api[method] !== 'function') {
        return sendJson(res, { ok: false, error: '当前宿主版本不支持一键启动 NapCat' });
      }
      result = await api[method]();
    } catch (error) {
      warn('dsh-bot NapCat 接口异常', { method, error: errorText(error) });
      return sendJson(res, { ok: false, error: 'NapCat 操作失败：' + errorText(error) });
    }
    if (!result || typeof result !== 'object') {
      return sendJson(res, { ok: false, error: 'NapCat 操作没有返回结果' });
    }
    return sendJson(res, result);
  }

  async function getLogsTail(url, res) {
    const view = configStore.read();
    const target = resolveLogFile(view.config, { file: url.searchParams.get('file') ?? '', now: now() });
    if (!target.ok) return sendJson(res, { ok: false, error: target.error });
    let text = '';
    try {
      text = await readFile(target.file, 'utf8');
    } catch (error) {
      // 今天还没写日志是常态，不该在前端报错
      if (error && error.code === 'ENOENT') return sendJson(res, { ok: true, lines: [] });
      return sendJson(res, { ok: false, error: '读取日志失败：' + errorText(error) });
    }
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    return sendJson(res, { ok: true, lines: lines.slice(-tailCount(url)) });
  }

  async function dispatch(req, res) {
    const rawUrl = typeof req?.url === 'string' && req.url !== '' ? req.url : API_PREFIX;
    let url;
    try {
      url = new URL(rawUrl, 'http://dsh-bot.local');
    } catch {
      return sendJson(res, { ok: false, error: '无法解析请求路径：' + rawUrl });
    }
    const suffix = suffixOf(url.pathname);
    if (suffix === null) return sendJson(res, { ok: false, error: '未知接口：' + url.pathname });
    const method = String(req?.method ?? 'GET').toUpperCase();

    if (suffix === '/status') {
      if (method !== 'GET') return sendJson(res, { ok: false, error: '只接受 GET /status' });
      return sendJson(res, { ok: true, ...runtime.status() });
    }
    if (suffix === '/config') {
      if (method === 'GET') {
        const view = getConfigView();
        return sendJson(res, { ok: true, config: maskSecrets(view.config), warnings: view.warnings, configPath: view.configPath });
      }
      if (method === 'POST') return postConfig(req, res);
      return sendJson(res, { ok: false, error: '只接受 GET / POST /config' });
    }
    if (suffix === '/control') {
      if (method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST /control' });
      return postControl(req, res);
    }
    if (suffix === '/platforms') {
      if (method !== 'GET') return sendJson(res, { ok: false, error: '只接受 GET /platforms' });
      return sendJson(res, { ok: true, platforms: listPlatforms(), wizardQr: wizardQrPayload() });
    }
    if (suffix === '/test-send') {
      if (method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST /test-send' });
      return postTestSend(req, res);
    }
    if (suffix === '/verify-credentials') {
      if (method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST /verify-credentials' });
      return postVerifyCredentials(req, res);
    }
    if (suffix === '/logs/tail') {
      if (method !== 'GET') return sendJson(res, { ok: false, error: '只接受 GET /logs/tail' });
      return getLogsTail(url, res);
    }
    if (suffix === '/napcat/start') {
      if (method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST /napcat/start' });
      return napcatCall('start', res);
    }
    if (suffix === '/napcat/status') {
      if (method !== 'GET') return sendJson(res, { ok: false, error: '只接受 GET /napcat/status' });
      return napcatCall('status', res);
    }
    if (suffix === '/napcat/qr') {
      if (method !== 'GET') return sendJson(res, { ok: false, error: '只接受 GET /napcat/qr' });
      return napcatCall('qrcode', res);
    }
    if (suffix === '/napcat/stop') {
      if (method !== 'POST') return sendJson(res, { ok: false, error: '只接受 POST /napcat/stop' });
      return napcatCall('stop', res);
    }
    return sendJson(res, { ok: false, error: '未知接口：' + url.pathname });
  }

  return async function handler(req, res) {
    try {
      await dispatch(req, res);
    } catch (error) {
      // 堆栈只进日志，绝不出现在响应体里
      warn('dsh-bot 接口异常', { error: errorText(error) });
      try {
        sendJson(res, { ok: false, error: '接口内部错误：' + errorText(error) });
      } catch {
        // 响应都写不出去就只能放弃了
      }
    }
  };
}

/** 契约 §3：一个 kind:'prefix' 路由挂在 /dsh-bot/api。 */
export function createApiRoutes({ configStore, runtime, logger = null, now = () => Date.now(), fetchImpl, launcher = null } = {}) {
  return { kind: 'prefix', path: API_PREFIX, handler: createApiHandler({ configStore, runtime, logger, now, fetchImpl, launcher }) };
}
