import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

// lib/client.js 是浏览器脚本（不转译、不打包）：喂假 window 抓工厂，再喂假 React 造元素树。
function loadEntry() {
  const registered = [];
  const win = { __ModuleLoader__: { load: (entry) => registered.push(entry) } };
  const context = vm.createContext({ window: win, console: { warn() {}, log() {}, error() {} } });
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  assert.equal(registered.length, 1);
  return registered[0];
}

// 纯函数用：真渲染了就报错，免得测试悄悄依赖了渲染期状态。
const NO_RENDER = {
  createElement() {
    throw new Error('这一条只测纯函数，不该渲染');
  },
  useState() {
    throw new Error('这一条只测纯函数，不该 useState');
  },
  useEffect() {}
};

function pureExports() {
  return loadEntry().factory((name) => {
    if (name === 'react') return NO_RENDER;
    throw new Error('工厂请求了未声明的模块：' + name);
  });
}

// 交互用：useState 背后是真状态，setState 直接改它，render() 就地把新状态渲染一遍。
function mount(initialState, api) {
  let current = initialState;
  const react = {
    createElement(type, props, ...children) {
      const flat = [];
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child);
        else flat.push(child);
      }
      return { type, props: props || {}, children: flat };
    },
    useState(initial) {
      if (current === undefined) current = typeof initial === 'function' ? initial() : initial;
      return [
        current,
        (next) => {
          current = typeof next === 'function' ? next(current) : { ...current, ...next };
        }
      ];
    },
    useEffect() {}
  };
  const exports = loadEntry().factory((name) => {
    if (name === 'react') return react;
    throw new Error('工厂请求了未声明的模块：' + name);
  });
  return {
    exports,
    render: () => exports.DshBotSection({ api, close: () => {} }),
    get state() {
      return current;
    }
  };
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.children);
}

function findAll(node, predicate, out) {
  const acc = out || [];
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  for (const child of node.children) findAll(child, predicate, acc);
  return acc;
}

// 「看不见」= display:none / visibility:hidden。已配置好时整张字段表挂在树上但不可见，
// 所以断言"首屏没有输入框"必须按可见性走，不能按节点是否存在。
function invisible(node) {
  const style = node && node.props ? node.props.style : null;
  return !!style && (style.display === 'none' || style.visibility === 'hidden');
}

function findVisible(node, predicate, out) {
  const acc = out || [];
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findVisible(child, predicate, acc);
    return acc;
  }
  if (invisible(node)) return acc;
  if (predicate(node)) acc.push(node);
  for (const child of node.children) findVisible(child, predicate, acc);
  return acc;
}

function visibleText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join('');
  if (invisible(node)) return '';
  return visibleText(node.children);
}

function buttonByText(element, label, onlyVisible) {
  const found = onlyVisible ? findVisible : findAll;
  return found(element, (node) => node.type === 'button' && textOf(node) === label)[0] || null;
}

function fieldInputIds(element, onlyVisible) {
  const found = onlyVisible ? findVisible : findAll;
  return found(element, (node) => typeof node.props.id === 'string' && node.props.id.indexOf('dsh-bot-field-') === 0).map((node) => node.props.id);
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

// ---------------- 夹具 ----------------

const COMMON_FIELDS = [
  { key: 'enabled', label: '开机自动启动', type: 'boolean', group: 'basic' },
  { key: 'storage.rootDir', label: '数据目录', type: 'text', group: 'basic' },
  { key: 'security.userWhitelist', label: '用户白名单', type: 'stringList', group: 'basic' }
];

const PLATFORMS = [
  {
    id: 'qq-official',
    label: 'QQ 官方机器人',
    description: 'QQ 开放平台 WebSocket 网关',
    fields: COMMON_FIELDS.concat([
      { key: 'qqOfficial.appId', label: '机器人 AppID', type: 'text', group: 'basic' },
      { key: 'qqOfficial.appSecret', label: '机器人 AppSecret', type: 'password', secret: true, group: 'basic' },
      { key: 'dsh.runner', label: '干活方式', type: 'select', options: ['headless', 'sdk'], group: 'advanced' }
    ])
  },
  {
    id: 'qq-napcat',
    label: 'QQ 个人账号',
    description: '用小号 QQ 扫码登录',
    fields: COMMON_FIELDS.concat([
      { key: 'qqNapcat.wsUrl', label: 'NapCat 门牌号', type: 'text', group: 'basic' },
      { key: 'qqNapcat.accessToken', label: 'NapCat 口令', type: 'password', secret: true, group: 'basic' },
      { key: 'qqNapcat.homeDir', label: 'NapCat 装在哪个目录', type: 'text', group: 'basic' }
    ])
  },
  { id: 'wechat', label: '微信（未实现）', description: '尚未实现', fields: COMMON_FIELDS.slice() }
];

const READY_OFFICIAL = {
  enabled: false,
  platform: 'qq-official',
  storage: { rootDir: 'E:\\dsh-im-bridge-data' },
  security: { userWhitelist: ['1772538871'] },
  qqOfficial: { appId: '102911163', appSecret: '***' }
};

const READY_NAPCAT = {
  enabled: false,
  platform: 'qq-napcat',
  storage: { rootDir: 'E:\\dsh-im-bridge-data' },
  security: { userWhitelist: ['10001', '10002'] },
  qqNapcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'tok' }
};

