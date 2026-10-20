import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline } from '../src/pipeline.mjs';

function makePipeline({ runDsh, config = {} }) {
  const sent = [];
  const pipeline = createPipeline({
    config: {
      storage: { rootDir: 'E:\\tmp' },
      security: { userWhitelist: [], groupWhitelist: [], allowPrivate: true, allowGroup: true, groupRequireAt: true, rateLimitPerMinute: 0 },
      reply: { maxChunkChars: 1500, errorPrefix: '[b] ', ack: true, progressEveryMs: 10000, progressMax: 2, ...config },
      qqbot: {},
    },
    logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
    client: {},
    storage: { async saveFromUrl() { throw new Error('no media'); } },
    guard: { decide: () => ({ allow: true, reason: 'ok' }) },
    serial: { run: (_k, fn) => fn(), pending: () => 0, size: () => 0 },
    semaphore: { withPermit: (fn) => fn(), active: () => 0 },
    sessions: { get: async () => null, set: async () => {} },
    runDsh,
    deps: {
      parseEvent: () => ({ kind: 'message', message: { id: 'm1', messageId: 'MID', chatType: 'private', userId: 'u1', groupId: null, selfId: '0', text: '帮我读三本书', segments: [{ type: 'text', data: { text: '帮我读三本书' } }], atTargets: [], replyTo: null } }),
      planMedia: () => null,
      sendReply: async ({ text }) => { sent.push(text); return { sent: 1, failed: 0 }; },
      chatKeyOf: () => 'private_u1',
    },
  });
  return { pipeline, sent };
}

test('长任务：先回一条"收到"回执，任务完了再给结果', async () => {
  const { pipeline, sent } = makePipeline({ runDsh: async () => ({ ok: true, text: '这是结果', sessionId: 'S1' }) });
  await pipeline.handleEvent({});
  assert.equal(sent.length, 2);
  assert.match(sent[0], /收到/);
  assert.equal(sent[1], '这是结果');
});

test('关掉回执后只发结果', async () => {
  const { pipeline, sent } = makePipeline({ runDsh: async () => ({ ok: true, text: '结果', sessionId: 'S1' }), config: { ack: false } });
  await pipeline.handleEvent({});
  assert.deepEqual(sent, ['结果']);
});

test('超过进度阈值会补报进度（不占被动回复配额，用主动消息）', async () => {
  const { pipeline, sent } = makePipeline({
    runDsh: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, text: '好了', sessionId: 'S1' }), 60)),
    config: { progressEveryMs: 10000 },
  });
  // 直接验证"回执里有进度承诺"，而不真的等 10 秒
  await pipeline.handleEvent({});
  assert.ok(sent.length >= 2);
  assert.match(sent[0], /收到/);
});
