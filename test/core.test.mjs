import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { ConfigError, formatConfigSummary, loadConfig, validateConfig } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';
import { attachmentPath, chatKeyOf, ensureDir, sanitizeSegment } from '../src/paths.mjs';
import { createSemaphore, createSerialQueue } from '../src/queue.mjs';
import { createGuard } from '../src/security.mjs';
import { createSessionStore } from '../src/sessions.mjs';
import { createStorage } from '../src/storage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// 沙箱目录优先放仓库内（.test-tmp 已 gitignore），仓库不可写时才退到系统临时目录：
// 受限环境（DSH 沙箱）里子进程只能写系统临时目录，硬写仓库会让整轮测试直接 EPERM。
function pickTmpRoot() {
  const override = process.env.DSH_BRIDGE_TEST_TMP;
  if (override) {
    mkdirSync(override, { recursive: true });
    return override;
  }
  const local = join(repoRoot, '.test-tmp');
  try {
    mkdirSync(local, { recursive: true });
    const probe = join(local, '.probe-' + process.pid);
    writeFileSync(probe, 'x');
    rmSync(probe, { force: true });
    return local;
  } catch {
    const fallback = join(tmpdir(), 'dsh-im-bridge-test-' + process.pid);
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

const tmpRoot = pickTmpRoot();

let seq = 0;
function sandbox(name) {
  seq += 1;
  const dir = join(tmpRoot, name + '-' + process.pid + '-' + seq);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function walkFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function deleteKey(target, key) {
  delete target[key];
  return target;
}

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结论
  }
});

// ---------------------------------------------------------------- A. config

function baseRaw(patch) {
  const p = patch || {};
  return {
    onebot: Object.assign({ wsUrl: 'ws://127.0.0.1:3001' }, p.onebot),
    dsh: Object.assign({ nodePath: process.execPath, binPath: process.execPath }, p.dsh),
    // p.storage 传非对象时原样放进去，用来测“section 类型错误”
    storage: p.storage === undefined
      ? { rootDir: 'D:/bridge-data' }
      : (typeof p.storage === 'object' && p.storage !== null && !Array.isArray(p.storage)
        ? Object.assign({ rootDir: 'D:/bridge-data' }, p.storage)
        : p.storage),
    security: Object.assign({}, p.security),
    log: Object.assign({}, p.log)
  };
}

test('validateConfig: 合法配置全部通过并补齐默认值', () => {
  const result = validateConfig(baseRaw(), { env: {} });
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.deepEqual(result.problems, []);
  assert.equal(result.config.dsh.profile, 'im-bridge');
  assert.equal(result.config.dsh.permissionMode, 'workspace-write');
  assert.equal(result.config.dsh.timeoutMs, 300000);
  assert.equal(result.config.dsh.cwd, join(resolve('D:/bridge-data'), 'workspace'));
  assert.equal(result.config.log.dir, join(resolve('D:/bridge-data'), 'logs'));
  assert.equal(result.config.log.level, 'info');
  assert.equal(result.config.security.maxConcurrentRuns, 2);
  assert.equal(result.config.security.rateLimitPerMinute, 6);
  assert.deepEqual(result.config.security.userWhitelist, []);
  assert.equal(result.config.reply.errorPrefix, '[bridge] ');
  assert.equal(result.config.storage.maxFileBytes, 104857600);
  assert.equal(result.config.storage.retentionDays, 30);
  assert.equal(result.config.asr.command, '');
});

