import test from 'node:test';
import assert from 'node:assert/strict';
import { sendQqReply, buildTextBody } from '../src/qqbot/send.mjs';

function fakeClient() {
  const calls = [];
  return {
    calls,
    async sendMessage({ body }) {
      calls.push(body);
      if (calls.length === 2) { const e = new Error('消息被去重'); e.code = 40054005; throw e; }
    },
  };
}

test('同一 msg_id 的连续回复：msg_seq 递增，不会被判去重', async () => {
  const client = fakeClient();
  const message = { chatType: 'private', userId: 'u1', messageId: 'MID-1' };
  const config = { reply: { maxChunkChars: 100 }, qqbot: {} };
  await sendQqReply({ client, message, text: '第一条', config });
  await sendQqReply({ client, message, text: '第二条', config });
  assert.deepEqual(client.calls.map((c) => c.msg_seq).slice(0, 2), [1, 2]);
});

test('被动回复被"去重"拒绝时，自动改写主动消息送达', async () => {
  const client = fakeClient();
  const message = { chatType: 'private', userId: 'u1', messageId: 'MID-2' };
  const config = { reply: { maxChunkChars: 100 }, qqbot: {} };
  await sendQqReply({ client, message, text: '第一次', config });
  const result = await sendQqReply({ client, message, text: '第二次', config });
  assert.equal(result.sent, 1);
  assert.equal(client.calls[client.calls.length - 1].msg_id, undefined);
});
