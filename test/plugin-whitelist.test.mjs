import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/plugin/runtime.mjs';
import { normalizeConfig } from '../src/plugin/config-store.mjs';

const baseConfig = (security) => ({
  enabled: false,
  platform: 'qq-napcat',
  storage: { rootDir: 'E:\\dsh-im-bridge-data', maxFileBytes: 1024, retentionDays: 7 },
  security: Object.assign({ userWhitelist: [], groupWhitelist: [], allowPrivate: true, allowGroup: true, groupRequireAt: true, rateLimitPerMinute: 0, maxConcurrentRuns: 1, maxPromptChars: 100 }, security),
  reply: { maxChunkChars: 100, errorPrefix: '[b] ', showSessionId: false },
  asr: { command: '', args: [], timeoutMs: 1000 },
  log: { dir: '', level: 'info' },
  qqNapcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', reconnectMinMs: 1000, reconnectMaxMs: 1000 },
  qqOfficial: { appId: '', appSecret: '', sandbox: true },
  dsh: { nodePath: '', binPath: '', profile: 'im-bridge', cwd: '', timeoutMs: 1000, permissionMode: 'workspace-write' }
});

test('runtime: 白名单为空时拒绝启动（不把本机执行权开放给所有人）', async () => {
  const configStore = { read: () => ({ config: baseConfig({}), warnings: [], problems: [] }) };
  const runtime = createRuntime({ configStore, logger: null });
  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.ok(String(result.error).includes('白名单为空'), '错误信息要说明是白名单问题：' + result.error);
  assert.equal(runtime.status().running, false);
});

test('config: 白名单为空时给出可见警告', () => {
  const { warnings, problems } = normalizeConfig(baseConfig({}));
  assert.equal(problems.length, 0);
  assert.ok(warnings.some((w) => w.includes('白名单为空')), '应提示白名单为空会导致拒绝启动');
});