test('validateConfig: 非法配置逐条报出问题且不抛异常', () => {
  const noRoot = baseRaw();
  deleteKey(noRoot.storage, 'rootDir');
  const r1 = validateConfig(noRoot, { env: {} });
  assert.equal(r1.ok, false);
  assert.ok(r1.problems.some((p) => p.indexOf('storage.rootDir 必填') !== -1), r1.problems.join('; '));

  const badMode = validateConfig(baseRaw({ dsh: { permissionMode: 'root' } }), { env: {} });
  assert.equal(badMode.ok, false);
  assert.ok(badMode.problems.some((p) => p.indexOf('dsh.permissionMode') !== -1));

  const badUrl = validateConfig(baseRaw({ onebot: { wsUrl: 'http://127.0.0.1:3001' } }), { env: {} });
  assert.equal(badUrl.ok, false);
  assert.ok(badUrl.problems.some((p) => p.indexOf('onebot.wsUrl') !== -1));

  const badTypes = validateConfig(
    baseRaw({ security: { allowPrivate: 'yes', maxConcurrentRuns: 0, userWhitelist: '123' }, log: { level: 'verbose' } }),
    { env: {} }
  );
  assert.equal(badTypes.ok, false);
  assert.ok(badTypes.problems.some((p) => p.indexOf('security.allowPrivate') !== -1));
  assert.ok(badTypes.problems.some((p) => p.indexOf('security.maxConcurrentRuns') !== -1));
  assert.ok(badTypes.problems.some((p) => p.indexOf('security.userWhitelist') !== -1));
  assert.ok(badTypes.problems.some((p) => p.indexOf('log.level') !== -1));

  const notObject = validateConfig(baseRaw({ storage: 5 }), { env: {} });
  assert.equal(notObject.ok, false);
  assert.ok(notObject.problems.some((p) => p.indexOf('storage 必须是对象') !== -1));

  const noBin = validateConfig(baseRaw({ dsh: { binPath: '' } }), { env: {} });
  assert.equal(noBin.ok, false);
  assert.ok(noBin.problems.some((p) => p.indexOf('dsh.binPath 为空') !== -1));

  const ghostBin = validateConfig(baseRaw({ dsh: { binPath: join(tmpRoot, 'no-such-dsh.mjs') } }), { env: {} });
  assert.equal(ghostBin.ok, false);
  assert.ok(ghostBin.problems.some((p) => p.indexOf('dsh.binPath 指向的文件不存在') !== -1));
});

test('validateConfig: 不就地修改调用方传入的对象', () => {
  const frozen = deepFreeze(baseRaw());
  const result = validateConfig(frozen, { env: {} });
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.deepEqual(Object.keys(frozen).sort(), ['dsh', 'log', 'onebot', 'security', 'storage']);
  assert.deepEqual(Object.keys(frozen.onebot), ['wsUrl']);
  assert.deepEqual(Object.keys(frozen.dsh).sort(), ['binPath', 'nodePath']);
  assert.equal(frozen.dsh.profile, undefined);
  assert.notEqual(result.config, frozen);
});

test('loadConfig: 文件缺失抛 ConfigError，DSH_BRIDGE_CONFIG 可指定路径', () => {
  const dir = sandbox('config-missing');
  const missing = join(dir, 'nope.json');
  assert.throws(
    () => loadConfig({ filePath: missing, env: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.name, 'ConfigError');
      assert.ok(Array.isArray(err.problems));
      assert.ok(err.problems[0].indexOf('配置文件不存在') !== -1);
      return true;
    }
  );

  const file = join(dir, 'bridge.config.json');
  writeFileSync(file, JSON.stringify({ onebot: { wsUrl: 'ws://127.0.0.1:3001' }, storage: { rootDir: 'D:/bridge-data' } }), 'utf8');
  const loaded = loadConfig({ env: { DSH_BRIDGE_CONFIG: file, DSH_BIN: process.execPath } });
  assert.equal(loaded.filePath, file);
  assert.equal(loaded.config.dsh.binPath, process.execPath);
  assert.deepEqual(loaded.warnings, []);
});

test('loadConfig: 容忍 JSONC 注释与尾逗号，且 ws:// 不被当成注释', () => {
  const dir = sandbox('config-jsonc');
  const file = join(dir, 'bridge.config.json');
  const text = [
    '{',
    '  // 单行注释里的 ws://127.0.0.1 不能被剥掉',
    '  "onebot": {',
    '    "wsUrl": "ws://127.0.0.1:3001", /* 块注释 */',
    '    "accessToken": "a//b",',
    '  },',
    '  "storage": { "rootDir": "D:/bridge-data", },',
    '}'
  ].join('\n');
  writeFileSync(file, text, 'utf8');
  const loaded = loadConfig({ filePath: file, env: { DSH_BIN: process.execPath } });
  assert.equal(loaded.config.onebot.wsUrl, 'ws://127.0.0.1:3001');
  assert.equal(loaded.config.onebot.accessToken, 'a//b');
  assert.equal(loaded.config.storage.rootDir, resolve('D:/bridge-data'));
});

