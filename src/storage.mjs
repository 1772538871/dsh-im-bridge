import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { attachmentPath } from './paths.mjs';

export class StorageError extends Error {
  constructor(code, message, cause) {
    super(message || code);
    this.name = 'StorageError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_DIR = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function baseNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : '';
  } catch {
    return '';
  }
}

async function pathSize(target) {
  let count = 0;
  let bytes = 0;
  let entries = [];
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return { count, bytes };
  }
  for (const entry of entries) {
    const full = join(target, entry.name);
    if (entry.isDirectory()) {
      const sub = await pathSize(full);
      count += sub.count;
      bytes += sub.bytes;
      continue;
    }
    try {
      const info = await stat(full);
      count += 1;
      bytes += info.size;
    } catch {
      // 文件在扫描过程中被删掉，忽略即可
    }
  }
  return { count, bytes };
}

function dayEndMs(name) {
  const parts = name.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN;
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

/**
 * 从文件头判断真实格式：QQ 给表情包的 url 常常没有后缀（或后缀与内容不符），
 * 我们早先就因此把一张 GIF89a 存成了 .jpg —— 再发出去动图就死了。
 */
export function sniffImageExt(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (buf.length >= 8 && buf.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return '';
}

/**
 * 落盘后校正图片扩展名：内容是真的 GIF 却叫 .jpg，发出去就变静图/打不开。
 * 只在 kind=image 且文件头能判定时改名，其它情况一律不动。
 */
async function fixImageExt(filePath, kind) {
  if (kind !== 'image') return filePath;
  let head;
  try {
    const handle = await open(filePath, 'r');
    try {
      head = Buffer.alloc(16);
      await handle.read(head, 0, 16, 0);
    } finally {
      await handle.close();
    }
  } catch {
    return filePath;
  }
  const real = sniffImageExt(head);
  if (real === '' || extname(filePath).toLowerCase() === '.' + real) return filePath;
  const next = filePath.slice(0, filePath.length - extname(filePath).length) + '.' + real;
  try {
    await rename(filePath, next);
    return next;
  } catch {
    return filePath;
  }
}

export function createStorage(options) {
  const opts = options || {};
  const config = opts.config || {};
  const logger = opts.logger;
  const storageCfg = config.storage || {};
  const rootDir = typeof storageCfg.rootDir === 'string' ? storageCfg.rootDir : '';
  const maxFileBytes = Number.isFinite(storageCfg.maxFileBytes) && storageCfg.maxFileBytes > 0 ? Math.floor(storageCfg.maxFileBytes) : 104857600;
  const retentionDays = Number.isFinite(storageCfg.retentionDays) ? Math.floor(storageCfg.retentionDays) : 30;
  const workspaceDir = rootDir ? join(rootDir, 'workspace') : '';

  const log = (level, message, extra) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](message, extra);
    } catch {
      // 日志失败不影响落盘
    }
  };

  const ready = (async () => {
    if (!rootDir) throw new StorageError('ROOT_REQUIRED', 'storage.rootDir 未配置，无法保存附件');
    await mkdir(rootDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  })().catch((err) => {
    log('error', '数据目录初始化失败：' + (err && err.message ? err.message : String(err)));
    throw err;
  });
  // 只在真正用得上时 await：createStorage 是同步工厂，bin 里可以直接建
  ready.catch(() => {});

  const tooLarge = (bytes) =>
    new StorageError('FILE_TOO_LARGE', '附件超过上限 ' + maxFileBytes + ' 字节（实际 ' + bytes + ' 字节）');

function targetFor(kind, chatInfo, filename, ext, ts) {
    return attachmentPath({ rootDir, chat: chatInfo, kind, filename, ext, ts });
  }

  async function uniquePath(p) {
    if (!existsSync(p)) return p;
    const ext = extname(p);
    const base = ext ? p.slice(0, p.length - ext.length) : p;
    for (let i = 1; i < 1000; i += 1) {
      const candidate = base + '-' + i + ext;
      if (!existsSync(candidate)) return candidate;
    }
    throw new StorageError('NAME_COLLISION', '同名附件过多，无法生成唯一路径：' + p);
  }

  async function saveBuffer(buffer, saveOpts) {
    const o = saveOpts || {};
    await ready;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    const bytes = buf.length;
    if (bytes > maxFileBytes) throw tooLarge(bytes);
    const finalPath = await uniquePath(targetFor(o.kind || 'file', o.chat, o.filename, o.ext, o.ts));
    await mkdir(dirname(finalPath), { recursive: true });
    // 先写 .part 再改名：中途崩了不会留下看起来完整的半截附件
    const tmp = finalPath + '.part';
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(buf);
      await handle.close();
    } catch (err) {
      try {
        await handle.close();
      } catch {
        // 已经关掉了
      }
      try {
        await unlink(tmp);
      } catch {
        // 清理失败不掩盖原始错误
      }
      throw new StorageError('WRITE_FAILED', '附件写入失败：' + (err && err.message ? err.message : String(err)), err);
    }
    await rename(tmp, finalPath);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const fixed = await fixImageExt(finalPath, o.kind || 'file');
    if (fixed !== finalPath) log('debug', '按真实格式改名 ' + fixed);
    log('debug', '附件已保存 ' + finalPath + '（' + bytes + ' 字节）');
    return { path: await fixImageExt(finalPath, o.kind || 'file'), bytes, sha256 };
  }

  async function saveFromUrl(url, saveOpts) {
    const o = saveOpts || {};
    await ready;
    if (typeof url !== 'string' || !url) throw new StorageError('BAD_URL', '附件下载地址为空');
    const urlName = baseNameFromUrl(url);
    const filename = o.filename || urlName || 'download';
    const ext = o.ext || (urlName && extname(urlName) ? extname(urlName).replace(/^\.+/, '') : '');
    const finalPath = await uniquePath(targetFor(o.kind || 'file', o.chat, filename, ext, o.ts));
    await mkdir(dirname(finalPath), { recursive: true });
    const tmp = finalPath + '.part';

    const controller = new AbortController();
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (err) {
      throw new StorageError('DOWNLOAD_FAILED', '附件下载失败：' + (err && err.message ? err.message : String(err)), err);
    }
    if (!response || response.ok === false) {
      const status = response && response.status !== undefined ? response.status : 'unknown';
      throw new StorageError('DOWNLOAD_FAILED', '附件下载失败：HTTP ' + status);
    }

    const declared = Number(response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-length') : NaN);
    const cleanup = async (handle) => {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // 已关闭
        }
      }
      try {
        await unlink(tmp);
      } catch {
        // 还没创建或已删除
      }
    };

    if (Number.isFinite(declared) && declared > maxFileBytes) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
      try {
        if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
      } catch {
        // ignore
      }
      throw tooLarge(declared);
    }

    const hash = createHash('sha256');
    let bytes = 0;
    const handle = await open(tmp, 'w');
    try {
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          const chunk = step.value;
          bytes += chunk.byteLength;
          if (bytes > maxFileBytes) {
            try {
              await reader.cancel();
            } catch {
              // ignore
            }
            controller.abort();
            await cleanup(handle);
            throw tooLarge(bytes);
          }
          hash.update(chunk);
          await handle.write(chunk);
        }
      } else {
        const whole = Buffer.from(await response.arrayBuffer());
        bytes = whole.length;
        if (bytes > maxFileBytes) {
          await cleanup(handle);
          throw tooLarge(bytes);
        }
        hash.update(whole);
        await handle.write(whole);
      }
      await handle.close();
    } catch (err) {
      if (err instanceof StorageError) throw err;
      await cleanup(null);
      throw new StorageError('DOWNLOAD_FAILED', '附件写盘失败：' + (err && err.message ? err.message : String(err)), err);
    }
    await rename(tmp, finalPath);
    const sha256 = hash.digest('hex');
    log('debug', '附件已下载 ' + finalPath + '（' + bytes + ' 字节）');
    return { path: finalPath, bytes, sha256 };
  }

  function resolveExisting(p) {
    if (typeof p !== 'string' || !p) return null;
    const abs = isAbsolute(p) ? p : resolve(rootDir, p);
    return existsSync(abs) ? abs : null;
  }

  async function sweepRetention(now) {
    const at = Number.isFinite(now) ? now : Date.now();
    if (retentionDays <= 0) return { deleted: 0, bytes: 0 };
    const mediaDir = join(rootDir, 'media');
    let entries = [];
    try {
      entries = await readdir(mediaDir, { withFileTypes: true });
    } catch {
      return { deleted: 0, bytes: 0 };
    }
    // 只扫 media/<YYYY-MM-DD>/：workspace、sessions.json、logs 都在 media 之外，
    // 这样清理逻辑再怎么写错也伤不到会话状态和工作目录。
    const cutoff = at - retentionDays * DAY_MS;
    let deleted = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !DATE_DIR.test(entry.name)) continue;
      const end = dayEndMs(entry.name);
      if (!Number.isFinite(end) || end >= cutoff) continue;
      const dirPath = join(mediaDir, entry.name);
      const size = await pathSize(dirPath);
      try {
        await rm(dirPath, { recursive: true, force: true });
      } catch (err) {
        log('warn', '清理过期附件目录失败 ' + dirPath + '：' + (err && err.message ? err.message : String(err)));
        continue;
      }
      deleted += size.count;
      bytes += size.bytes;
    }
    if (deleted > 0) log('info', '已清理过期附件 ' + deleted + ' 个（' + bytes + ' 字节）');
    return { deleted, bytes };
  }

  return {
    rootDir,
    workspaceDir,
    maxFileBytes,
    saveBuffer,
    saveFromUrl,
    resolveExisting,
    sweepRetention
  };
}
