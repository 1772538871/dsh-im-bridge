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
    // platform 是「用户点的是哪张卡片」：宿主只肯从正在跑的那个平台发，对不上就明说。
    function buildTestSendPayload(target, platform) {
      const payload = {};
      const wanted = toText(target).trim();
      if (wanted !== '') payload.target = wanted;
      const id = toText(platform).trim();
      if (id !== '') payload.platform = id;
      return payload;
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

    // ---------------- 首次配置引导：三步问完，主界面就只剩状态与按钮 ----------------

    const FIRST_RUN_STEPS = [
      { id: 'platform', title: '选平台', hint: '先决定用哪种方式接：官方机器人，还是小号 QQ。' },
      { id: 'credentials', title: '填凭证', hint: '凭证只写进本机配置文件，不会发给任何第三方。' },
      { id: 'scope', title: '谁能用', hint: '只有名单上的人能使唤它。附件、历史和日志都存在默认位置，不用你填。' }
    ];

    function firstRunSteps() {
      return FIRST_RUN_STEPS.map((step) => ({ ...step }));
    }

    // 平台专属凭证：官方要 AppID/AppSecret，个人号要 WebSocket 地址 + 访问令牌。
    // 这一步问的比"必需"的多一项：NapCat 安装目录填了才能一键启动，但缺了照样能手工连。
    const CREDENTIAL_KEYS = {
      'qq-official': ['qqOfficial.appId', 'qqOfficial.appSecret'],
      'qq-napcat': ['qqNapcat.wsUrl', 'qqNapcat.accessToken', 'qqNapcat.homeDir']
    };

    // 判"配好了"只认这几项；安装目录这类"更省事但非必需"的不算进完成度。
    const REQUIRED_KEYS = {
      'qq-official': ['qqOfficial.appId', 'qqOfficial.appSecret'],
      // 令牌可留空：字段文案就写着"NapCat 里没设就留空"，判死会让这些人永远停在引导
      'qq-napcat': ['qqNapcat.wsUrl']
    };

    // 第 3 步只问一件事：谁能用。
    // 数据目录不再出现在任何界面上（默认 E:\dsh-im-bridge-data，要换改配置文件），
    // 所以这里也不问它——页面上出现"数据目录"就说明还有入口没删干净。
    const SCOPE_KEYS = ['security.userWhitelist'];

    function isFilled(value) {
      return toText(value).trim() !== '';
    }

    // "配置好了"= 能把机器人跑起来所需的东西齐全了。
    // GET /config 把 secret 脱敏成 ***：它非空就算已填，否则每次进设置页都会掉回第 1 步，
    // 用户会以为配置压根没存上。
    function isConfigured(config, platformId) {
      if (!isPlainObject(config)) return false;
      const whitelist = dotGet(config, 'security.userWhitelist', undefined);
      if (!Array.isArray(whitelist) || whitelist.length === 0) return false;
      if (!isFilled(dotGet(config, 'storage.rootDir', ''))) return false;
      const platform = toText(platformId).trim() || toText(config.platform).trim();
      const keys = REQUIRED_KEYS[platform] || [];
      return keys.every((key) => isFilled(dotGet(config, key, '')));
    }

    // 步骤号来自组件状态：越界或脏值一律夹回第一页。渲染不能因为一个坏状态整页崩。
    function clampStep(value) {
      const step = Number(value);
      return Number.isInteger(step) && step >= 0 && step < FIRST_RUN_STEPS.length ? step : 0;
    }

    function stepProgressText(step) {
      return '第 ' + (clampStep(step) + 1) + ' 步 / 共 ' + FIRST_RUN_STEPS.length + ' 步';
    }

    // 字段表由 host 下发，引导只挑自己要问的那几项；host 没下发就少问一项，不自己造 label。
    function pickFields(fields, keys) {
      const list = Array.isArray(fields) ? fields : [];
      return keys.map((key) => list.filter((field) => field.key === key)[0]).filter(Boolean);
    }

    function credentialFields(fields, platformId) {
      return pickFields(fields, CREDENTIAL_KEYS[toText(platformId).trim()] || []);
    }

    function scopeFields(fields) {
      return pickFields(fields, SCOPE_KEYS);
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
      const wechat = platform === 'wechat';
      const verify = isPlainObject(s.verifyResult) ? s.verifyResult : null;
      const verified = verify !== null && verify.ok === true;
      const test = isPlainObject(s.testResult) ? s.testResult : null;

      const steps = [];
      // 第 1 步：去哪儿抄 AppID/AppSecret。NapCat 改成扫码登录本机后台；
      // 还没选平台（或选了本机桥、压根没有外部链接的微信）时不给链接，免得把人带去一个用不上的地方。
      steps.push({
        id: 'open-platform',
        index: 1,
        title: official ? '去开放平台' : napcat ? '装好 NapCat 并扫码' : wechat ? '让微信客户端登录小号' : '先选平台',
        status: verified ? 'ok' : 'todo',
        url: official ? OPEN_PLATFORM_URL : napcat ? NAPCAT_DOWNLOAD_URL : '',
        action: official ? '打开开放平台' : napcat ? '打开 NapCat 下载页' : '',
        // TODO(P6)：把二维码直接画在这张卡片里，现在只给链接 + 复制
        text: official
          ? '用手机 QQ 扫码登录 → 创建机器人 →「开发设置」里就是 AppID 和 AppSecret。'
          : napcat
            ? '装好并启动 NapCat / SnowLuma，在里面用手机扫码登录小号；确认 WebSocket 服务端开着，端口跟下面的地址对上。'
            : wechat
              ? '扫码登录由微信客户端完成：装好微信 3.9.12.17，用小号扫进桌面客户端；再启动本机桥（tools/wcf-bridge/bridge.py）。'
              : '先在上面选一种连接方式（QQ 官方机器人 / NapCat / 微信个人号），这一步的链接和文案会跟着变。'
      });

      // 第 2 步：只有官方机器人有凭证可填；NapCat 这一步天生没东西做，直接算通过。
      let credentialStatus = 'todo';
      let credentialText = '把上面拿到的 AppID / AppSecret 填进去，点「验证凭证」。';
      if (napcat) {
        credentialStatus = 'ok';
        credentialText = 'NapCat 走本机 WebSocket，没有 AppID / AppSecret，这一步不用做。';
      } else if (wechat) {
        credentialStatus = 'ok';
        credentialText = '微信走本机桥，没有 AppID / AppSecret，这一步不用做：桥地址填对就能收发。';
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
    // 上面是平台卡片，下面是接入卡片 + 账号与权限 + 人设与记忆 + 已绑定卡片（整页一条主流程，没有 Tab）。
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
    // 微信已经接了（本机桥），只有故人常用的 weixin 这个别名不再单独开放。
    const PLATFORM_COMING_SOON = ['weixin'];

    /** 图标 token → 品牌色方块 + 白色字形；不是 token 的（宿主下发的自定义图标）按文本渲染。 */
    function iconNode(value, style, svgSize) {
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

    // 每个平台"手机上要做的三件事"。文案就是用户在手机上照着做的动作，不能泛化。
    const CONNECT_STEPS = {
      'qq-official': ['手机打开开放平台', '创建或查看机器人，复制 AppID 与 AppSecret', '回到这里填进去，点「验证凭证」'],
      'qq-napcat': ['装好并启动 NapCat / SnowLuma', '在它的面板里用手机扫码登录小号', '回来填 WebSocket 地址（默认 3001）与口令，点「检测连接」'],
      wechat: ['装好微信 3.9.12.17，用小号扫码登录桌面客户端', '启动 WeChatFerry 桥（tools/wcf-bridge/bridge.py）', '回来填桥地址（默认 19100）与轮询间隔，点「检测连接」']
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
        // 个人号不再渲染下载按钮：装完、扫完码之后它只会占地方。
        // 还没装的人走方块下面那行「还没装？去 GitHub 下载 NapCat」的文字链接。
        action: '打开 NapCat 下载页',
        reopen: '重新打开下载页',
        url: NAPCAT_DOWNLOAD_URL
      },
      wechat: {
        waitText: '等待微信客户端登录小号',
        title: '小号在微信里登录，本机桥负责转发',
        description:
          '扫码登录由微信客户端完成：装好微信 3.9.12.17、用小号扫进去，再启动 WeChatFerry 桥（tools/wcf-bridge/bridge.py），把桥地址填到下面。',
        // 微信没有网页后台可给：装客户端、扫码、起桥都在本机，页面只说下一步做什么
        action: '',
        reopen: '',
        url: ''
      }
    };

    // 还没选平台（或选了未开放的平台）时的兜底文案：不说"已连通"，也不给用不上的链接。
    const CONNECT_COPY_FALLBACK = {
      waitText: '先选一种接入方式',
      title: '选一种接入方式开始',
      description: '左边挑「QQ 个人账号」「QQ 官方机器人」或「微信个人号」，这里会出现对应的操作步骤。',
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

    // ---------------- 微信个人号：本机桥的「检测连接」 ----------------
    // 微信没有可验证的凭证：所谓检测就是让宿主替页面问一句桥的 /status，再把三件事说清：
    // 桥在不在、微信登没登、登录的是谁。
    const WECHAT_BRIDGE_HINT = '扫码登录由微信客户端完成';
    const WECHAT_DETECT_LABEL = '检测连接';
    const WECHAT_DETECTING_LABEL = '检测中…';
    const WECHAT_NEVER_CHECKED = '还没检测过：点「检测连接」问一下微信桥';
    const WECHAT_NOT_LOGGED_HINT = '桥在跑，但微信还没登录：先在微信客户端用小号扫码登录';
    const WECHAT_DEFAULT_BRIDGE_URL = 'http://127.0.0.1:19100';

    /** 桥的 /status 回执 → { ok, loggedIn, name, text }。只认宿主/桥明说的事实，不替它编。 */
    function describeWechatStatus(payload) {
      if (!isPlainObject(payload)) return { ok: false, loggedIn: false, name: '', text: WECHAT_NEVER_CHECKED };
      if (payload.ok === false) {
        const why = toText(payload.error).trim();
        return { ok: false, loggedIn: false, name: '', text: '连不上微信桥：' + (why === '' ? '确认桥已经启动' : why) };
      }
      const name = toText(payload.nickname).trim() || toText(payload.selfWxid).trim() || '微信';
      if (payload.loggedIn === true) return { ok: true, loggedIn: true, name, text: '已连接：' + name };
      const why = toText(payload.error).trim();
      return { ok: false, loggedIn: false, name: '', text: WECHAT_NOT_LOGGED_HINT + (why === '' ? '' : '（' + why + '）') };
    }

    // ---------------- 个人号：本机 NapCat 的「检测连接」 ----------------
    // NapCat 没有凭证可验：检测就是让宿主问一句 /napcat/status（页面直连 127.0.0.1 会撞跨源），
    // 再把"通没通、小号在不在线"说清楚。三态，只认宿主明说的事实。
    const NAPCAT_DEFAULT_WS_PORT = 3001;
    const COLLAPSE_LABEL = '收起';
    const COLLAPSE_HINT = '只收起这张卡，不改配置';

    function napcatOfflineText(target) {
      return '连不上 ' + target + '：NapCat 没在跑，或 OneBot 的 WebSocket 服务器没开。';
    }

    /** ws://127.0.0.1:3001 → 3001。认不出端口就返回 0，交给 describeNapcatCheck 兜底。 */
    function portFromWsUrl(value) {
      const match = /:(\d{1,5})(?:\/|$)/u.exec(toText(value));
      if (match === null) return 0;
      const port = Number(match[1]);
      return Number.isFinite(port) && port > 0 && port <= 65535 ? port : 0;
    }

    /**
     * /napcat/status 的回执 → { ok, port, account, text }。
     * 端口取 payload.port（NapCat 自己的 ws 端口）→ fallbackPort（配置里的 wsUrl）→ 3001。
     */
    function describeNapcatCheck(payload, fallbackPort) {
      const fromPayload = Number(payload && payload.port);
      const fromFallback = Number(fallbackPort);
      const port =
        Number.isFinite(fromPayload) && fromPayload > 0
          ? Math.floor(fromPayload)
          : Number.isFinite(fromFallback) && fromFallback > 0
            ? Math.floor(fromFallback)
            : NAPCAT_DEFAULT_WS_PORT;
      const target = 'ws://127.0.0.1:' + port;
      if (!isPlainObject(payload)) return { ok: false, port, account: '', text: napcatOfflineText(target) };
      const account = toText(payload.account).trim();
      if (payload.ok === false) {
        const why = toText(payload.error).trim();
        // 宿主已经用自己的话说清了（没装 / 没起 / 端口不通），原样搬，不叠前缀
        return { ok: false, port, account: '', text: why === '' ? napcatOfflineText(target) : why };
      }
      if (payload.listening === true) {
        return {
          ok: true,
          port,
          account,
          text: '已连上 ' + target + '：' + (account === '' ? '小号在线' : '小号 ' + account + ' 在线')
        };
      }
      return { ok: false, port, account: '', text: napcatOfflineText(target) };
    }

    // ---------------- NapCat 一键启动（宿主拉起本机 NapCat，二维码在它自己的磁盘上） ----------------
    // 宿主侧事实：登录二维码是 NapCat 自己写的 <安装目录>/napcat/cache/qrcode.png。
    // 前端只做三件事：轮询状态、把那张图贴进方块、扫完了把方块换成绿色。没有别的授权接口可调。
    const NAPCAT_POLL_MS = 3000;
    const NAPCAT_QR_HINT = '二维码有效期约 2 分钟，过期点「刷新二维码」';
    const NAPCAT_QR_STALE_HINT = '这张码可能过期了：点「刷新二维码」重新生成';
    const NAPCAT_QR_STALE_MS = 120000;
    const NAPCAT_NO_HOME_HINT = '还没填 NapCat 安装目录：在配置文件的 qqNapcat.homeDir 里填一次（例如 D:\\NapCat），之后就只用点启动';
    const NAPCAT_WAITING_HINT = '还没生成二维码：先点一键启动，等它出码（一般 5–20 秒）';
    const NAPCAT_LOGGED_IN_TEXT = '✅ 已扫码登录';
    const NAPCAT_LOGGED_IN_PREFIX = '✅ 已扫码登录：';
    const NAPCAT_LOGGED_IN_UNKNOWN = '✅ 已扫码登录（账号未知）';
    const NAPCAT_LOGGED_IN_HINT = '下一步：填访问令牌，点检测连接';
    // 端口/令牌是 NapCat 自己写下来的：页面上只需要说一句"已读过"，不用人再抄一遍
    const NAPCAT_AUTOFILL_HINT = '已从 NapCat 自动读取端口与令牌';
    const NAPCAT_OPEN_PANEL_LABEL = '打开 NapCat 面板';
    const NAPCAT_OPEN_PANEL_FIRST_LABEL = '打开 NapCat 面板（先扫码登录）';
    const NAPCAT_OPENED_TEXT = '已打开 NapCat 面板（令牌已复制）';
    const NAPCAT_PANEL_HINT = '在面板里「网络配置 → 添加 WebSocket 服务器」，端口填 3001，保存后这里会自动读到。';
    const NAPCAT_COPY_TOKEN_LABEL = '复制令牌';
    const NAPCAT_TOKEN_PREFIX = '令牌 ';
    const NAPCAT_WS_PREFIX = 'WebSocket  ';
    const NAPCAT_START_LABEL = '一键启动';
    const NAPCAT_RUNNING_LABEL = '已启动 · 扫码登录';
    const NAPCAT_REFRESH_LABEL = '刷新二维码';
    // 只认这几种图片 dataUrl：宿主给什么就贴什么，等于把任意字符串塞进 <img src>
    const NAPCAT_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

    function emptyNapcatState() {
      return { status: null, qr: null, fetchedAt: 0, stale: false };
    }

    function safeDataUrl(value) {
      const text = toText(value).trim().replace(/\s+/g, '');
      return NAPCAT_DATA_URL.test(text) ? text : '';
    }

    // 纯数字才认：宿主给什么就显示什么，但不把 "abc" 拼成账号
    function napcatDigits(value) {
      const text = toText(value).trim();
      return /^\d+$/.test(text) ? text : '';
    }

    // onebot 探测结果：地址必须是 ws(s):// 才认，其余字段缺了就是空串
    function napcatOnebotOf(value) {
      if (!isPlainObject(value)) return null;
      const wsUrl = toText(value.wsUrl).trim();
      if (!/^wss?:\/\//i.test(wsUrl)) return null;
      return { wsUrl, token: toText(value.token).trim(), name: toText(value.name).trim() };
    }

    // 视图模型：只认宿主明确说过的 ok:true。取不到就当"没拿到"——宁可显示"还没出码"，
    // 也不能凭一个空响应编出"已登录"（那会让用户以为能用了）。
    function describeNapcatPanel(napcat) {
      const n = isPlainObject(napcat) ? napcat : {};
      const status = isPlainObject(n.status) ? n.status : null;
      const qr = isPlainObject(n.qr) ? n.qr : null;
      const usable = status !== null && status.ok !== false;
      const listening = usable && status.listening === true;
      const loggedIn = usable && status.loggedIn === true;
      // 账号与 OneBot 参数只在宿主明说 ok 的时候才信：ok:false 时 status 里没这些字段
      const account = usable ? napcatDigits(status.account) : '';
      const onebot = usable ? napcatOnebotOf(status.onebot) : null;
      const dataUrl = qr !== null && qr.ok === true ? safeDataUrl(qr.dataUrl) : '';
      const mtimeMs = qr !== null && qr.ok === true ? pickNumber(qr.mtimeMs) : null;

      // 宿主明说 ok:false（没填目录这类）才是"错误"；还没拉到不算错，也别吓用户
      const error = status !== null && status.ok === false ? toText(status.error).trim() : '';
      let hint = '';
      if (error !== '') hint = error;
      else if (qr !== null && qr.ok === false) hint = toText(qr.error).trim() || NAPCAT_WAITING_HINT;
      else hint = NAPCAT_WAITING_HINT;

      return {
        listening,
        loggedIn,
        dataUrl,
        mtimeMs,
        stale: n.stale === true,
        error,
        hint,
        startLabel: listening ? NAPCAT_RUNNING_LABEL : NAPCAT_START_LABEL,
        refreshLabel: NAPCAT_REFRESH_LABEL,
        qrHint: n.stale === true ? NAPCAT_QR_STALE_HINT : NAPCAT_QR_HINT,
        loggedInText: NAPCAT_LOGGED_IN_TEXT,
        // 绿框里写的这句要能直接看到"是哪个号"，拿不到账号就如实说不知道
        loggedInAccountText: account === '' ? NAPCAT_LOGGED_IN_UNKNOWN : NAPCAT_LOGGED_IN_PREFIX + account,
        loggedInHint: NAPCAT_LOGGED_IN_HINT,
        noHomeHint: NAPCAT_NO_HOME_HINT,
        account,
        onebot,
        token: onebot === null ? '' : onebot.token,
        autofillHint: NAPCAT_AUTOFILL_HINT,
        openPanelLabel: loggedIn ? NAPCAT_OPEN_PANEL_LABEL : NAPCAT_OPEN_PANEL_FIRST_LABEL,
        copyTokenLabel: NAPCAT_COPY_TOKEN_LABEL,
        openedText: NAPCAT_OPENED_TEXT,
        panelHint: NAPCAT_PANEL_HINT
      };
    }

    // 卡片上那行地址：NapCat 自己说的端口优先，没有就用已经在配置里的那个
    function napcatWsLine(napcat, configuredUrl) {
      const panel = describeNapcatPanel(napcat);
      const url = panel.onebot !== null && panel.onebot.wsUrl !== '' ? panel.onebot.wsUrl : toText(configuredUrl).trim();
      return url === '' ? '' : NAPCAT_WS_PREFIX + url;
    }

    // 探测到的端口/令牌自动填进表单：只填空着或不一样的值（掩码 *** 也算不一样）。
    // 只改表单、不落盘——保存仍然由用户点按钮触发。
    function onebotFormPatch(napcat, form) {
      const panel = describeNapcatPanel(napcat);
      if (panel.onebot === null) return null;
      const current = isPlainObject(form) ? form : {};
      const patch = {};
      if (panel.onebot.wsUrl !== '' && toText(current['qqNapcat.wsUrl']).trim() !== panel.onebot.wsUrl) {
        patch['qqNapcat.wsUrl'] = panel.onebot.wsUrl;
      }
      if (panel.onebot.token !== '' && toText(current['qqNapcat.accessToken']).trim() !== panel.onebot.token) {
        patch['qqNapcat.accessToken'] = panel.onebot.token;
      }
      return Object.keys(patch).length > 0 ? patch : null;
    }

    // 读回来的 NapCat 状态落进组件状态：探测到端口/令牌就一并填进表单。
    // 只填不保存——落盘仍然是「保存」按钮的事，自动保存等于替用户改了配置。
    function applyNapcat(prev, next) {
      const patch = onebotFormPatch(next, isPlainObject(prev) ? prev.form : null);
      if (patch === null) return { napcat: next };
      return { napcat: next, form: { ...(isPlainObject(prev) ? prev.form : {}), ...patch }, napcatFilled: true };
    }

    // 剪贴板：能写就写，写不了（非 https / 老浏览器 / 被拒）就当没这回事，绝不让页面报错。
    function writeClipboard(value) {
      const text = toText(value);
      if (text === '') return false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          const ret = navigator.clipboard.writeText(text);
          if (ret && typeof ret.catch === 'function') ret.catch(() => {});
          return true;
        }
      } catch {
        // 复制不了也不影响用户手抄上面那行令牌
      }
      return false;
    }

    // 「用这个小号」：扫完码才算真能用，点一下把平台切过去并重启。
    // 已经在跑个人号就没什么可切的——按钮不给，省得人以为点了会有什么变化。
    const USE_NAPCAT_LABEL = '用这个小号';
    const USE_NAPCAT_DONE_TEXT = '已切到小号，正在重启…';

    function savedPlatformOf(state) {
      return toText(dotGet(isPlainObject(state) ? state.config : null, 'platform', '')).trim();
    }

    function shouldOfferUseNapcat(state) {
      const s = isPlainObject(state) ? state : {};
      if (toText(s.platformId).trim() !== 'qq-napcat') return false;
      if (describeNapcatPanel(s.napcat).loggedIn !== true) return false;
      return savedPlatformOf(s) !== 'qq-napcat';
    }

    // 保存的东西：只把 platform 换成个人号，wsUrl / accessToken 用页面上现在的值；
    // 掩码 *** 交给 buildConfig 跳过，于是没改过的令牌还是已存的那个，不会被写成 ***。
    function buildSwitchToNapcatPayload(state) {
      const s = isPlainObject(state) ? state : {};
      const form = isPlainObject(s.form) ? { ...s.form } : {};
      form.platform = 'qq-napcat';
      return buildConfig(s.config, s.fields, form);
    }

    // 一次读：状态 + 二维码。两个调用各自的失败都折成 {ok:false,error}，调用方不必 try/catch
    async function readNapcatOnce(api, clock) {
      const call = (name) => {
        try {
          if (!api || typeof api[name] !== 'function') {
            return Promise.resolve({ ok: false, error: '当前宿主版本不支持一键启动 NapCat' });
          }
          return Promise.resolve(api[name]()).then(
            (value) => (isPlainObject(value) ? value : { ok: false, error: '宿主没有返回可用的结果' }),
            (err) => ({ ok: false, error: describeError(err) })
          );
        } catch (err) {
          return Promise.resolve({ ok: false, error: describeError(err) });
        }
      };
      const [status, qr] = await Promise.all([call('napcatStatus'), call('napcatQr')]);
      const raw = typeof clock === 'function' ? Number(clock()) : Date.now();
      const at = Number.isFinite(raw) ? raw : Date.now();
      const mtimeMs = qr.ok === true ? Number(qr.mtimeMs) : Number.NaN;
      const stale = Number.isFinite(mtimeMs) && at - mtimeMs > NAPCAT_QR_STALE_MS;
      return { status, qr, fetchedAt: at, stale };
    }

    /**
     * 轮询器：api 与定时器都注入，于是"进卡片每 3 秒拉一次"和"卸载要清定时器"
     * 都能在没有浏览器的情况下验。stop() 之后迟到的响应一律丢弃。
     */
    function createNapcatWatcher(deps) {
      const d = isPlainObject(deps) ? deps : {};
      const intervalMs = pickNumber(d.intervalMs) || NAPCAT_POLL_MS;
      const clock = typeof d.now === 'function' ? d.now : () => Date.now();
      const setTimer =
        typeof d.setInterval === 'function' ? d.setInterval : typeof setInterval === 'function' ? setInterval : null;
      const clearTimer =
        typeof d.clearInterval === 'function' ? d.clearInterval : typeof clearInterval === 'function' ? clearInterval : null;
      const emit = typeof d.onState === 'function' ? d.onState : () => {};
      let timer = null;
      let stopped = false;
      let inFlight = false;

      async function poll() {
        if (stopped || inFlight) return null;
        inFlight = true;
        let state;
        try {
          state = await readNapcatOnce(d.api, clock);
        } catch (err) {
          state = { status: { ok: false, error: describeError(err) }, qr: null, fetchedAt: 0, stale: false };
        } finally {
          inFlight = false;
        }
        // 卸载后才回来的响应直接丢掉：否则界面会被"已经关掉的那次轮询"改写
        if (stopped) return null;
        try {
          emit(state);
        } catch {
          // 渲染层自己的异常不该把轮询弄死
        }
        return state;
      }

      return {
        intervalMs,
        poll,
        refresh: poll,
        start() {
          if (stopped || timer !== null) return;
          poll();
          if (typeof setTimer !== 'function') return;
          timer = setTimer(() => {
            poll();
          }, intervalMs);
          if (timer && typeof timer.unref === 'function') timer.unref();
        },
        stop() {
          stopped = true;
          if (timer !== null && typeof clearTimer === 'function') {
            try {
              clearTimer(timer);
            } catch {
              // 清不掉也只会多醒一次
            }
          }
          timer = null;
        },
        running() {
          return timer !== null && stopped === false;
        }
      };
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
        },
        // NapCat 一键启动那四条同理：ok:false 是正常结果（还没填目录 / 还没出码），
        // 一律不抛错，交给 describeNapcatPanel 说人话
        napcatStatus() {
          return request('GET', '/napcat/status');
        },
        napcatQr() {
          return request('GET', '/napcat/qr');
        },
        napcatStart() {
          return request('POST', '/napcat/start', {});
        },
        napcatStop() {
          return request('POST', '/napcat/stop', {});
        },
        // 打开面板 = 让宿主拉起程序并开浏览器；失败也是正常结果（ok:false），不抛
        napcatOpenWebui() {
          return request('POST', '/napcat/open-webui', {});
        },
        // 微信「检测连接」：宿主替页面去问桥的 /status（页面直连 127.0.0.1 会撞跨源）。
        // 桥没起来同样是正常结果（ok:false），交给 describeWechatStatus 说人话
        wechatStatus() {
          return request('GET', '/wechat/status');
        },
        // 人设与记忆：四块都落在宿主的 /persona /lessons /journal /stickers 上，恒 200 + {ok}。
        // 读不到（还没有这份文件）也是正常结果，页面按空列表说人话。
        persona() {
          return getJson('/persona');
        },
        async savePersona(text) {
          const payload = await request('PUT', '/persona', { text: toText(text) });
          if (payload.ok === false) throw makeApiError(payload.error || '保存人设失败', payload.problems);
          return payload;
        },
        lessons() {
          return getJson('/lessons');
        },
        async addLesson(body) {
          const payload = await request('POST', '/lessons', { body: toText(body) });
          if (payload.ok === false) throw makeApiError(payload.error || '这一条没记下来', payload.problems);
          return payload;
        },
        async deleteLesson(index) {
          const payload = await request('DELETE', '/lessons', { index });
          if (payload.ok === false) throw makeApiError(payload.error || '这一条没删掉', payload.problems);
          return payload;
        },
        journal() {
          return getJson('/journal');
        },
        examples() {
          return getJson('/examples');
        },
        async addExample(text) {
          const payload = await request('POST', '/examples', { text: toText(text) });
          if (payload.ok === false) throw makeApiError(payload.error || '这段对话没存上', payload.problems);
          return payload;
        },
        async clearExamples() {
          const payload = await request('DELETE', '/examples');
          if (payload.ok === false) throw makeApiError(payload.error || '示例没清掉', payload.problems);
          return payload;
        },
        stickers() {
          return getJson('/stickers');
        },
        async deleteSticker(id) {
          const payload = await request('DELETE', '/stickers', { id: toText(id) });
          if (payload.ok === false) throw makeApiError(payload.error || '这一张没删掉', payload.problems);
          return payload;
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
        // 「收起」只收起向导卡，不动任何配置；是否展开属于纯展示状态
        connectCollapsed: false,
        showBindingDetails: false,
        // 首次配置引导走到第几步（0/1/2）；只活在组件里，不落配置
        onboardingStep: 0,
// 引导第 3 步的保存失败提示：贴在按钮下方，不借顶部那条全局 notice
        onboardingError: null,
// 容器/视口宽度，用来决定两栏还是堆叠；0 = 还没测到（先按宽屏渲染）
        viewportWidth: 0,
        // 最近一次 /status 成功的时间：已绑定卡片上的「最近检查」如实来自这里
        statusAt: 0,
        platforms: [],
        // 平台 id -> 二维码 SVG 字符串；宿主没下发或编码失败时为空对象（退回占位方块）
        wizardQr: {},
        // 个人号的 NapCat 一键启动状态：{status, qr, fetchedAt, stale}，由 3 秒轮询填
        napcat: emptyNapcatState(),
        // 微信桥最近一次 /status 的回执：只为"已连通/连不上"这句话服务，不落盘
        wechatCheck: null,
        // 个人号「检测连接」的回执：卡片里那句"通没通"只认它，不借页面级 notice
        napcatCheck: null,
        // 端口/令牌是不是已经从 NapCat 读到并填进表单了（只改表单，不落盘）
        napcatFilled: false,
        platformId: '',
        fields: [],
        config: {},
        form: {},
        configPath: '',
        warnings: [],
        status: null,
        notice: null,
        // 人设与记忆：默认收起——它是"偶尔改一次"的东西，不该占首屏
        memoryOpen: false,
        memoryLoaded: false,
        personaText: '',
        personaSaving: false,
        personaNote: null,
        lessons: [],
        lessonDraft: '',
        lessonsBusy: '',
        lessonsNote: null,
        examples: [],
        exampleDraft: '',
        examplesBusy: '',
        examplesNote: null,
        // 清空按钮的二次确认到期时刻（毫秒时间戳）：> now 时按钮显示「再点一次清空」
        examplesClearArmed: 0,
        journal: [],
        journalLoaded: false,
        stickers: [],
        stickersBusy: '',
        stickersNote: null,
        // 「谁能用」：null = 还没改过，直接显示配置里那份名单
        whitelistText: null,
        whitelistSaving: false,
        whitelistNote: null
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
      // 兜底用的纯文本链接：不去抢主按钮的位置，只给「还没装」的人一条路
      textLink: { color: 'var(--dsh-accent, #247bbf)', fontSize: '12px', textDecoration: 'underline' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      group: { border: '1px solid var(--dsh-border, rgba(127,127,127,0.25))', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' },
      groupTitle: { margin: '0', fontSize: '12px', fontWeight: '600', color: 'var(--dsh-text-secondary, #888)' },
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
      // 顶部右侧的状态药丸（页面没有 Tab 了，只剩这一个状态位）
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
      // NapCat 自己写的 png，按 200×200 贴：和占位方块同尺寸，换进换出不跳版
      qrImage: { width: '200px', height: '200px', display: 'block' },
      // 扫码登录完成：同一个方块换成绿色，用户一眼就知道下一步该填令牌了
      qrLoggedIn: { borderColor: 'rgba(34,197,94,0.55)', background: 'rgba(34,197,94,0.12)', color: '#16a34a', gap: '6px' },
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
      ghostButton: { padding: '2px 8px', borderRadius: '6px', border: '1px solid transparent', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer' },
      // 令牌是要人"看一眼、抄一下"的东西：等宽 + 浅底，和正文分开
      token: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px', padding: '2px 6px', borderRadius: '4px', background: 'rgba(127,127,127,0.14)' }
    };

    function fieldControl(field, form, onChange, idPrefix) {
      const value = form[field.key];
      const shared = {
        id: (idPrefix || 'dsh-bot-field-') + field.key.replace(/\./g, '-'),
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

    // 一行字段（标题 + 控件 + 说明）：字段表和首次引导共用，免得两处渲染慢慢长歪。
    // idPrefix 让同一个字段在引导和字段表里各有一份 id，页面上不会出现重复 id。
    function fieldRowNode(field, form, onChange, idPrefix) {
      return h(
        'div',
        { key: field.key, style: styles.field },
        h(
          'label',
          { style: styles.label, htmlFor: (idPrefix || 'dsh-bot-field-') + field.key.replace(/\./g, '-') },
          field.label,
          field.required ? h('span', { style: { color: '#de5050' } }, ' *') : null
        ),
        fieldControl(field, form, onChange, idPrefix),
        field.help ? h('p', { style: styles.muted }, field.help) : null
      );
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

    // 个人号方块的三种形态：已登录（绿）/ 有码（贴 NapCat 写的那张 png）/ 还没有码（占位 + 人话提示）。
    // 拿不到码时退回原占位而不是白屏：下面还有三步说明和下载链接，用户不会卡死在半路。
    function napcatSquareNode(panel, actionLink) {
      if (panel.loggedIn) {
        return h(
          'div',
          { key: 'square', style: { ...styles.qrSquare, ...styles.qrLoggedIn } },
          // 文案自带 ✅ 和账号，所以不再单独摆一个勾：同一句话里说清"哪个号已经登进来了"
          h('span', { key: 'text', style: { fontSize: '14px', fontWeight: '600', textAlign: 'center' } }, panel.loggedInAccountText),
          h('span', { key: 'next', style: { fontSize: '11px', textAlign: 'center' } }, panel.loggedInHint)
        );
      }
      if (panel.dataUrl !== '') {
        return h(
          'div',
          { key: 'square', style: styles.qrImageBox },
          h('img', {
            key: 'img',
            src: panel.dataUrl,
            alt: 'NapCat 登录二维码',
            width: 200,
            height: 200,
            style: styles.qrImage
          })
        );
      }
      return h(
        'div',
        { key: 'square', style: styles.qrSquare },
        actionLink,
        h('span', { key: 'hint', style: styles.placeholderUrl }, panel.hint || panel.noHomeHint)
      );
    }

    // 「正在接入」= 向导卡：状态 → 主标题 → 说明 → 二维码占位 → 编号步骤 → 次级按钮。
    function connectPanelNode(state, handlers) {
      const platform = toText(state.platformId).trim();
      const copy = connectCopy(platform);
      const steps = stepsOf(platform);
      const official = platform === 'qq-official';
      const napcat = platform === 'qq-napcat';
      const wechat = platform === 'wechat';
      const status = isPlainObject(state.status) ? state.status : {};
      const verify = isPlainObject(state.verifyResult) ? state.verifyResult : null;
      const test = isPlainObject(state.testResult) ? state.testResult : null;
      const verifying = state.verifying === true;
      const testing = state.testing === true;
      const busy = toText(state.busy);

      // 已连通只认"能证明连通"的东西：官方机器人靠凭证验证，NapCat 靠运行时真的在跑。
      // 只看 status.running 会让"验证失败"的卡片同时显示已连通。
      // 微信只认"检测连接成功"：桥没通的时候运行时可能照样在跑，不能拿 running 冒充已连通
      const wechatView = describeWechatStatus(state.wechatCheck);
      // 「检测连接」的结果按卡片自己的状态渲染：页面级 notice 一闪而过，卡片里一个字不变，
      // 用户看到的就是"点了没反应"——所以这里读 state.napcatCheck，不读 notice
      const checkView =
        napcat && isPlainObject(state.napcatCheck)
          ? describeNapcatCheck(state.napcatCheck, portFromWsUrl(dotGet(state.config, 'qqNapcat.wsUrl', '')))
          : null;
      const live = official
        ? verify !== null && verify.ok === true
        : napcat
          ? status.running === true
          : wechat
            ? wechatView.ok === true
            : false;
      // 个人号的方块另有真相：NapCat 的登录状态来自 /napcat/status + /napcat/qr
      const napcatPanel = napcat ? describeNapcatPanel(state.napcat) : null;
      // 扫完码就是用户眼里"已经登录了"：卡片顶上的状态先按这个事实走，
      // 不能一边方块写着 ✅ 已扫码登录、一边顶上还挂着"等待扫码"
      const scanned = napcatPanel !== null && napcatPanel.loggedIn === true;
      const headLive = live || scanned;
      const headText = scanned ? '已扫码登录' : live ? copy.liveText : copy.waitText;

      const head = h(
        'div',
        { key: 'head', style: styles.connectHead },
        h('span', { key: 'eyebrow', style: styles.eyebrow }, '连接向导（三步点通）'),
        h(
          'span',
          { key: 'state', style: styles.row },
          h('span', { key: 'dot', style: { ...styles.dot, background: headLive ? '#22c55e' : '#f59e0b' } }),
          h('span', { key: 'text', style: { color: headLive ? '#22c55e' : 'var(--dsh-text-secondary, #888)' } }, headText)
        )
      );
      const title = h('h3', { key: 'title', style: styles.connectTitle }, copy.title);
      const desc = h('p', { key: 'desc', style: styles.connectDesc }, copy.description);

      // 「收起」只收起这张卡：不动配置，也不丢已经填过的输入
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
      // 个人号一个下载按钮都不摆：装完、扫完码之后它们只会占地方。
      // 唯一留下的是「还没登录」时的一行小字 + 纯文本链接，兜住连 NapCat 都还没装的人。
      const downloadHint =
        napcat && napcatPanel.loggedIn !== true
          ? h(
              'p',
              { key: 'download', style: styles.muted },
              '还没装？',
              h('a', { key: 'dl', href: NAPCAT_DOWNLOAD_URL, target: '_blank', rel: 'noreferrer', style: styles.textLink }, '去 GitHub 下载 NapCat')
            )
          : null;
      const actionLink =
        napcat || copy.url === ''
          ? null
          : h('a', { key: 'go', href: copy.url, target: '_blank', rel: 'noreferrer', style: styles.placeholderAction }, copy.action);

      // 个人号优先贴 NapCat 自己出的登录码；官方机器人还是 /platforms 下发的 SVG
      const square = wechat
        ? h(
            'div',
            { key: 'square', style: styles.qrSquare },
            h('span', { key: 'hint', style: { fontSize: '12px', color: '#475569', textAlign: 'center' } }, WECHAT_BRIDGE_HINT),
            h(
              'span',
              { key: 'bridge', style: styles.placeholderUrl },
              toText(dotGet(state.config, 'wechat.bridgeUrl', '')).trim() || WECHAT_DEFAULT_BRIDGE_URL
            )
          )
        : napcat
        ? napcatSquareNode(napcatPanel, actionLink)
        : qrSvg
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

      // 方块上方：一键启动 / 已启动 · 扫码登录 + 刷新二维码（只有个人号有这套）
      const napcatBar = napcat
        ? h(
            'div',
            { key: 'napcatBar', style: styles.row },
            h(
              'button',
              {
                key: 'start',
                type: 'button',
                style: styles.primary,
                disabled: busy === 'napcat' || state.loading === true,
                onClick: () => handlers.startNapcat()
              },
              napcatPanel.startLabel
            ),
            h(
              'button',
              { key: 'refresh', type: 'button', style: styles.button, disabled: busy === 'napcat', onClick: () => handlers.refreshNapcat() },
              napcatPanel.refreshLabel
            )
          )
        : null;
      // 卡片上的"下一步"：地址一行、自动读取一行、打开面板一行、面板操作提示一行。
      // 这四样是扫码之后真正要做的事，全部留在扫码卡片里，不另开页面。
      const configuredWs = toText(dotGet(state.config, 'qqNapcat.wsUrl', '')).trim();
      const wsLineText = napcat ? napcatWsLine(state.napcat, configuredWs) : '';
      const wsLine = wsLineText === '' ? null : h('p', { key: 'ws', style: styles.muted }, wsLineText);
      const autofillHint =
        napcat && state.napcatFilled === true
          ? h('p', { key: 'autofill', style: styles.muted }, napcatPanel.autofillHint)
          : null;
      const panelRow = napcat
        ? h(
            'div',
            { key: 'panelRow', style: styles.row },
            h(
              'button',
              { key: 'open-panel', type: 'button', style: styles.primary, disabled: busy === 'panel', onClick: () => handlers.openPanel() },
              busy === 'panel' ? '正在打开…' : napcatPanel.openPanelLabel
            ),
            napcatPanel.loggedIn === true
              ? h('span', { key: 'token', style: styles.token }, napcatPanel.token === '' ? '令牌 —' : NAPCAT_TOKEN_PREFIX + napcatPanel.token)
              : null,
            napcatPanel.loggedIn === true
              ? h(
                  'button',
                  {
                    key: 'copy-token',
                    type: 'button',
                    style: styles.ghostButton,
                    disabled: napcatPanel.token === '',
                    onClick: () => handlers.copyToken(napcatPanel.token)
                  },
                  napcatPanel.copyTokenLabel
                )
              : null
          )
        : null;
      const panelHint =
        napcat && napcatPanel.loggedIn === true ? h('p', { key: 'panelHint', style: styles.muted }, napcatPanel.panelHint) : null;

      // 方块下方那行小字：只在"贴着一张真二维码"时出现，说清它能活多久
      const qrFooter =
        napcat && napcatPanel.dataUrl !== '' && napcatPanel.loggedIn === false
          ? h('p', { key: 'qrHint', style: styles.muted }, napcatPanel.qrHint)
          : null;

      // 个人号没有「当前链接」可给：地址是 NapCat 自己的本机面板，登录后没人会用它
      // 微信也没有外部链接：桥就在本机，登录在微信客户端里做
      const linkRow = napcat || wechat
        ? null
        : h(
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
      } else if (wechat) {
        credential.push(
          h('p', { key: 'wechatHint', style: styles.muted }, WECHAT_BRIDGE_HINT + '：小号在微信里扫码登录好，再把桥地址填对，点「检测连接」。'),
          h('p', { key: 'wechatState', style: styles.muted }, wechatView.text)
        );
      }

      const testRow = h(
        'div',
        { key: 'test', style: { ...styles.row, ...styles.actionRow } },
        h('button', { key: 'btn', type: 'button', style: styles.button, disabled: testing || state.loading === true, onClick: () => handlers.test() }, testing ? '发送中…' : '发条测试消息'),
        test === null ? null : h('span', { key: 'res', style: styles.muted }, describeTestResult(test).text)
      );

      const useAlt = shouldOfferUseNapcat(state);
      const secondary = [];
      if (napcat) {
        // 扫完码这一步才是「小号真的能用了」：给它一个主按钮，省得人再翻字段表改平台
        if (useAlt) {
          secondary.push(
            h(
              'button',
              { key: 'use-alt', type: 'button', style: styles.primary, disabled: busy === 'switch' || state.loading === true, onClick: () => handlers.useAlt() },
              busy === 'switch' ? '切换中…' : USE_NAPCAT_LABEL
            )
          );
        }
        secondary.push(
          h(
            'button',
            { key: 'detect', type: 'button', style: styles.button, disabled: busy === 'detect', onClick: () => handlers.detect() },
            busy === 'detect' ? '检测中…' : '检测连接'
          )
        );
      } else if (wechat) {
        // 微信没有凭证可验：这个按钮就是唯一"它到底通没通"的入口
        secondary.push(
          h(
            'button',
            { key: 'detect-wx', type: 'button', style: styles.button, disabled: busy === 'wechat', onClick: () => handlers.detectWechat() },
            busy === 'wechat' ? WECHAT_DETECTING_LABEL : WECHAT_DETECT_LABEL
          )
        );
      } else if (copy.reopen !== '') {
        secondary.push(h('button', { key: 'reopen', type: 'button', style: styles.button, onClick: () => handlers.open() }, copy.reopen));
      }
      // 「收起」只影响这张卡：配置不动、填过的输入也不丢，所以旁边写清楚，免得有人以为它会撤销
      secondary.push(h('button', { key: 'collapse', type: 'button', style: styles.ghostButton, onClick: () => handlers.cancel() }, COLLAPSE_LABEL));
      secondary.push(h('span', { key: 'collapseHint', style: styles.muted }, COLLAPSE_HINT));

      return h(
        'section',
        { key: 'connect', style: styles.connectCard },
        head,
        title,
        desc,
        napcatBar,
        square,
        wsLine,
        autofillHint,
        panelRow,
        panelHint,
        downloadHint,
        qrFooter,
        linkRow,
        stepRows.length === 0 ? null : h('div', { key: 'steps', style: styles.steps }, stepRows),
        // 凭证区块左对齐：步骤是"照着做"的清单，中间的说明和输入框跟它同一条视觉基线
        h('div', { key: 'credential', style: styles.credentialBlock }, credential),
        testRow,
        h('div', { key: 'secondary', style: { ...styles.row, ...styles.actionRow } }, secondary),
        checkView === null ? null : h('p', { key: 'napcatCheck', style: styles.muted }, checkView.text)
      );
    }

    // 底部「已绑定」卡片：常驻显示；点箭头才展开五项详情。
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
          iconNode(card.avatar, { ...styles.avatar, key: 'avatar' }, 19),
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

    // 首次配置引导：三步把"能跑起来"必需的东西问完，之后主界面只剩状态与按钮。
    // 第 1 步不自己摆平台选择——左栏卡片已经选好了，同一个决定不该让用户做两遍。
    function firstRunPanelNode(state, handlers) {
      const steps = firstRunSteps();
      const step = clampStep(handlers.step);
      const current = steps[step];
      const form = isPlainObject(state.form) ? state.form : {};
      const pickedLabel = toText(handlers.platformLabel).trim();
      const nodes = [
        h('p', { key: 'progress', style: styles.muted }, stepProgressText(step)),
        h('h3', { key: 'title', style: styles.groupTitle }, current.title),
        h('p', { key: 'hint', style: styles.muted }, current.hint)
      ];

      if (current.id === 'platform') {
        nodes.push(
          h('p', { key: 'picked', style: styles.label }, pickedLabel ? '已选：' + pickedLabel : '先在左边选一种接入方式'),
          h(
            'div',
            { key: 'nav', style: styles.row },
            h(
              'button',
              { key: 'next', type: 'button', style: styles.primary, disabled: pickedLabel === '' || state.loading, onClick: () => handlers.goto(1) },
              '下一步'
            )
          )
        );
        return h('section', { key: 'firstRun', style: styles.group }, nodes);
      }

      const fields = current.id === 'credentials' ? credentialFields(handlers.fields, handlers.platformId) : scopeFields(handlers.fields);
      nodes.push(
        fields.length > 0
          ? h('div', { key: 'fields', style: styles.panel }, fields.map((field) => fieldRowNode(field, form, handlers.field, 'dsh-bot-step-')))
          : h('p', { key: 'nofields', style: styles.muted }, '宿主没有下发这几项字段，保存后会落到「修改配置」里，可以再补。')
      );

      if (current.id === 'credentials') {
        nodes.push(
          h(
            'div',
            { key: 'nav', style: styles.row },
            h('button', { key: 'prev', type: 'button', style: styles.button, onClick: () => handlers.goto(-1) }, '上一步'),
            h(
              'button',
              { key: 'next', type: 'button', style: styles.primary, disabled: state.saving, onClick: () => handlers.goto(1) },
              '下一步'
            )
          )
        );
        return h('section', { key: 'firstRun', style: styles.group }, nodes);
      }

      // 第 3 步：谁能用，然后只剩「保存并启动」
      nodes.push(
        h(
          'div',
          { key: 'nav', style: styles.row },
          h('button', { key: 'prev', type: 'button', style: styles.button, disabled: state.saving, onClick: () => handlers.goto(-1) }, '上一步'),
          h(
            'button',
            { key: 'save', type: 'button', style: styles.primary, disabled: state.saving || state.loading, onClick: () => handlers.saveAndStart() },
            state.saving ? '保存并启动中…' : '保存并启动'
          )
        ),
        // 保存失败的提示就贴在这两个按钮下面：跳步、或者只在顶部闪一下，都会让人以为已经存好了
        noticeNode(state.onboardingError)
      );
      return h('section', { key: 'firstRun', style: styles.group }, nodes);
    }

    // ---------------- 账号与权限（谁能用） ----------------
    // 整页只保留这一个能改的配置项：名单为空等于谁都能使唤你电脑，所以文案要点明。
    const WHITELIST_LABEL = '谁能用：填你自己的 QQ 号 / 微信 wxid，一行一个（空着不让启动）';
    const WHITELIST_HINT = '这一块只改「谁能用」，其它配置一个字都不动。';

    function whitelistValueOf(state) {
      if (typeof state.whitelistText === 'string') return state.whitelistText;
      return listToText(dotGet(state.config, 'security.userWhitelist', []));
    }

    function accountSectionNode(state, handlers) {
      const value = whitelistValueOf(state);
      const count = textToList(value).length;
      return h(
        'section',
        { key: 'account', style: styles.group },
        h('h3', { key: 'title', style: styles.groupTitle }, '账号与权限'),
        h(
          'div',
          { key: 'whitelist', style: styles.field },
          h('label', { key: 'label', style: styles.label, htmlFor: 'dsh-bot-whitelist' }, WHITELIST_LABEL),
          h('textarea', {
            key: 'box',
            id: 'dsh-bot-whitelist',
            style: styles.textarea,
            spellCheck: false,
            rows: 4,
            value,
            onChange: (event) => handlers.change(event && event.target ? event.target.value : '')
          }),
          h(
            'p',
            { key: 'help', style: styles.muted },
            count === 0 ? '现在是空的：启动会被拒绝，先把自己的号填进来。' : '现在有 ' + count + ' 个人能用。'
          )
        ),
        h(
          'div',
          { key: 'save', style: styles.row },
          h(
            'button',
            {
              key: 'saveBtn',
              type: 'button',
              style: styles.primary,
              disabled: state.whitelistSaving === true || state.loading === true,
              onClick: () => handlers.save()
            },
            state.whitelistSaving === true ? '保存中…' : '保存'
          ),
          h('span', { key: 'hint', style: styles.muted }, WHITELIST_HINT)
        ),
        noticeNode(state.whitelistNote)
      );
    }

    // ---------------- 人设与记忆（整页最底下，默认收起） ----------------
    // 五块都是文件：prompts/persona.md、prompts/lessons.md、prompts/examples.md、
    // prompts/journal.md、stickers/index.json。
    // 默认收起的原因是"偶尔改一次"，不该和扫码、启动这些常用动作抢位置。
    const MEMORY_TITLE = '人设与记忆';
    const MEMORY_HINT = '它怎么说话、你教过它什么、照哪几段真人对话说、它自己写的日记、收过的表情，都在这五块里。';
    const PERSONA_MAX_CHARS = 20000;
    const PERSONA_HINT = '它在 QQ 里怎么说话，就写在这里（存到 prompts/persona.md）。';
    const LESSON_DRAFT_PLACEHOLDER = '比如：以后别人问你几点，就说现在几点';
    const STICKER_USAGE_HINT = '用法：跟它说「发个表情」它就自己挑一张；序号就是库里这个顺序。';
    const EXAMPLE_HINT = '粘贴几段真实对话（我：… / 它：…），它照着学；比写“幽默、毒舌”这种形容词管用。';
    const EXAMPLE_PLACEHOLDER = '我：累死了\n它：活该，谁让你不睡';
    const EXAMPLE_SAVE_LABEL = '存成示例';
    const EXAMPLE_CLEAR_LABEL = '清空示例';
    // 清空是不可逆的，所以第一次点只改按钮文案，3 秒内再点才真删
    const EXAMPLE_CLEAR_ARMED_LABEL = '再点一次清空';
    const EXAMPLE_CLEAR_MS = 3000;
    const EXAMPLE_PREVIEW_LINES = 2;

    function personaCharsText(text) {
      return toText(text).length + ' / ' + PERSONA_MAX_CHARS + ' 字';
    }

    function memorySummaryLine(state) {
      const personas = toText(state.personaText);
      const lessons = Array.isArray(state.lessons) ? state.lessons.length : 0;
      const journal = Array.isArray(state.journal) ? state.journal.length : 0;
      const stickers = Array.isArray(state.stickers) ? state.stickers.length : 0;
      const personaPart = personas.trim() === '' ? '人设 空' : '人设 ' + personas.length + ' 字';
      return personaPart + ' · 你教过 ' + lessons + ' 条 · 日记 ' + journal + ' 条 · 表情 ' + stickers + ' 张';
    }

    function personaBlockNode(state, handlers) {
      return h(
        'div',
        { key: 'persona', style: styles.field },
        h('h4', { key: 'title', style: styles.groupTitle }, '人设'),
        h('p', { key: 'hint', style: styles.muted }, PERSONA_HINT),
        h('textarea', {
          key: 'box',
          id: 'dsh-bot-persona',
          style: styles.textarea,
          spellCheck: false,
          rows: 6,
          value: toText(state.personaText),
          onChange: (event) => handlers.changePersona(event && event.target ? event.target.value : '')
        }),
        h(
          'div',
          { key: 'save', style: styles.row },
          h(
            'button',
            {
              // key 不能和「账号与权限」那个保存撞：页面上有两个"保存"按钮
              key: 'personaSave',
              type: 'button',
              style: styles.primary,
              disabled: state.personaSaving === true,
              onClick: () => handlers.savePersona()
            },
            state.personaSaving === true ? '保存中…' : '保存人设'
          ),
          h('span', { key: 'chars', style: styles.muted }, personaCharsText(state.personaText))
        ),
        noticeNode(state.personaNote)
      );
    }

    function lessonsBlockNode(state, handlers) {
      const lessons = Array.isArray(state.lessons) ? state.lessons : [];
      const busy = toText(state.lessonsBusy);
      return h(
        'div',
        { key: 'lessons', style: styles.field },
        h('h4', { key: 'title', style: styles.groupTitle }, '你教过的'),
        h('p', { key: 'hint', style: styles.muted }, '这些话每轮都会被它记着（prompts/lessons.md）：一句一个，长了反而记不住。'),
        lessons.length === 0
          ? h('p', { key: 'empty', style: styles.muted }, '还没有。下面写一句试试。')
          : h(
              'ul',
              { key: 'list', style: styles.problems },
              lessons.map((lesson) =>
                h(
                  'li',
                  { key: 'lesson-' + lesson.index, style: styles.detailRow },
                  h('span', { key: 'text' }, h('span', { key: 'when', style: styles.muted }, toText(lesson.when) + ' '), toText(lesson.body)),
                  h(
                    'button',
                    {
                      key: 'del',
                      type: 'button',
                      style: styles.ghostButton,
                      disabled: busy === 'delete-' + lesson.index,
                      onClick: () => handlers.deleteLesson(lesson.index)
                    },
                    '删掉'
                  )
                )
              )
            ),
        h(
          'div',
          { key: 'add', style: styles.row },
          h('input', {
            key: 'draft',
            id: 'dsh-bot-lesson',
            style: { ...styles.input, width: 'auto', flex: '1 1 220px' },
            type: 'text',
            placeholder: LESSON_DRAFT_PLACEHOLDER,
            value: toText(state.lessonDraft),
            onChange: (event) => handlers.changeDraft(event && event.target ? event.target.value : '')
          }),
          h(
            'button',
            {
              key: 'addBtn',
              type: 'button',
              style: styles.button,
              disabled: busy === 'add' || toText(state.lessonDraft).trim() === '',
              onClick: () => handlers.addLesson()
            },
            busy === 'add' ? '记着…' : '加一条'
          )
        ),
        noticeNode(state.lessonsNote)
      );
    }

    // 列表里只露前两行：整段贴出来会把「你教过的」挤没，时间 + 开头两句足够认人
    function exampleLinesOf(entry) {
      const lines = Array.isArray(entry && entry.lines) ? entry.lines : [];
      return lines
        .map((line) => {
          const speaker = toText(line && line.speaker);
          const text = toText(line && line.text);
          return speaker === '' ? text : speaker + '：' + text;
        })
        .filter((line) => line !== '');
    }

    function examplePreviewNodes(entry, index) {
      const all = exampleLinesOf(entry);
      const shown = all.slice(0, EXAMPLE_PREVIEW_LINES);
      const nodes = shown.map((text, line) => h('div', { key: 'example-' + index + '-line-' + line }, text));
      if (all.length > shown.length) nodes.push(h('div', { key: 'example-' + index + '-more', style: styles.muted }, '…'));
      return nodes;
    }

    function examplesBlockNode(state, handlers) {
      const entries = Array.isArray(state.examples) ? state.examples : [];
      const busy = toText(state.examplesBusy);
      const draft = toText(state.exampleDraft);
      const armed = Number(state.examplesClearArmed) > Date.now();
      return h(
        'div',
        { key: 'examples', style: styles.field },
        h('h4', { key: 'title', style: styles.groupTitle }, '对话示例'),
        h('p', { key: 'hint', style: styles.muted }, EXAMPLE_HINT),
        entries.length === 0
          ? h('p', { key: 'empty', style: styles.muted }, '还没有。粘几段真实对话试试，它下一条就照着说。')
          : h(
              'ul',
              { key: 'list', style: styles.problems },
              entries.map((entry, index) =>
                h(
                  'li',
                  { key: 'example-' + index },
                  h('div', { key: 'when', style: styles.muted }, toText(entry && entry.when)),
                  examplePreviewNodes(entry, index)
                )
              )
            ),
        h('textarea', {
          key: 'box',
          id: 'dsh-bot-examples',
          style: styles.textarea,
          spellCheck: false,
          rows: 6,
          placeholder: EXAMPLE_PLACEHOLDER,
          value: draft,
          onChange: (event) => handlers.changeExampleDraft(event && event.target ? event.target.value : '')
        }),
        h(
          'div',
          { key: 'actions', style: styles.row },
          h(
            'button',
            {
              key: 'exampleSave',
              type: 'button',
              style: styles.primary,
              disabled: busy === 'add' || draft.trim() === '',
              onClick: () => handlers.addExample()
            },
            busy === 'add' ? '存着…' : EXAMPLE_SAVE_LABEL
          ),
          h(
            'button',
            {
              key: 'exampleClear',
              type: 'button',
              style: armed ? styles.primary : styles.button,
              disabled: busy === 'clear' || entries.length === 0,
              onClick: () => handlers.clearExamples()
            },
            busy === 'clear' ? '清着…' : armed ? EXAMPLE_CLEAR_ARMED_LABEL : EXAMPLE_CLEAR_LABEL
          )
        ),
        noticeNode(state.examplesNote)
      );
    }

    function journalBlockNode(state) {
      const entries = Array.isArray(state.journal) ? state.journal : [];
      return h(
        'div',
        { key: 'journal', style: styles.field },
        h('h4', { key: 'title', style: styles.groupTitle }, '日记'),
        h('p', { key: 'hint', style: styles.muted }, '它自己写的最近 5 条（prompts/journal.md）。这里只读：改了就成你替它记的了。'),
        entries.length === 0
          ? h('p', { key: 'empty', style: styles.muted }, '还没写过日记。聊几轮之后它会自己回顾一次。')
          : h(
              'ul',
              { key: 'list', style: styles.problems },
              entries.map((entry, index) =>
                h(
                  'li',
                  { key: 'journal-' + index },
                  h('span', { key: 'when', style: styles.muted }, toText(entry.title) + ' '),
                  toText(entry.body)
                )
              )
            )
      );
    }

    function stickersBlockNode(state, handlers) {
      const stickers = Array.isArray(state.stickers) ? state.stickers : [];
      const busy = toText(state.stickersBusy);
      return h(
        'div',
        { key: 'stickers', style: styles.field },
        h('h4', { key: 'title', style: styles.groupTitle }, '表情库'),
        h('p', { key: 'hint', style: styles.muted }, STICKER_USAGE_HINT),
        stickers.length === 0
          ? h('p', { key: 'empty', style: styles.muted }, '还没收过表情：把图发给它，它会自己存进 stickers/。')
          : h(
              'ul',
              { key: 'list', style: styles.problems },
              stickers.map((sticker, index) =>
                h(
                  'li',
                  { key: 'sticker-' + toText(sticker.id), style: styles.detailRow },
                  h('span', { key: 'text' }, index + 1 + '. ' + toText(sticker.note)),
                  h(
                    'button',
                    {
                      key: 'del',
                      type: 'button',
                      style: styles.ghostButton,
                      disabled: busy === 'sticker-' + toText(sticker.id),
                      onClick: () => handlers.deleteSticker(sticker.id)
                    },
                    '删掉'
                  )
                )
              )
            ),
        noticeNode(state.stickersNote)
      );
    }

    function memorySectionNode(state, handlers) {
      const open = state.memoryOpen === true;
      return h(
        'section',
        { key: 'memory', style: styles.group },
        h(
          'div',
          { key: 'head', style: { ...styles.row, justifyContent: 'space-between' } },
          h(
            'div',
            { key: 'left', style: styles.row },
            h('h3', { key: 'title', style: styles.groupTitle }, MEMORY_TITLE),
            h('span', { key: 'summary', style: styles.muted }, open || state.memoryLoaded === true ? memorySummaryLine(state) : MEMORY_HINT)
          ),
          h(
            'button',
            { key: 'memoryToggle', type: 'button', style: styles.ghostButton, 'aria-expanded': open, onClick: () => handlers.toggle() },
            open ? '收起' : '展开'
          )
        ),
        // 收起时只是 display:none：展开过再收起，填了一半的人设不会被扔掉
        h(
          'div',
          { key: 'memoryBody', style: open ? styles.panel : styles.hidden },
          personaBlockNode(state, handlers),
          lessonsBlockNode(state, handlers),
          examplesBlockNode(state, handlers),
          journalBlockNode(state),
          stickersBlockNode(state, handlers)
        )
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

      // 只有选中「QQ 个人账号」才轮询：别的平台打这两个接口纯属浪费，
      // 而且会把"没有 NapCat"的宿主也每 3 秒敲一次。切走/卸载必须清掉定时器。
      const watchingNapcat = state.platformId === 'qq-napcat';
      React.useEffect(() => {
        if (!watchingNapcat) return undefined;
        const watcher = createNapcatWatcher({
          api,
          intervalMs: NAPCAT_POLL_MS,
          // 合并回去：applyNapcat 只会给出要改的那几项，整份状态不能被它替掉
          onState: (next) => setState((prev) => ({ ...prev, ...applyNapcat(prev, next) }))
        });
        watcher.start();
        return () => watcher.stop();
      }, [watchingNapcat]);

      function updateField(key, value) {
        setState((prev) => ({ ...prev, form: { ...prev.form, [key]: value }, notice: null }));
      }

      function selectPlatform(id) {
        setState((prev) => {
          const next = switchPlatformForm(prev, id);
          return { ...prev, ...next, notice: null };
        });
      }

      // 引导第 3 步的「保存并启动」：先落盘、再启动，两步都成了才算走完。
      // 保存失败就地停下：错误贴在按钮下面，配置一个字节都不动，也不跳步。
      function saveAndStart() {
        const payload = buildConfig(state.config, state.fields, state.form);
        setState((prev) => ({ ...prev, saving: true, onboardingError: null }));
        api.save(payload).then(
          (response) => {
            const config = isPlainObject(response && response.config) ? response.config : payload;
            setState((prev) => ({
              ...prev,
              config,
              form: buildForm(config, prev.fields, prev.form.platform),
              warnings: Array.isArray(response && response.warnings) ? response.warnings.map(toText).filter(Boolean) : prev.warnings,
              configPath: toText(response && response.configPath) || prev.configPath,
              busy: 'start'
            }));
            // 启动失败时配置已经完整，页面会切到摘要态：错误走顶部 notice 才跟着一起留在屏幕上
            api.control('start').then(
              (res) => {
                setState((prev) => ({
                  ...prev,
                  saving: false,
                  busy: '',
                  status: isPlainObject(res && res.status) ? res.status : prev.status,
                  onboardingStep: 0,
                  notice: { kind: 'ok', text: '配置已保存，机器人已启动', problems: [] }
                }));
              },
              (err) => {
                setState((prev) => ({
                  ...prev,
                  saving: false,
                  busy: '',
                  notice: { kind: 'error', text: '配置已保存，但启动没成功：' + describeError(err), problems: (err && err.problems) || [] }
                }));
              }
            );
          },
          (err) => {
            setState((prev) => ({
              ...prev,
              saving: false,
              onboardingError: { kind: 'error', text: '保存失败：' + describeError(err), problems: (err && err.problems) || [] }
            }));
          }
        );
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

      // 发一条测试消息：只发给我现在真正在跑的那个平台，发错平台等于把话发给了另一个号
      function runTest() {
        setState((prev) => ({ ...prev, testing: true, testResult: null, notice: null }));
        api
          .testSend(buildTestSendPayload(state.form.testTarget, state.platformId))
          .then((payload) => {
            // 向导第 3 步要的是原始结果（带 target），notice 是给页面顶部那条提示用的
            setState((prev) => ({ ...prev, testing: false, testResult: payload, notice: describeTestResult(payload) }));
          })
          .catch((err) => {
            setState((prev) => ({
              ...prev,
              testing: false,
              testResult: { ok: false, error: describeError(err) },
              // 服务端那句话本身就是「下一步该改哪」：原样摆出来，不再自己拼前缀
              notice: { kind: 'error', text: describeError(err), problems: (err && err.problems) || [] }
            }));
          });
      }

      // 「用这个小号」：扫码成功这一刻才是真能用的时候。先保存（platform 切到个人号），
      // 再让宿主重启；两步都成了才说切好了，任何一步失败都只把服务端原话摆出来。
      function applyAltAccount() {
        const payload = buildSwitchToNapcatPayload(state);
        setState((prev) => ({ ...prev, busy: 'switch', notice: null }));
        const failed = (err) => {
          setState((prev) => ({
            ...prev,
            busy: '',
            notice: { kind: 'error', text: describeError(err), problems: (err && err.problems) || [] }
          }));
        };
        api.save(payload).then((response) => {
          const config = isPlainObject(response && response.config) ? response.config : payload;
          // 界面当场切到个人号卡片并刷新摘要：摘要读的就是这份 config
          const fields = mergeFields(state.platforms, 'qq-napcat');
          setState((prev) => ({
            ...prev,
            config,
            platformId: 'qq-napcat',
            fields,
            form: buildForm(config, fields, 'qq-napcat')
          }));
          api.control('restart').then((res) => {
            setState((prev) => ({
              ...prev,
              busy: '',
              status: isPlainObject(res && res.status) ? res.status : prev.status,
              notice: { kind: 'ok', text: USE_NAPCAT_DONE_TEXT, problems: [] }
            }));
          }, failed);
        }, failed);
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

      // 一键启动：让宿主拉起本机 NapCat。真正出码要几秒，所以这里只报"已经让它开始了"，
      // 二维码交给 3 秒轮询呈现——不在启动响应里假装已经有码。
      function startNapcat() {
        setState((prev) => ({ ...prev, busy: 'napcat', notice: null }));
        const settle = (payload) => {
          const ok = !isPlainObject(payload) || payload.ok !== false;
          setState((prev) => ({
            ...prev,
            busy: '',
            notice: ok
              ? { kind: 'ok', text: '已让本机 NapCat 开始启动，二维码出来就会显示在上面（一般 5–20 秒）', problems: [] }
              : { kind: 'error', text: '启动失败：' + (toText(payload && payload.error) || '宿主没给原因'), problems: [] }
          }));
          if (ok) refreshNapcat();
        };
        try {
          const ret = api.napcatStart();
          if (ret && typeof ret.then === 'function') ret.then(settle, (err) => settle({ ok: false, error: describeError(err) }));
          else settle({ ok: false, error: '宿主没有返回结果' });
        } catch (err) {
          settle({ ok: false, error: describeError(err) });
        }
      }

      // 「刷新二维码」= 立刻问一次状态和二维码，不等下一个 3 秒
      function refreshNapcat() {
        setState((prev) => ({ ...prev, busy: 'napcat' }));
        readNapcatOnce(api, () => Date.now()).then((next) => {
          setState((prev) => ({ ...prev, busy: '', ...applyNapcat(prev, next) }));
        });
      }

      // 打开 NapCat 面板：宿主拉起程序 + 开浏览器，令牌一并回传。
      // 拿到令牌就顺手写剪贴板（失败静默），人可以直接粘进面板登录框。
      function openNapcatPanel() {
        setState((prev) => ({ ...prev, busy: 'panel', notice: null }));
        const settle = (payload) => {
          const ok = isPlainObject(payload) && payload.ok !== false;
          const token = isPlainObject(payload) ? toText(payload.token).trim() : '';
          if (ok && token !== '') writeClipboard(token);
          setState((prev) => ({
            ...prev,
            busy: '',
            notice: ok
              ? { kind: 'ok', text: NAPCAT_OPENED_TEXT + '。' + NAPCAT_PANEL_HINT, problems: [] }
              : { kind: 'error', text: toText(payload && payload.error) || '打开 NapCat 面板失败：宿主没给原因', problems: [] }
          }));
        };
        try {
          const ret = api.napcatOpenWebui();
          if (ret && typeof ret.then === 'function') ret.then(settle, (err) => settle({ ok: false, error: describeError(err) }));
          else settle({ ok: false, error: '宿主没有返回结果' });
        } catch (err) {
          settle({ ok: false, error: describeError(err) });
        }
      }

      function copyToken(value) {
        const token = toText(value).trim();
        if (token === '') return;
        writeClipboard(token);
        setState((prev) => ({ ...prev, notice: { kind: 'ok', text: '已复制令牌：' + token, problems: [] } }));
      }

      // NapCat 没有凭证可验：所谓"检测连接"就是问一次 /napcat/status（不是运行时 /status）。
      // 结果只写进 napcatCheck——卡片自己那句"通没通"读的就是它。
      function detectConnection() {
        setState((prev) => ({ ...prev, busy: 'detect', napcatCheck: null, notice: null }));
        api
          .napcatStatus()
          .then((payload) => {
            setState((prev) => ({
              ...prev,
              busy: '',
              napcatCheck: isPlainObject(payload) ? payload : { ok: false, error: '宿主没有返回 NapCat 状态' }
            }));
          })
          .catch((err) => {
            setState((prev) => ({
              ...prev,
              busy: '',
              napcatCheck: { ok: false, error: '检测失败：' + describeError(err) }
            }));
          });
      }

      // 微信「检测连接」：一次 /wechat/status 说清三件事（桥在不在、微信登没登、登的是谁）
      function detectWechat() {
        setState((prev) => ({ ...prev, busy: 'wechat', notice: null }));
        api
          .wechatStatus()
          .then((payload) => {
            const view = describeWechatStatus(payload);
            setState((prev) => ({
              ...prev,
              busy: '',
              wechatCheck: isPlainObject(payload) ? payload : { ok: false, error: '宿主没有返回微信桥状态' },
              notice: { kind: view.ok ? 'ok' : 'error', text: view.text, problems: [] }
            }));
          })
          .catch((err) => {
            const payload = { ok: false, error: describeError(err) };
            setState((prev) => ({
              ...prev,
              busy: '',
              wechatCheck: payload,
              notice: { kind: 'error', text: describeWechatStatus(payload).text, problems: (err && err.problems) || [] }
            }));
          });
      }

      // 复制链接：剪贴板不可用（非 https、老浏览器）时也不该把页面弄崩，只是复制不成功
      function copyText(value) {
        const wanted = toText(value);
        if (wanted === '') return;
        // 剪贴板被拒就只留链接本身，用户还能手选中
        writeClipboard(wanted);
        setState((prev) => ({ ...prev, notice: { kind: 'ok', text: '已复制链接：' + wanted, problems: [] } }));
      }

      // ---------------- 账号与权限 ----------------

      // 只提交白名单这一项：整份回传会把用户手改过的隐藏字段（reply.ack / qqNapcat.homeDir …）
      // 一起冲回默认值——那些字段页面不再暴露，只存在于配置文件里。
      function saveWhitelist() {
        const list = textToList(whitelistValueOf(state));
        setState((prev) => ({ ...prev, whitelistSaving: true, whitelistNote: null }));
        api
          .save({ security: { userWhitelist: list } })
          .then((response) => {
            const config = isPlainObject(response && response.config) ? response.config : state.config;
            setState((prev) => ({
              ...prev,
              whitelistSaving: false,
              config,
              whitelistText: null,
              whitelistNote: {
                kind: 'ok',
                text: list.length === 0 ? '已保存，但名单是空的：这样启动会被拒绝' : '已保存：' + list.length + ' 个人能用',
                problems: []
              }
            }));
          })
          .catch((err) => {
            setState((prev) => ({
              ...prev,
              whitelistSaving: false,
              whitelistNote: { kind: 'error', text: '保存失败：' + describeError(err), problems: (err && err.problems) || [] }
            }));
          });
      }

      // ---------------- 人设与记忆 ----------------

      // 五块记忆各自读一次：任何一块读失败（或宿主老到没有这个接口）都不该挡住另外四块
      function loadMemory() {
        const apply = (next) => setState((prev) => ({ ...prev, ...next }));
        const ask = (name, onOk) => {
          if (typeof api[name] !== 'function') return;
          try {
            const ret = api[name]();
            if (ret && typeof ret.then === 'function') ret.then(onOk, () => {});
          } catch {
            // 读不到就按空列表说人话：一块坏掉不该把整页弄崩
          }
        };
        ask('persona', (payload) => apply({ personaText: toText(payload && payload.text) }));
        ask('lessons', (payload) => apply({ lessons: Array.isArray(payload && payload.lessons) ? payload.lessons : [] }));
        ask('examples', (payload) => apply({ examples: Array.isArray(payload && payload.examples) ? payload.examples : [] }));
        ask('journal', (payload) => apply({ journal: Array.isArray(payload && payload.entries) ? payload.entries : [], journalLoaded: true }));
        ask('stickers', (payload) => apply({ stickers: Array.isArray(payload && payload.stickers) ? payload.stickers : [] }));
        apply({ memoryLoaded: true });
      }

      function toggleMemory() {
        const open = state.memoryOpen !== true;
        patch({ memoryOpen: open });
        if (open && state.memoryLoaded !== true) loadMemory();
      }

      function savePersona() {
        const text = toText(state.personaText);
        setState((prev) => ({ ...prev, personaSaving: true, personaNote: null }));
        api.savePersona(text).then(
          (payload) => {
            const saved = toText(payload && payload.text !== undefined ? payload.text : text);
            setState((prev) => ({
              ...prev,
              personaSaving: false,
              personaText: saved,
              personaNote: { kind: 'ok', text: '已保存人设：' + saved.length + ' 字', problems: [] }
            }));
          },
          (err) => {
            setState((prev) => ({
              ...prev,
              personaSaving: false,
              personaNote: { kind: 'error', text: '保存失败：' + describeError(err), problems: (err && err.problems) || [] }
            }));
          }
        );
      }

      function addLesson() {
        const draft = toText(state.lessonDraft).trim();
        if (draft === '') return;
        setState((prev) => ({ ...prev, lessonsBusy: 'add', lessonsNote: null }));
        api.addLesson(draft).then(
          (payload) => {
            setState((prev) => ({
              ...prev,
              lessonsBusy: '',
              lessonDraft: '',
              lessons: Array.isArray(payload && payload.lessons) ? payload.lessons : prev.lessons,
              lessonsNote: { kind: 'ok', text: '记住了：' + toText(payload && payload.body), problems: [] }
            }));
          },
          (err) => {
            setState((prev) => ({
              ...prev,
              lessonsBusy: '',
              lessonsNote: { kind: 'error', text: describeError(err), problems: (err && err.problems) || [] }
            }));
          }
        );
      }

      function deleteLesson(index) {
        setState((prev) => ({ ...prev, lessonsBusy: 'delete-' + index, lessonsNote: null }));
        api.deleteLesson(index).then(
          (payload) => {
            setState((prev) => ({
              ...prev,
              lessonsBusy: '',
              lessons: Array.isArray(payload && payload.lessons) ? payload.lessons : prev.lessons,
              lessonsNote: { kind: 'ok', text: '删掉了这一条', problems: [] }
            }));
          },
          (err) => {
            setState((prev) => ({
              ...prev,
              lessonsBusy: '',
              lessonsNote: { kind: 'error', text: describeError(err), problems: (err && err.problems) || [] }
            }));
          }
        );
      }

      function addExample() {
        const draft = toText(state.exampleDraft).trim();
        if (draft === '') return;
        setState((prev) => ({ ...prev, examplesBusy: 'add', examplesNote: null }));
        api.addExample(draft).then(
          (payload) => {
            setState((prev) => {
              const next = Array.isArray(payload && payload.examples) ? payload.examples : prev.examples;
              const count = Array.isArray(next) ? next.length : 0;
              return {
                ...prev,
                examplesBusy: '',
                exampleDraft: '',
                examples: next,
                examplesClearArmed: 0,
                examplesNote: { kind: 'ok', text: '已存 ' + count + ' 段示例，下一条消息就按它们说话', problems: [] }
              };
            });
          },
          (err) => {
            setState((prev) => ({
              ...prev,
              examplesBusy: '',
              examplesNote: { kind: 'error', text: describeError(err), problems: (err && err.problems) || [] }
            }));
          }
        );
      }

      function clearExamples() {
        const armedUntil = Number(state.examplesClearArmed) || 0;
        // 第一次点只上膛：按钮改成「再点一次清空」，清空这种不可逆动作不该一次点击就生效
        if (!(armedUntil > Date.now())) {
          setState((prev) => ({ ...prev, examplesClearArmed: Date.now() + EXAMPLE_CLEAR_MS, examplesNote: null }));
          // 有定时器就把按钮文案收回；真删与否只按时刻判，所以没有定时器也不会误删
          const timer = typeof setTimeout === 'function' ? setTimeout : null;
          if (timer) {
            timer(
              () =>
                setState((prev) =>
                  Number(prev.examplesClearArmed) > Date.now() ? prev : { ...prev, examplesClearArmed: 0 }
                ),
              EXAMPLE_CLEAR_MS
            );
          }
          return;
        }
        setState((prev) => ({ ...prev, examplesBusy: 'clear', examplesClearArmed: 0, examplesNote: null }));
        api.clearExamples().then(
          (payload) => {
            setState((prev) => ({
              ...prev,
              examplesBusy: '',
              examples: Array.isArray(payload && payload.examples) ? payload.examples : [],
              examplesNote: { kind: 'ok', text: '示例清空了，它下一条消息就照人设说', problems: [] }
            }));
          },
          (err) => {
            setState((prev) => ({
              ...prev,
              examplesBusy: '',
              examplesNote: { kind: 'error', text: describeError(err), problems: (err && err.problems) || [] }
            }));
          }
        );
      }

      function deleteSticker(id) {
        setState((prev) => ({ ...prev, stickersBusy: 'sticker-' + toText(id), stickersNote: null }));
        api.deleteSticker(id).then(
          (payload) => {
            setState((prev) => ({
              ...prev,
              stickersBusy: '',
              stickers: Array.isArray(payload && payload.stickers) ? payload.stickers : prev.stickers,
              stickersNote: { kind: 'ok', text: '删掉了这一张', problems: [] }
            }));
          },
          (err) => {
            setState((prev) => ({
              ...prev,
              stickersBusy: '',
              stickersNote: { kind: 'error', text: describeError(err), problems: (err && err.problems) || [] }
            }));
          }
        );
      }

      try {
        // host 的数据不是数组时也要能渲染：整页白屏比少一块卡片严重得多
        const platformList = Array.isArray(state.platforms) ? state.platforms : [];
        const selected = platformList.filter((p) => p.id === state.platformId)[0] || null;
        const fields = Array.isArray(state.fields) ? state.fields : [];

        // 信封控件独占 platform/enabled，但 label/help 仍取自 host 下发的字段，避免两套文案。
        const enabledField = fields.filter((field) => field.key === 'enabled')[0] || null;
        // 顶部常驻操作行：只留开机自启 + 启动/停止/重启（发测试消息在卡片里，这里不再重复）
        const controls = [];
        const layout = layoutStyle(state.viewportWidth);
        const cards = platformCards(platformList, state.platformId);
        const online = isPlainObject(state.status) && state.status.running === true ? 1 : 0;

        // 引导只在"配置读到了且没读错"之后出现——加载中或读失败就弹引导，
        // 等于让用户对着一份没读到的空配置重填一遍。
        const configured = isConfigured(state.config, state.platformId);
        const onboarding = !state.loading && !state.error && !configured;
        const onboardingStep = clampStep(state.onboardingStep);

        const header = h(
          'div',
          { key: 'head', style: styles.head },
          h(
            'div',
            null,
            h('h2', { style: styles.title }, '消息接入'),
            h('p', { style: styles.muted }, '把各平台消息接给本机 DSH：官方机器人，或用小号扮演一个角色。')
          ),
          h(
            'div',
            { key: 'headRight', style: styles.row },
            h('span', { key: 'pill', style: { ...styles.pill, ...(online > 0 ? styles.pillOn : null) } }, online + ' / 1 在线'),
            close ? h('button', { key: 'done', type: 'button', style: styles.button, onClick: () => close() }, '完成') : null
          )
        );

        // 上面：一个平台一张卡片，选中态由 platformCards 算，渲染只负责摆
        const cardsRow = h(
          'div',
          { key: 'cards', style: { display: 'flex', flexWrap: 'wrap', gap: '8px', width: '100%' } },
          cards.length > 0
            ? cards.map((card) => platformCardNode(card, selectPlatform))
            : h('p', { key: 'empty', style: styles.muted }, state.loading ? '正在读取可用的接入方式…' : '服务没有下发任何平台')
        );

        // 接入卡片：扫码/凭证这一步全在这里，没有第二个页面需要切过去
        const connectPanel = h(
          'div',
          { key: 'connectPanel', style: styles.panel },
          connectPanelNode(state, {
            field: updateField,
            value: wizardValue,
            verify: runVerify,
            test: runTest,
            copy: copyText,
            open: () => openLink(connectCopy(state.platformId).url),
            detect: detectConnection,
            detectWechat,
            useAlt: applyAltAccount,
            startNapcat,
            refreshNapcat,
            openPanel: openNapcatPanel,
            copyToken,
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
            actionButtons
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

        // 「账号与权限」：整页只剩一个能改的配置项——谁能用。
        // 其余配置（数据目录 / 日志 / 回复节奏 / 审批…）继续留在配置文件里，页面不再给入口：
        // 一堆看不懂的开关只会让人不敢动，真需要时改文件即可。
        const accountSection = accountSectionNode(state, {
          change: (value) => patch({ whitelistText: value, whitelistNote: null }),
          save: saveWhitelist
        });
        // 「人设与记忆」：人设 / 你教过的 / 对话示例 / 日记 / 表情库，默认收起
        const memorySection = memorySectionNode(state, {
          toggle: toggleMemory,
          changePersona: (value) => patch({ personaText: value, personaNote: null }),
          savePersona,
          changeDraft: (value) => patch({ lessonDraft: value, lessonsNote: null }),
          addLesson,
          deleteLesson,
          changeExampleDraft: (value) => patch({ exampleDraft: value, examplesNote: null }),
          addExample,
          clearExamples,
          deleteSticker
        });

        const onboardingPanel = onboarding
          ? firstRunPanelNode(state, {
              step: onboardingStep,
              platformId: state.platformId,
              platformLabel: selected ? selected.label : '',
              fields: state.fields,
              field: updateField,
              goto: (delta) => patch({ onboardingStep: clampStep(onboardingStep + delta), onboardingError: null }),
              saveAndStart
            })
          : null;

        // 提示与配置告警挂在页面级：展开/收起任何一块都不该把"保存失败"藏起来
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

        // 整页就是一条主流程：上面平台卡片、下面接入卡片，再往下是账号与权限、人设与记忆、已绑定。
        // 顶部操作行与提示在流程之外，随页面常驻，不用为了点「启动」去展开什么。
        const frame = h(
          'div',
          { key: 'frame', style: { ...layout.container, flexDirection: 'column' } },
          cardsRow,
          onboardingPanel,
          connectPanel,
          accountSection,
          memorySection,
          bindingPanelNode(state, { toggleDetails: () => patch({ showBindingDetails: state.showBindingDetails !== true }) }),
          h('p', { key: 'status', style: styles.muted }, state.loading ? '正在读取状态…' : statusLine(state.status)),
          warningsNode
        );

        return h('div', { style: styles.root }, [
          header,
          notice,
          h('div', { key: 'top', style: styles.panel }, controls),
          frame
        ]);
      } catch (err) {
        // 渲染异常绝不能变成设置页白屏：退化成一行可读提示。
        return h('div', { style: { ...styles.notice, ...styles.error } }, '消息接入 页面渲染失败：' + describeError(err));
      }
    }

    function apply(ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
          console.warn('[dsh-bot] slots 服务不可用，设置页已跳过注册');
          return;
        }
        ctx.slots.inject(SECTION_SLOT, () =>
          // id / order 是 DSH 侧契约（配置命名空间 + 侧栏顺序），只改 label 这一层显示名
          ctx.slots.register({ name: SECTION_SLOT, id: SECTION_ID, order: 120, label: () => '消息接入' }, DshBotSection)
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
    // 首次配置引导：三步走完之前只问"能跑起来"必需的东西
    module.exports.isConfigured = isConfigured;
    module.exports.firstRunSteps = firstRunSteps;
    module.exports.stepProgressText = stepProgressText;
    module.exports.credentialFields = credentialFields;
    module.exports.FIRST_RUN_STEPS = FIRST_RUN_STEPS;
    // 设置页布局的纯函数：卡片 / 步骤 / 已绑定卡片 / 响应式样式，都能单独断言
    module.exports.platformCards = platformCards;
    module.exports.napcatWsLine = napcatWsLine;
    module.exports.onebotFormPatch = onebotFormPatch;
    module.exports.napcatOnebotOf = napcatOnebotOf;
    module.exports.stepsOf = stepsOf;
    module.exports.connectCopy = connectCopy;
    module.exports.describeBindingCard = describeBindingCard;
    module.exports.layoutStyle = layoutStyle;
    module.exports.clockOf = clockOf;
    module.exports.durationText = durationText;
    module.exports.CONNECT_STEPS = CONNECT_STEPS;
    // 个人号一键启动：视图模型与轮询器都是纯函数/可注入依赖，没浏览器也能验
    module.exports.describeNapcatCheck = describeNapcatCheck;
    module.exports.portFromWsUrl = portFromWsUrl;
    module.exports.napcatOfflineText = napcatOfflineText;
    module.exports.NAPCAT_DEFAULT_WS_PORT = NAPCAT_DEFAULT_WS_PORT;
    module.exports.COLLAPSE_LABEL = COLLAPSE_LABEL;
    module.exports.COLLAPSE_HINT = COLLAPSE_HINT;
    // 账号与权限 + 人设与记忆：页面上的四块记忆都能单独断言
    module.exports.WHITELIST_LABEL = WHITELIST_LABEL;
    module.exports.whitelistValueOf = whitelistValueOf;
    module.exports.accountSectionNode = accountSectionNode;
    module.exports.memorySectionNode = memorySectionNode;
    module.exports.memorySummaryLine = memorySummaryLine;
    module.exports.personaCharsText = personaCharsText;
    module.exports.MEMORY_TITLE = MEMORY_TITLE;
    module.exports.PERSONA_MAX_CHARS = PERSONA_MAX_CHARS;
    module.exports.STICKER_USAGE_HINT = STICKER_USAGE_HINT;
    module.exports.describeWechatStatus = describeWechatStatus;
    module.exports.WECHAT_BRIDGE_HINT = WECHAT_BRIDGE_HINT;
    module.exports.WECHAT_DETECT_LABEL = WECHAT_DETECT_LABEL;
    module.exports.WECHAT_DEFAULT_BRIDGE_URL = WECHAT_DEFAULT_BRIDGE_URL;
    module.exports.describeNapcatPanel = describeNapcatPanel;
    module.exports.createNapcatWatcher = createNapcatWatcher;
    module.exports.readNapcatOnce = readNapcatOnce;
    module.exports.emptyNapcatState = emptyNapcatState;
    module.exports.NAPCAT_POLL_MS = NAPCAT_POLL_MS;
    module.exports.NAPCAT_QR_HINT = NAPCAT_QR_HINT;
    module.exports.NAPCAT_LOGGED_IN_TEXT = NAPCAT_LOGGED_IN_TEXT;
    module.exports.NAPCAT_LOGGED_IN_UNKNOWN = NAPCAT_LOGGED_IN_UNKNOWN;
    module.exports.NAPCAT_AUTOFILL_HINT = NAPCAT_AUTOFILL_HINT;
    module.exports.NAPCAT_OPEN_PANEL_LABEL = NAPCAT_OPEN_PANEL_LABEL;
    module.exports.NAPCAT_OPEN_PANEL_FIRST_LABEL = NAPCAT_OPEN_PANEL_FIRST_LABEL;
    module.exports.NAPCAT_OPENED_TEXT = NAPCAT_OPENED_TEXT;
    module.exports.NAPCAT_PANEL_HINT = NAPCAT_PANEL_HINT;
    module.exports.NAPCAT_COPY_TOKEN_LABEL = NAPCAT_COPY_TOKEN_LABEL;
    module.exports.writeClipboard = writeClipboard;
    module.exports.applyNapcat = applyNapcat;
    module.exports.NAPCAT_START_LABEL = NAPCAT_START_LABEL;
    module.exports.NAPCAT_RUNNING_LABEL = NAPCAT_RUNNING_LABEL;
    module.exports.NAPCAT_REFRESH_LABEL = NAPCAT_REFRESH_LABEL;
    // 扫码成功后的一键切换：判定与 payload 都是纯函数，脱离浏览器可断言
    module.exports.shouldOfferUseNapcat = shouldOfferUseNapcat;
    module.exports.buildSwitchToNapcatPayload = buildSwitchToNapcatPayload;
    module.exports.USE_NAPCAT_LABEL = USE_NAPCAT_LABEL;
    module.exports.USE_NAPCAT_DONE_TEXT = USE_NAPCAT_DONE_TEXT;
    module.exports.LAYOUT_STACK_BREAKPOINT = LAYOUT_STACK_BREAKPOINT;
    return module.exports;
  }
});
