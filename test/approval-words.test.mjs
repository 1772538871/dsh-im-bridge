import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyApprovalReply } from '../src/approval-bridge.mjs';

test('自然语言的审批回复也能识别', () => {
  for (const word of ['1', '同意', '允许', '确认', '好', '好的', '可以', '是的']) {
    assert.equal(classifyApprovalReply(word), 'allowed-once', word + ' 应该被当成放行');
  }
  for (const word of ['2', '拒绝', '不行', '不要', '不允许']) {
    assert.equal(classifyApprovalReply(word), 'rejected', word + ' 应该被当成拒绝');
  }
  for (const word of ['0', '取消']) {
    assert.equal(classifyApprovalReply(word), 'cancelled', word + ' 应该被当成取消');
  }
  assert.equal(classifyApprovalReply('帮我看看天气'), null, '普通消息不能被误判成审批回复');
});
