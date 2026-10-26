import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline } from '../src/pipeline.mjs';

const CHAT_KEY = 'private_10001';

function makeConfig(dsh = {}) {
  return {
    platform: 'qq-napcat',
    dsh: { runner: 'inprocess', cwd: 'E:\\dsh\\proj', newSessionPerMessage: false, ...dsh },
    storage: { rootDir: 'E:\\data' },
    reply: { errorPrefix: '[bridge] ', maxChunkChars: 1500 },
  };
}

function makeLogger() {
  const lines = [];
  const push = (level) => (message, meta) => lines.push({ level, message, meta });
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

function makeSessions(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: (key) => map.get(key),
    async set(key, value) {
      map.set(key, value);
    },
    async clear(key) {
      map.delete(key);
    },
    all: () => Object.fromEntries(map),
  };
}

function makeHarness(options = {}) {
  const sent = [];
  const runCalls = [];
  const logger = makeLogger();
  const sessions = options.sessions ?? makeSessions(options.initial ?? {});
  const pipeline = createPipeline({
    config: options.config ?? makeConfig(),
    logger,
    client: {
      isOpen: () => true,
      async call() {
        return { status: 'ok', retcode: 0, data: {} };
      },
    },
    storage: {
      rootDir: options.rootDir ?? 'E:\\data',
      async saveFromUrl() {
        return { path: 'E:\\data\\media\\a.png', bytes: 1, sha256: 'sha' };
      },
    },
    guard: { decide: () => ({ allow: true, reason: 'ok' }) },
    serial: {
      async run(key, fn) {
        return await fn();
      },
      pending: () => 0,
      size: () => 0,
    },
    semaphore: {
      async withPermit(fn) {
        return await fn();
      },
      active: () => 0,
    },
    sessions,
    runDsh: async (args) => {
      runCalls.push(args);
      if (typeof options.runDshImpl === 'function') return await options.runDshImpl(args);
      return options.runDshResult ?? { ok: true, text: 'ANSWER', sessionId: 'session-new' };
    },
    approvalBridge: options.approvalBridge ?? null,
    questionBridge: options.questionBridge ?? null,
    deps: {
      parseEvent: (raw) => ({ kind: 'message', message: raw.message }),
      planMedia: () => null,
      sendReply: async ({ text }) => {
        sent.push(text);
        return { sent: 1, failed: 0 };
      },
      chatKeyOf: () => CHAT_KEY,
      transcribe: async () => ({ ok: false, text: '', reason: 'not_configured' }),
    },
  });
  return { pipeline, sent, runCalls, logger, sessions };
}

function eventOf(text) {
  const message = {
    messageId: '1',
    chatType: 'private',
    userId: '10001',
    text,
    segments: [{ type: 'text', data: { text } }],
    atTargets: [],
  };
  return { message };
}

test('pipeline 命令：/help 直接回命令表，不进 DSH', async () => {
  const h = makeHarness({ initial: { [CHAT_KEY]: 'session-4088cad7-1111' } });
  await h.pipeline.handleEvent(eventOf('/help'));

  assert.equal(h.runCalls.length, 0);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /可用命令/);
  assert.match(h.sent[0], /\/export/);
  assert.match(h.sent[0], /4088cad7/);
});

test('pipeline 命令：/新会话 清掉绑定并说清"下一条消息开始生效"', async () => {
  const h = makeHarness({ initial: { [CHAT_KEY]: 'session-abcdefgh-1111' } });
  await h.pipeline.handleEvent(eventOf('/新会话'));

  assert.equal(h.runCalls.length, 0);
  assert.equal(h.sessions.map.has(CHAT_KEY), false);
  assert.match(h.sent[0], /已开新会话/);
  assert.match(h.sent[0], /下一条消息开始生效/);
});

