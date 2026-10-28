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

    // 二维码由宿主算好随 /platforms 下发：本文件引不到 lib/qr.js，前端只负责把 SVG 贴上去。
    // 只收「以 <svg 开头、且不带脚本/事件属性」的字符串——这是唯一被当 HTML 注入的位置。
    function normalizeWizardQr(raw) {
      const out = {};
      if (!isPlainObject(raw)) return out;
      for (const key of Object.keys(raw)) {
        const svg = typeof raw[key] === 'string' ? raw[key].trim() : '';
        if (!/^<svg[\s>]/i.test(svg)) continue;
        if (/<script|\son[a-z]+\s*=/i.test(svg)) continue;
        out[key] = svg;
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
  const NAPCAT_DOWNLOAD_URL = 'https://github.com/NapNeko/NapCatQQ/releases';
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
        title: official ? '去开放平台' : napcat ? '装好 NapCat 并扫码' : '先选平台',
        status: verified ? 'ok' : 'todo',
        url: official ? OPEN_PLATFORM_URL : napcat ? NAPCAT_DOWNLOAD_URL : '',
        action: official ? '打开开放平台' : napcat ? '打开 NapCat 下载页' : '',
        // TODO(P6)：把二维码直接画在这张卡片里，现在只给链接 + 复制
        text: official
          ? '用手机 QQ 扫码登录 → 创建机器人 →「开发设置」里就是 AppID 和 AppSecret。'
          : napcat
            ? '装好并启动 NapCat / SnowLuma，在里面用手机扫码登录小号；确认 WebSocket 服务端开着，端口跟下面的地址对上。'
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

    // ---------------- 设置页布局（两栏）：纯逻辑，不依赖 React，可单测 ----------------
    // 左栏是平台卡片，右栏是「正在接入 / 手动接入」两个 Tab + 内容 + 底部已绑定卡片。
    // 这里只算"该显示什么"，渲染层负责拼装，所以每条都能脱离浏览器断言。

    // 图标只用 emoji：零依赖，也不会像外部图片那样在离线环境里变成破图。
    // 平台图标：app 图标样式（品牌色圆角方块 + 白色字形）。
    // QQ / 微信 的字形路径取自 Simple Icons（CC0 1.0），见 THIRD_PARTY_NOTICES.md。
    const PLATFORM_ICONS = { 'qq-napcat': 'qq', 'qq-official': 'robot', wechat: 'chat', weixin: 'chat' };
    const ICON_BRAND = {
      qq: {
        bg: '#12B7F5',
        fill: '#fff',
        stroke: 'none',
        nodes: [{ tag: 'path', d: "M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673" }]
      },
      chat: {
        bg: '#07C160',
        fill: '#fff',
        stroke: 'none',
        nodes: [{ tag: 'path', d: "M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" }]
      },
      robot: {
        bg: '#3B82F6',
        fill: 'none',
        stroke: '#fff',
        strokeWidth: '1.8',
        nodes: [
          { tag: 'rect', x: '5', y: '8', width: '14', height: '10.5', rx: '3.5' },
          { tag: 'path', d: 'M12 4.2v3.4' },
          { tag: 'circle', cx: '12', cy: '4', r: '1.1' },
          { tag: 'circle', cx: '9.6', cy: '12.6', r: '1.05' },
          { tag: 'circle', cx: '14.4', cy: '12.6', r: '1.05' },
          { tag: 'path', d: 'M10 16h4' }
        ]
      }
    };
    // 尚未开放的平台：卡片照样列出来（用户知道以后会有），但点不动并标注"即将支持"。
    const PLATFORM_COMING_SOON = ['wechat', 'weixin'];

    /** 图标 token → 品牌色方块 + 白色字形；不是 token 的（宿主下发的自定义图标）按文本渲染。 */
    function iconNode(value, style) {
      const key = toText(value).trim();
      const brand = ICON_BRAND[key];
      if (!brand) return h('span', { style }, key);
      const svgProps = {
        viewBox: '0 0 24 24',
        width: '15',
        height: '15',
        fill: brand.fill,
        stroke: brand.stroke,
        strokeWidth: brand.strokeWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true'
      };
      return h('span', {
        style: {
          width: '24px',
          height: '24px',
          borderRadius: '7px',
          background: brand.bg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '0 0 24px',
          ...style
        }
      }, h('svg', svgProps, brand.nodes.map((node, index) => h(node.tag, { key: 'n' + index, ...node }))));
    }

    function platformCards(platforms, selected) {
      const list = Array.isArray(platforms) ? platforms : [];
      const wanted = toText(selected).trim();
      const out = [];
      for (const item of list) {
        if (!isPlainObject(item)) continue;
        const id = toText(item.id).trim();
        if (!id) continue;
        const disabled =
          PLATFORM_COMING_SOON.indexOf(id) !== -1 ||
          item.disabled === true ||
          item.available === false ||
          item.comingSoon === true;
        out.push({
          id,
          label: toText(item.label).trim() || id,
          icon: toText(item.icon).trim() || PLATFORM_ICONS[id] || '🔌',
          selected: id === wanted,
          disabled,
          badge: disabled ? '即将支持' : ''
        });
      }
      return out;
    }

    const SETTINGS_TABS = [
      { id: 'connect', label: '正在接入' },
      { id: 'manual', label: '手动接入' }
    ];

    function tabsOf(active) {
      const wanted = toText(active).trim() || 'connect';
      return SETTINGS_TABS.map((item) => ({ id: item.id, label: item.label, active: item.id === wanted }));
    }

    // 每个平台"手机上要做的三件事"。文案就是用户在手机上照着做的动作，不能泛化。
    const CONNECT_STEPS = {
      'qq-official': ['手机打开开放平台', '创建或查看机器人，复制 AppID 与 AppSecret', '回到这里填进去，点「验证凭证」'],
      'qq-napcat': ['下载并启动 NapCat / SnowLuma', '在它的面板里用手机扫码登录小号', '回来填 WebSocket 地址（默认 3001）与口令，点「检测连接」']
    };

    function stepsOf(platform) {
      const list = CONNECT_STEPS[toText(platform).trim()];
      if (!Array.isArray(list)) return [];
      return list.map((text, index) => ({ index: index + 1, text }));
    }

    const CONNECT_COPY = {
      'qq-official': {
        waitText: '等待手机打开开放平台',
        title: '用自己的手机完成机器人接入',
        description: '在手机上打开 QQ 开放平台，创建或查看机器人，把 AppID / AppSecret 填到这里。',
        action: '在手机上打开开放平台',
        reopen: '重新打开开放平台',
        url: OPEN_PLATFORM_URL
      },
      'qq-napcat': {
        waitText: '等待用小号扫码登录',
        title: '小号 QQ 扫码登录，托管给 DSH',
        description: '先在电脑上装 NapCat / SnowLuma 并启动，它会给你登录二维码；用手机 QQ 扫它、把小号登进去，再把端口和口令填到下面。',
        action: '打开 NapCat 下载页',
        reopen: '重新打开下载页',
        url: NAPCAT_DOWNLOAD_URL
      }
    };

    // 还没选平台（或选了未开放的平台）时的兜底文案：不说"已连通"，也不给用不上的链接。
    const CONNECT_COPY_FALLBACK = {
      waitText: '先选一种接入方式',
      title: '选一种接入方式开始',
      description: '左边挑「QQ 个人账号」或「QQ 官方机器人」，这里会出现对应的手机操作步骤。',
      action: '',
      reopen: '',
      url: ''
    };

    const CONNECT_LIVE_TEXT = '已连通';

    function connectCopy(platform) {
      const id = toText(platform).trim();
      const copy = Object.prototype.hasOwnProperty.call(CONNECT_COPY, id) ? CONNECT_COPY[id] : CONNECT_COPY_FALLBACK;
      return { platform: id, liveText: CONNECT_LIVE_TEXT, ...copy };
    }

    const BINDING_NAMES = { 'qq-official': 'QQ 机器人', 'qq-napcat': 'NapCat 机器人', wechat: '微信机器人' };
    const BINDING_KIND_COLOR = { ok: '#22c55e', failed: '#ef4444', idle: 'var(--dsh-text-secondary, #888)' };

    function pad2(value) {
      const n = Math.floor(Math.abs(Number(value)));
      return n < 10 ? '0' + n : String(n);
    }

    // 宿主没给时间就明说"—"：编一个时间戳比空着更糟，用户会以为刚检查过。
    function clockOf(value) {
      const ms = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Number.NaN;
      if (!Number.isFinite(ms) || ms <= 0) return '—';
      const date = new Date(ms);
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
    }

    function durationText(value) {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 0) return '—';
      return ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
    }

    // 取第一个"像数字"的候选：/status 将来多给字段时不用改渲染层。
    function pickNumber() {
      for (let i = 0; i < arguments.length; i += 1) {
        const raw = arguments[i];
        if (raw === undefined || raw === null || raw === '') continue;
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) return n;
      }
      return null;
    }

    // 底部「已绑定」卡片：状态点/文案/最近检查/展开后的五项详情。
    // 宿主没下发的项一律"—"，宁可少说，也不猜一个看起来像真的数字。
    function describeBindingCard(status, extras) {
      const s = isPlainObject(status) ? status : {};
      const e = isPlainObject(extras) ? extras : {};
      const platformId = toText(s.platform).trim() || toText(e.platform).trim();
      const name = BINDING_NAMES[platformId] || toText(e.label).trim() || platformId || '未选择平台';
      const avatar = PLATFORM_ICONS[platformId] || name.slice(0, 1) || '🤖';
      const error = toText(s.lastError).replace(/\s+/g, ' ').trim();

      let kind = 'idle';
      let statusText = '未启动';
      if (s.running === true) {
        kind = 'ok';
        statusText = '运行正常';
      } else if (error !== '') {
        kind = 'failed';
        statusText = '启动失败：' + (error.length > 40 ? error.slice(0, 40) + '…' : error);
      }

      const sessions = pickNumber(e.sessions, s.sessions);
      const duration = pickNumber(e.lastRoundMs, s.lastRoundMs, s.lastRoundDurationMs);
      const whitelist = pickNumber(e.whitelistCount, s.whitelistCount);
      const runner = toText(e.runner).trim() || toText(s.runner).trim();

      return {
        platformId,
        name,
        avatar,
        kind,
        color: BINDING_KIND_COLOR[kind],
        statusText,
        checkedAt: clockOf(e.checkedAt === undefined ? s.checkedAt : e.checkedAt),
        details: [
          { label: '平台', value: platformId || '—' },
          { label: '跑法', value: runner || '—' },
          { label: '会话数', value: sessions === null ? '—' : String(sessions) },
          { label: '最近一轮耗时', value: duration === null ? '—' : durationText(duration) },
          { label: '白名单人数', value: whitelist === null ? '—' : whitelist + ' 人' }
        ]
      };
    }

    // 两栏 / 堆叠：宽度未知（0）时按宽屏走，宁可并排也不要一次都不显示。
    const LAYOUT_STACK_BREAKPOINT = 720;

    function layoutStyle(width) {
      const n = Number(width);
      const stacked = Number.isFinite(n) && n > 0 && n < LAYOUT_STACK_BREAKPOINT;
      const left = stacked
        ? { display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', minWidth: '0' }
        : { display: 'flex', flexDirection: 'column', gap: '8px', flex: '0 0 30%', minWidth: '200px', maxWidth: '320px' };
      const right = stacked
        ? { display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', minWidth: '0' }
        : { display: 'flex', flexDirection: 'column', gap: '12px', flex: '1 1 360px', minWidth: '0' };
      return {
        stacked,
        // flexWrap 是兜底：真实容器比视口窄时（侧栏展开/缩放），没有测到宽度也照样堆叠
        container: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '16px', flexDirection: stacked ? 'column' : 'row' },
        left,
        right
      };
    }

    // 视口宽度只在浏览器里才有；没有 window（测试/SSR）就当未知，按宽屏渲染。
    function viewportWidthOf() {
      try {
        if (typeof window !== 'undefined' && Number.isFinite(Number(window.innerWidth))) return Number(window.innerWidth);
      } catch {
        // 取不到宽度不影响任何配置能力
      }
      return 0;
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
        // 右栏当前 Tab：'connect'（正在接入，默认）/ 'manual'（手动接入）
        tab: 'connect',
        // 「取消」只收起向导卡，不动任何配置；是否展开属于纯展示状态
        connectCollapsed: false,
        showBindingDetails: false,
        // 容器/视口宽度，用来决定两栏还是堆叠；0 = 还没测到（先按宽屏渲染）
        viewportWidth: 0,
        // 最近一次 /status 成功的时间：已绑定卡片上的「最近检查」如实来自这里
        statusAt: 0,
        platforms: [],
        // 平台 id -> 二维码 SVG 字符串；宿主没下发或编码失败时为空对象（退回占位方块）
        wizardQr: {},
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
        wizardQr: normalizeWizardQr(platformsPayload ? platformsPayload.wizardQr : {}),
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
      link: { padding: '4px 12px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', color: 'inherit', textDecoration: 'none', fontSize: '12px' },
      panel: { display: 'flex', flexDirection: 'column', gap: '12px' },
      hidden: { display: 'none' },
      // 右栏顶部：左边两个 Tab，右边状态药丸
      tabsRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,0.25))', paddingBottom: '8px' },
      tabList: { display: 'flex', gap: '4px' },
      tab: { padding: '4px 12px', borderRadius: '6px', border: '1px solid transparent', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '13px', cursor: 'pointer' },
      tabActive: { background: 'rgba(59,130,246,0.12)', color: '#3b82f6', borderColor: 'rgba(59,130,246,0.35)', fontWeight: '600' },
      pill: { padding: '2px 10px', borderRadius: '999px', fontSize: '12px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.3))', color: 'var(--dsh-text-secondary, #888)' },
      pillOn: { borderColor: 'rgba(34,197,94,0.5)', color: '#16a34a', background: 'rgba(34,197,94,0.12)' },
      // 左栏平台卡片：选中 = 1px 蓝描边 + 略深底色 + 名称高亮
      card: { display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '10px 12px', borderRadius: '10px', boxSizing: 'border-box', border: '1px solid var(--dsh-border, rgba(127,127,127,0.22))', background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' },
      cardOn: { borderColor: '#3b82f6', background: 'rgba(59,130,246,0.10)' },
      cardOff: { opacity: 0.5, cursor: 'not-allowed' },
      cardIcon: { fontSize: '20px', lineHeight: '1', width: '22px', textAlign: 'center', flex: '0 0 22px', color: 'var(--dsh-text-secondary, #9aa4b2)' },
      cardText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' },
      cardName: { fontSize: '13px', fontWeight: '500', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      cardNameOn: { color: '#3b82f6', fontWeight: '600' },
      cardBadge: { fontSize: '11px', color: 'var(--dsh-text-secondary, #888)' },
      connectCard: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '14px 16px', borderRadius: '10px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.25))' },
      connectHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', width: '100%', fontSize: '12px' },
      eyebrow: { fontSize: '12px', color: 'var(--dsh-text-secondary, #888)' },
      connectTitle: { margin: '0', fontSize: '18px', fontWeight: '700', lineHeight: '1.35', textAlign: 'center' },
      connectDesc: { margin: '0', fontSize: '12px', lineHeight: '1.5', color: 'var(--dsh-text-secondary, #888)', maxWidth: '46ch', textAlign: 'center' },
      // 二维码占位：白底圆角方块；宿主没下发真二维码时用它兜底
      qrSquare: { width: '220px', height: '220px', boxSizing: 'border-box', padding: '12px', background: '#fff', border: '1px dashed rgba(59,130,246,0.45)', borderRadius: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', color: '#0f172a' },
      placeholderAction: { padding: '8px 14px', borderRadius: '8px', background: '#3b82f6', color: '#fff', textDecoration: 'none', fontSize: '13px', fontWeight: '600', textAlign: 'center', maxWidth: '100%' },
      placeholderUrl: { fontSize: '11px', color: '#475569', wordBreak: 'break-all', textAlign: 'center' },
      // 真二维码：和占位方块同尺寸的白底框，换进换出都不跳版
      qrImageBox: { width: '220px', height: '220px', boxSizing: 'border-box', padding: '10px', background: '#fff', border: '1px solid rgba(15,23,42,0.12)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      steps: { display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', paddingTop: '4px' },
      stepRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px' },
      stepIndex: { flex: '0 0 18px', width: '18px', height: '18px', borderRadius: '50%', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', lineHeight: '1' },
      dot: { display: 'inline-block', flex: '0 0 6px', width: '6px', height: '6px', borderRadius: '50%', background: '#f59e0b' },
      bindingRow: { display: 'flex', alignItems: 'center', gap: '10px' },
      avatar: { flex: '0 0 36px', width: '36px', height: '36px', borderRadius: '50%', color: 'var(--dsh-accent, #3b82f6)', padding: '6px', boxSizing: 'border-box', background: 'rgba(59,130,246,0.14)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' },
      bindingName: { fontSize: '13px', fontWeight: '600' },
      credentialBlock: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '6px', width: '100%', paddingTop: '4px' },
      actionRow: { width: '100%', justifyContent: 'flex-start', paddingTop: '2px' },
      details: { display: 'flex', flexDirection: 'column', gap: '4px', width: '100%', paddingTop: '8px', borderTop: '1px solid var(--dsh-border, rgba(127,127,127,0.18))' },
      detailRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', fontSize: '12px' },
      ghostButton: { padding: '2px 8px', borderRadius: '6px', border: '1px solid transparent', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer' }
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


    // 左栏平台卡片：整块可点，选中态用 1px 蓝描边 + 略深底色 + 名称高亮。
    function platformCardNode(card, onSelect) {
      const style = {
        ...styles.card,
        ...(card.selected ? styles.cardOn : null),
        ...(card.disabled ? styles.cardOff : null)
      };
      return h(
        'button',
        {
          key: card.id,
          type: 'button',
          style,
          disabled: card.disabled,
          'aria-pressed': card.selected === true,
          onClick: () => {
            if (!card.disabled) onSelect(card.id);
          }
        },
        iconNode(card.icon, { ...styles.cardIcon, key: 'icon' }),
        h(
          'span',
          { key: 'text', style: styles.cardText },
          h('span', { key: 'name', style: { ...styles.cardName, ...(card.selected ? styles.cardNameOn : null) } }, card.label),
          card.badge === '' ? null : h('span', { key: 'badge', style: styles.cardBadge }, card.badge)
        )
      );
    }

    function tabNode(tab, onPick) {
      return h(
        'button',
        {
          key: tab.id,
          type: 'button',
          style: { ...styles.tab, ...(tab.active ? styles.tabActive : null) },
          'aria-pressed': tab.active === true,
          onClick: () => onPick(tab.id)
        },
        tab.label
      );
    }

    // 「正在接入」= 向导卡：状态 → 主标题 → 说明 → 二维码占位 → 编号步骤 → 次级按钮。
    function connectPanelNode(state, handlers) {
      const platform = toText(state.platformId).trim();
      const copy = connectCopy(platform);
      const steps = stepsOf(platform);
      const official = platform === 'qq-official';
      const napcat = platform === 'qq-napcat';
      const status = isPlainObject(state.status) ? state.status : {};
      const verify = isPlainObject(state.verifyResult) ? state.verifyResult : null;
      const test = isPlainObject(state.testResult) ? state.testResult : null;
      const verifying = state.verifying === true;
      const testing = state.testing === true;
      const busy = toText(state.busy);

      // 已连通只认"能证明连通"的东西：官方机器人靠凭证验证，NapCat 靠运行时真的在跑。
      // 只看 status.running 会让"验证失败"的卡片同时显示已连通。
      const live = official ? verify !== null && verify.ok === true : napcat ? status.running === true : false;

      const head = h(
        'div',
        { key: 'head', style: styles.connectHead },
        h('span', { key: 'eyebrow', style: styles.eyebrow }, '连接向导（三步点通）'),
        h(
          'span',
          { key: 'state', style: styles.row },
          h('span', { key: 'dot', style: { ...styles.dot, background: live ? '#22c55e' : '#f59e0b' } }),
          h('span', { key: 'text', style: { color: live ? '#22c55e' : 'var(--dsh-text-secondary, #888)' } }, live ? copy.liveText : copy.waitText)
        )
      );
      const title = h('h3', { key: 'title', style: styles.connectTitle }, copy.title);
      const desc = h('p', { key: 'desc', style: styles.connectDesc }, copy.description);

      // 「取消」只收起卡片：不动配置，也不丢已经填过的输入
      if (state.connectCollapsed === true) {
        return h(
          'section',
          { key: 'connect', style: styles.connectCard },
          head,
          title,
          h(
            'div',
            { key: 'collapsed', style: styles.row },
            h('span', { key: 'hint', style: styles.muted }, '接入向导已收起，配置没有改动。'),
            h('button', { key: 'expand', type: 'button', style: styles.button, onClick: () => handlers.expand() }, '展开')
          )
        );
      }

      // 二维码是宿主算好的 SVG（GET /platforms 的 wizardQr）：本文件引不到 lib/qr.js，
      // 所以这里只贴图。宿主没给（编码失败/旧宿主）就退回占位方块，不能白屏。
      const qrSvg = isPlainObject(state.wizardQr) ? toText(state.wizardQr[platform]) : '';
      const actionLink =
        copy.url === ''
          ? null
          : h('a', { key: 'go', href: copy.url, target: '_blank', rel: 'noreferrer', style: styles.placeholderAction }, copy.action);

      const square = qrSvg
        ? h('div', {
            key: 'square',
            style: styles.qrImageBox,
            'aria-label': '扫码打开：' + copy.url,
            dangerouslySetInnerHTML: { __html: qrSvg }
          })
        : h(
            'div',
            { key: 'square', style: styles.qrSquare },
            copy.url === ''
              ? h('span', { key: 'none', style: { fontSize: '12px', color: '#475569' } }, '还没有可打开的链接')
              : actionLink,
            h('span', { key: 'url', style: styles.placeholderUrl }, copy.url === '' ? '—' : copy.url)
          );

      const linkRow = h(
        'div',
        { key: 'link', style: styles.row },
        h('span', { key: 'label', style: styles.muted }, '当前链接：' + (copy.url === '' ? '—' : copy.url)),
        // 方块里只放二维码时，按钮挪到这一行：扫不了码的人还有一条路
        qrSvg ? actionLink : null,
        h('button', { key: 'copy', type: 'button', style: styles.button, onClick: () => handlers.copy(copy.url) }, '复制链接')
      );

      const stepRows = steps.map((step) =>
        h(
          'div',
          { key: 'step-' + step.index, style: styles.stepRow },
          h('span', { key: 'n', style: styles.stepIndex }, String(step.index)),
          h('span', { key: 't' }, step.text)
        )
      );

      const credential = [];
      if (official) {
        const credentialStatus = verifying ? 'running' : verify === null ? 'todo' : verify.ok === true ? 'ok' : 'failed';
        credential.push(
          h('div', { key: 'credTitle', style: styles.eyebrow }, '去开放平台拿 AppID / AppSecret'),
          h(
            'div',
            { key: 'credRow', style: styles.row },
            h('input', {
              key: 'appId',
              style: { ...styles.input, width: 'auto', flex: '1 1 120px' },
              type: 'text',
              'aria-label': 'AppID',
              placeholder: 'AppID',
              value: handlers.value('qqOfficial.appId'),
              onChange: (event) => handlers.field('qqOfficial.appId', event && event.target ? event.target.value : '')
            }),
            h('input', {
              key: 'appSecret',
              style: { ...styles.input, width: 'auto', flex: '1 1 140px' },
              type: 'password',
              autoComplete: 'new-password',
              'aria-label': 'AppSecret',
              placeholder: 'AppSecret（填过就显示 ***，不用重打）',
              value: handlers.value('qqOfficial.appSecret'),
              onChange: (event) => handlers.field('qqOfficial.appSecret', event && event.target ? event.target.value : '')
            }),
            h(
              'button',
              { key: 'verify', type: 'button', style: styles.primary, disabled: verifying || state.loading === true, onClick: () => handlers.verify() },
              verifying ? '验证中…' : '验证凭证'
            ),
            h('span', { key: 'mark', style: styles.wizardMark }, WIZARD_STATUS_MARK[credentialStatus]),
            h('span', { key: 'statusText', style: styles.muted }, WIZARD_STATUS_TEXT[credentialStatus])
          ),
          verify === null ? null : h('p', { key: 'verifyText', style: styles.muted }, describeVerifyResult(verify).text)
        );
      } else if (napcat) {
        credential.push(
          h(
            'p',
            { key: 'napcatHint', style: styles.muted },
            '个人号走本机 WebSocket，没有 AppID / AppSecret：小号扫码登录好、端口对上，点「检测连接」。'
          )
        );
      }

      const testRow = h(
        'div',
        { key: 'test', style: { ...styles.row, ...styles.actionRow } },
        h('button', { key: 'btn', type: 'button', style: styles.button, disabled: testing || state.loading === true, onClick: () => handlers.test() }, testing ? '发送中…' : '发条测试消息'),
        test === null ? null : h('span', { key: 'res', style: styles.muted }, describeTestResult(test).text)
      );

      const secondary = [];
      if (napcat) {
        secondary.push(
          h(
            'button',
            { key: 'detect', type: 'button', style: styles.button, disabled: busy === 'detect', onClick: () => handlers.detect() },
            busy === 'detect' ? '检测中…' : '检测连接'
          )
        );
      } else if (copy.reopen !== '') {
        secondary.push(h('button', { key: 'reopen', type: 'button', style: styles.button, onClick: () => handlers.open() }, copy.reopen));
      }
      secondary.push(h('button', { key: 'cancel', type: 'button', style: styles.ghostButton, onClick: () => handlers.cancel() }, '取消'));

      return h(
        'section',
        { key: 'connect', style: styles.connectCard },
        head,
        title,
        desc,
        square,
        linkRow,
        stepRows.length === 0 ? null : h('div', { key: 'steps', style: styles.steps }, stepRows),
        // 凭证区块左对齐：步骤是"照着做"的清单，中间的说明和输入框跟它同一条视觉基线
        h('div', { key: 'credential', style: styles.credentialBlock }, credential),
        testRow,
        h('div', { key: 'secondary', style: { ...styles.row, ...styles.actionRow } }, secondary)
      );
    }

    // 底部「已绑定」卡片：两个 Tab 都显示；点箭头才展开五项详情。
    function bindingPanelNode(state, handlers) {
      const whitelist = dotGet(state.config, 'security.userWhitelist', undefined);
      const card = describeBindingCard(state.status, {
        platform: state.platformId,
        runner: toText(dotGet(state.config, 'dsh.runner', '')),
        whitelistCount: Array.isArray(whitelist) ? whitelist.length : null,
        checkedAt: state.statusAt
      });
      const expanded = state.showBindingDetails === true;
      return h(
        'section',
        { key: 'binding', style: styles.group },
        h('h3', { key: 'title', style: styles.groupTitle }, '已绑定'),
        h(
          'div',
          { key: 'main', style: styles.bindingRow },
          iconNode(card.avatar, { ...styles.avatar, key: 'avatar' }),
          h(
            'div',
            { key: 'meta', style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: '0' } },
            h('div', { key: 'name', style: styles.bindingName }, card.name),
            h(
              'div',
              { key: 'state', style: styles.row },
              h('span', { key: 'dot', style: { ...styles.dot, background: card.color } }),
              h('span', { key: 'text', style: styles.muted }, card.statusText)
            )
          ),
          h(
            'div',
            { key: 'right', style: styles.row },
            h('span', { key: 'at', style: styles.muted }, '最近检查 ' + card.checkedAt),
            h(
              'button',
              { key: 'toggle', type: 'button', style: styles.ghostButton, 'aria-expanded': expanded, onClick: () => handlers.toggleDetails() },
              expanded ? '▴ 收起' : '▾ 展开'
            )
          )
        ),
        expanded
          ? h(
              'div',
              { key: 'details', style: styles.details },
              card.details.map((row) =>
                h(
                  'div',
                  { key: 'detail-' + row.label, style: styles.detailRow },
                  h('span', { key: 'label', style: styles.muted }, row.label),
                  h('span', { key: 'value' }, row.value)
                )
              )
            )
          : null
      );
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
        // statusAt 是"最近检查"的唯一来源：拿不到就明说没有，不编一个时间。
        api
          .status()
          .then((payload) => apply({ status: payload, statusAt: Date.now() }))
          .catch(() => {});
        apply({ viewportWidth: viewportWidthOf() });
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
          return () => {
            alive = false;
          };
        }
        const onResize = () => apply({ viewportWidth: viewportWidthOf() });
        window.addEventListener('resize', onResize);
        return () => {
          alive = false;
          window.removeEventListener('resize', onResize);
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

      // 次级按钮「重新打开开放平台」：能开新标签就开，开不了只留提示，不碰 window 就直接返回
      function openLink(url) {
        const wanted = toText(url);
        if (wanted === '') return;
        try {
          if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(wanted, '_blank', 'noopener');
        } catch {
          // 弹窗被拦时用户还有「复制链接」这条路
        }
        setState((prev) => ({ ...prev, notice: { kind: 'ok', text: '已在新标签页打开：' + wanted, problems: [] } }));
      }

      // NapCat 没有凭证可验：所谓"检测连接"就是重新问一次 /status，并如实说通没通
      function detectConnection() {
        setState((prev) => ({ ...prev, busy: 'detect', notice: null }));
        api
          .status()
          .then((payload) => {
            const running = isPlainObject(payload) && payload.running === true;
            setState((prev) => ({
              ...prev,
              busy: '',
              status: payload,
              statusAt: Date.now(),
              notice: {
                kind: running ? 'ok' : 'error',
                text: running ? '✅ NapCat 已连上：运行时在跑' : '还没连上：先点「启动」，或在 NapCat 面板里确认已经扫码登录',
                problems: []
              }
            }));
          })
          .catch((err) => {
            setState((prev) => ({
              ...prev,
              busy: '',
              notice: { kind: 'error', text: '检测失败：' + describeError(err), problems: (err && err.problems) || [] }
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
        // host 的数据不是数组时也要能渲染：整页白屏比少一块卡片严重得多
        const platformList = Array.isArray(state.platforms) ? state.platforms : [];
        const selected = platformList.filter((p) => p.id === state.platformId)[0] || null;
        const fields = Array.isArray(state.fields) ? state.fields : [];
        const groups = groupFields(fields.filter((field) => ENVELOPE_KEYS.indexOf(field.key) === -1));
        // 信封控件独占 platform/enabled，但 label/help 仍取自 host 下发的字段，避免两套文案。
        const enabledField = fields.filter((field) => field.key === 'enabled')[0] || null;
        // controls 装的是「手动接入」Tab 的内容：按钮行 + 字段表 + 保存，仍旧是原来那套渲染
        const controls = [];
        const layout = layoutStyle(state.viewportWidth);
        const cards = platformCards(platformList, state.platformId);
        const manualTab = state.tab === 'manual';
        const online = isPlainObject(state.status) && state.status.running === true ? 1 : 0;

        const header = h(
          'div',
          { key: 'head', style: styles.head },
          h('div', null, h('h2', { style: styles.title }, 'dsh bot'), h('p', { style: styles.muted }, '把 QQ 消息转给本机 DSH 处理，再把结果回复到聊天。')),
          close ? h('button', { type: 'button', style: styles.button, onClick: () => close() }, '完成') : null
        );

        // 左栏：一个平台一张卡片，选中态由 platformCards 算，渲染只负责摆
        const leftColumn = h(
          'div',
          { key: 'left', style: layout.left },
          cards.length > 0
            ? cards.map((card) => platformCardNode(card, selectPlatform))
            : h('p', { key: 'empty', style: styles.muted }, state.loading ? '正在读取可用的接入方式…' : '服务没有下发任何平台')
        );

        // 右栏顶部：左边两个 Tab，右边状态药丸（running 为真算 1 个在线，共 1 个）
        const tabsRow = h(
          'div',
          { key: 'tabs', style: styles.tabsRow },
          h('div', { key: 'list', style: styles.tabList }, tabsOf(state.tab).map((tab) => tabNode(tab, (id) => patch({ tab: id })))),
          h('span', { key: 'pill', style: { ...styles.pill, ...(online > 0 ? styles.pillOn : null) } }, online + ' / 1 在线')
        );

        // 两个 Tab 都渲染、只切换显示：切换时不丢输入，也不会重建字段控件
        const connectPanel = h(
          'div',
          { key: 'connectPanel', style: manualTab ? styles.hidden : styles.panel },
          connectPanelNode(state, {
            field: updateField,
            value: wizardValue,
            verify: runVerify,
            test: runTest,
            copy: copyText,
            open: () => openLink(connectCopy(state.platformId).url),
            detect: detectConnection,
            cancel: () => patch({ connectCollapsed: true }),
            expand: () => patch({ connectCollapsed: false })
          })
        );

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

        // 字段表里的平台下拉：和左栏卡片是同一份状态，窄屏下也能一键换平台
        if (platformList.length > 0) {
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
                platformList.map((platform) => h('option', { key: platform.id, value: platform.id }, platform.label))
              ),
              selected && selected.description ? h('p', { style: styles.muted }, selected.description) : null
            )
          );
        }

        if (!state.loading && !state.error && fields.length === 0) {
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

        // 提示与配置告警挂在右栏外侧：切 Tab 不该把"保存失败"藏起来
        const notice = noticeNode(state.notice);
        const warningsNode =
          state.warnings.length > 0
            ? h(
                'div',
                { key: 'warnings', style: { ...styles.notice, ...styles.ok } },
                h('div', null, '配置告警'),
                h('ul', { style: styles.problems }, state.warnings.map((w, i) => h('li', { key: 'w' + i }, w)))
              )
            : null;

        const manualPanel = h('div', { key: 'manualPanel', style: manualTab ? styles.panel : styles.hidden }, controls);

        return h('div', { style: styles.root }, [
          header,
          h('div', { key: 'frame', style: layout.container }, [
            leftColumn,
            h('div', { key: 'right', style: layout.right }, [
              tabsRow,
              notice,
              connectPanel,
              manualPanel,
              bindingPanelNode(state, { toggleDetails: () => patch({ showBindingDetails: state.showBindingDetails !== true }) }),
              h('p', { key: 'status', style: styles.muted }, state.loading ? '正在读取状态…' : statusLine(state.status)),
              warningsNode
            ])
          ])
        ]);
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
    module.exports.normalizeWizardQr = normalizeWizardQr;
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
    module.exports.NAPCAT_DOWNLOAD_URL = NAPCAT_DOWNLOAD_URL;
    module.exports.WIZARD_STATUS_TEXT = WIZARD_STATUS_TEXT;
    module.exports.formFromConfig = formFromConfig;
    module.exports.buildForm = buildForm;
    module.exports.buildConfig = buildConfig;
    module.exports.switchPlatformForm = switchPlatformForm;
    module.exports.describeError = describeError;
    module.exports.statusLine = statusLine;
    // 设置页两栏布局的纯函数：卡片 / Tab / 步骤 / 已绑定卡片 / 响应式样式，都能单独断言
    module.exports.platformCards = platformCards;
    module.exports.tabsOf = tabsOf;
    module.exports.stepsOf = stepsOf;
    module.exports.connectCopy = connectCopy;
    module.exports.describeBindingCard = describeBindingCard;
    module.exports.layoutStyle = layoutStyle;
    module.exports.clockOf = clockOf;
    module.exports.durationText = durationText;
    module.exports.CONNECT_STEPS = CONNECT_STEPS;
    module.exports.LAYOUT_STACK_BREAKPOINT = LAYOUT_STACK_BREAKPOINT;
    return module.exports;
  }
});