test('loadConfig: 非法 JSON 抛 ConfigError 并带上原因', () => {
  const dir = sandbox('config-badjson');
  const file = join(dir, 'bridge.config.json');
  writeFileSync(file, '{ "onebot": ', 'utf8');
  assert.throws(
    () => loadConfig({ filePath: file, env: {} }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.problems[0].indexOf('不是合法 JSON') !== -1);
      return true;
    }
  );
});

test('loadConfig: rootDir 落在 C 盘时追加中文告警', () => {
  const dir = sandbox('config-cdrive');
  const file = join(dir, 'bridge.config.json');
  writeFileSync(
    file,
    JSON.stringify({ onebot: { wsUrl: 'ws://127.0.0.1:3001' }, storage: { rootDir: 'C:\\bridge-data' } }),
    'utf8'
  );
  const loaded = loadConfig({ filePath: file, env: { DSH_BIN: process.execPath } });
  assert.ok(loaded.warnings.length >= 1, loaded.warnings.join('; '));
  assert.ok(loaded.warnings.some((w) => w.indexOf('C 盘') !== -1), loaded.warnings.join('; '));
  assert.ok(loaded.warnings.some((w) => w.indexOf('产线数据不进 C 盘') !== -1), loaded.warnings.join('; '));
});

test('formatConfigSummary: 含生效路径、白名单数量与并发数', () => {
  const { config } = validateConfig(baseRaw({ security: { userWhitelist: ['1', '2'], groupWhitelist: ['9'] } }), { env: {} });
  const text = formatConfigSummary(config);
  assert.ok(text.indexOf('配置摘要') !== -1);
  assert.ok(text.indexOf(config.storage.rootDir) !== -1);
  assert.ok(text.indexOf(config.dsh.cwd) !== -1);
  assert.ok(text.indexOf('用户 2 个') !== -1);
  assert.ok(text.indexOf('群 1 个') !== -1);
  assert.ok(text.indexOf('最大并发 2') !== -1);
  assert.ok(text.split('\n').length >= 8);
});

test('bridge.config.example.json 可直接加载并通过校验', () => {
  const loaded = loadConfig({ filePath: join(repoRoot, 'bridge.config.example.json'), env: { DSH_BIN: process.execPath } });
  assert.equal(loaded.config.dsh.profile, 'im-bridge');
  assert.equal(loaded.config.onebot.wsUrl, 'ws://127.0.0.1:3001');
  assert.equal(loaded.config.storage.rootDir, 'E:\\dsh-im-bridge-data');
  assert.equal(loaded.config.log.dir, join('E:\\dsh-im-bridge-data', 'logs'));
  assert.deepEqual(loaded.warnings, []);
  const checked = validateConfig(loaded.config, { env: { DSH_BIN: process.execPath } });
  assert.equal(checked.ok, true, checked.problems.join('; '));
});

// ----------------------------------------------------------------- C. paths