const NOT_READY = {
  enabled: false,
  platform: 'qq-official',
  storage: { rootDir: '' },
  security: { userWhitelist: [] },
  qqOfficial: { appId: '', appSecret: '' }
};

const NO_API = {
  save() {
    throw new Error('这一条不该保存');
  },
  control() {
    throw new Error('这一条不该控制');
  }
};

// 引导卡与「更多设置」现在同在一页（已经没有 Tab 可站）：收起态只靠 display:none 藏起来，
// 节点仍在树上，所以断言一律走 findVisible，才看得出用户到底能看见什么。
function stateOf(config, extra) {
  const exports = pureExports();
  const base = {
    ...exports.createInitialState(),
    ...exports.snapshotFrom({ platforms: PLATFORMS }, { config, configPath: 'E:\\cfg\\config.json' }),
    loading: false
  };
  return { ...base, ...(extra || {}) };
}

function draw(state) {
  const mounted = mount(state, NO_API);
  return { element: mounted.render(), state: mounted.state };
}

// ---------------- 1. isConfigured：六种组合 ----------------

test('isConfigured：官方 AppID/AppSecret 齐全，AppSecret 是脱敏的 *** 也算配好', () => {
  const { isConfigured } = pureExports();
  assert.equal(isConfigured(READY_OFFICIAL, 'qq-official'), true, '*** 是非空值，必须当成已填');
  assert.equal(isConfigured(READY_OFFICIAL, 'qq-official'), true);
});

test('isConfigured：白名单是空数组 = 没配好', () => {
  const { isConfigured } = pureExports();
  assert.equal(isConfigured({ ...READY_OFFICIAL, security: { userWhitelist: [] } }, 'qq-official'), false);
  assert.equal(isConfigured({ ...READY_OFFICIAL, security: {} }, 'qq-official'), false, '整块缺失也一样');
});

test('isConfigured：数据目录空着 = 没配好', () => {
  const { isConfigured } = pureExports();
  assert.equal(isConfigured({ ...READY_OFFICIAL, storage: { rootDir: '' } }, 'qq-official'), false);
  assert.equal(isConfigured({ ...READY_OFFICIAL, storage: { rootDir: '   ' } }, 'qq-official'), false, '纯空白等于没填');
});

test('isConfigured：官方缺 AppSecret = 没配好', () => {
  const { isConfigured } = pureExports();
  assert.equal(isConfigured({ ...READY_OFFICIAL, qqOfficial: { appId: '102911163', appSecret: '' } }, 'qq-official'), false);
  assert.equal(isConfigured({ ...READY_OFFICIAL, qqOfficial: { appId: '', appSecret: '***' } }, 'qq-official'), false, '缺 AppID 一样不行');
});

