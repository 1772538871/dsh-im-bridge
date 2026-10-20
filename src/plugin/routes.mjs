import { readFile } from 'node:fs/promises';
import { maskSecrets, mergeSecretMasks, resolveLogFile } from './config-store.mjs';
import { listPlatforms } from './platforms.mjs';

export const API_PREFIX = '/dsh-bot/api';
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_TAIL_LINES = 500;
const DEFAULT_TAIL_LINES = 100;
const CONTROL_ACTIONS = ['start', 'stop', 'restart'];

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

export function createApiHandler({ configStore, runtime, logger = null, now = () => Date.now() } = {}) {
  if (!configStore || typeof configStore.read !== 'function') throw new Error('createApiHandler: 需要 configStore');
  if (!runtime || typeof runtime.status !== 'function') throw new Error('createApiHandler: 需要 runtime');

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
      return sendJson(res, { ok: true, platforms: listPlatforms() });
    }
    if (suffix === '/logs/tail') {
      if (method !== 'GET') return sendJson(res, { ok: false, error: '只接受 GET /logs/tail' });
      return getLogsTail(url, res);
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
export function createApiRoutes({ configStore, runtime, logger = null, now = () => Date.now() } = {}) {
  return { kind: 'prefix', path: API_PREFIX, handler: createApiHandler({ configStore, runtime, logger, now }) };
}
