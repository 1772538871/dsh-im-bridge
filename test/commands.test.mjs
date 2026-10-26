import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  buildHistoryMarkdown,
  commandExportDoneText,
  commandExportFailedText,
  commandHelpText,
  commandNewSessionText,
  commandStatusText,
  decodeSessionLog,
  decodeZstdFrames,
  encodeCwdSegment,
  exportSessionMarkdown,
  parseCommand,
  shortSessionId,
} from '../src/commands.mjs';

const HEADER = { type: 'session', version: 4, id: 'session-1', cwd: 'E:\\dsh\\proj' };
const USER_LINE = {
  type: 'user/message',
  time: 1,
  data: { content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } },
};
const ASSISTANT_LINE = {
  type: 'assistant/message',
  time: 2,
  data: { message: { content: [{ type: 'reasoning', text: '想想' }, { type: 'text', text: '答案' }] } },
};

function jsonl(events) {
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

/** 每个 append 一帧：真机文件就是多帧 zstd，不是一整块。 */
function multiFrame(textParts) {
  return Buffer.concat(textParts.map((part) => zstdCompressSync(Buffer.from(part, 'utf8'))));
}

function sampleLog() {
  return {
    header: JSON.stringify(HEADER) + '\n',
    turn1: jsonl([USER_LINE, { type: 'tool/call', data: { name: 'read' } }]),
    turn2: jsonl([ASSISTANT_LINE, { type: 'turn/end', data: { reason: { kind: 'completed' } } }]),
  };
}

test('commands：认 /new /status /export /help 与四个中文同义词', () => {
  assert.deepEqual(parseCommand('/new'), { name: 'new', args: '' });
  assert.deepEqual(parseCommand('  /status  '), { name: 'status', args: '' });
  assert.deepEqual(parseCommand('/export'), { name: 'export', args: '' });
  assert.deepEqual(parseCommand('/help'), { name: 'help', args: '' });
  assert.deepEqual(parseCommand('/新会话'), { name: 'new', args: '' });
  assert.deepEqual(parseCommand('/状态'), { name: 'status', args: '' });
  assert.deepEqual(parseCommand('/导出'), { name: 'export', args: '' });
  assert.deepEqual(parseCommand('/帮助'), { name: 'help', args: '' });
});

test('commands：大小写、全角斜杠、带参数都能认', () => {
  assert.deepEqual(parseCommand('/HELP'), { name: 'help', args: '' });
  assert.deepEqual(parseCommand('／状态'), { name: 'status', args: '' });
  assert.deepEqual(parseCommand('/export 全部'), { name: 'export', args: '全部' });
});

test('commands：不是命令就返回 null，绝不抢普通消息', () => {
  assert.equal(parseCommand('帮我看看这个报错'), null);
  assert.equal(parseCommand('/'), null);
  assert.equal(parseCommand('//'), null);
  assert.equal(parseCommand('/unknown'), null);
  assert.equal(parseCommand('我 /new 你说呢'), null);
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand(123), null);
});

test('commands：/help 不超过 4 行、四个命令都在、带会话简称', () => {
  const text = commandHelpText({ sessionId: 'session-4088cad7-1111-2222-3333-444455556666' });
  const lines = text.split('\n');
  assert.ok(lines.length <= 4, text);
  for (const keyword of ['/new', '/status', '/export', '/help', '/新会话', '/状态', '/导出', '/帮助']) {
    assert.ok(text.includes(keyword), '缺少 ' + keyword);
  }
  assert.ok(text.includes('4088cad7'), text);
});

test('commands：/status 报平台、跑法、会话前 8 位、上一轮耗时；没有挂起就不出现那一行', () => {
  const base = {
    platform: 'qq-napcat',
    runner: 'inprocess',
    sessionId: 'session-abcdefgh-9999-8888',
    lastDurationMs: 2500,
  };
  const idle = commandStatusText(base);
  assert.match(idle, /平台 qq-napcat/);
  assert.match(idle, /跑法 inprocess/);
  assert.match(idle, /会话 abcdefgh/);
  assert.match(idle, /最近一轮 2\.5 秒/);
  assert.doesNotMatch(idle, /正在等/);

  const busy = commandStatusText({ ...base, approvalPending: 1, questionPending: 2 });
  assert.match(busy, /正在等：审批 1 个 · 提问 2 个/);
});

test('commands：/status 在没会话、没跑过时也说人话', () => {
  const text = commandStatusText({ platform: 'qq-official', runner: 'headless', sessionId: null, lastDurationMs: null });
  assert.match(text, /还没建/);
  assert.match(text, /还没跑过/);
});

test('commands：会话简称去掉 session- 前缀', () => {
  assert.equal(shortSessionId('session-abcdef12-rest'), 'abcdef12');
  assert.equal(shortSessionId('abcdef12'), 'abcdef12');
  assert.equal(shortSessionId(''), '');
  assert.equal(shortSessionId(null), '');
});

test('commands：/new 的文案明确说"下一条消息开始生效"', () => {
  const text = commandNewSessionText('session-aaaaaaaa-1111');
  assert.match(text, /已开新会话/);
  assert.match(text, /下一条消息开始生效/);
  assert.match(text, /aaaaaaaa/);
  assert.match(commandNewSessionText(null), /已开新会话/);
});