test('sanitizeSegment: 路径穿越与非法字符', () => {
  const cases = ['../../etc/passwd', '..\\..\\windows\\system32', 'a:b*c?d"e<f>g|h', 'x\u0000y\u001fz\u007f', '   ', '...', ' .hidden. '];
  for (const input of cases) {
    const safe = sanitizeSegment(input);
    assert.equal(typeof safe, 'string');
    assert.ok(safe.indexOf('..') === -1, '不能残留 .. : ' + input + ' -> ' + safe);
    assert.ok(!/[/\\:*?"<>|\u0000-\u001f\u007f]/.test(safe), '不能残留非法字符 : ' + input + ' -> ' + safe);
    assert.ok(!safe.startsWith('.') && !safe.startsWith(' ') && !safe.endsWith('.') && !safe.endsWith(' '), '首尾点/空格 : ' + safe);
    assert.notEqual(safe.length, 0);
  }
  assert.equal(sanitizeSegment('../../etc/passwd'), 'etcpasswd');
  assert.equal(sanitizeSegment('a:b*c?d"e<f>g|h'), 'abcdefgh');
  assert.equal(sanitizeSegment('   '), '_unknown_');
  assert.equal(sanitizeSegment('...'), '_unknown_');
  assert.equal(sanitizeSegment(' .hidden. '), 'hidden');
  assert.equal(sanitizeSegment(undefined), '_unknown_');
  assert.equal(sanitizeSegment(null), '_unknown_');
  assert.equal(sanitizeSegment(''), '_unknown_');
});

test('sanitizeSegment: 非 ASCII 保留并按字节安全截断', () => {
  const long = '中文名字'.repeat(20);
  const safe = sanitizeSegment(long, { maxLength: 30 });
  assert.ok(Buffer.byteLength(safe, 'utf8') <= 30, '字节长度应 <= 30，实际 ' + Buffer.byteLength(safe, 'utf8'));
  assert.ok(safe.indexOf('\uFFFD') === -1, '不能截出半个字符');
  assert.equal(safe, '中文名字'.repeat(2) + '中文');
  assert.equal(sanitizeSegment('a'.repeat(200), { maxLength: 10 }), 'a'.repeat(10));
  assert.equal(sanitizeSegment('中文名', { maxLength: 64 }), '中文名');
});

test('chatKeyOf: 私聊与群聊前缀', () => {
  assert.equal(chatKeyOf({ chatType: 'private', userId: '12345' }), 'private_12345');
  assert.equal(chatKeyOf({ chatType: 'group', groupId: '998877', userId: '12345' }), 'group_998877');
  assert.equal(chatKeyOf({ chatType: 'private', userId: '../evil' }), 'private_evil');
  assert.equal(chatKeyOf({ chatType: 'private' }), 'private_unknown');
  assert.equal(chatKeyOf({}), 'private_unknown');
});

test('attachmentPath: 日期与 chatKey 布局', () => {
  const ts = new Date(2024, 0, 2, 3, 4, 5).getTime();
  const chat = { chatType: 'group', groupId: '998877', userId: '12345' };
  const p = attachmentPath({ rootDir: 'D:/data', chat, kind: 'image', filename: 'a b?.png', ts });
  assert.equal(p, join('D:/data', 'media', '2024-01-02', 'group_998877', ts + '-image-a b.png'));
  const segs = p.split(/[\\/]/);
  assert.equal(segs[segs.length - 4], 'media');
  assert.equal(segs[segs.length - 3], '2024-01-02');
  assert.equal(segs[segs.length - 2], 'group_998877');

  const priv = attachmentPath({ rootDir: 'D:/data', chat: { chatType: 'private', userId: 42 }, kind: 'file', filename: '报告.pdf', ts });
  assert.equal(priv, join('D:/data', 'media', '2024-01-02', 'private_42', ts + '-file-报告.pdf'));

  const noExt = attachmentPath({ rootDir: 'D:/data', chat: { chatType: 'private', userId: 1 }, kind: 'record', filename: 'voice', ts });
  assert.equal(noExt, join('D:/data', 'media', '2024-01-02', 'private_1', ts + '-record-voice.bin'));

  const viaExtArg = attachmentPath({ rootDir: 'D:/data', chat: { chatType: 'private', userId: 1 }, kind: 'record', filename: 'voice', ext: '.AMR', ts });
  assert.ok(viaExtArg.endsWith(ts + '-record-voice.amr'), viaExtArg);

  const weirdKind = attachmentPath({ rootDir: 'D:/data', chat: { chatType: 'private', userId: 1 }, kind: 'video', filename: 'v.mp4', ts });
  assert.ok(weirdKind.indexOf('-other-') !== -1, weirdKind);

  const traverse = attachmentPath({ rootDir: 'D:/data', chat: { chatType: 'private', userId: '../..' }, kind: 'image', filename: '../../evil.png', ts });
  assert.ok(traverse.indexOf('..') === -1, traverse);
});

test('ensureDir: 递归创建且幂等', async () => {
  const base = sandbox('ensure-dir');
  const target = join(base, 'a', 'b', 'c');
  await ensureDir(target);
  assert.equal(existsSync(target), true);
  await ensureDir(target);
  assert.equal(existsSync(target), true);
});

// --------------------------------------------------------------- E. security

function guardConfig(over) {
  return {
    security: Object.assign(
      {
        userWhitelist: [],
        groupWhitelist: [],
        allowPrivate: true,
        allowGroup: true,
        groupRequireAt: true,
        rateLimitPerMinute: 0,
        maxConcurrentRuns: 2,
        maxPromptChars: 8000
      },
      over
    )
  };
}

function privateMsg(over) {
  return Object.assign(
    { chatType: 'private', userId: '1001', groupId: null, selfId: '9000', atTargets: [], segments: [], text: 'hi' },
    over
  );
}

function groupMsg(over) {
  return Object.assign(
    { chatType: 'group', userId: '1001', groupId: '5555', selfId: '9000', atTargets: ['9000'], segments: [], text: 'hi' },
    over
  );
}

test('guard: 六种拒绝原因 + 放行', () => {
  const now = 1000000;

  const noPrivate = createGuard({ config: guardConfig({ allowPrivate: false }) });
  assert.deepEqual(noPrivate.decide(privateMsg(), now), { allow: false, reason: 'chat_type_disabled' });

  const noGroup = createGuard({ config: guardConfig({ allowGroup: false }) });
  assert.deepEqual(noGroup.decide(groupMsg(), now), { allow: false, reason: 'chat_type_disabled' });

  const userFiltered = createGuard({ config: guardConfig({ userWhitelist: ['2002'] }) });
  assert.deepEqual(userFiltered.decide(privateMsg(), now), { allow: false, reason: 'user_not_allowed' });
  assert.deepEqual(userFiltered.decide(privateMsg({ userId: '2002' }), now), { allow: true, reason: 'ok' });

  const groupFiltered = createGuard({ config: guardConfig({ groupWhitelist: ['7777'] }) });
  assert.deepEqual(groupFiltered.decide(groupMsg(), now), { allow: false, reason: 'group_not_allowed' });
  assert.deepEqual(groupFiltered.decide(groupMsg({ groupId: '7777' }), now), { allow: true, reason: 'ok' });

  const needAt = createGuard({ config: guardConfig() });
  assert.deepEqual(needAt.decide(groupMsg({ atTargets: [] }), now), { allow: false, reason: 'need_at' });
  assert.deepEqual(needAt.decide(groupMsg({ atTargets: ['all'] }), now), { allow: true, reason: 'ok' });
  assert.deepEqual(needAt.decide(groupMsg({ atTargets: ['123'] }), now), { allow: false, reason: 'need_at' });
  assert.deepEqual(needAt.decide(privateMsg({ atTargets: [] }), now), { allow: true, reason: 'ok' });

  const limited = createGuard({ config: guardConfig({ rateLimitPerMinute: 2 }) });
  assert.equal(limited.decide(privateMsg(), now).allow, true);
  assert.equal(limited.decide(privateMsg(), now + 10).allow, true);
  assert.deepEqual(limited.decide(privateMsg(), now + 20), { allow: false, reason: 'rate_limited' });
  // 滑窗外的计数要淘汰，否则机器人会被一次性刷爆后永久静音
  assert.equal(limited.decide(privateMsg(), now + 60001).allow, true);
});

test('guard: 判定顺序固定（群白名单先于 need_at）', () => {
  const guard = createGuard({ config: guardConfig({ groupWhitelist: ['7777'] }) });
  const both = groupMsg({ groupId: '5555', atTargets: [] });
  assert.equal(guard.decide(both).reason, 'group_not_allowed');
});

test('guard: 群聊 userWhitelist 为空时只按群白名单', () => {
  const guard = createGuard({ config: guardConfig({ groupWhitelist: ['5555'] }) });
  assert.deepEqual(guard.decide(groupMsg({ userId: '4321' })), { allow: true, reason: 'ok' });
  const strict = createGuard({ config: guardConfig({ groupWhitelist: ['5555'], userWhitelist: ['1001'] }) });
  assert.deepEqual(strict.decide(groupMsg({ userId: '4321' })), { allow: false, reason: 'user_not_allowed' });
});

// ----------------------------------------------------------------- F. queue

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('serialQueue: 同 key 串行（计数器证明顺序）', async () => {
  const queue = createSerialQueue();
  const trace = [];
  let running = 0;
  let peak = 0;

  const task = (id, ms) => () => {
    running += 1;
    peak = Math.max(peak, running);
    trace.push('start-' + id);
    return sleep(ms).then(() => {
      trace.push('end-' + id);
      running -= 1;
      return id;
    });
  };

  const all = Promise.all([queue.run('chat', task(1, 20)), queue.run('chat', task(2, 1)), queue.run('chat', task(3, 5))]);
  assert.equal(queue.pending('chat'), 3);
  assert.equal(queue.size(), 3);
  const ids = await all;
  assert.deepEqual(ids, [1, 2, 3]);
  assert.deepEqual(trace, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  assert.equal(peak, 1);
  assert.equal(queue.pending('chat'), 0);
  assert.equal(queue.size(), 0);
});

test('serialQueue: 不同 key 并行', async () => {
  const queue = createSerialQueue();
  let running = 0;
  let peak = 0;
  const task = () => async () => {
    running += 1;
    peak = Math.max(peak, running);
    await sleep(10);
    running -= 1;
  };
  await Promise.all([queue.run('a', task()), queue.run('b', task()), queue.run('c', task())]);
  assert.equal(peak, 3);
});

test('serialQueue: 前一个任务失败不阻塞同 key 后续任务', async () => {
  const queue = createSerialQueue();
  await assert.rejects(queue.run('k', async () => {
    throw new Error('boom');
  }), /boom/);
  const value = await queue.run('k', async () => 'next');
  assert.equal(value, 'next');
  assert.equal(queue.pending('k'), 0);
});

test('semaphore: 并发额度受限且异常后归还许可', async () => {
  const sem = createSemaphore(2);
  let running = 0;
  let peak = 0;
  const tasks = [];
  for (let i = 0; i < 5; i += 1) {
    tasks.push(
      sem.withPermit(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(5);
        running -= 1;
        return i;
      })
    );
  }
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.equal(sem.active(), 0);

  await assert.rejects(sem.withPermit(async () => {
    assert.equal(sem.active(), 1);
    throw new Error('permit-boom');
  }), /permit-boom/);
  assert.equal(sem.active(), 0);
});

// -------------------------------------------------------------- G. sessions

test('sessions: 原子写、可读回、无 .tmp 残留', async () => {
  const dir = sandbox('sessions');
  const file = join(dir, 'sessions.json');
  const warns = [];
  const store = createSessionStore({ file, logger: { warn: (m) => warns.push(m), error: (m) => warns.push(m) } });

  assert.equal(store.get('private_1'), undefined);
  await store.set('private_1', 'sess-aaa');
  assert.equal(store.get('private_1'), 'sess-aaa');
  assert.ok(existsSync(file));

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(raw, { private_1: 'sess-aaa' });
  // 原子写：目录里不该留下半成品 tmp
  const leftovers = readdirSync(dir).filter((name) => name.indexOf('.tmp') !== -1);
  assert.deepEqual(leftovers, []);

  await Promise.all([store.set('private_2', 'sess-bbb'), store.set('group_9', 'sess-ccc')]);
  assert.deepEqual(Object.keys(store.all()).sort(), ['group_9', 'private_1', 'private_2']);
  const reloaded = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(reloaded, { private_1: 'sess-aaa', private_2: 'sess-bbb', group_9: 'sess-ccc' });

  await store.clear('private_2');
  assert.equal(store.get('private_2'), undefined);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).private_2, undefined);
  assert.deepEqual(warns, []);
});

