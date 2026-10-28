import { QqBotAuthError } from './auth.mjs';

// 官方文档：所有 openapi 走 https://api.bot.qq.com；失败时以响应体 err_code 判定，不能只看 HTTP 码。
const DEFAULT_API_BASE = 'https://api.bot.qq.com';
const DEFAULT_TIMEOUT_MS = 15000;
const AUTH_ERR_CODES = new Set([11241, 11243]);

export class QqBotError extends Error {
  constructor(message, { code = null, status = null, method = '', path = '' } = {}) {
    super(message);
    this.name = 'QqBotError';
    this.code = code;
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

function errCodeOf(body) {
  if (!body || typeof body !== 'object') return null;
  const raw = body.err_code !== undefined ? body.err_code : body.code;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

function reasonOf(error) {
  if (!error) return 'unknown';
  if (error.name === 'AbortError') return '请求超时';
  return String(error.message ?? error);
}

function targetKind(chatType) {
  return chatType === 'group' ? 'groups' : 'users';
}

function requireId(value, label) {
  const id = value === undefined || value === null ? '' : String(value).trim();
  if (!id) throw new QqBotError('缺少 ' + label + '，无法发起调用');
  return id;
}

export function createQqBotClient({
  config = {},
  tokenProvider = null,
  fetchImpl = globalThis.fetch,
  logger = null,
} = {}) {
  const base = String(config.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const wanted = Number(config.requestTimeoutMs);
  const timeoutMs = Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_TIMEOUT_MS;

  async function send(method, path, { body = null, form = null, query = null, headers = {}, auth = true } = {}) {
    if (typeof fetchImpl !== 'function') throw new QqBotError('运行环境没有可用的 fetch', { method, path });
    const url = new URL(base + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }

    const init = { method, headers: { accept: 'application/json', ...headers } };
    if (auth) {
      if (!tokenProvider) throw new QqBotAuthError('缺少 token provider', {});
      init.headers.authorization = await tokenProvider.authHeader();
    }
    if (form !== null && form !== undefined) {
      // multipart 的 boundary 由运行时自己写，这里绝不能手动设 content-type
      init.body = form;
    } else if (body !== null && body !== undefined) {
      init.headers['content-type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    init.signal = controller.signal;

    let response;
    let text = '';
    try {
      response = await fetchImpl(url.toString(), init);
      text = await response.text();
    } catch (error) {
      if (error instanceof QqBotError || error instanceof QqBotAuthError) throw error;
      throw new QqBotError('请求失败：' + reasonOf(error), { method, path });
    } finally {
      clearTimeout(timer);
    }

    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // 2xx 却不是 JSON 说明拿到的是网关页/代理页，必须当错误
        throw new QqBotError('返回体不是 JSON：' + String(text).slice(0, 200), {
          status: response.status,
          method,
          path,
        });
      }
    }
    return { status: response.status, ok: response.ok, data };
  }

  function unwrap(result, method, path) {
    const code = errCodeOf(result.data);
    if (!result.ok || code !== null) {
      const label = code !== null ? '拒绝（err_code ' + code + '）' : 'HTTP ' + result.status;
      throw new QqBotError(method + ' ' + path + ' ' + label + '：' + String(result.data?.message ?? ''), {
        code,
        status: result.status,
        method,
        path,
      });
    }
    return result.data;
  }

  async function request(method, path, options = {}) {
    const result = await send(method, path, options);
    const code = errCodeOf(result.data);
    const authFailed = options.auth !== false && (result.status === 401 || AUTH_ERR_CODES.has(code));
    if (!authFailed) return unwrap(result, method, path);
    // token 失效是最常见的瞬时错误：作废缓存后立刻重试一次，避免一条消息直接丢
    logger?.warn?.('QQ Bot 鉴权失败，刷新 token 后重试一次', { path, code });
    tokenProvider?.invalidate?.();
    return unwrap(await send(method, path, options), method, path);
  }

  return {
    apiBase: base,

    request,

    async getGateway() {
      const data = await request('GET', '/gateway');
      const url = typeof data?.url === 'string' ? data.url.trim() : '';
      return { url, raw: data };
    },

    async sendMessage({ chatType = 'private', target, body = {} } = {}) {
      const id = requireId(target, chatType === 'group' ? 'group_openid' : 'user_openid');
      const path = '/v2/' + targetKind(chatType) + '/' + encodeURIComponent(id) + '/messages';
      return request('POST', path, { body });
    },

    async uploadFile({ chatType = 'private', target, fileType = 1, url = '' } = {}) {
      const id = requireId(target, chatType === 'group' ? 'group_openid' : 'user_openid');
      if (!url) throw new QqBotError('上传富媒体需要可公网访问的 url');
      const path = '/v2/' + targetKind(chatType) + '/' + encodeURIComponent(id) + '/files';
      return request('POST', path, { body: { file_type: Number(fileType), url } });
    },

    // 本地文件只能走表单：官方 /files 除了 {url} 还收 multipart，两者是同一个端点。
    async uploadFileContent({ chatType = 'private', target, fileType = 4, filename = '', bytes = null } = {}) {
      const id = requireId(target, chatType === 'group' ? 'group_openid' : 'user_openid');
      const content = Buffer.isBuffer(bytes) ? bytes : bytes ? Buffer.from(bytes) : null;
      if (!content || content.length === 0) throw new QqBotError('上传富媒体需要文件内容');
      const form = new FormData();
      form.append('file_type', String(Number(fileType)));
      form.append('srv_send_msg', 'false');
      form.append('file', new Blob([content]), String(filename || 'file'));
      const path = '/v2/' + targetKind(chatType) + '/' + encodeURIComponent(id) + '/files';
      return request('POST', path, { form });
    },

    // pipeline 的 resolveUrl 只会拿 plan.callSpec.action 来调；QQ 侧附件都自带直链，
    // 这里只保留内核可能用到的少数动作，其余显式报错而不是静默返回空。
    async call(action, params = {}) {
      if (action === 'upload_file') return this.uploadFile(params);
      if (action === 'gateway') return this.getGateway();
      throw new QqBotError('QQ Bot client 不支持该 action：' + String(action));
    },

    status() {
      return { apiBase: base, token: tokenProvider?.state?.() ?? null };
    },
  };
}
