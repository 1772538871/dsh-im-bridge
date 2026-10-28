import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 数据目录固定分成五层：用户打开根目录就知道东西该放哪，不必自己建。
// 顺序即创建顺序，也是"这五层一定存在"的断言表。
export const DATA_DIRS = ['logs', 'media', 'history', 'prompts', 'state'];

// 「注释开头的空模板」：注释不会进提示词，所以刚建出来等于没写，行为与之前完全一致。
export const SYSTEM_TEMPLATE = `<!--
  这里写系统级要求，会加在每次对话前。
  比如：只说中文、回复别超过 5 行、不确定就先问我。
  注释里的内容（像这一段）不会进提示词。
-->
`;

// 角色卡：改这个文件就等于换人格。占位骨架（# 角色名 / - 性格：）在被填上之前同样不进提示词，
// 所以"建了文件但还没写"和"没有这个文件"对对话的影响是一样的。
export const PERSONA_TEMPLATE = `<!--
  改这个文件就等于换人格：把下面这张卡填好，每轮对话前都会带上它。
  空着的项（包括现在这几行占位）和注释一样，不会进提示词。
-->
# 角色名
- 性格：
- 说话风格：
- 背景设定：
- 互动规则：
- 能力边界：
`;

export const TEMPLATES = [
  { file: 'system.md', dir: 'prompts', content: SYSTEM_TEMPLATE },
  { file: 'persona.md', dir: 'prompts', content: PERSONA_TEMPLATE }
];

function warn(logger, message, extra) {
  try {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(message, extra);
      return;
    }
  } catch {
    // 宿主 logger 坏掉时还有 console
  }
  try {
    if (extra === undefined) console.warn(message);
    else console.warn(message, extra);
  } catch {
    // 连 console 都没有就彻底静默：建目录失败绝不能反过来把启动流程带崩
  }
}

function textOf(error) {
  return error && error.message ? String(error.message) : String(error);
}

function fsOf(fsImpl) {
  const io = fsImpl && typeof fsImpl === 'object' ? fsImpl : {};
  return {
    mkdir: typeof io.mkdir === 'function' ? io.mkdir : mkdir,
    writeFile: typeof io.writeFile === 'function' ? io.writeFile : writeFile
  };
}

/**
 * 幂等地把 <rootDir> 分层建好，并补上缺失的模板文件。
 * 已存在的模板一个字都不动（flag:'wx' 保证这一点），失败只 warn：
 * 目录没建出来最多是"少几个空文件夹"，绝不该让保存配置或启动运行时失败。
 */
export async function ensureDataLayout({ rootDir = '', logger = null, fsImpl = null } = {}) {
  const root = typeof rootDir === 'string' ? rootDir.trim() : '';
  if (root === '') {
    return { ok: false, error: '没有数据目录（storage.rootDir 为空），已跳过', dirs: [], created: [], skipped: [] };
  }

  const io = fsOf(fsImpl);
  // created 只装"这次真的写出文件"的那几项：mkdir(recursive) 分不出新旧，目录本身用 dirs 回报
  const created = [];
  const skipped = [];

  try {
    for (const name of DATA_DIRS) {
      await io.mkdir(join(root, name), { recursive: true });
    }
    for (const item of TEMPLATES) {
      const target = join(root, item.dir, item.file);
      const relative = item.dir + '/' + item.file;
      try {
        // 'wx' = 只在不存在时创建：用户改过的角色卡不能被一次保存配置覆盖掉
        await io.writeFile(target, item.content, { encoding: 'utf8', flag: 'wx' });
        created.push(relative);
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          skipped.push(relative);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    warn(logger, 'dsh-bot: 数据目录初始化失败（收发不受影响，可稍后重试）', {
      rootDir: root,
      error: textOf(error)
    });
    return { ok: false, error: textOf(error), dirs: DATA_DIRS.slice(), created, skipped };
  }

  return { ok: true, dirs: DATA_DIRS.slice(), created, skipped };
}
