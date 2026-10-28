import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureDataLayout } from '../src/plugin/data-layout.mjs';
import { buildPrompt, readPromptSections, templateBody } from '../src/prompt.mjs';

async function tempDataDir() {
  return mkdtemp(join(tmpdir(), 'dsh-im-prompt-'));
}

function makeConfig(rootDir) {
  return {
    storage: { rootDir },
    security: { maxPromptChars: 8000 },
    reply: { maxChunkChars: 1500 }
  };
}

function makeMessage(text = '把今天的记录整理一下') {
  return { chatType: 'private', userId: '1772538871', text };
}

async function writeTemplates(rootDir, files) {
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(rootDir, 'prompts', name), body, 'utf8');
  }
}

function seedPromptsDir(rootDir) {
  return ensureDataLayout({ rootDir });
}

test('提示词：系统要求 + 角色设定都有时，三段固定顺序拼在用户消息前', async () => {
  const root = await tempDataDir();
  await seedPromptsDir(root);
  await writeTemplates(root, {
    'system.md': '只用中文回答。\n不确定就先问我。\n',
    'persona.md': '# 小美\n- 性格：温柔但不迁就\n'
  });

  const prompt = buildPrompt({ config: makeConfig(root), message: makeMessage() });
  const iSystem = prompt.indexOf('[系统要求]');
  const iPersona = prompt.indexOf('[角色设定]');
  const iUser = prompt.indexOf('[用户消息]');

  assert.ok(iSystem >= 0 && iPersona >= 0 && iUser >= 0, prompt.slice(0, 200));
  assert.ok(iSystem < iPersona && iPersona < iUser, '顺序必须是 系统要求 → 角色设定 → 用户消息');
  assert.equal(prompt.startsWith('[系统要求]\n'), true, prompt.slice(0, 40));
  assert.ok(prompt.includes('只用中文回答。'));
  assert.ok(prompt.includes('# 小美'));
  assert.ok(prompt.includes('把今天的记录整理一下'), '用户原文必须还在');
});

test('提示词：只有 persona 时只加 [角色设定] 与 [用户消息]', async () => {
  const root = await tempDataDir();
  await seedPromptsDir(root);
  await writeTemplates(root, { 'persona.md': '# 老王\n- 说话风格：爱用比喻\n' });

  const prompt = buildPrompt({ config: makeConfig(root), message: makeMessage() });
  assert.equal(prompt.includes('[系统要求]'), false);
  assert.equal(prompt.startsWith('[角色设定]\n'), true, prompt.slice(0, 40));
  assert.ok(prompt.includes('[用户消息]'));
  assert.ok(prompt.includes('爱用比喻'));
});

test('提示词：两份模板都没有内容时保持原样（不出现任何段标题）', async () => {
  const root = await tempDataDir();
  await seedPromptsDir(root); // 刚建出来的模板 = 注释 + 空占位

  const prompt = buildPrompt({ config: makeConfig(root), message: makeMessage() });
  for (const title of ['[系统要求]', '[角色设定]', '[用户消息]']) {
    assert.equal(prompt.includes(title), false, '不该出现 ' + title);
  }
  assert.equal(prompt.startsWith('你正在通过 QQ 与用户对话'), true, prompt.slice(0, 40));
  assert.ok(prompt.includes('用户原文：'));
});

test('提示词：dataDir 直接指定也生效，不依赖 config.storage.rootDir', async () => {
  const root = await tempDataDir();
  await seedPromptsDir(root);
  await writeTemplates(root, { 'persona.md': '# 阿岚\n- 能力边界：不碰生产库\n' });

  const prompt = buildPrompt({ config: makeConfig(''), message: makeMessage(), dataDir: root });
  assert.ok(prompt.includes('[角色设定]'));
  assert.ok(prompt.includes('不碰生产库'));
});

test('提示词：注释行不算内容，也不进提示词', async () => {
  const root = await tempDataDir();
  await seedPromptsDir(root);
  await writeTemplates(root, {
    'system.md': '<!-- 这里只是说明\n    不会进提示词 -->\n回答别超过 5 行。\n'
  });

  const prompt = buildPrompt({ config: makeConfig(root), message: makeMessage() });
  assert.ok(prompt.includes('[系统要求]'));
  assert.ok(prompt.includes('回答别超过 5 行。'));
  assert.equal(prompt.includes('这里只是说明'), false);
  assert.equal(prompt.includes('<!--'), false);
});

test('提示词：空占位不算内容，填了才算（角色卡骨架的两种状态）', async () => {
  const skeleton = '# 角色名\n- 性格：\n- 说话风格：\n';
  assert.deepEqual(templateBody(skeleton), [], '空骨架不该算"写了角色"');
  assert.deepEqual(templateBody('# 小美\n- 性格：\n'), ['# 小美'], '填过标题就算写了');

  const root = await tempDataDir();
  await seedPromptsDir(root);
  await writeTemplates(root, { 'persona.md': skeleton });
  const empty = buildPrompt({ config: makeConfig(root), message: makeMessage() });
  assert.equal(empty.includes('[角色设定]'), false);

  await writeTemplates(root, { 'persona.md': '# 小美\n- 性格：直接\n' });
  const filled = buildPrompt({ config: makeConfig(root), message: makeMessage() });
  assert.ok(filled.includes('[角色设定]\n# 小美'));
});

test('提示词：读模板失败时降级为原样，绝不让整轮崩', async () => {
  const root = await tempDataDir();
  const prompt = buildPrompt({
    config: makeConfig(root),
    message: makeMessage(),
    fsImpl: {
      readFileSync() {
        throw Object.assign(new Error('EACCES: 没有读权限'), { code: 'EACCES' });
      }
    }
  });
  assert.equal(prompt.includes('[系统要求]'), false);
  assert.ok(prompt.includes('用户原文：'));
});

test('提示词：dataDir 为空时根本不碰文件系统', () => {
  let reads = 0;
  const prompt = buildPrompt({
    config: makeConfig(''),
    message: makeMessage(),
    fsImpl: {
      readFileSync() {
        reads += 1;
        return '';
      }
    }
  });
  assert.equal(reads, 0);
  assert.equal(prompt.includes('[用户消息]'), false);
});

test('readPromptSections：只返回有内容的段，顺序固定为 system → persona', () => {
  const files = {
    [join('E:', 'data', 'prompts', 'system.md')]: '系统要求正文',
    [join('E:', 'data', 'prompts', 'persona.md')]: '角色正文'
  };
  const sections = readPromptSections({
    dataDir: join('E:', 'data'),
    fsImpl: { readFileSync: (file) => files[file] }
  });
  assert.deepEqual(sections.map((s) => s.title), ['[系统要求]', '[角色设定]']);
  assert.deepEqual(sections.map((s) => s.body), [['系统要求正文'], ['角色正文']]);
});