test('pipeline 命令：/new 之后那条消息确实换了新会话', async () => {
  const h = makeHarness({ initial: { [CHAT_KEY]: 'session-old' } });
  await h.pipeline.handleEvent(eventOf('/new'));
  await h.pipeline.handleEvent(eventOf('接着聊'));

  assert.equal(h.runCalls.length, 1);
  // 绑定已清，所以这一轮不带旧会话 id
  assert.equal(h.runCalls[0].sessionId, null);
});

test('pipeline 命令：/status 报平台、跑法、会话，没有挂起时不出现等待行', async () => {
  const h = makeHarness({ initial: { [CHAT_KEY]: 'session-abcdefgh-2222' } });
  await h.pipeline.handleEvent(eventOf('/status'));

  assert.equal(h.runCalls.length, 0);
  const text = h.sent[0];
  assert.match(text, /平台 qq-napcat/);
  assert.match(text, /跑法 inprocess/);
  assert.match(text, /会话 abcdefgh/);
  assert.doesNotMatch(text, /正在等/);
});

test('pipeline 命令：/status 里带审批/提问挂起数', async () => {
  const h = makeHarness({
    approvalBridge: { pendingCount: () => 1 },
    questionBridge: { pendingCount: () => 2 },
  });
  await h.pipeline.handleEvent(eventOf('/status'));
  assert.match(h.sent[0], /正在等：审批 1 个 · 提问 2 个/);
});

test('pipeline 命令：/status 报上一轮耗时', async () => {
  const h = makeHarness({
    runDshImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { ok: true, text: 'ok', sessionId: 'session-new' };
    },
  });
  await h.pipeline.handleEvent(eventOf('先跑一轮'));
  await h.pipeline.handleEvent(eventOf('/status'));
  // 机器快慢差别很大，只断言"报出了真实耗时"而不是具体数字
  assert.doesNotMatch(h.sent[1], /还没跑过/);
  assert.match(h.sent[1], /最近一轮 \d+(\.\d)? (毫秒|秒)/);
});

test('pipeline 命令：/export 没有绑定会话时给人话错误，不进 DSH', async () => {
  const h = makeHarness();
  await h.pipeline.handleEvent(eventOf('/export'));

  assert.equal(h.runCalls.length, 0);
  assert.match(h.sent[0], /这次没导出成/);
  assert.match(h.sent[0], /还没开始/);
});

test('pipeline 命令：普通消息里出现 /new 不会被当成命令', async () => {
  const h = makeHarness();
  await h.pipeline.handleEvent(eventOf('我在 /new 和你说话'));
  assert.equal(h.runCalls.length, 1);
});

test('pipeline 绑定：并发两条消息不会同时读到空绑定，只建一个会话', async () => {
  const seen = [];
  const h = makeHarness({
    runDshImpl: async ({ sessionId }) => {
      seen.push(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, text: 'ok', sessionId: sessionId ?? 'session-first' };
    },
  });

  await Promise.all([h.pipeline.handleEvent(eventOf('第一句')), h.pipeline.handleEvent(eventOf('第二句'))]);

  assert.deepEqual(seen, [null, 'session-first']);
  assert.equal(h.sessions.map.get(CHAT_KEY), 'session-first');
});

test('pipeline 绑定：result.rebound 只记 warn，不打扰用户', async () => {
  const h = makeHarness({
    initial: { [CHAT_KEY]: 'session-old' },
    runDshResult: { ok: true, text: '答案', sessionId: 'session-fresh', rebound: true },
  });

  await h.pipeline.handleEvent(eventOf('在吗'));

  assert.equal(h.sent[0], '答案');
  assert.doesNotMatch(h.sent[0], /rebound|新会话/i);
  const warn = h.logger.lines.find((line) => line.level === 'warn' && /已换新会话继续/.test(line.message));
  assert.equal(warn.meta.chatKey, CHAT_KEY);
  assert.equal(warn.meta.sessionId, 'session-fresh');
  assert.equal(h.sessions.map.get(CHAT_KEY), 'session-fresh');
});