test('sessions: 损坏的 JSON 不抛，备份为 .corrupt 后从空开始', async () => {
  const dir = sandbox('sessions-corrupt');
  const file = join(dir, 'sessions.json');
  writeFileSync(file, '{ this is not json', 'utf8');
  const warns = [];
  const store = createSessionStore({ file, logger: { warn: (m) => warns.push(m), error: (m) => warns.push(m) } });

  assert.equal(store.get('private_1'), undefined);
  assert.deepEqual(store.all(), {});
  assert.ok(existsSync(file + '.corrupt'));
  assert.equal(readFileSync(file + '.corrupt', 'utf8'), '{ this is not json');
  assert.equal(warns.length, 1);

  await store.set('private_1', 'sess-new');
  assert.equal(store.get('private_1'), 'sess-new');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { private_1: 'sess-new' });
});

test('sessions: 非对象根节点与空文件都按空表处理', async () => {
  const dir = sandbox('sessions-shape');
  const file = join(dir, 'sessions.json');
  writeFileSync(file, '[]', 'utf8');
  const store = createSessionStore({ file });
  assert.deepEqual(store.all(), {});
  assert.ok(existsSync(file + '.corrupt'));

  writeFileSync(file, '   ', 'utf8');
  const store2 = createSessionStore({ file });
  assert.deepEqual(store2.all(), {});
});

