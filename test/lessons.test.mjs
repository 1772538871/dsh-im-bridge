import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isTeaching, lessonBody, appendLesson, readLessonsTail } from '../src/lessons.mjs';

test('isTeaching：认出"在教我"的说法', () => {
  for (const text of ['记住：以后别喊我', '教你一下，我说喊锤子你就接喊锤子', '下次这样回：行吧', '这种时候你就说"急啥"', '以后你要先问一句']) {
    assert.equal(isTeaching(text), true, text);
  }
  for (const text of ['帮我看看这个文件', 'ok', '你好', '']) {
    assert.equal(isTeaching(text), false, text);
  }
});

test('lessonBody：去掉开头的指令词，只留要背的内容', () => {
  assert.equal(lessonBody('记住：以后别喊我'), '以后别喊我');
  assert.equal(lessonBody('下次这样回：行吧'), '行吧');
  assert.equal(lessonBody('教你一下，我说喊锤子你就接喊锤子'), '我说喊锤子你就接喊锤子');
});

test('appendLesson + readLessonsTail：写进去能读出来，按时间倒序取最后几条', async () => {
  const dir = join(tmpdir(), 'dsh-lessons-' + Date.now());
  const a = await appendLesson({ dataDir: dir, text: '记住：别喊我', now: Date.now() });
  assert.equal(a.ok, true);
  const b = await appendLesson({ dataDir: dir, text: '下次这样回：行吧', now: Date.now() });
  assert.equal(b.ok, true);
  const tail = readLessonsTail({ dataDir: dir });
  assert.equal(tail.length, 2);
  assert.equal(tail[1].body, '行吧');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('readLessonsTail：没文件/没目录都返回空数组，不抛', () => {
  assert.deepEqual(readLessonsTail({ dataDir: '' }), []);
  assert.deepEqual(readLessonsTail({ dataDir: 'E:\\不存在的目录-xyz' }), []);
});

test('appendLesson：空内容不写文件', async () => {
  const r = await appendLesson({ dataDir: join(tmpdir(), 'x-' + Date.now()), text: '记住：' });
  assert.equal(r.ok, false);
});
