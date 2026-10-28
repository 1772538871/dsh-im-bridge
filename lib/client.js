// DSH 运行期不打包、不转译：这个文件被浏览器当脚本执行，靠 __ModuleLoader__ 注册惰性工厂。
window.__ModuleLoader__.load({
  id: 'dsh-im-bridge',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const module = { exports: {} };

    const API_BASE = '/dsh-bot/api';
    const SECRET_MASK = '***';
    const SECTION_SLOT = 'settings.section';
    const SECTION_ID = 'dsh-bot';
    // 字段类型是 host 下发的封闭集合；未知类型按 text 渲染，避免 host 加新类型时整页白屏。
    const FIELD_TYPES = ['text', 'password', 'number', 'boolean', 'stringList', 'select'];
    // platform / enabled 是契约固定的配置信封字段，不在 host 下发的字段表里也必须能改。
    const ENVELOPE_KEYS = ['platform', 'enabled'];

    // ---------------- 无 React 依赖的纯逻辑（可单独测试） ----------------

    function isPlainObject(v) {
      return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    function toText(v) {
      return v === undefined || v === null ? '' : String(v);
    }

    function splitPath(path) {
      return toText(path).split('.').map((s) => s.trim()).filter(Boolean);
    }

    function dotGet(obj, path, fallback) {
      const parts = splitPath(path);
      let cur = obj;
      for (const part of parts) {
        if (cur === undefined || cur === null) return fallback;
        if (Array.isArray(cur)) {
          const index = Number(part);
          if (!Number.isInteger(index) || index < 0) return fallback;
          cur = cur[index];
          continue;
        }
        if (typeof cur !== 'object') return fallback;
        cur = cur[part];
      }
      return cur === undefined ? fallback : cur;
    }

    // 沿路径浅拷贝：不改原对象，才敢把 fetch 回来的 config 直接当草稿反复写。
    function dotSet(obj, path, value) {
      const parts = splitPath(path);
      if (parts.length === 0) return obj;
      const clone = isPlainObject(obj) ? { ...obj } : {};
      let cur = clone;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const key = parts[i];
        const next = cur[key];
        cur[key] = isPlainObject(next) ? { ...next } : Array.isArray(next) ? next.slice() : {};
        cur = cur[key];
      }
      cur[parts[parts.length - 1]] = value;
      return clone;
    }

    function deepClone(v) {
      if (Array.isArray(v)) return v.map(deepClone);
      if (isPlainObject(v)) {
        const out = {};
        for (const key of Object.keys(v)) out[key] = deepClone(v[key]);
        return out;
      }
      return v;
    }

    function listToText(list) {
      return Array.isArray(list) ? list.map((x) => toText(x).trim()).filter(Boolean).join('\n') : '';
    }

    // 白名单是"一行一个"，但用户常从聊天窗口整段粘进来（逗号/分号/中文标点），一并拆开并去重。
    function textToList(text) {
      const out = [];
      const seen = new Set();
      const lines = toText(text).split(/\r?\n/);
      for (const line of lines) {
        for (const piece of line.split(/[,，;；]/)) {
          const item = piece.trim();
          if (!item || seen.has(item)) continue;
          seen.add(item);
          out.push(item);
        }
      }
      return out;
    }

    function normalizeOptions(raw) {
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        if (isPlainObject(item)) {
          const value = toText(item.value !== undefined ? item.value : item.id);
          if (value) out.push({ value, label: toText(item.label || item.name) || value });
        } else if (item !== undefined && item !== null && String(item) !== '') {
          out.push({ value: String(item), label: String(item) });
        }
      }
      return out;
    }

    function normalizeField(raw) {
      if (!isPlainObject(raw)) return null;
      const key = toText(raw.key).trim();
      if (!key) return null;
      const type = FIELD_TYPES.indexOf(raw.type) === -1 ? 'text' : raw.type;
      return {
        key,
        label: toText(raw.label) || key,
        type,
        required: raw.required === true,
        // password 也必须按密文处理：host 忘了 secret 标记时不能把口令明文回显。
        secret: raw.secret === true || type === 'password',
        placeholder: toText(raw.placeholder),
        help: toText(raw.help),
        // host 现在只发 basic / advanced；其它值（老版本 host、拼错）一律当 advanced，
        // 不能让渲染层遇到第三个分组名就把它藏起来或丢掉。
        group: toText(raw.group).trim().toLowerCase() === 'basic' ? 'basic' : 'advanced',
        options: normalizeOptions(raw.options || raw.choices || raw.values)
      };
    }

    function normalizePlatforms(raw) {
      const list = Array.isArray(raw) ? raw : [];
      const out = [];
      for (const item of list) {
        if (!isPlainObject(item)) continue;
        const id = toText(item.id).trim();
        if (!id) continue;
        const fields = (Array.isArray(item.fields) ? item.fields : []).map(normalizeField).filter(Boolean);
        out.push({ id, label: toText(item.label) || id, description: toText(item.description), fields });
      }
      return out;
    }

    // host 只保证"每个平台下发自己那一组字段"：公共字段（存储/白名单/回复…）可能被重复下发进
    // 每个平台，也可能根本没有。取各平台字段的交集当公共组，前端因此不需要任何硬编码字段表。
    function mergeFields(platforms, platformId) {
      const list = Array.isArray(platforms) ? platforms : [];
      const selected = list.filter((p) => p.id === platformId)[0] || list[0];
      if (!selected) return [];
      const own = Array.isArray(selected.fields) ? selected.fields : [];
      if (list.length < 2) return own.slice();
      const commonKeys = new Set(own.map((f) => f.key));
      for (const platform of list) {
        if (platform.id === selected.id) continue;
        const keys = new Set((platform.fields || []).map((f) => f.key));
        for (const key of Array.from(commonKeys)) if (!keys.has(key)) commonKeys.delete(key);
      }
      const common = own.filter((f) => commonKeys.has(f.key));
      const specific = own.filter((f) => !commonKeys.has(f.key));
      return common.concat(specific);
    }

    const GROUP_TITLES = { basic: '常用设置', advanced: '高级设置（一般不用改）' };

    // 只分两档：basic 直接展开，advanced 收进折叠区。
    // 一个 basic 都没有时（老版本 host 不下发 group）整体按 basic 渲染——
    // 宁可不折叠，也不能让用户打开设置页只看到一堆被收起来的字段。
    function groupFields(fields) {
      const list = Array.isArray(fields) ? fields : [];
      const hasBasic = list.some((field) => field.group === 'basic');
      const out = [];
      for (const name of ['basic', 'advanced']) {
        const picked = list.filter((field) => (hasBasic ? field.group === name : name === 'basic'));
        if (picked.length > 0) out.push({ group: name, title: GROUP_TITLES[name], fields: picked });
      }
      return out;
    }

    function formFromConfig(config, fields) {
      const out = {};
      for (const field of Array.isArray(fields) ? fields : []) {
        const raw = dotGet(config, field.key, undefined);
        if (field.type === 'boolean') {
          out[field.key] = raw === true;
          continue;
        }
        if (field.type === 'stringList') {
          out[field.key] = listToText(raw);
          continue;
        }
        if (field.type === 'number') {
          out[field.key] = raw === undefined || raw === null || raw === '' ? '' : String(raw);
          continue;
        }
        if (field.secret) {
          // 空值保持空：让用户看得出"尚未设置"，而不是把 *** 当成已配置。
          out[field.key] = raw === undefined || raw === null || raw === '' ? '' : SECRET_MASK;
          continue;
        }
        out[field.key] = toText(raw);
      }
      return out;
    }

    // 信封字段（platform/enabled）由页面顶部的专用控件维护，不依赖 host 是否下发它们。
    function buildForm(config, fields, platformId) {
      const form = formFromConfig(config, fields);
      const platform = toText(platformId) || toText(isPlainObject(config) ? config.platform : '');
      if (platform) form.platform = platform;
      form.enabled = isPlainObject(config) ? config.enabled === true : false;
      return form;
    }

    function coerceValue(field, value) {
      if (field.type === 'boolean') return value === true || value === 'true';
      if (field.type === 'stringList') return Array.isArray(value) ? value.slice() : textToList(value);
      if (field.type === 'number') {
        const n = Number(value);
        // 非数字原样透传，让服务端校验把问题回出来，而不是前端悄悄改成 0。
        return Number.isFinite(n) ? n : value;
      }
      return value === undefined || value === null ? '' : String(value);
    }

    function buildConfig(baseConfig, fields, form) {
      let next = deepClone(isPlainObject(baseConfig) ? baseConfig : {});
      const values = isPlainObject(form) ? form : {};
      for (const field of Array.isArray(fields) ? fields : []) {
        if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
        const value = values[field.key];
        if (field.secret && (value === SECRET_MASK || value === undefined || value === null)) continue;
        // 数字留空表示"保持原值"，否则空串会被 Number() 变成 0 写进配置。
        if (field.type === 'number' && toText(value).trim() === '') continue;
        next = dotSet(next, field.key, coerceValue(field, value));
      }
      const platform = toText(values.platform).trim();
      if (platform) next.platform = platform;
      if (typeof values.enabled === 'boolean') next.enabled = values.enabled;
      return next;
    }

    // 切平台只换字段表；公共字段保留用户已改的输入，私有字段保留原配置值。
    function switchPlatformForm(state, platformId) {
      const current = isPlainObject(state) ? state : {};
      const fields = mergeFields(current.platforms, platformId);
      const form = formFromConfig(current.config, fields);
      const previous = isPlainObject(current.form) ? current.form : {};
      for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(previous, field.key)) form[field.key] = previous[field.key];
      }
      form.platform = platformId;
      form.enabled = typeof previous.enabled === 'boolean' ? previous.enabled : isPlainObject(current.config) && current.config.enabled === true;
      return { platformId, fields, form };
    }

    function describeError(err) {
      if (!err) return '未知错误';
      const raw = typeof err === 'string' ? err : err.message || String(err);
      const oneLine = toText(raw).replace(/\s+/g, ' ').trim();
      if (!oneLine) return '未知错误';
      return oneLine.length > 300 ? oneLine.slice(0, 300) + '…' : oneLine;
    }

    function makeApiError(message, problems) {
      const err = new Error(describeError(message || '请求失败'));
      err.name = 'DshBotApiError';
      err.problems = Array.isArray(problems) ? problems.map((p) => toText(p)).filter(Boolean) : [];
      return err;
    }

    // 「发送测试消息」的请求体：留空就不传 target，让宿主按平台自己挑一个收件人，
    // 新手因此不必为了点一下按钮先搞懂 openid 和 QQ 号的区别。
    function buildTestSendPayload(target) {
      const wanted = toText(target).trim();
      return wanted === '' ? {} : { target: wanted };
    }

    // 结果文案：成功说清"发给谁"，失败说清"为什么"——两句话就能判断下一步该改哪。
    function describeTestResult(payload) {
      if (!isPlainObject(payload) || payload.ok !== true) {
        const reason = isPlainObject(payload) ? toText(payload.error) : '';
        return { kind: 'error', text: '没发出去：' + (reason || '服务没有说明原因'), problems: [] };
      }
      const target = toText(payload.target) || '（自动挑的目标）';
      const chunks = Number(payload.chunkCount);
      // 分了几条是要紧的：官方 QQ 一条消息最多回 4/5 次，超了就被平台拒
      const tail = Number.isFinite(chunks) && chunks > 1 ? '（分 ' + chunks + ' 条）' : '';
      return { kind: 'ok', text: '✅ 已发送给 ' + target + tail, problems: [] };
    }

    // ---------------- 连接向导：三步走通的纯逻辑（不依赖 React，可单测） ----------------

    // 官方机器人的 AppID/AppSecret 只在开放平台后台；NapCat 只要本机扫码登录，根本不进开放平台。
    const OPEN_PLATFORM_URL = 'https://q.qq.com/qqbot/#/developer';
    const NAPCAT_WEB_URL = 'http://127.0.0.1:6099';
    const WIZARD_STATUS_TEXT = { todo: '未做', running: '进行中', ok: '通过', failed: '失败' };
    const WIZARD_STATUS_MARK = { todo: '○', running: '…', ok: '✅', failed: '⚠️' };

    function wizardStatus(value) {
      return Object.prototype.hasOwnProperty.call(WIZARD_STATUS_TEXT, value) ? value : 'todo';
    }

    // 三步的状态机：输入一份页面状态，输出三步各自该怎么显示（顺序固定 1→3）。
    // 失败的一步把宿主给的 error 原样当文案：向导的价值全在"下一步该改哪"这句话上。
    function resolveWizardStep(state) {
      const s = isPlainObject(state) ? state : {};
      const platform = toText(s.platform).trim();
      const official = platform === 'qq-official';
      const napcat = platform === 'qq-napcat';
      const verify = isPlainObject(s.verifyResult) ? s.verifyResult : null;
      const verified = verify !== null && verify.ok === true;
      const test = isPlainObject(s.testResult) ? s.testResult : null;

      const steps = [];
      // 第 1 步：去哪儿抄 AppID/AppSecret。NapCat 改成扫码登录本机后台；
      // 还没选平台（或选了未实现的微信）时不给链接，免得把人带去一个用不上的地方。
      steps.push({
        id: 'open-platform',
        index: 1,
        title: official ? '去开放平台' : napcat ? '登录 NapCat' : '先选平台',
        status: verified ? 'ok' : 'todo',
        url: official ? OPEN_PLATFORM_URL : napcat ? NAPCAT_WEB_URL : '',
        action: official ? '打开开放平台' : napcat ? '打开 NapCat 后台' : '',
        // TODO(P6)：把二维码直接画在这张卡片里，现在只给链接 + 复制
        text: official
          ? '用手机 QQ 扫码登录 → 创建机器人 →「开发设置」里就是 AppID 和 AppSecret。'
          : napcat
            ? '用手机 QQ 扫码登录 NapCat 后台，确认 WebSocket 服务端开着，端口跟下面的 wsUrl 对上。'
            : '先在上面选一种连接方式（QQ 官方机器人 / NapCat），这一步的链接和文案会跟着变。'
      });

      // 第 2 步：只有官方机器人有凭证可填；NapCat 这一步天生没东西做，直接算通过。
      let credentialStatus = 'todo';
      let credentialText = '把上面拿到的 AppID / AppSecret 填进去，点「验证凭证」。';
      if (napcat) {
        credentialStatus = 'ok';
        credentialText = 'NapCat 走本机 WebSocket，没有 AppID / AppSecret，这一步不用做。';
      } else if (!official) {
        credentialText = '先在上面选「QQ 官方机器人」，这一步才有凭证要填。';
      } else if (s.verifying === true) {
        credentialStatus = 'running';
        credentialText = '正在向开放平台要 token，再确认一次网关地址…';
      } else if (verify !== null) {
        credentialStatus = verified ? 'ok' : 'failed';
        credentialText = describeVerifyResult(verify).text;
      }
      steps.push({ id: 'credentials', index: 2, title: '填凭证并验证', status: credentialStatus, text: credentialText });

      // 第 3 步：发一条测试消息 = 配置、连接、送达三件事一起被证明
      let testStatus = 'todo';
      let testText = '点「发条测试消息」，QQ 里收到就说明整条链路通了。';
      if (official && !verified) testText = '先把上一步验证通过，再发测试消息。';
      if (s.testing === true) {
        testStatus = 'running';
        testText = '正在发送…';
      } else if (test !== null) {
        testStatus = test.ok === true ? 'ok' : 'failed';
        testText = describeTestResult(test).text;
      }
      steps.push({ id: 'test-send', index: 3, title: '发条测试消息', status: testStatus, text: testText });

      return steps.map((step) => {
        const status = wizardStatus(step.status);
        return { ...step, status, statusText: WIZARD_STATUS_TEXT[status], mark: WIZARD_STATUS_MARK[status] };
      });
    }

    // 验证结果文案：成功带上"是谁"和"哪个环境"；失败只说人话（错误码宿主已经写在括号里）。
    function describeVerifyResult(res) {
      if (!isPlainObject(res) || res.ok !== true) {
        const reason = isPlainObject(res) ? toText(res.error) : '';
        const step = isPlainObject(res) ? toText(res.step) : '';
        return { kind: 'error', step, text: reason || '验证没通过：服务没有说明原因' };
      }
      const name = toText(res.nickname).trim() || toText(res.appId).trim() || '这台机器人';
      const env = res.sandbox === true ? '沙箱环境' : '正式环境';
      return { kind: 'ok', step: '', text: '✅ 已连通：' + name + '（' + env + '）' };
    }

    // 向导只填两个框：填了才发给宿主，空着/掩码就让宿主拿已保存的配置去验，
    // 于是"什么都没填直接点验证"也能用存过的密钥试一次。
    function buildVerifyPayload(fields) {
      const src = isPlainObject(fields) ? fields : {};
      const pick = (keys) => {
        for (const key of keys) {
          const value = toText(src[key]).trim();
          if (value !== '') return value;
        }
        return '';
      };
      const appId = pick(['qqOfficial.appId', 'appId']);
      const rawSecret = pick(['qqOfficial.appSecret', 'appSecret']);
      const appSecret = rawSecret === SECRET_MASK ? '' : rawSecret;
      const sandboxRaw = src['qqOfficial.sandbox'] !== undefined ? src['qqOfficial.sandbox'] : src.sandbox;
      const payload = {};
      if (appId !== '') payload.appId = appId;
      if (appSecret !== '') payload.appSecret = appSecret;
      if (typeof sandboxRaw === 'boolean') payload.sandbox = sandboxRaw;
      return payload;
    }

    function num(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }

    function statusLine(status) {
      if (!isPlainObject(status)) return '状态：未知（服务未返回状态）';
      const stats = isPlainObject(status.stats) ? status.stats : {};
      const parts = [status.running === true ? '运行中' : '已停止', '启用' + (status.enabled === true ? '开' : '关')];
      if (status.platform) parts.push('平台 ' + toText(status.platform));
      if (status.since) parts.push('启动于 ' + toText(status.since));
      parts.push(
        '收到 ' + num(stats.received) + ' / 已处理 ' + num(stats.handled) + ' / 拒绝 ' + num(stats.denied) + ' / 失败 ' + num(stats.failed)
      );
      if (status.lastError) parts.push('最近错误：' + describeError(status.lastError));
      return parts.join(' · ');
    }

    // ---------------- 网络层（fetch 可注入，测试不碰真实网络） ----------------

    function createApi(fetchImpl, base) {
      const basePath = toText(base || API_BASE).replace(/\/+$/, '');

      function resolveFetch() {
        if (typeof fetchImpl === 'function') return fetchImpl;
        if (typeof fetch === 'function') return (url, init) => fetch(url, init);
        throw makeApiError('当前环境没有可用的 fetch，无法访问 dsh-im-bridge 服务');
      }

      async function request(method, path, body) {
        const init = { method, headers: {}, cache: 'no-store' };
        if (body !== undefined) {
          init.headers['content-type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
        let response;
        try {
          response = await resolveFetch()(basePath + path, init);
        } catch (err) {
          throw makeApiError('连不上 dsh-im-bridge 服务：' + describeError(err));
        }
        if (!response || typeof response.status !== 'number') throw makeApiError('服务返回了无法识别的响应');
        if (response.status < 200 || response.status >= 300) throw makeApiError('服务返回 HTTP ' + response.status);
        let payload;
        try {
          payload = typeof response.json === 'function' ? await response.json() : null;
        } catch (err) {
          throw makeApiError('服务返回的内容不是合法 JSON');
        }
        if (!isPlainObject(payload)) throw makeApiError('服务返回的内容不是 JSON 对象');
        return payload;
      }

      async function getJson(path) {
        const payload = await request('GET', path);
        if (payload.ok === false) throw makeApiError(payload.error || '请求失败', payload.problems);
        return payload;
      }

      return {
        base: basePath,
        request,
        status() {
          return getJson('/status');
        },
        config() {
          return getJson('/config');
        },
        platforms() {
          return getJson('/platforms');
        },
        async save(config) {
          const payload = await request('POST', '/config', { config });
          // 校验失败也走 HTTP 200，必须按 ok 判断，否则会把"没落盘"当成保存成功。
          if (payload.ok === false) throw makeApiError(payload.error || '配置校验失败', payload.problems);
          return payload;
        },
        async control(action) {
          const payload = await request('POST', '/control', { action });
          if (payload.ok === false) throw makeApiError(payload.error || '操作失败', payload.problems);
          return payload;
        },
        async testSend(body) {
          const payload = await request('POST', '/test-send', isPlainObject(body) ? body : {});
          if (payload.ok === false) throw makeApiError(payload.error || '发送测试消息失败', payload.problems);
          return payload;
        },
        async verifyCredentials(body) {
          // 凭证不对是正常结果（页面按 step 说人话），不能按 ok:false 抛错
          return request('POST', '/verify-credentials', isPlainObject(body) ? body : {});
        }
      };
    }

    function createInitialState() {
      return {
        loading: true,
        error: '',
        saving: false,
        testing: false,
        // 向导第 2 步的进行中/结果，与第 3 步的测试结果分开存：两个按钮各自有自己的状态
        verifying: false,
        verifyResult: null,
        testResult: null,
        busy: '',
        platforms: [],
        platformId: '',
        fields: [],
        config: {},
        form: {},
        configPath: '',
        warnings: [],
        status: null,
        notice: null
      };
    }

    function snapshotFrom(platformsPayload, configPayload) {
      const platforms = normalizePlatforms(platformsPayload ? platformsPayload.platforms : []);
      const config = isPlainObject(configPayload && configPayload.config) ? configPayload.config : {};
      const wanted = toText(config.platform).trim();
      const platformId = platforms.filter((p) => p.id === wanted)[0] ? wanted : platforms.length ? platforms[0].id : '';
      const fields = mergeFields(platforms, platformId);
      return {
        platforms,
        platformId,
        fields,
        config,
        form: buildForm(config, fields, platformId),
        configPath: toText(configPayload ? configPayload.configPath : ''),
        warnings: Array.isArray(configPayload && configPayload.warnings) ? configPayload.warnings.map(toText).filter(Boolean) : []
      };
    }

    // ---------------- 渲染 ----------------

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0 24px', fontSize: '13px', lineHeight: '1.6' },
      head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' },
      title: { margin: '0', fontSize: '15px', fontWeight: '600' },
      muted: { color: 'var(--dsh-text-secondary, #888)', fontSize: '12px', margin: '0' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      group: { border: '1px solid var(--dsh-border, rgba(127,127,127,0.25))', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' },
      groupTitle: { margin: '0', fontSize: '12px', fontWeight: '600', color: 'var(--dsh-text-secondary, #888)' },
      summary: { cursor: 'pointer', fontSize: '12px', fontWeight: '600', color: 'var(--dsh-text-secondary, #888)' },
      field: { display: 'flex', flexDirection: 'column', gap: '2px' },
      label: { fontSize: '12px' },
      input: { width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', font: 'inherit' },
      textarea: { width: '100%', boxSizing: 'border-box', minHeight: '64px', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', font: 'inherit', resize: 'vertical' },
      button: { padding: '4px 12px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      primary: { padding: '4px 14px', borderRadius: '6px', border: '1px solid transparent', background: 'var(--dsh-accent, #247bbf)', color: '#fff', font: 'inherit', cursor: 'pointer' },
      notice: { margin: '0', padding: '6px 10px', borderRadius: '6px', fontSize: '12px' },
      ok: { background: 'rgba(48,164,108,0.14)', color: 'var(--dsh-text, inherit)' },
      error: { background: 'rgba(222,80,80,0.14)', color: 'var(--dsh-text, inherit)' },
      problems: { margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px' },
      wizardStep: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px 0 0', borderTop: '1px solid var(--dsh-border, rgba(127,127,127,0.18))' },
      wizardMark: { fontSize: '12px', width: '14px' },
      link: { padding: '4px 12px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', color: 'inherit', textDecoration: 'none', fontSize: '12px' }
    };

    function fieldControl(field, form, onChange) {
      const value = form[field.key];
      const shared = {
        id: 'dsh-bot-field-' + field.key.replace(/\./g, '-'),
        'aria-label': field.label,
        placeholder: field.placeholder || undefined
      };
      if (field.type === 'boolean') {
        return h('input', {
          ...shared,
          type: 'checkbox',
          checked: value === true,
          onChange: (event) => onChange(field.key, !!(event && event.target ? event.target.checked : false))
        });
      }
      if (field.type === 'stringList') {
        return h('textarea', {
          ...shared,
          style: styles.textarea,
          spellCheck: false,
          value: toText(value),
          onChange: (event) => onChange(field.key, event && event.target ? event.target.value : '')
        });
      }
      if (field.type === 'select' && field.options.length > 0) {
        const options = field.options.map((option) =>
          h('option', { key: option.value, value: option.value }, option.label)
        );
        if (!field.options.some((option) => option.value === toText(value))) {
          options.unshift(h('option', { key: '__current', value: toText(value) }, toText(value) || '（未选择）'));
        }
        return h(
          'select',
          { ...shared, style: styles.input, value: toText(value), onChange: (event) => onChange(field.key, event && event.target ? event.target.value : '') },
          options
        );
      }
      return h('input', {
        ...shared,
        style: styles.input,
        type: field.secret ? 'password' : field.type === 'number' ? 'number' : 'text',
        autoComplete: field.secret ? 'new-password' : undefined,
        value: toText(value),
        onChange: (event) => onChange(field.key, event && event.target ? event.target.value : '')
      });
    }

    function noticeNode(notice) {
      if (!isPlainObject(notice) || !notice.text) return null;
      const problems = Array.isArray(notice.problems) ? notice.problems : [];
      return h(
        'div',
        { key: 'notice', style: { ...styles.notice, ...(notice.kind === 'ok' ? styles.ok : styles.error) } },
        h('div', null, notice.text),
        problems.length > 0 ? h('ul', { style: styles.problems }, problems.map((p, i) => h('li', { key: 'p' + i }, p))) : null
      );
    }


    // 连接向导卡片：装完第一次进设置页，照着点三步就能通，不用对着一堆字段猜。
    function wizardNode(state, handlers) {
      const official = toText(state.platformId).trim() === 'qq-official';
      const steps = resolveWizardStep({
        platform: state.platformId,
        verifying: state.verifying === true,
        verifyResult: state.verifyResult,
        testing: state.testing === true,
        testResult: state.testResult
      });
      const rows = steps.map((step) => {
        const controls = [];
        if (step.id === 'open-platform' && step.url !== '') {
          // 用真链接而不是 window.open：浏览器里中键/右键都还能用，也不用碰弹窗拦截
          controls.push(
            h('a', { key: 'open', href: step.url, target: '_blank', rel: 'noreferrer', style: styles.link }, step.action),
            h('button', { key: 'copy', type: 'button', style: styles.button, onClick: () => handlers.copy(step.url) }, '复制链接')
          );
        }
        if (step.id === 'credentials' && official) {
          controls.push(
            h('input', {
              key: 'appId',
              style: styles.input,
              type: 'text',
              'aria-label': 'AppID',
              placeholder: 'AppID',
              value: handlers.value('qqOfficial.appId'),
              onChange: (event) => handlers.field('qqOfficial.appId', event && event.target ? event.target.value : '')
            }),
            h('input', {
              key: 'appSecret',
              style: styles.input,
              type: 'password',
              autoComplete: 'new-password',
              'aria-label': 'AppSecret',
              placeholder: 'AppSecret（填过就显示 ***，不用重打）',
              value: handlers.value('qqOfficial.appSecret'),
              onChange: (event) => handlers.field('qqOfficial.appSecret', event && event.target ? event.target.value : '')
            }),
            h(
              'button',
              { key: 'verify', type: 'button', style: styles.primary, disabled: state.verifying === true, onClick: () => handlers.verify() },
              state.verifying === true ? '验证中…' : '验证凭证'
            )
          );
        }
        if (step.id === 'test-send') {
          controls.push(
            h(
              'button',
              { key: 'test', type: 'button', style: styles.button, disabled: state.testing === true, onClick: () => handlers.test() },
              state.testing === true ? '发送中…' : '发条测试消息'
            )
          );
        }
        return h(
          'div',
          { key: step.id, style: step.index === 1 ? { ...styles.wizardStep, borderTop: 'none' } : styles.wizardStep },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.wizardMark }, step.mark),
            h('strong', null, step.index + '. ' + step.title),
            h('span', { style: styles.muted }, step.statusText)
          ),
          h('p', { style: styles.muted }, step.text),
          controls.length > 0 ? h('div', { style: styles.row }, controls) : null
        );
      });
      return h('section', { key: 'wizard', style: styles.group }, h('h3', { style: styles.groupTitle }, '连接向导（三步点通）'), rows);
    }

    function DshBotSection(props) {
      const api = (props && props.api) || createApi();
      const close = props && typeof props.close === 'function' ? props.close : null;
      const [state, setState] = React.useState(createInitialState);

      const patch = (next) => setState((prev) => ({ ...prev, ...next }));

      React.useEffect(() => {
        let alive = true;
        const apply = (next) => {
          if (alive) setState((prev) => ({ ...prev, ...next }));
        };
        Promise.all([api.platforms(), api.config()])
          .then((results) => {
            apply({ ...snapshotFrom(results[0], results[1]), loading: false, error: '' });
          })
          .catch((err) => apply({ loading: false, error: describeError(err) }));
        // 状态是"锦上添花"，拿不到不能挡住整页配置。
        api
          .status()
          .then((payload) => apply({ status: payload }))
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      function updateField(key, value) {
        setState((prev) => ({ ...prev, form: { ...prev.form, [key]: value }, notice: null }));
      }

      function selectPlatform(id) {
        setState((prev) => {
          const next = switchPlatformForm(prev, id);
          return { ...prev, ...next, notice: null };
        });
      }

      function save() {
        const payload = buildConfig(state.config, state.fields, state.form);
        setState((prev) => ({ ...prev, saving: true, notice: null }));
        api
          .save(payload)
          .then((response) => {
            const config = isPlainObject(response && response.config) ? response.config : payload;
            setState((prev) => ({
              ...prev,
              saving: false,
              config,
              warnings: Array.isArray(response && response.warnings) ? response.warnings.map(toText).filter(Boolean) : prev.warnings,
              configPath: toText(response && response.configPath) || prev.configPath,
              form: buildForm(config, prev.fields, prev.form.platform),
              notice: { kind: 'ok', text: '已保存到 ' + (toText(response && response.configPath) || prev.configPath || '配置文件'), problems: [] }
            }));
          })
          .catch((err) => {
            setState((prev) => ({
              ...prev,
              saving: false,
              notice: { kind: 'error', text: '保存失败：' + describeError(err), problems: (err && err.problems) || [] }
            }));
          });
      }

      function control(action) {
        const label = action === 'stop' ? '已停止' : action === 'restart' ? '已重启' : '已启动';
        setState((prev) => ({ ...prev, busy: action, notice: null }));
        api
          .control(action)
          .then((response) => {
            setState((prev) => ({
              ...prev,
              busy: '',
              status: isPlainObject(response && response.status) ? response.status : prev.status,
              notice: { kind: 'ok', text: label, problems: [] }
            }));
          })
          .catch((err) => {
            setState((prev) => ({
              ...prev,
              busy: '',
              notice: { kind: 'error', text: '操作失败：' + describeError(err), problems: (err && err.problems) || [] }
            }));
          });
      }

      // 发一条测试消息：走的还是"保存后启动"的那套适配器，所以它通了就说明整条链路通了
      function runTest() {
        setState((prev) => ({ ...prev, testing: true, testResult: null, notice: null }));
        api
          .testSend(buildTestSendPayload(state.form.testTarget))
          .then((payload) => {
            // 向导第 3 步要的是原始结果（带 target），notice 是给页面顶部那条提示用的
            setState((prev) => ({ ...prev, testing: false, testResult: payload, notice: describeTestResult(payload) }));
          })
          .catch((err) => {
            setState((prev) => ({
              ...prev,
              testing: false,
              testResult: { ok: false, error: describeError(err) },
              notice: { kind: 'error', text: '没发出去：' + describeError(err), problems: (err && err.problems) || [] }
            }));
          });
      }

      // 向导的两个框读写的是字段表里同一个键（qqOfficial.appId / appSecret），
      // 所以"在向导里填完 → 点保存"就落盘了，不必在下面再填一遍。
      function wizardValue(key) {
        if (Object.prototype.hasOwnProperty.call(state.form, key)) return toText(state.form[key]);
        return toText(dotGet(state.config, key, ''));
      }

      function runVerify() {
        const sandboxInForm = Object.prototype.hasOwnProperty.call(state.form, 'qqOfficial.sandbox')
          ? state.form['qqOfficial.sandbox']
          : dotGet(state.config, 'qqOfficial.sandbox', undefined);
        const payload = buildVerifyPayload({
          'qqOfficial.appId': wizardValue('qqOfficial.appId'),
          'qqOfficial.appSecret': wizardValue('qqOfficial.appSecret'),
          'qqOfficial.sandbox': sandboxInForm
        });
        setState((prev) => ({ ...prev, verifying: true, verifyResult: null, notice: null }));
        api
          .verifyCredentials(payload)
          .then((res) => {
            setState((prev) => ({ ...prev, verifying: false, verifyResult: res }));
          })
          .catch((err) => {
            setState((prev) => ({
              ...prev,
              verifying: false,
              verifyResult: { ok: false, step: 'unknown', error: describeError(err) }
            }));
          });
      }

      // 复制链接：剪贴板不可用（非 https、老浏览器）时也不该把页面弄崩，只是复制不成功
      function copyText(value) {
        const wanted = toText(value);
        if (wanted === '') return;
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            const ret = navigator.clipboard.writeText(wanted);
            if (ret && typeof ret.catch === 'function') ret.catch(() => {});
          }
        } catch {
          // 剪贴板被拒就只留链接本身，用户还能手选中
        }
        setState((prev) => ({ ...prev, notice: { kind: 'ok', text: '已复制链接：' + wanted, problems: [] } }));
      }

      try {
        const selected = state.platforms.filter((p) => p.id === state.platformId)[0] || null;
        const groups = groupFields(state.fields.filter((field) => ENVELOPE_KEYS.indexOf(field.key) === -1));
        // 信封控件独占 platform/enabled，但 label/help 仍取自 host 下发的字段，避免两套文案。
        const enabledField = state.fields.filter((field) => field.key === 'enabled')[0] || null;
        const controls = [];

        const header = h(
          'div',
          { key: 'head', style: styles.head },
          h('div', null, h('h2', { style: styles.title }, 'dsh bot'), h('p', { style: styles.muted }, '把 QQ 消息转给本机 DSH 处理，再把结果回复到聊天。')),
          close ? h('button', { type: 'button', style: styles.button, onClick: () => close() }, '完成') : null
        );
        controls.push(header);

        // 向导必须排在最上面：第一次进来的人看到的第一个东西应该是"点哪三步"，而不是 30 个字段
        controls.push(
          wizardNode(state, {
            field: updateField,
            value: wizardValue,
            verify: runVerify,
            test: runTest,
            copy: copyText
          })
        );

        controls.push(h('p', { key: 'status', style: styles.muted }, state.loading ? '正在读取状态…' : statusLine(state.status)));

        const actionButtons = ['start', 'stop', 'restart'].map((action) =>
          h(
            'button',
            {
              key: 'btn-' + action,
              type: 'button',
              style: styles.button,
              disabled: state.busy !== '' || state.loading,
              onClick: () => control(action)
            },
            action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'
          )
        );
        controls.push(
          h(
            'div',
            { key: 'actions', style: styles.row },
            h(
              'label',
              { style: styles.row },
              h('input', {
                type: 'checkbox',
                checked: state.form.enabled === true,
                onChange: (event) => updateField('enabled', !!(event && event.target ? event.target.checked : false))
              }),
              enabledField ? enabledField.label : '启用（保存后生效）'
            ),
            h('span', { style: styles.muted }, '|'),
            actionButtons,
            h('span', { style: styles.muted }, '|'),
            h(
              'button',
              {
                key: 'btn-test',
                type: 'button',
                style: styles.button,
                disabled: state.testing || state.loading,
                onClick: () => runTest()
              },
              state.testing ? '发送中…' : '发送测试消息'
            )
          )
        );

        if (state.loading) controls.push(h('p', { key: 'loading', style: styles.muted }, '正在读取配置…'));
        if (state.error) {
          controls.push(
            h('div', { key: 'error', style: { ...styles.notice, ...styles.error } }, state.error),
            h(
              'div',
              { key: 'reload', style: styles.row },
              h('button', { type: 'button', style: styles.button, onClick: () => window.location.reload() }, '重新加载页面')
            )
          );
        }

        if (state.platforms.length > 0) {
          controls.push(
            h(
              'div',
              { key: 'platform', style: styles.field },
              h('label', { style: styles.label, htmlFor: 'dsh-bot-platform' }, '平台'),
              h(
                'select',
                {
                  id: 'dsh-bot-platform',
                  style: styles.input,
                  value: state.platformId,
                  disabled: state.saving,
                  onChange: (event) => selectPlatform(event && event.target ? event.target.value : '')
                },
                state.platforms.map((platform) => h('option', { key: platform.id, value: platform.id }, platform.label))
              ),
              selected && selected.description ? h('p', { style: styles.muted }, selected.description) : null
            )
          );
        }

        if (!state.loading && !state.error && state.fields.length === 0) {
          controls.push(h('p', { key: 'nofields', style: styles.muted }, '服务没有下发任何可配置字段，请检查 dsh-im-bridge 宿主半边的 /platforms 路由。'));
        }

        for (const group of groups) {
          const rows = group.fields.map((field) =>
            h(
              'div',
              { key: field.key, style: styles.field },
              h(
                'label',
                { style: styles.label, htmlFor: 'dsh-bot-field-' + field.key.replace(/\./g, '-') },
                field.label,
                field.required ? h('span', { style: { color: '#de5050' } }, ' *') : null
              ),
              fieldControl(field, state.form, updateField),
              field.help ? h('p', { style: styles.muted }, field.help) : null
            )
          );
          if (group.group === 'advanced') {
            // 折叠用浏览器原生的 details：不引第三方组件，也不自己实现展开状态
            controls.push(
              h(
                'details',
                { key: 'group-advanced', style: styles.group },
                h('summary', { style: styles.summary }, group.title),
                rows
              )
            );
            continue;
          }
          controls.push(
            h('section', { key: 'group-basic', style: styles.group }, h('h3', { style: styles.groupTitle }, group.title), rows)
          );
        }

        controls.push(
          h(
            'div',
            { key: 'save', style: styles.row },
            h('button', { type: 'button', style: styles.primary, disabled: state.saving || state.loading, onClick: () => save() }, state.saving ? '保存中…' : '保存'),
            h('span', { style: styles.muted }, state.configPath ? '配置文件：' + state.configPath : '')
          )
        );

        const notice = noticeNode(state.notice);
        if (notice) controls.push(notice);

        if (state.warnings.length > 0) {
          controls.push(
            h(
              'div',
              { key: 'warnings', style: { ...styles.notice, ...styles.ok } },
              h('div', null, '配置告警'),
              h('ul', { style: styles.problems }, state.warnings.map((w, i) => h('li', { key: 'w' + i }, w)))
            )
          );
        }

        return h('div', { style: styles.root }, controls);
      } catch (err) {
        // 渲染异常绝不能变成设置页白屏：退化成一行可读提示。
        return h('div', { style: { ...styles.notice, ...styles.error } }, 'dsh bot 页面渲染失败：' + describeError(err));
      }
    }

    function apply(ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
          console.warn('[dsh-bot] slots 服务不可用，设置页已跳过注册');
          return;
        }
        ctx.slots.inject(SECTION_SLOT, () =>
          ctx.slots.register({ name: SECTION_SLOT, id: SECTION_ID, order: 120, label: () => 'dsh bot' }, DshBotSection)
        );
      } catch (err) {
        // 第三方插件的 slot 注册是未文档化能力：失败只降级，不能让 DSH 起不来。
        console.warn('[dsh-bot] 设置页注册失败：' + describeError(err));
      }
    }

    module.exports.apply = apply;
    module.exports.inject = ['slots', 'locale'];
    module.exports.DshBotSection = DshBotSection;
    module.exports.API_BASE = API_BASE;
    module.exports.SECRET_MASK = SECRET_MASK;
    module.exports.createApi = createApi;
    module.exports.createInitialState = createInitialState;
    module.exports.snapshotFrom = snapshotFrom;
    module.exports.dotGet = dotGet;
    module.exports.dotSet = dotSet;
    module.exports.deepClone = deepClone;
    module.exports.textToList = textToList;
    module.exports.listToText = listToText;
    module.exports.normalizeField = normalizeField;
    module.exports.normalizePlatforms = normalizePlatforms;
    module.exports.mergeFields = mergeFields;
    module.exports.groupFields = groupFields;
    module.exports.GROUP_TITLES = GROUP_TITLES;
    module.exports.buildTestSendPayload = buildTestSendPayload;
    module.exports.describeTestResult = describeTestResult;
    module.exports.resolveWizardStep = resolveWizardStep;
    module.exports.describeVerifyResult = describeVerifyResult;
    module.exports.buildVerifyPayload = buildVerifyPayload;
    module.exports.OPEN_PLATFORM_URL = OPEN_PLATFORM_URL;
    module.exports.NAPCAT_WEB_URL = NAPCAT_WEB_URL;
    module.exports.WIZARD_STATUS_TEXT = WIZARD_STATUS_TEXT;
    module.exports.formFromConfig = formFromConfig;
    module.exports.buildForm = buildForm;
    module.exports.buildConfig = buildConfig;
    module.exports.switchPlatformForm = switchPlatformForm;
    module.exports.describeError = describeError;
    module.exports.statusLine = statusLine;
    return module.exports;
  }
});