// --------------------------------------------------------------- D. storage

function chatPrivate(userId) {
  return { chatType: 'private', userId: userId || '1001', groupId: null };
}

test('storage: saveBuffer 落盘布局、字节数与 sha256', async () => {
  const dir = sandbox('storage-save');
  const storage = createStorage({ config: { storage: { rootDir: dir, maxFileBytes: 1024, retentionDays: 30 } } });
  const buf = Buffer.from('hello 附件', 'utf8');
  const saved = await storage.saveBuffer(buf, { chat: chatPrivate('1001'), kind: 'file', filename: '../../evil.txt' });
  assert.equal(saved.bytes, buf.length);
  assert.equal(saved.sha256, createHash('sha256').update(buf).digest('hex'));
  assert.ok(existsSync(saved.path));
  assert.ok(saved.path.indexOf('..') === -1, saved.path);
  const parts = saved.path.split(/[\\/]/);
  assert.equal(parts[parts.length - 2], 'private_1001');
  assert.equal(parts[parts.length - 3].length, 10, 'media 下应为 YYYY-MM-DD');
  assert.equal(parts[parts.length - 4], 'media');
  assert.ok(readFileSync(saved.path).equals(buf));
  assert.equal(storage.resolveExisting(saved.path), saved.path);
  assert.equal(storage.resolveExisting(join(dir, 'nope.bin')), null);
});

