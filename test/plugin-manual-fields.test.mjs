import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { listPlatforms } from '../src/plugin/platforms.mjs';
import { defaultConfig, normalizeConfig } from '../src/plugin/config-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

// lib/client.js 是浏览器脚本（不转译、不打包），这里喂假 window + 假 React 把 factory 抓出来。
// forcedState 有值时 useState 就固定返回它——渲染结果因此可以被直接断言。
function loadClient(forcedState) {
  const registered = [];
  const win = { __ModuleLoader__: { load: (entry) => registered.push(entry) } };
  const context = vm.createContext({ window: win, console: { warn() {}, log() {}, error() {} } });
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  assert.equal(registered.length, 1);
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
      const value = typeof initial === 'function' ? initial() : initial;
      return [forcedState === undefined ? value : forcedState, () => {}];
    },
    useEffect() {}
  };
  return registered[0].factory((name) => {
    if (name === 'react') return react;
    throw new Error('工厂请求了未声明的模块：' + name);
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
    id: 'qq-official',
    label: 'QQ 官方机器人',
    description: 'QQ 开放平台 WebSocket 网关',
    fields: [
      { key: 'enabled', label: '启用', type: 'boolean', group: 'basic' },
      { key: 'storage.rootDir', label: '数据目录（附件/历史/日志/提示词都在这下面）', type: 'text', group: 'basic' },
      { key: 'log.dir', label: '日志目录（留空=数据目录下的 logs）', type: 'text', group: 'basic' },
      { key: 'qqOfficial.appId', label: '机器人 AppID', type: 'text', group: 'basic' },
      { key: 'qqOfficial.appSecret', label: '机器人 AppSecret', type: 'password', secret: true, group: 'basic' },
      { key: 'security.userWhitelist', label: '用户白名单', type: 'stringList', group: 'basic' },
      { key: 'dsh.runner', label: '干活方式', type: 'select', group: 'advanced', options: ['headless', 'sdk'] }
    ]
  }
];

const CONFIG = {
  enabled: false,
  platform: 'qq-official',
  storage: { rootDir: 'E:\\dsh-im-bridge-data' },
  security: { userWhitelist: ['1772538871'] },
  log: { dir: '', level: 'info' },
  qqOfficial: { appId: '102911163', appSecret: '***' },
  dsh: { runner: 'headless' }
};

function snapshotState(extra) {
  const exports = loadClient();
  const base = {
    ...exports.createInitialState(),
    ...exports.snapshotFrom({ platforms: PLATFORMS }, { config: CONFIG, configPath: 'E:\\cfg\\config.json' }),
    loading: false
  };
  return { ...base, ...(extra || {}) };
}

function render(extra) {
  const state = snapshotState(extra);
  const exports = loadClient(state);
  const element = exports.DshBotSection({ close: () => {} });
  return { exports, state, element, text: textOf(element) };
}

// ---------------- 1. 字段表已经整块删掉（连同它那套纯函数） ----------------

test('导出：字段表那套纯函数已经删掉，不留没有界面的死代码', () => {
  const exports = loadClient();
  for (const name of ['visibleFields', 'groupFields', 'summaryLine', 'GROUP_TITLES', 'SHOW_ALL_FIELDS_LABEL']) {
    assert.equal(name in exports, false, '界面入口删了，纯函数也必须跟着删：' + name);
  }
});

test('渲染：整页不再出现「高级设置」「显示全部字段」「更多设置」「数据目录」「日志目录」', () => {
  const { text } = render();
  for (const word of ['高级设置', '显示全部字段', '更多设置', '数据目录', '日志目录', '日志单独放一个目录']) {
    assert.equal(text.includes(word), false, '这些入口必须彻底消失：' + word);
  }
});

