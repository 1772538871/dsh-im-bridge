import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { listPlatforms } from '../src/plugin/platforms.mjs';

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

// ---------------- 1. 纯函数：可见字段 ----------------

test('visibleFields：默认只留 group=basic 的字段', () => {
  const exports = loadClient();
  const fields = exports.normalizePlatforms(PLATFORMS)[0].fields;
  const keys = exports.visibleFields(fields, false).map((field) => field.key);
  assert.deepEqual(keys, ['enabled', 'storage.rootDir', 'log.dir', 'qqOfficial.appId', 'qqOfficial.appSecret', 'security.userWhitelist']);
  assert.equal(keys.includes('security.userWhitelist'), true, '白名单必须可见：空着不让启动，藏起来等于让新手卡死');
});

test('visibleFields：开关打开后 advanced 一个不少地回来', () => {
  const exports = loadClient();
  const fields = exports.normalizePlatforms(PLATFORMS)[0].fields;
  const keys = exports.visibleFields(fields, true).map((field) => field.key);
  assert.equal(keys.length, fields.length);
  assert.ok(keys.includes('security.userWhitelist'));
  assert.ok(keys.includes('dsh.runner'));
});

test('visibleFields：字段表里一个 basic 都没有时整表显示（老版本 host 不能变白页）', () => {
  const exports = loadClient();
  const legacy = exports.normalizePlatforms([{ id: 'x', fields: [{ key: 'a' }, { key: 'b' }] }])[0].fields;
  assert.deepEqual(exports.visibleFields(legacy, false).map((field) => field.key), ['a', 'b']);
  // 跨 realm 的数组比不了原型，只看元素
  assert.deepEqual(Array.from(exports.visibleFields([], false)), []);
  assert.deepEqual(Array.from(exports.visibleFields(undefined, false)), []);
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

// ---------------- 3. 渲染：默认隐藏 + 底部开关 ----------------

test('渲染：默认态下 advanced 字段（跑法）不可见，basic 字段（含白名单）可见', () => {
  const { text, state } = render();
  assert.ok(text.includes('数据目录'), text.slice(0, 200));
  assert.equal(text.includes('日志目录'), false, '日志目录默认收起（跟随数据目录）');
  assert.ok(text.includes('用户白名单'), '白名单必须默认可见（空着不让启动）');
  assert.equal(text.includes('干活方式'), false, 'advanced 字段默认不该出现');
  assert.equal(state.showAllFields, false);
});

test('渲染：勾「日志单独放」才出现日志目录输入框', () => {
  const { text } = render({ showLogDir: true });
  assert.ok(text.includes('日志目录'), '勾上之后必须能填日志目录');
});

test('渲染：状态里把开关打开后，advanced 字段按分组全部出现', () => {
  const { text } = render({ showAllFields: true });
  assert.ok(text.includes('用户白名单'), text.slice(0, 300));
  assert.ok(text.includes('干活方式'));
  assert.ok(text.includes('数据目录'), 'basic 字段不该因为放开 advanced 而消失');
});

test('渲染：底部有「显示全部字段（排查用）」复选框，默认不勾', () => {
  const { element } = render();
  const labels = findAll(element, (node) => node.type === 'label' && textOf(node).includes('显示全部字段（排查用）'));
  assert.equal(labels.length, 1, '必须正好一个开关');
  const boxes = findAll(labels[0], (node) => node.type === 'input');
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].props.type, 'checkbox');
  assert.equal(boxes[0].props.checked, false, '默认必须是关的');
  assert.equal(typeof boxes[0].props.onChange, 'function', '勾选要能改状态');
});

// ---------------- 4. 开关不落配置 ----------------

test('开关只在组件内：初始状态是 false，且不会写进配置', () => {
  const exports = loadClient();
  const initial = exports.createInitialState();
  assert.equal(initial.showAllFields, false);
  assert.equal(initial.form.showAllFields, undefined);

  const fields = exports.normalizePlatforms(PLATFORMS)[0].fields;
  const next = exports.buildConfig(CONFIG, fields, {
    'storage.rootDir': 'E:\\dsh-im-bridge-data',
    'log.dir': '',
    showAllFields: true
  });
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
