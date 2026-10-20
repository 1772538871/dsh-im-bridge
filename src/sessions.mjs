import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function createSessionStore(options) {
  const opts = options || {};
  const filePath = typeof opts.file === 'string' ? opts.file : '';
  const logger = opts.logger;

  let map = {};
  let loaded = false;
  let chain = Promise.resolve();

  const log = (level, message) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](message);
    } catch {
      // 日志失败不影响会话存取
    }
  };

  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!filePath || !existsSync(filePath)) {
      map = {};
      return;
    }
    let text = '';
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (err) {
      map = {};
      log('warn', 'sessions.json 读取失败，按空表处理：' + (err && err.message ? err.message : String(err)));
      return;
    }
    if (!text.trim()) {
      map = {};
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('根节点不是对象');
      }
      const next = {};
      for (const key of Object.keys(parsed)) {
        const value = parsed[key];
        if (typeof value === 'string' && value) next[key] = value;
      }
      map = next;
    } catch (err) {
      // 宁可丢历史会话也不能让机器人整体起不来：留一份 .corrupt 供人工打捞
      const backup = filePath + '.corrupt';
      map = {};
      try {
        copyFileSync(filePath, backup);
        log('warn', 'sessions.json 已损坏（' + (err && err.message ? err.message : String(err)) + '），已备份到 ' + backup + ' 并从空表开始');
      } catch (copyErr) {
        log('warn', 'sessions.json 已损坏且备份失败，从空表开始：' + (copyErr && copyErr.message ? copyErr.message : String(copyErr)));
      }
    }
  };

  const persist = () => {
    if (!filePath) return Promise.resolve();
    const snapshot = JSON.stringify(map, null, 2) + '\n';
    chain = chain
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        // tmp + rename：进程被 kill 时 sessions.json 也不能出现半截 JSON
        const tmp = filePath + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
        await writeFile(tmp, snapshot, 'utf8');
        await rename(tmp, filePath);
      })
      .catch((err) => {
        log('error', 'sessions.json 写入失败：' + (err && err.message ? err.message : String(err)));
      });
    return chain;
  };

  return {
    get(key) {
      load();
      return map[String(key)];
    },
    async set(key, sessionId) {
      load();
      const name = String(key);
      if (sessionId === undefined || sessionId === null || sessionId === '') {
        delete map[name];
      } else {
        map[name] = String(sessionId);
      }
      await persist();
    },
    async clear(key) {
      load();
      delete map[String(key)];
      await persist();
    },
    all() {
      load();
      return { ...map };
    }
  };
}