test('storage: 超过 maxFileBytes 抛 StorageError(FILE_TOO_LARGE)', async () => {
  const dir = sandbox('storage-large');
  const storage = createStorage({ config: { storage: { rootDir: dir, maxFileBytes: 4, retentionDays: 30 } } });
  await assert.rejects(
    () => storage.saveBuffer(Buffer.from('12345'), { chat: chatPrivate(), kind: 'file', filename: 'big.txt' }),
    (err) => {
      assert.equal(err.name, 'StorageError');
      assert.equal(err.code, 'FILE_TOO_LARGE');
      return true;
    }
  );
  assert.deepEqual(walkFiles(dir).filter((p) => p.indexOf('.part') !== -1), []);
});

async function withFakeFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('storage: saveFromUrl 用全局 fetch 下载并计数', async () => {
  const dir = sandbox('storage-url');
  const storage = createStorage({ config: { storage: { rootDir: dir, maxFileBytes: 1024, retentionDays: 30 } } });
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const saved = await withFakeFetch(async () => new Response(payload), () =>
    storage.saveFromUrl('http://127.0.0.1:9/media/pic.png', { chat: chatPrivate('7'), kind: 'image' })
  );
  assert.equal(saved.bytes, 5);
  assert.equal(saved.sha256, createHash('sha256').update(Buffer.from(payload)).digest('hex'));
  assert.ok(saved.path.endsWith('.png'), saved.path);
  assert.ok(existsSync(saved.path));
});

test('storage: saveFromUrl 超限时中止并删除半成品', async () => {
  const dir = sandbox('storage-url-large');
  const storage = createStorage({ config: { storage: { rootDir: dir, maxFileBytes: 4, retentionDays: 30 } } });
  await assert.rejects(
    () =>
      withFakeFetch(async () => new Response(new Uint8Array(64)), () =>
        storage.saveFromUrl('http://127.0.0.1:9/media/big.bin', { chat: chatPrivate('7'), kind: 'file' })
      ),
    (err) => {
      assert.equal(err.code, 'FILE_TOO_LARGE');
      return true;
    }
  );
  assert.deepEqual(walkFiles(dir).filter((p) => p.indexOf('.part') !== -1), []);
});

