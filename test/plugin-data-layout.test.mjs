import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DATA_DIRS, PERSONA_TEMPLATE, SYSTEM_TEMPLATE, ensureDataLayout } from '../src/plugin/data-layout.mjs';
import { createConfigStore, resolveLogDir } from '../src/plugin/config-store.mjs';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-im-layout-'));
}

function collectingLogger() {
  const warnings = [];
  return { warnings, warn: (message, extra) => warnings.push({ message, extra }) };
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

test('ensureDataLayout：五层目录 + 两份模板一次建好', async () => {
  const root = await tempRoot();
  const result = await ensureDataLayout({ rootDir: root });

  assert.equal(result.ok, true);
  for (const name of DATA_DIRS) {
    assert.equal(await exists(join(root, name)), true, '缺目录：' + name);
  }
  assert.deepEqual(DATA_DIRS, ['logs', 'media', 'history', 'prompts', 'state']);
  assert.deepEqual((await readdir(join(root, 'prompts'))).sort(), ['persona.md', 'system.md']);
  assert.deepEqual(result.dirs, DATA_DIRS);
  assert.deepEqual(result.created, ['prompts/system.md', 'prompts/persona.md']);
});

test('ensureDataLayout：再调一次是幂等的，已存在的模板不再写', async () => {
  const root = await tempRoot();
  await ensureDataLayout({ rootDir: root });
  const before = await readFile(join(root, 'prompts', 'system.md'), 'utf8');

  const again = await ensureDataLayout({ rootDir: root });
  assert.equal(again.ok, true);
  assert.deepEqual(again.created, [], '第二次不该再写任何文件');
  assert.deepEqual(again.skipped.sort(), ['prompts/persona.md', 'prompts/system.md']);
  assert.equal(await readFile(join(root, 'prompts', 'system.md'), 'utf8'), before);
});

test('ensureDataLayout：用户写过的模板一个字都不会被覆盖（这是人格文件）', async () => {
  const root = await tempRoot();
  await ensureDataLayout({ rootDir: root });
  const mine = '# 小美\n- 性格：温柔但不迁就\n';
  await writeFile(join(root, 'prompts', 'persona.md'), mine, 'utf8');

  const result = await ensureDataLayout({ rootDir: root });
  assert.equal(result.ok, true);
  assert.equal(await readFile(join(root, 'prompts', 'persona.md'), 'utf8'), mine);
});

test('模板内容：system.md 是注释开头的空模板，并说明会加在每次对话前', () => {
  assert.ok(SYSTEM_TEMPLATE.startsWith('<!--'), '必须以注释开头：' + SYSTEM_TEMPLATE.slice(0, 20));
  assert.match(SYSTEM_TEMPLATE, /系统级要求/);
  assert.match(SYSTEM_TEMPLATE, /加在每次对话前/);
  // 注释外面不能有任何正文：刚建出来的模板等于"没写"，不能污染提示词
  assert.equal(SYSTEM_TEMPLATE.replace(/<!--[\s\S]*?-->/g, '').trim(), '');
});

test('模板内容：persona.md 是角色卡骨架，并写明"改这个文件就等于换人格"', () => {
  assert.match(PERSONA_TEMPLATE, /改这个文件就等于换人格/);
  for (const line of ['# 角色名', '- 性格：', '- 说话风格：', '- 背景设定：', '- 互动规则：', '- 能力边界：']) {
    assert.ok(PERSONA_TEMPLATE.includes(line), '角色卡缺一项：' + line);
  }
});

test('ensureDataLayout：rootDir 为空只回报原因，不抛也不建东西', async () => {
  for (const rootDir of ['', '   ', undefined, null]) {
    const result = await ensureDataLayout({ rootDir });
    assert.equal(result.ok, false);
    assert.match(result.error, /数据目录/);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.dirs, []);
  }
});

test('ensureDataLayout：建目录失败只 warn，不让保存配置/启动变红', async () => {
  const logger = collectingLogger();
  const boom = Object.assign(new Error('设备没空间了'), { code: 'ENOSPC' });
  const result = await ensureDataLayout({
    rootDir: 'E:\\dsh-im-bridge-data',
    logger,
    fsImpl: {
      mkdir: async () => {
        throw boom;
      },
      writeFile: async () => {}
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /设备没空间了/);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0].message, /数据目录初始化失败/);
  assert.equal(logger.warnings[0].extra.error, '设备没空间了');
});

test('ensureDataLayout：写模板失败（非 EEXIST）同样只 warn，坏掉的是模板不是目录', async () => {
  const logger = collectingLogger();
  const result = await ensureDataLayout({
    rootDir: 'E:\\dsh-im-bridge-data',
    logger,
    fsImpl: {
      mkdir: async () => {},
      writeFile: async () => {
        throw Object.assign(new Error('只读文件系统'), { code: 'EROFS' });
      }
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /只读文件系统/);
  assert.equal(logger.warnings.length, 1);
});

test('log.dir 留空：解析成 <rootDir>/logs，且 ensureDataLayout 真把这个目录建出来', async () => {
  const root = await tempRoot();
  const config = { storage: { rootDir: root }, log: { dir: '' } };
  const resolved = resolveLogDir(config);
  assert.equal(resolved, join(root, 'logs'));

  await ensureDataLayout({ rootDir: root });
  assert.equal(await exists(resolved), true, '留空时日志目录必须正好是自动建的 logs');
});

test('保存配置不会把 log.dir 补成绝对路径（用户配置文件不被改写）', async () => {
  const root = await tempRoot();
  const configPath = join(root, 'config.json');
  const store = createConfigStore({ env: {}, filePath: configPath });

  const saved = await store.save({
    platform: 'qq-napcat',
    enabled: false,
    storage: { rootDir: root },
    security: { userWhitelist: ['1772538871'] },
    log: { dir: '' }
  });
  assert.equal(saved.ok, true, JSON.stringify(saved.problems || saved.error));

  const written = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(written.log.dir, '', 'log.dir 留空就该原样存空串');
  assert.equal(resolveLogDir(written), join(await realpathOf(root), 'logs'));
});

// 配置层会把 rootDir 解析成规范化的绝对路径，断言时用同一套解析，避免大小写/短路径差异
async function realpathOf(target) {
  const { realpath } = await import('node:fs/promises');
  return realpath(target);
}