test('isConfigured：个人号要 WebSocket 地址和访问令牌都填', () => {
  const { isConfigured } = pureExports();
  assert.equal(isConfigured(READY_NAPCAT, 'qq-napcat'), true);
  assert.equal(isConfigured({ ...READY_NAPCAT, qqNapcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' } }, 'qq-napcat'), true, '令牌可留空（字段文案就是这么写的）');
  assert.equal(isConfigured({ ...READY_NAPCAT, qqNapcat: { wsUrl: '', accessToken: 'tok' } }, 'qq-napcat'), false);
});

test('isConfigured：其它平台只看白名单和数据目录', () => {
  const { isConfigured } = pureExports();
  const wechat = { platform: 'wechat', storage: { rootDir: 'E:\\d' }, security: { userWhitelist: ['1'] } };
  assert.equal(isConfigured(wechat, 'wechat'), true);
  assert.equal(isConfigured({ ...wechat, storage: { rootDir: '' } }, 'wechat'), false);
});

test('isConfigured：config 不是对象一律 false，不抛', () => {
  const { isConfigured } = pureExports();
  for (const bad of [undefined, null, '', 0, [], 'x']) assert.equal(isConfigured(bad, 'qq-official'), false);
});

// ---------------- 2. firstRunSteps / summaryLine / 进度文案 ----------------

test('firstRunSteps：三步，id 与标题固定，每步都有一句人话 hint', () => {
  const { firstRunSteps } = pureExports();
  const steps = firstRunSteps();
  assert.equal(steps.length, 3);
  assert.deepEqual(Array.from(steps, (step) => step.id), ['platform', 'credentials', 'scope']);
  assert.deepEqual(Array.from(steps, (step) => step.title), ['选平台', '填凭证', '谁能用 + 存哪']);
  for (const step of steps) {
    assert.equal(typeof step.hint, 'string');
    assert.ok(step.hint.length > 0, step.id + ' 得有一句提示');
  }
});

test('firstRunSteps：拿到的是副本，改了也污染不到下一次', () => {
  const { firstRunSteps } = pureExports();
  const steps = firstRunSteps();
  steps[0].title = '改坏了';
  assert.equal(firstRunSteps()[0].title, '选平台');
});

test('summaryLine：白名单 0/1/2 人时人数跟着数组长度走', () => {
  const { summaryLine } = pureExports();
  const config = (list) => ({ platform: 'qq-official', storage: { rootDir: 'E:\\dsh-im-bridge-data' }, security: { userWhitelist: list } });
  assert.equal(summaryLine(config([]), 'qq-official'), '数据目录 E:\\dsh-im-bridge-data · 白名单 0 人 · 平台 QQ 官方机器人');
  assert.equal(summaryLine(config(['1772538871']), 'qq-official'), '数据目录 E:\\dsh-im-bridge-data · 白名单 1 人 · 平台 QQ 官方机器人');
  assert.equal(summaryLine(config(['1', '2']), 'qq-official'), '数据目录 E:\\dsh-im-bridge-data · 白名单 2 人 · 平台 QQ 官方机器人');
});

test('summaryLine：目录空着说"未设置"，个人号用中文平台名', () => {
  const { summaryLine } = pureExports();
  assert.equal(summaryLine({ storage: { rootDir: '  ' }, security: { userWhitelist: ['1'] } }, 'qq-napcat'), '数据目录 未设置 · 白名单 1 人 · 平台 QQ 个人账号');
  assert.equal(summaryLine({}, 'mystery'), '数据目录 未设置 · 白名单 0 人 · 平台 mystery', '不认识的平台原样显示，不编名字');
});

test('stepProgressText：读的是 1 起，越界/脏状态一律夹回第一步', () => {
  const { stepProgressText } = pureExports();
  assert.equal(stepProgressText(0), '第 1 步 / 共 3 步');
  assert.equal(stepProgressText(2), '第 3 步 / 共 3 步');
  assert.equal(stepProgressText(9), '第 1 步 / 共 3 步');
  assert.equal(stepProgressText(-1), '第 1 步 / 共 3 步');
  assert.equal(stepProgressText('x'), '第 1 步 / 共 3 步');
});

// ---------------- 3. A 态：三步引导 ----------------

test('引导第 1 步：进度、已选平台与「下一步」都在，按钮可用', () => {
  const { element } = draw(stateOf(NOT_READY));
  const text = visibleText(element);
  assert.ok(text.includes('第 1 步 / 共 3 步'), text);
  assert.ok(text.includes('选平台'), text);
  assert.ok(text.includes('已选：QQ 官方机器人'), '复用左栏卡片的选择：' + text);
  const next = buttonByText(element, '下一步', true);
  assert.ok(next, '必须有「下一步」');
  assert.equal(next.props.disabled, false);
  assert.equal(typeof next.props.onClick, 'function');
});

test('引导第 1 步：还没选平台时「下一步」禁用，并提示先在左边选', () => {
  const { element } = draw(stateOf(NOT_READY, { platformId: '' }));
  const text = visibleText(element);
  assert.ok(text.includes('先在左边选一种接入方式'), text);
  const next = buttonByText(element, '下一步', true);
  assert.ok(next);
  assert.equal(next.props.disabled, true, '没平台就不该让人往下走');
});

test('引导第 2 步：官方给 AppID/AppSecret 两个框，带「上一步」', () => {
  const { element } = draw(stateOf(NOT_READY, { onboardingStep: 1 }));
  const text = visibleText(element);
  assert.ok(text.includes('第 2 步 / 共 3 步'), text);
  assert.ok(text.includes('机器人 AppID'), text);
  assert.ok(text.includes('机器人 AppSecret'), text);
  const secret = findVisible(element, (node) => node.type === 'input' && node.props.type === 'password')[0];
  assert.ok(secret, 'AppSecret 必须是密码框');
  assert.equal(secret.props.id, 'dsh-bot-step-qqOfficial-appSecret', '引导与字段表各自一份 id，页面上不出现重复 id');
  assert.ok(buttonByText(element, '上一步', true));
  assert.ok(buttonByText(element, '下一步', true));
});

test('引导第 2 步：个人号给地址 / 口令 / 安装目录三个框', () => {
  const { element } = draw(
    stateOf({ platform: 'qq-napcat', storage: { rootDir: '' }, security: { userWhitelist: [] } }, { onboardingStep: 1 })
  );
  const text = visibleText(element);
  assert.ok(text.includes('NapCat 门牌号'), text);
  assert.ok(text.includes('NapCat 口令'), text);
  assert.ok(text.includes('NapCat 装在哪个目录'), text);
  assert.ok(!text.includes('机器人 AppID'), '个人号不该问开放平台的凭证：' + text);
});

test('引导第 3 步：只问白名单和数据目录，按钮是「保存并启动」', () => {
  const { element } = draw(stateOf(NOT_READY, { onboardingStep: 2 }));
  const text = visibleText(element);
  assert.ok(text.includes('第 3 步 / 共 3 步'), text);
  assert.ok(text.includes('用户白名单'), text);
  assert.ok(text.includes('数据目录'), text);
  assert.ok(!text.includes('机器人 AppID'), '凭证不该在第 3 步再问一遍：' + text);
  const area = findVisible(element, (node) => node.type === 'textarea')[0];
  assert.equal(area.props.id, 'dsh-bot-step-security-userWhitelist', 'stringList 仍然用 textarea');
  assert.ok(buttonByText(element, '保存并启动', true));
  assert.ok(buttonByText(element, '上一步', true));
});

test('引导态：字段表整张不可见（没有可见的平台下拉，也没有可见的「保存」）', () => {
  const { element } = draw(stateOf(NOT_READY));
  assert.equal(findVisible(element, (node) => node.props.id === 'dsh-bot-platform').length, 0);
  assert.equal(buttonByText(element, '保存', true), null, '引导没走完就不该露出字段表的保存按钮');
  assert.equal(fieldInputIds(element, true).length, 0, '第 1 步本来就没有输入框');
  assert.ok(findVisible(element, (node) => node.props.id === 'dsh-bot-platform').length === 0);
});

// ---------------- 4. B 态：摘要 + 修改配置 ----------------

test('已配置：首屏只有摘要 + 「修改配置」，看不到任何字段输入框', () => {
  const { element } = draw(stateOf(READY_OFFICIAL));
  const text = visibleText(element);
  assert.ok(text.includes('数据目录 E:\\dsh-im-bridge-data · 白名单 1 人 · 平台 QQ 官方机器人'), text);
  assert.ok(buttonByText(element, '修改配置', true), '必须给一个改配置的入口');
  assert.equal(fieldInputIds(element, true).length, 0, '首屏不该有字段输入框');
  assert.equal(findVisible(element, (node) => node.type === 'textarea').length, 0);
  assert.equal(findVisible(element, (node) => node.props.id === 'dsh-bot-platform').length, 0);
  assert.equal(buttonByText(element, '保存', true), null);
  // 顶部操作行保持原样：开机自动启动 / 启动 / 停止 / 重启 / 发送测试消息
  for (const label of ['启动', '停止', '重启', '发送测试消息']) assert.ok(buttonByText(element, label, true), '缺按钮：' + label);
  const checkboxes = findVisible(element, (node) => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(checkboxes.length, 1, '只剩「开机自动启动」一个勾选框');
});

test('已配置：点「修改配置」展开完整字段表，点「收起」回到摘要', () => {
  const mounted = mount(stateOf(READY_OFFICIAL), NO_API);
  let element = mounted.render();
  assert.equal(fieldInputIds(element, true).length, 0, '默认收起');

  buttonByText(element, '修改配置', true).props.onClick();
  element = mounted.render();
  assert.equal(mounted.state.showManualFields, true);
  assert.equal(findVisible(element, (node) => node.props.id === 'dsh-bot-field-qqOfficial-appId').length, 1, '展开后字段出现');
  assert.equal(findVisible(element, (node) => node.props.id === 'dsh-bot-platform').length, 1);
  assert.ok(buttonByText(element, '保存', true), '展开后才有字段表的保存');
  assert.ok(findVisible(element, (node) => node.props.id === 'dsh-bot-field-dsh-runner').length === 0, 'advanced 仍然收在开关后面');
  const collapse = buttonByText(element, '收起', true);
  assert.ok(collapse, '展开态必须能收回去');
  assert.equal(buttonByText(element, '修改配置', true), null, '展开态不该同时留着入口');

  collapse.props.onClick();
  element = mounted.render();
  assert.equal(mounted.state.showManualFields, false);
  assert.ok(buttonByText(element, '修改配置', true), '收起来之后又只剩摘要和入口');
  assert.equal(fieldInputIds(element, true).length, 0);
});

// ---------------- 5. 交互：保存失败不跳步 / 保存并启动成功 ----------------

function failingApi(message, problems) {
  return {
    save() {
      const err = new Error(message);
      err.problems = problems;
      return Promise.reject(err);
    },
    control() {
      return Promise.resolve({ ok: true });
    }
  };
}

test('交互：保存被拒 → 停在第 3 步，错误就贴在按钮下方', async () => {
  const mounted = mount(stateOf(NOT_READY, { onboardingStep: 2 }), failingApi('配置校验失败', ['storage.rootDir 必填']));
  let element = mounted.render();
  buttonByText(element, '保存并启动', true).props.onClick();
  await tick();
  element = mounted.render();

  assert.equal(mounted.state.onboardingStep, 2, '保存失败不许跳步');
  assert.equal(mounted.state.saving, false);
  assert.ok(mounted.state.onboardingError, '错误要落在引导自己的那条提示上');
  assert.ok(mounted.state.onboardingError.text.startsWith('保存失败：'), mounted.state.onboardingError.text);
  const text = visibleText(element);
  assert.ok(text.includes('第 3 步 / 共 3 步'), '还在第 3 步：' + text);
  assert.ok(text.includes('保存失败：配置校验失败'), text);
  assert.ok(text.includes('storage.rootDir 必填'), '服务端给的 problems 要带出来：' + text);
  assert.ok(!text.includes('修改配置'), '没配好之前不该出现 B 态的摘要入口');
});

test('交互：保存并启动 → 先 POST /config 再 POST /control，然后切到摘要态', async () => {
  const calls = [];
  const api = {
    save(payload) {
      calls.push(['save', payload]);
      return Promise.resolve({ ok: true, config: { ...READY_OFFICIAL }, configPath: 'E:\\cfg\\config.json' });
    },
    control(action) {
      calls.push(['control', action]);
      return Promise.resolve({ ok: true, status: { running: true } });
    }
  };
  const mounted = mount(stateOf(NOT_READY, { onboardingStep: 2 }), api);
  let element = mounted.render();
  buttonByText(element, '保存并启动', true).props.onClick();
  await tick();
  element = mounted.render();

  assert.equal(calls.length, 2, '一次保存 + 一次启动，顺序不能反');
  assert.equal(calls[0][0], 'save');
  assert.equal(calls[0][1].platform, 'qq-official', '保存的是页面上的那份表单');
  assert.deepEqual(Array.from(calls[0][1].security.userWhitelist), []);
  assert.equal(calls[1][0], 'control');
  assert.equal(calls[1][1], 'start');
  assert.equal(mounted.state.onboardingStep, 0, '走完回到第一步，下次从没配置重新开始时不用手动退');
  const text = visibleText(element);
  assert.ok(text.includes('配置已保存，机器人已启动'), text);
  assert.ok(text.includes('数据目录 E:\\dsh-im-bridge-data · 白名单 1 人 · 平台 QQ 官方机器人'), text);
  assert.ok(buttonByText(element, '修改配置', true), '配好之后主界面只剩状态 + 摘要 + 操作按钮');
  assert.equal(fieldInputIds(element, true).length, 0);
});

// ---------------- 6. 这些状态只在组件内 ----------------

test('createInitialState：引导步号与展开开关都不进配置', () => {
  const { createInitialState, buildConfig, normalizePlatforms } = pureExports();
  const initial = createInitialState();
  assert.equal(initial.onboardingStep, 0);
  assert.equal(initial.showManualFields, false);
  assert.equal(initial.onboardingError, null);

  const fields = normalizePlatforms(PLATFORMS)[0].fields;
  const next = buildConfig(READY_OFFICIAL, fields, {
    onboardingStep: 2,
    showManualFields: true,
    'storage.rootDir': 'E:\\dsh-im-bridge-data'
  });
  assert.equal('onboardingStep' in next, false);
  assert.equal('showManualFields' in next, false);
  assert.equal('onboardingError' in next, false);
});