test('渲染：字段输入框一个都没有了（平台下拉 / 字段输入 / 复选框只剩开机自启）', () => {
  const { element } = render();
  assert.equal(findAll(element, (node) => node.props && node.props.id === 'dsh-bot-platform').length, 0);
  assert.equal(findAll(element, (node) => node.props && String(node.props.id || '').indexOf('dsh-bot-field-') === 0).length, 0);
  const boxes = findAll(element, (node) => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(boxes.length, 1, '页面上只剩顶部「开机自动启动」一个勾选框');
});

test('渲染：状态里塞了老开关（showAllFields/showManualFields/showLogDir）也放不出字段表', () => {
  const { text } = render({ showAllFields: true, showManualFields: true, showLogDir: true });
  for (const word of ['干活方式', '数据目录', '日志目录', '高级设置', '显示全部字段']) {
    assert.equal(text.includes(word), false, word + ' 不该因为一个脏状态冒出来');
  }
});

// ---------------- 2. 字段表口径：默认可见的只有那 10 项（含白名单） ----------------

test('字段表：跨平台并集正好是约定的 11 项（含微信桥地址），其余一律 advanced', () => {
  const expected = [
    'qqOfficial.appId',
    'qqOfficial.appSecret',
    'qqNapcat.wsUrl',
    'qqNapcat.accessToken',
    'qqNapcat.homeDir',
    'storage.rootDir',
    'log.dir',
    'enabled',
    'security.userWhitelist',
    // 微信平台接进来之后，桥地址也是常用字段（前端要说清"填哪"）
    'wechat.bridgeUrl'
  ];
  const basic = new Set();
  for (const platform of listPlatforms()) {
    for (const field of platform.fields) {
      if (field.group === 'basic') basic.add(field.key);
    }
  }
  // 「平台」这一项由页面顶部的专用下拉渲染，不在 host 下发的字段表里，所以是 10 + 1 = 11
  assert.equal(basic.has('platform'), false);
  assert.deepEqual(Array.from(basic).sort(), expected.slice().sort());
  assert.equal(basic.size + 1, 11);
});

test('字段表：并发/限流/分段/语音转写/审批/跑法/预设/超时/reply/social 都不在 basic', () => {
  const advancedOnly = [
    'security.rateLimitPerMinute',
    'security.maxConcurrentRuns',
    'reply.maxChunkChars',
    'reply.sendDelayMs',
    'asr.command',
    'asr.timeoutMs',
    'approval.enabled',
    'approval.timeoutMs',
    'dsh.runner',
    'dsh.model',
    'dsh.agentPreset',
    'dsh.timeoutMs',
    'social.replyProbability',
    'testTarget',
    'dsh.binPath',
    'dsh.profile',
    'log.level'
  ];
  const byKey = new Map();
  for (const platform of listPlatforms()) {
    for (const field of platform.fields) byKey.set(field.key, field);
  }
  for (const key of advancedOnly) {
    assert.ok(byKey.has(key), '缺字段：' + key);
    assert.equal(byKey.get(key).group, 'advanced', key + ' 必须默认隐藏');
  }
});

test('字段表：数据目录与日志目录的文案是人话', () => {
  const napcat = listPlatforms().find((platform) => platform.id === 'qq-napcat');
  const byKey = new Map(napcat.fields.map((field) => [field.key, field]));
  assert.equal(byKey.get('storage.rootDir').label, '数据目录（附件/历史/日志/提示词都在这下面）');
  assert.equal(byKey.get('log.dir').label, '日志目录（留空=数据目录下的 logs）');
  assert.equal(byKey.get('log.dir').group, 'basic');
});

test('配置：隐藏字段仍在 DEFAULT_CONFIG / normalize 里，手工改配置文件照样生效', () => {
  const seeded = defaultConfig();
  seeded.reply.ack = false;
  seeded.log.dir = 'E:\\logs';
  seeded.asr.command = 'whisper';
  const view = normalizeConfig(seeded);
  assert.deepEqual(view.problems, [], '手工改的值必须能通过校验');
  assert.equal(view.config.reply.ack, false);
  assert.equal(view.config.log.dir, 'E:\\logs');
  assert.equal(view.config.asr.command, 'whisper');
  // 没动过的默认值一个都没变
  assert.equal(view.config.reply.ackMinSeconds, 20);
  assert.equal(view.config.storage.rootDir, 'E:\\dsh-im-bridge-data');
});

// ---------------- 3. 页面只剩四块：顶部动作 / 卡片 / 账号与权限 / 人设与记忆 ----------------

test('渲染：第三个方块是「账号与权限」，只有「谁能用」一个输入框', () => {
  const { text, element } = render();
  assert.ok(text.includes('账号与权限'), text.slice(0, 300));
  assert.ok(text.includes('谁能用：填你自己的 QQ 号 / 微信 wxid，一行一个（空着不让启动）'), text.slice(0, 400));
  const box = findAll(element, (node) => node.props && node.props.id === 'dsh-bot-whitelist')[0];
  assert.ok(box, '白名单必须有一个能直接改的框');
  assert.equal(box.type, 'textarea');
  assert.equal(box.props.value, '1772538871');
});

test('渲染：「人设与记忆」在最底下，四块都在，默认收起', () => {
  const { text, element } = render();
  assert.ok(text.includes('人设与记忆'), text.slice(0, 300));
  // 收起时正文挂在树上但 display:none：控件不重建，展开/收起不丢填了一半的值
  const hidden = findAll(element, (node) => node.props && node.props.style && node.props.style.display === 'none');
  assert.ok(hidden.length >= 1, '收起态必须有 display:none 的容器');
  const body = hidden.find((node) => textOf(node).includes('人设'));
  assert.ok(body, '人设块应该在收起状态里');
  for (const label of ['人设', '你教过的', '日记', '表情库']) {
    assert.ok(textOf(body).includes(label), '缺一块：' + label);
  }
  const toggle = findAll(element, (node) => node.type === 'button' && node.props.key === 'memoryToggle')[0];
  assert.ok(toggle, '必须有一个展开它们的按钮');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.equal(textOf(toggle), '展开');
});

test('渲染：展开态（memoryOpen=true）四块内容都在，并且各自读的字段对得上', () => {
  const { text, element } = render({
    memoryOpen: true,
    memoryLoaded: true,
    personaText: '你叫小号，说话短',
    lessons: [{ index: 0, when: '2026-01-01 10:00', body: '别人骂你别还嘴' }],
    journal: [{ title: '2026-01-02 09:00', body: '今天聊了天气' }],
    stickers: [{ id: 'aaa111', note: '笑' }]
  });
  const personaBox = findAll(element, (node) => node.props && node.props.id === 'dsh-bot-persona')[0];
  assert.ok(personaBox, '人设要有自己的多行文本框');
  assert.equal(personaBox.props.value, '你叫小号，说话短', '人设正文要显示在文本框里');
  assert.ok(text.includes('别人骂你别还嘴'), '教过的条目要在列表里');
  assert.ok(text.includes('今天聊了天气'), '日记最近一条要在列表里');
  assert.ok(text.includes('1. 笑'), '表情库按序号列出来');
  assert.ok(text.includes('人设 8 字'), '摘要行跟着四块的真实数量走：' + text.slice(0, 200));
});

// ---------------- 4. 老开关不会落进配置 ----------------

test('脏状态不落配置：createInitialState 里已经没有 showAllFields / showManualFields / showLogDir', () => {
  const exports = loadClient();
  const initial = exports.createInitialState();
  for (const key of ['showAllFields', 'showManualFields', 'showLogDir']) {
    assert.equal(key in initial, false, '界面删了，状态也删：' + key);
  }
  const fields = exports.normalizePlatforms(PLATFORMS)[0].fields;
  const next = exports.buildConfig(CONFIG, fields, { 'storage.rootDir': 'E:\\dsh-im-bridge-data' });
  assert.equal('showAllFields' in next, false);
  assert.equal(next.storage.rootDir, 'E:\\dsh-im-bridge-data');
});

// ---------------- 5. 改名：显示层是「消息接入」，id 不动 ----------------

test('改名：页面标题与副标题换成「消息接入」的新文案', () => {
  const { text } = render();
  assert.ok(text.includes('消息接入'));
  assert.ok(text.includes('把各平台消息接给本机 DSH：官方机器人，或用小号扮演一个角色。'));
  assert.equal(text.includes('dsh bot'), false);
});

test('改名：slot 注册的 id / order 不变，只有 label 变成「消息接入」', () => {
  const exports = loadClient();
  const registered = [];
  exports.apply({
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.section');
        callback();
        return () => {};
      },
      register(options) {
        registered.push(options);
        return () => {};
      }
    }
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, 'dsh-bot');
  assert.equal(registered[0].order, 120);
  assert.equal(registered[0].name, 'settings.section');
  assert.equal(registered[0].label(), '消息接入');
  assert.equal(exports.API_BASE, '/dsh-bot/api');
});
