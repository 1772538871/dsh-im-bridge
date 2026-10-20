import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function localDate(now) {
  const d = new Date(now);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function serializeExtra(extra) {
  if (extra === undefined) return undefined;
  if (extra instanceof Error) return { error: extra.message, stack: extra.stack };
  if (extra === null || typeof extra !== 'object') return extra;
  try {
    return JSON.parse(JSON.stringify(extra));
  } catch {
    return String(extra);
  }
}

function oneLine(value) {
  if (value === null || typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildLogger(state, scope) {
  const enabled = (lvl) => LEVELS[lvl] >= LEVELS[state.level];

  const write = (lvl, message, extra) => {
    if (!enabled(lvl)) return;
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const msg = typeof message === 'string' ? message : oneLine(message);
    const data = serializeExtra(extra);

    const record = { ts: iso, level: lvl, msg };
    if (scope) record.scope = scope;
    if (data !== undefined) record.data = data;

    // stderr 是人读的那一份：QQ 机器人排障时通常只 tail 终端输出。
    let line = iso + ' ' + lvl.toUpperCase().padEnd(5) + ' ';
    if (scope) line += '[' + scope + '] ';
    line += msg;
    if (data !== undefined) line += ' ' + oneLine(data);
    try {
      process.stderr.write(line + '\n');
    } catch {
      // stderr 都写不了就没别的办法了，绝不能因为日志把主流程打断
    }

    if (!state.dir) return;
    const payload = JSON.stringify(record) + '\n';
    const fileName = 'bridge-' + localDate(now) + '.log';
    state.chain = state.chain
      .then(async () => {
        if (state.degraded) return;
        try {
          await mkdir(state.dir, { recursive: true });
          await appendFile(join(state.dir, fileName), payload, 'utf8');
        } catch (err) {
          state.degraded = true;
          try {
            process.stderr.write('[logger] 日志写盘失败，已降级为仅 stderr：' + (err && err.message ? err.message : String(err)) + '\n');
          } catch {
            // 同上
          }
        }
      })
      .catch(() => {
        // chain 永远保持可继续 then 的状态
      });
  };

  return {
    info(message, extra) {
      write('info', message, extra);
    },
    warn(message, extra) {
      write('warn', message, extra);
    },
    error(message, extra) {
      write('error', message, extra);
    },
    debug(message, extra) {
      write('debug', message, extra);
    },
    child(childScope) {
      const name = childScope === undefined || childScope === null ? '' : String(childScope);
      if (!name) return buildLogger(state, scope);
      return buildLogger(state, scope ? scope + ':' + name : name);
    },
    flush() {
      return state.chain;
    },
    get filePath() {
      if (!state.dir) return '';
      return join(state.dir, 'bridge-' + localDate(Date.now()) + '.log');
    }
  };
}

export function createLogger(options) {
  const opts = options || {};
  const dir = typeof opts.dir === 'string' ? opts.dir.trim() : '';
  const level = LEVELS[opts.level] ? opts.level : 'info';
  const scope = typeof opts.scope === 'string' ? opts.scope : '';
  const state = { dir, level, chain: Promise.resolve(), degraded: false };
  return buildLogger(state, scope);
}
