import test from 'node:test';
import assert from 'node:assert/strict';
import { formatForQq } from '../src/format.mjs';

const FENCE = "```";

test('format: 标题/加粗/行内代码都变成纯文本', () => {
  const out = formatForQq('## 结论\n\n这是 **重点**，命令是 `npm test`。');
  assert.equal(out, '▍结论\n\n这是 重点，命令是 npm test。');
});

test('format: 列表统一成 ·，代码围栏去掉但保留内容', () => {
  const input = '- 第一\n* 第二\n\n' + FENCE + "js\nconsole.log(1)\n" + FENCE;
  const out = formatForQq(input);
  assert.match(out, /· 第一/);
  assert.match(out, /· 第二/);
  assert.equal(out.includes(FENCE), false);
  assert.match(out, /console\.log\(1\)/);
});

test('format: 表格压成要点，不留竖线', () => {
  const out = formatForQq('| 项 | 值 |\n| --- | --- |\n| 端口 | 3001 |');
  assert.equal(out.includes('|'), false);
  assert.match(out, /· 端口 ｜ 3001/);
});

test('format: 连续空行压缩、行尾空白清掉', () => {
  assert.equal(formatForQq('第一行   \n\n\n\n第二行'), '第一行\n\n第二行');
});

test('format: 空输入返回空串，不抛', () => {
  assert.equal(formatForQq(''), '');
  assert.equal(formatForQq('   \n\n '), '');
  assert.equal(formatForQq(null), '');
});