test('commands：导出文案带条数与绝对路径，失败给人话', () => {
  const done = commandExportDoneText({ path: 'E:\\data\\history\\session-1-20260101-120000.md', count: 7 });
  assert.match(done, /7 条消息/);
  assert.match(done, /E:\\data\\history\\session-1-20260101-120000\.md/);
  const failed = commandExportFailedText('找不到这个会话的日志文件');
  assert.match(failed, /这次没导出成/);
  assert.match(failed, /找不到这个会话的日志文件/);
});

test('commands：cwd 编码与真实 DSH 目录名一致（三条实测样本）', () => {
  assert.equal(encodeCwdSegment('E:\\dsh\\dsh-bot-msg'), '--E-dsh-dsh-bot-msg--');
  assert.equal(encodeCwdSegment('C:\\'), '--C---');
  assert.equal(encodeCwdSegment('E:\\每日信息合集'), '--E-~6BCF~65E5~4FE1~606F~5408~96C6--');
  assert.equal(encodeCwdSegment('E:\\ai_test\\01_文案'), '--E-ai_test-01_~6587~6848--');
});

test('commands：/export 能解多帧 zstd，只取 user/assistant 的文字块', () => {
  const { header, turn1, turn2 } = sampleLog();
  const frames = multiFrame([header, turn1, turn2]);

  assert.equal(decodeZstdFrames(frames).toString('utf8'), header + turn1 + turn2);

  const parsed = decodeSessionLog(frames);
  assert.equal(parsed.meta.cwd, 'E:\\dsh\\proj');
  assert.deepEqual(parsed.messages.map((item) => item.role), ['user', 'assistant']);
  assert.deepEqual(parsed.messages.map((item) => item.text), ['第一句', '答案']);
  assert.equal(parsed.messages[1].at, 2);
});

test('commands：末尾半截帧（崩在写一半）不影响已解出的部分', () => {
  const { header, turn1 } = sampleLog();
  const tail = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02]);
  const parsed = decodeSessionLog(Buffer.concat([multiFrame([header, turn1]), tail]));
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].text, '第一句');
});

test('commands：根本不是 zstd 的文件报得出来', () => {
  assert.throws(() => decodeZstdFrames(Buffer.from('这不是 zstd')), /zstd/);
});

test('commands：markdown 结构（标题 + 元信息 + 角色分节 + 条数）', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
  const markdown = buildHistoryMarkdown({
    sessionId: 'session-1',
    cwd: 'E:\\dsh\\proj',
    messages: [
      { role: 'user', text: '问' },
      { role: 'assistant', text: '答' },
    ],
    now: at,
  });
  const lines = markdown.split('\n');
  assert.equal(lines[0], '# DSH 会话导出');
  assert.match(markdown, /- 会话：session-1/);
  assert.match(markdown, /- 工作目录：E:\\dsh\\proj/);
  assert.match(markdown, /- 导出时间：2026-01-02 03:04:05/);
  assert.match(markdown, /- 消息条数：2/);
  assert.match(markdown, /## 用户\n\n问/);
  assert.match(markdown, /## DSH\n\n答/);
});

test('commands：exportSessionMarkdown 落到 history/<id>-<yyyyMMdd-HHmmss>.md', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-export-'));
  const home = path.join(root, 'home');
  const sessionId = 'session-1';
  const logDir = path.join(home, 'sessions', '--E-dsh-proj--', sessionId);
  await mkdir(logDir, { recursive: true });
  const { header, turn1, turn2 } = sampleLog();
  await writeFile(path.join(logDir, 'session.v4.jsonl.zstd'), multiFrame([header, turn1, turn2]));

  const outDir = path.join(root, 'history');
  const at = new Date(2026, 4, 6, 7, 8, 9).getTime();
  const result = await exportSessionMarkdown({
    dshHome: home,
    cwd: 'E:\\dsh\\proj',
    sessionId,
    outDir,
    now: () => at,
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.path, path.join(outDir, 'session-1-20260506-070809.md'));
  assert.equal(existsSync(result.path), true);

  const markdown = await readFile(result.path, 'utf8');
  assert.match(markdown, /# DSH 会话导出/);
  assert.match(markdown, /## 用户/);
  assert.match(markdown, /## DSH/);
});

test('commands：cwd 编码对不上时扫一遍 sessions 也能找到日志', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-export-scan-'));
  const home = path.join(root, 'home');
  const sessionId = 'session-9';
  const logDir = path.join(home, 'sessions', '--weird-encoding--', sessionId);
  await mkdir(logDir, { recursive: true });
  const { header, turn1 } = sampleLog();
  await writeFile(path.join(logDir, 'session.v4.jsonl.zstd'), multiFrame([header, turn1]));

  const result = await exportSessionMarkdown({
    dshHome: home,
    cwd: 'E:\\completely\\different',
    sessionId,
    outDir: path.join(root, 'history'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
});

test('commands：导出失败一律给人话，不抛', async () => {
  const noSession = await exportSessionMarkdown({ sessionId: '', outDir: 'E:\\data\\history' });
  assert.equal(noSession.ok, false);
  assert.match(noSession.message, /还没开始/);

  const noDir = await exportSessionMarkdown({ sessionId: 'session-1', outDir: '' });
  assert.equal(noDir.ok, false);
  assert.match(noDir.message, /数据目录/);

  const missing = await exportSessionMarkdown({
    dshHome: path.join(os.tmpdir(), 'dsh-export-does-not-exist'),
    cwd: 'E:\\x',
    sessionId: 'session-missing',
    outDir: path.join(os.tmpdir(), 'dsh-export-does-not-exist-history'),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /找不到这个会话的日志文件/);
});
