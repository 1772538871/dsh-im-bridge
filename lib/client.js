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
        group: toText(raw.group || raw.section),
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

    // 分组只看点路径首段或 host 下发的 group，不从字段名里推断业务语义。
    function groupFields(fields) {
      const groups = [];
      const byTitle = new Map();
      for (const field of Array.isArray(fields) ? fields : []) {
        const dotted = field.key.indexOf('.') > 0;
        const title = field.group || (dotted ? field.key.split('.')[0] : '通用');
        let group = byTitle.get(title);
        if (!group) {
          group = { title, fields: [] };
          byTitle.set(title, group);
          groups.push(group);
        }
        group.fields.push(field);
      }
      return groups;
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
        }
      };
    }

    function createInitialState() {
      return {
        loading: true,
        error: '',
        saving: false,
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
      field: { display: 'flex', flexDirection: 'column', gap: '2px' },
      label: { fontSize: '12px' },
      input: { width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', font: 'inherit' },
      textarea: { width: '100%', boxSizing: 'border-box', minHeight: '64px', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', font: 'inherit', resize: 'vertical' },
      button: { padding: '4px 12px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      primary: { padding: '4px 14px', borderRadius: '6px', border: '1px solid transparent', background: 'var(--dsh-accent, #247bbf)', color: '#fff', font: 'inherit', cursor: 'pointer' },
      notice: { margin: '0', padding: '6px 10px', borderRadius: '6px', fontSize: '12px' },
      ok: { background: 'rgba(48,164,108,0.14)', color: 'var(--dsh-text, inherit)' },
      error: { background: 'rgba(222,80,80,0.14)', color: 'var(--dsh-text, inherit)' },
      problems: { margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px' }
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
          controls.push(
            h('section', { key: 'group-' + group.title, style: styles.group }, h('h3', { style: styles.groupTitle }, group.title), rows)
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
    module.exports.formFromConfig = formFromConfig;
    module.exports.buildForm = buildForm;
    module.exports.buildConfig = buildConfig;
    module.exports.switchPlatformForm = switchPlatformForm;
    module.exports.describeError = describeError;
    module.exports.statusLine = statusLine;
    return module.exports;
  }
});