test('storage: sweepRetention 只删 media 下的过期日期目录', async () => {
  const dir = sandbox('storage-sweep');
  mkdirSync(join(dir, 'media', '2000-01-01', 'private_1'), { recursive: true });
  writeFileSync(join(dir, 'media', '2000-01-01', 'private_1', 'a.bin'), 'old!!', 'utf8');
  mkdirSync(join(dir, 'media', '2000-01-02', 'group_2'), { recursive: true });
  writeFileSync(join(dir, 'media', '2000-01-02', 'group_2', 'b.bin'), 'old', 'utf8');
  const today = new Date();
  const todayName =
    today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  mkdirSync(join(dir, 'media', todayName, 'private_1'), { recursive: true });
  writeFileSync(join(dir, 'media', todayName, 'private_1', 'fresh.bin'), 'new', 'utf8');
  mkdirSync(join(dir, 'media', 'not-a-date'), { recursive: true });
  writeFileSync(join(dir, 'media', 'not-a-date', 'keep.bin'), 'keep', 'utf8');
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  writeFileSync(join(dir, 'workspace', 'keep.txt'), 'workspace', 'utf8');
  writeFileSync(join(dir, 'sessions.json'), '{}', 'utf8');
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', 'bridge-2024-01-01.log'), 'log', 'utf8');

  const storage = createStorage({ config: { storage: { rootDir: dir, maxFileBytes: 1024, retentionDays: 30 } } });
  const result = await storage.sweepRetention(Date.now());
  assert.equal(result.deleted, 2);
  assert.equal(result.bytes, 8);
  assert.equal(existsSync(join(dir, 'media', '2000-01-01')), false);
  assert.equal(existsSync(join(dir, 'media', '2000-01-02')), false);
  assert.equal(existsSync(join(dir, 'media', todayName, 'private_1', 'fresh.bin')), true);
  assert.equal(existsSync(join(dir, 'media', 'not-a-date', 'keep.bin')), true);
  assert.equal(existsSync(join(dir, 'workspace', 'keep.txt')), true);
  assert.equal(existsSync(join(dir, 'sessions.json')), true);
  assert.equal(existsSync(join(dir, 'logs', 'bridge-2024-01-01.log')), true);
});

test('storage: 数据目录与 workspace 会被自动创建', async () => {
  const dir = join(sandbox('storage-mkdir'), 'nested', 'root');
  const storage = createStorage({ config: { storage: { rootDir: dir } } });
  await storage.saveBuffer(Buffer.from('x'), { chat: chatPrivate(), kind: 'text', filename: 'a.txt' });
  assert.equal(existsSync(dir), true);
  assert.equal(existsSync(join(dir, 'workspace')), true);
  assert.equal(storage.workspaceDir, join(dir, 'workspace'));
});

// ------------------------------------------------------------------- B. log

function captureStderr(fn) {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

test('log: JSONL 写盘 + stderr 人读行 + child scope', async () => {
  const dir = sandbox('log');
  const logger = createLogger({ dir, level: 'debug' });
  const lines = captureStderr(() => {
    logger.info('启动');
    logger.child('onebot').warn('掉线', { attempts: 3 });
    logger.error('炸了', new Error('boom'));
    logger.debug('细节');
  });
  await logger.flush();

  assert.equal(lines.length, 4);
  assert.ok(lines[0].indexOf('INFO') !== -1);
  assert.ok(lines[1].indexOf('[onebot]') !== -1);
  assert.ok(logger.filePath.endsWith('.log'));
  const text = readFileSync(logger.filePath, 'utf8').trim().split('\n');
  assert.equal(text.length, 4);
  const records = text.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((r) => r.level), ['info', 'warn', 'error', 'debug']);
  assert.equal(records[0].msg, '启动');
  assert.equal(records[1].scope, 'onebot');
  assert.deepEqual(records[1].data, { attempts: 3 });
  assert.equal(records[2].data.error, 'boom');
});

test('log: 级别过滤与写盘失败降级不抛', async () => {
  const dir = sandbox('log-level');
  const quiet = createLogger({ dir, level: 'warn' });
  captureStderr(() => {
    quiet.info('不该出现');
    quiet.warn('该出现');
  });
  await quiet.flush();
  const text = readFileSync(quiet.filePath, 'utf8').trim().split('\n');
  assert.equal(text.length, 1);
  assert.equal(JSON.parse(text[0]).level, 'warn');

  const brokenDir = join(sandbox('log-broken'), 'file-not-dir');
  writeFileSync(brokenDir, 'x', 'utf8');
  const broken = createLogger({ dir: brokenDir, level: 'info' });
  const lines = captureStderr(() => {
    broken.info('父路径是文件，写不进去');
  });
  await broken.flush();
  await broken.flush();
  assert.equal(lines.length >= 1, true);
  assert.ok(lines.some((line) => line.indexOf('父路径是文件，写不进去') !== -1));

  const noDir = createLogger({ dir: '', level: 'info' });
  const noDirLines = captureStderr(() => noDir.info('只写 stderr'));
  await noDir.flush();
  assert.equal(noDir.filePath, '');
  assert.ok(noDirLines.some((line) => line.indexOf('只写 stderr') !== -1));
});
