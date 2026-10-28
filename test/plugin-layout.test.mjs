import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

// 设置页布局是纯函数算出来的，这里只喂假 window + 假 React，和浏览器无关。
function captureEntry() {
  const registered = [];
  const win = { __ModuleLoader__: { load: (entry) => registered.push(entry) } };
  const context = vm.createContext({ window: win, console: { warn() {}, log() {}, error() {} } });
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  assert.equal(registered.length, 1);
  return registered[0];
}

function makeReactStub(forcedState) {
  return {
    createElement(type, props, ...children) {
      const flat = [];
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child);
        else flat.push(child);
      }
      return { type, props: props || {}, children: flat };
    },
    useState(initial) {
      return [forcedState === undefined ? (typeof initial === 'function' ? initial() : initial) : forcedState, () => {}];
    },
    useEffect() {}
  };
}

function loadClient(forcedState) {
  const entry = captureEntry();
  return entry.factory((name) => {
    if (name === 'react') return makeReactStub(forcedState);
    throw new Error('factory 请求了未声明的模块：' + name);
  });
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

const PLATFORMS = [
  {
    id: 'qq-napcat',
    label: 'QQ（NapCat / OneBot）',
    description: 'OneBot v11 反向 WebSocket',
    fields: [
      { key: 'enabled', label: '启用', type: 'boolean' },
      { key: 'storage.rootDir', label: '数据目录', type: 'text', group: 'basic' },
      { key: 'qqNapcat.wsUrl', label: 'WebSocket 地址', type: 'text', group: 'basic' }
    ]
  },
  {
    id: 'qq-official',
    label: 'QQ 官方机器人',
    description: 'QQ 开放平台',
    fields: [
      { key: 'enabled', label: '启用', type: 'boolean' },
      { key: 'storage.rootDir', label: '数据目录', type: 'text', group: 'basic' },
      { key: 'security.userWhitelist', label: '用户白名单', type: 'stringList', group: 'basic' },
      { key: 'qqOfficial.appId', label: 'AppID', type: 'text', group: 'basic' },
      { key: 'qqOfficial.appSecret', label: 'AppSecret', type: 'password', secret: true, group: 'basic' }
    ]
  },
  { id: 'wechat', label: '微信', description: '还没做完', fields: [] }
];

const CONFIG = {
  enabled: true,
  platform: 'qq-official',
  dsh: { runner: 'inprocess' },
  storage: { rootDir: 'E:\\dsh-im-bridge-data' },
  security: { userWhitelist: ['a', 'b', 'c'] },
  qqOfficial: { appId: '102911163', appSecret: '***' }
};

// ---------------- 1. 左栏：平台卡片 ----------------

test('platformCards: 每个平台一张卡片，选中项带高亮标记与图标', () => {
  const { platformCards } = loadClient();
  const cards = platformCards(PLATFORMS, 'qq-official');
  assert.equal(cards.length, 3);
  assert.deepEqual(Array.from(cards.map((c) => c.id)), ['qq-napcat', 'qq-official', 'wechat']);
  const picked = cards.filter((c) => c.selected);
  assert.equal(picked.length, 1, '只能有一张选中');
  assert.equal(picked[0].id, 'qq-official');
  assert.equal(cards[0].label, 'QQ（NapCat / OneBot）', '名称原样来自 /platforms');
  assert.equal(cards[0].icon, 'qq');
  assert.equal(cards[1].icon, 'robot');
});

test('platformCards: 未开放的 wechat 是禁用态并标注「即将支持」', () => {
  const { platformCards } = loadClient();
  const wechat = platformCards(PLATFORMS, 'qq-official').filter((c) => c.id === 'wechat')[0];
  assert.equal(wechat.disabled, true);
  assert.equal(wechat.badge, '即将支持');
  const napcat = platformCards(PLATFORMS, 'qq-official').filter((c) => c.id === 'qq-napcat')[0];
  assert.equal(napcat.disabled, false);
  assert.equal(napcat.badge, '');
});

test('platformCards: host 用 available/comingSoon/disabled 标记时也算禁用', () => {
  const { platformCards } = loadClient();
  const cards = platformCards(
    [
      { id: 'a', label: 'A', available: false },
      { id: 'b', label: 'B', comingSoon: true },
      { id: 'c', label: 'C', disabled: true }
    ],
    'a'
  );
  assert.deepEqual(Array.from(cards.map((c) => c.disabled)), [true, true, true]);
  assert.ok(cards.every((c) => c.badge === '即将支持'));
});

test('platformCards: 非数组、缺 id、非对象的垃圾数据都不会让页面炸', () => {
  const { platformCards } = loadClient();
  assert.equal(platformCards(null, 'x').length, 0);
  assert.equal(platformCards({ not: 'an array' }, 'x').length, 0);
  assert.deepEqual(Array.from(platformCards([null, 'x', { label: '没有 id' }, { id: 'ok', label: '可用' }], 'ok').map((c) => c.id)), ['ok']);
});

// ---------------- 2. 右栏：Tab / 步骤 / 向导文案 ----------------

test('tabsOf: 两个 Tab，默认选中「正在接入」', () => {
  const { tabsOf } = loadClient();
  const tabs = tabsOf();
  assert.deepEqual(Array.from(tabs.map((t) => t.label)), ['正在接入', '手动接入']);
  assert.deepEqual(Array.from(tabs.map((t) => t.id)), ['connect', 'manual']);
  assert.deepEqual(Array.from(tabs.map((t) => t.active)), [true, false]);
});

test('tabsOf: 传 manual 时选中项跟着换，只有一个 active', () => {
  const { tabsOf } = loadClient();
  const tabs = tabsOf('manual');
  assert.equal(tabs.filter((t) => t.active).length, 1);
  assert.equal(tabs.filter((t) => t.active)[0].id, 'manual');
});

test('stepsOf: 官方机器人三步就是手机上要做的三个动作', () => {
  const { stepsOf } = loadClient();
  const steps = stepsOf('qq-official');
  assert.equal(steps.length, 3);
  assert.deepEqual(Array.from(steps.map((s) => s.index)), [1, 2, 3]);
  assert.equal(steps[0].text, '手机打开开放平台');
  assert.equal(steps[1].text, '创建或查看机器人，复制 AppID 与 AppSecret');
  assert.equal(steps[2].text, '回到这里填进去，点「验证凭证」');
});

test('stepsOf: 个人号三步是先装并启动、再扫码登录小号、最后填地址口令', () => {
  const { stepsOf } = loadClient();
  const steps = stepsOf('qq-napcat');
  assert.equal(steps.length, 3);
  assert.ok(steps[0].text.includes('NapCat'), steps[0].text);
  assert.ok(steps[1].text.includes('扫码登录'), steps[1].text);
  assert.ok(steps[2].text.includes('3001'), steps[2].text);
  assert.ok(steps[2].text.includes('检测连接'), steps[2].text);
});

test('stepsOf: 没选平台/未知平台时没有步骤可显示', () => {
  const { stepsOf } = loadClient();
  assert.equal(stepsOf('').length, 0);
  assert.equal(stepsOf('wechat').length, 0);
});

test('connectCopy: 官方机器人给出等待状态、主标题、说明和开放平台链接', () => {
  const { connectCopy, OPEN_PLATFORM_URL } = loadClient();
  const copy = connectCopy('qq-official');
  assert.equal(copy.waitText, '等待手机打开开放平台');
  assert.equal(copy.liveText, '已连通');
  assert.equal(copy.title, '用自己的手机完成机器人接入');
  assert.equal(copy.description, '在手机上打开 QQ 开放平台，创建或查看机器人，把 AppID / AppSecret 填到这里。');
  assert.equal(copy.url, OPEN_PLATFORM_URL);
  assert.ok(copy.action.includes('打开开放平台'), copy.action);
});

test('connectCopy: 个人号给下载页，并说明二维码在 NapCat 自己那边', () => {
  const { connectCopy, NAPCAT_DOWNLOAD_URL } = loadClient();
  const copy = connectCopy('qq-napcat');
  assert.equal(copy.waitText, '等待用小号扫码登录');
  assert.equal(copy.title, '小号 QQ 扫码登录，托管给 DSH');
  assert.equal(copy.description, '先在电脑上装 NapCat / SnowLuma 并启动，它会给你登录二维码；用手机 QQ 扫它、把小号登进去，再把端口和口令填到下面。');
  assert.equal(copy.url, NAPCAT_DOWNLOAD_URL);
});

test('connectCopy: 没选平台时不给链接，也不假装已连通', () => {
  const { connectCopy } = loadClient();
  const copy = connectCopy('');
  assert.equal(copy.url, '');
  assert.equal(copy.action, '');
  assert.equal(copy.waitText, '先选一种接入方式');
  assert.notEqual(copy.waitText, copy.liveText);
});

// ---------------- 3. 底部「已绑定」卡片 ----------------

test('describeBindingCard: 运行中显示「运行正常」并带上最近检查时间', () => {
  const { describeBindingCard } = loadClient();
  const at = Date.now();
  const card = describeBindingCard({ running: true, platform: 'qq-official' }, { checkedAt: at });
  assert.equal(card.kind, 'ok');
  assert.equal(card.statusText, '运行正常');
  assert.match(card.checkedAt, /^\d\d:\d\d:\d\d$/, card.checkedAt);
  assert.equal(card.checkedAt, new Date(at).toTimeString().slice(0, 8));
});

test('describeBindingCard: 没跑也没错误是「未启动」，没有时间就用「—」', () => {
  const { describeBindingCard } = loadClient();
  const card = describeBindingCard({ running: false, platform: 'qq-napcat', lastError: null });
  assert.equal(card.kind, 'idle');
  assert.equal(card.statusText, '未启动');
  assert.equal(card.checkedAt, '—');
  assert.equal(describeBindingCard(null).statusText, '未启动');
});

test('describeBindingCard: 启动失败时把 lastError 截到 40 字', () => {
  const { describeBindingCard } = loadClient();
  const long = '连不上 NapCat：' + 'x'.repeat(60);
  const card = describeBindingCard({ running: false, platform: 'qq-napcat', lastError: long });
  assert.equal(card.kind, 'failed');
  assert.ok(card.statusText.startsWith('启动失败：'), card.statusText);
  const tail = card.statusText.slice('启动失败：'.length);
  assert.equal(tail.length, 41, '40 字 + 省略号：' + tail);
  assert.ok(tail.endsWith('…'));
  const short = describeBindingCard({ running: false, lastError: '端口被占用' });
  assert.equal(short.statusText, '启动失败：端口被占用');
});

test('describeBindingCard: 展开详情是平台/跑法/会话数/最近一轮耗时/白名单人数', () => {
  const { describeBindingCard } = loadClient();
  const card = describeBindingCard(
    { running: true, platform: 'qq-official', sessions: 2, lastRoundMs: 1500 },
    { runner: 'sdk', whitelistCount: 3 }
  );
  assert.deepEqual(Array.from(card.details.map((d) => d.label)), ['平台', '跑法', '会话数', '最近一轮耗时', '白名单人数']);
  assert.deepEqual(Array.from(card.details.map((d) => d.value)), ['qq-official', 'sdk', '2', '1.5 s', '3 人']);
});

test('describeBindingCard: 宿主没下发的详情一项都不编，统一「—」', () => {
  const { describeBindingCard } = loadClient();
  const card = describeBindingCard({ running: true });
  assert.deepEqual(Array.from(card.details.map((d) => d.value)), ['—', '—', '—', '—', '—']);
  assert.equal(card.name, '未选择平台');
  const ms = describeBindingCard({ running: true, platform: 'qq-official', lastRoundMs: 42 });
  assert.equal(ms.details.filter((d) => d.label === '最近一轮耗时')[0].value, '42 ms');
});

test('describeBindingCard: 官方平台显示「QQ 机器人」，头像用平台图标', () => {
  const { describeBindingCard } = loadClient();
  const official = describeBindingCard({ running: true }, { platform: 'qq-official' });
  assert.equal(official.name, 'QQ 机器人');
  assert.equal(official.avatar, 'robot');
  const napcat = describeBindingCard({ running: true }, { platform: 'qq-napcat' });
  assert.equal(napcat.name, 'NapCat 机器人');
  assert.equal(napcat.avatar, 'qq');
});

// ---------------- 4. 响应式两栏 ----------------

test('layoutStyle: 宽屏两栏（左约 1/3），窄屏堆叠，宽度未知按宽屏', () => {
  const { layoutStyle, LAYOUT_STACK_BREAKPOINT } = loadClient();
  assert.equal(LAYOUT_STACK_BREAKPOINT, 720);
  const wide = layoutStyle(1024);
  assert.equal(wide.stacked, false);
  assert.equal(wide.container.flexDirection, 'row');
  assert.ok(wide.left.flex.includes('30%'), wide.left.flex);
  const narrow = layoutStyle(600);
  assert.equal(narrow.stacked, true);
  assert.equal(narrow.container.flexDirection, 'column');
  assert.equal(narrow.left.width, '100%');
  assert.equal(narrow.right.width, '100%');
  // 0 / undefined 表示还没测到宽度：宁可并排，也不能两次都不显示
  assert.equal(layoutStyle(0).stacked, false);
  assert.equal(layoutStyle(undefined).stacked, false);
  assert.equal(layoutStyle(719).stacked, true);
  assert.equal(layoutStyle(720).stacked, false);
});

// ---------------- 5. 渲染骨架（不依赖浏览器） ----------------

function sectionState(extra) {
  const base = loadClient().createInitialState();
  const snap = loadClient().snapshotFrom(
    { platforms: PLATFORMS },
    { config: CONFIG, configPath: 'E:\\cfg\\config.json', warnings: [] }
  );
  return { ...base, ...snap, loading: false, status: { running: true, enabled: true, platform: 'qq-official' }, statusAt: Date.now(), ...extra };
}

test('渲染: 左栏是平台卡片，右栏顶部是 Tab + 状态药丸', () => {
  const { DshBotSection } = loadClient(sectionState());
  const element = DshBotSection({ close: () => {} });
  const text = textOf(element);
  assert.ok(text.includes('正在接入'), text);
  assert.ok(text.includes('手动接入'), text);
  assert.ok(text.includes('1 / 1 在线'), text);
  assert.ok(text.includes('QQ 官方机器人'), '左栏卡片用 /platforms 的名称：' + text);
  assert.ok(text.includes('即将支持'), 'wechat 卡片要标注即将支持：' + text);
  const pressed = findAll(element, (n) => n.props && Object.prototype.hasOwnProperty.call(n.props, 'aria-pressed'));
  assert.ok(pressed.length >= 5, '三张卡片 + 两个 Tab 都是可选中控件：' + pressed.length);
  const disabled = findAll(element, (n) => n.type === 'button' && n.props.disabled === true);
  assert.ok(disabled.some((n) => textOf(n).includes('微信')), 'wechat 卡片必须是禁用按钮');
});

test('渲染: 向导卡有状态小字、二维码占位与三步编号', () => {
  const { DshBotSection } = loadClient(sectionState());
  const element = DshBotSection({ close: () => {} });
  const text = textOf(element);
  assert.ok(text.includes('等待手机打开开放平台'), text);
  assert.ok(text.includes('用自己的手机完成机器人接入'), text);
  assert.ok(text.includes('手机打开开放平台'), text);
  const squares = findAll(element, (n) => n.props && n.props.style && n.props.style.width === '220px');
  assert.equal(squares.length, 1, '二维码占位方块只有一个');
  assert.equal(squares[0].props.style.background, '#fff');
  const anchors = findAll(element, (n) => n.type === 'a');
  assert.equal(anchors.length, 1);
  assert.ok(text.includes('当前链接：https://q.qq.com/qqbot/#/developer'), text);
});

test('渲染: 已绑定卡片显示名称、状态与最近检查时间', () => {
  const { DshBotSection } = loadClient(sectionState());
  const element = DshBotSection({ close: () => {} });
  const text = textOf(element);
  assert.ok(text.includes('已绑定'), text);
  assert.ok(text.includes('QQ 机器人'), text);
  assert.ok(text.includes('运行正常'), text);
  assert.match(text, /最近检查 \d\d:\d\d:\d\d/, text);
});

test('渲染: 「取消」只收起向导卡，字段表与配置一个都没丢', () => {
  const { DshBotSection } = loadClient(sectionState({ connectCollapsed: true }));
  const text = textOf(DshBotSection({ close: () => {} }));
  assert.ok(text.includes('接入向导已收起，配置没有改动。'), text);
  assert.ok(text.includes('展开'), text);
  assert.ok(!text.includes('复制链接'), '收起后不再显示链接与复制按钮：' + text);
  assert.ok(text.includes('数据目录'), '字段表仍在（收起不改配置）：' + text);
  assert.ok(text.includes('保存'), text);
});

test('渲染: 窄屏宽度下两栏容器改成纵向堆叠', () => {
  const { DshBotSection } = loadClient(sectionState({ viewportWidth: 640 }));
  const element = DshBotSection({ close: () => {} });
  // styles.row 也带 flexWrap，所以靠 gap=16px + alignItems=flex-start 认出两栏骨架
  const frames = findAll(
    element,
    (n) => n.props && n.props.style && n.props.style.flexWrap === 'wrap' && n.props.style.gap === '16px' && n.props.style.alignItems === 'flex-start'
  );
  assert.equal(frames.length, 1, '两栏骨架只应有一个');
  assert.equal(frames[0].props.style.flexDirection, 'column');
});

// ---------------- 6. 既有能力仍在 ----------------

test('导出保留: 既有纯函数与新增布局函数同时在', () => {
  const exports = loadClient();
  for (const name of [
    'resolveWizardStep',
    'describeVerifyResult',
    'buildVerifyPayload',
    'groupFields',
    'buildConfig',
    'describeTestResult',
    'platformCards',
    'tabsOf',
    'stepsOf',
    'describeBindingCard',
    'layoutStyle'
  ]) {
    assert.equal(typeof exports[name], 'function', '缺少导出：' + name);
  }
});
