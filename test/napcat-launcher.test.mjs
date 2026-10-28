import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOGIN_QUIET_MS,
  MSG_NO_HOME,
  MSG_NO_QRCODE,
  NAPCAT_LAUNCHERS,
  QRCODE_MIN_BYTES,
  createNapcatLauncher,
  resolveLauncherCommand
} from '../src/plugin/napcat-launcher.mjs';
import { API_PREFIX, createApiHandler, createApiRoutes } from '../src/plugin/routes.mjs';

const HOME = 'D:\\NapCat';
const QR_DEEP = HOME + '\\napcat\\cache\\qrcode.png';
const QR_SHALLOW = HOME + '\\cache\\qrcode.png';

// ---- 假件：fs / spawn / net / kill。真机没装 NapCat，这些分支只能靠它们验 ----

function pngBytes(size) {
  const head = Buffer.from('89504e470d0a1a0a', 'hex');
  const pad = Buffer.alloc(Math.max(0, size - head.length), 0x41);
  return Buffer.concat([head, pad]).subarray(0, size);
}

// 存在性只看"这个路径在 files 里"或"在 dirs 里"：和真 fs 的语义一致，也方便逐分支构造
function fakeFs({ dirs = [], files = {} } = {}) {
  const calls = { exists: [], stat: [], readFile: [] };
  const has = (target) => Object.prototype.hasOwnProperty.call(files, target);
  return {
    calls,
    api: {
      exists(target) {
        calls.exists.push(target);
        return dirs.indexOf(target) !== -1 || has(target);
      },
      async stat(target) {
        calls.stat.push(target);
        if (!has(target)) {
          const err = new Error('ENOENT: ' + target);
          err.code = 'ENOENT';
          throw err;
        }
        return { size: files[target].bytes.length, mtimeMs: files[target].mtimeMs || 0 };
      },
      async readFile(target) {
        calls.readFile.push(target);
        if (!has(target)) {
          const err = new Error('ENOENT: ' + target);
          err.code = 'ENOENT';
          throw err;
        }
        return files[target].bytes;
      }
    }
  };
}

// 安装目录 + 指定启动器文件（字节内容无所谓，只要存在）
function homeWith(...names) {
  const files = {};
  for (const name of names) files[HOME + '\\' + name] = { bytes: Buffer.from('launcher'), mtimeMs: 0 };
  return { dirs: [HOME], files };
}

function fakeSpawn({ pid = 4242, throwError = null } = {}) {
  const calls = [];
  const impl = (file, args, options) => {
    calls.push({ file, args, options });
    if (throwError) throw throwError;
    const listeners = Object.create(null);
    const child = {
      pid,
      unref() {
        calls[calls.length - 1].unref = true;
      },
      on(name, fn) {
        listeners[name] = fn;
        return child;
      },
      emit(name) {
        if (listeners[name]) listeners[name]();
      }
    };
    calls[calls.length - 1].child = child;
    return child;
  };
  impl.calls = calls;
  return impl;
}

// 端口探测：listening=通、hang=永远不回（验超时归零）、throwOnConnect=connect 直接抛
function fakeNet({ listening = false, hang = false, throwOnConnect = false } = {}) {
  const calls = [];
  return {
    calls,
    connect(options) {
      calls.push(options);
      if (throwOnConnect) throw new Error('connect 直接炸了');
      const handlers = Object.create(null);
      const socket = {
        destroyed: false,
        once(name, fn) {
          (handlers[name] = handlers[name] || []).push(fn);
          return socket;
        },
        destroy() {
          socket.destroyed = true;
        },
        fire(name) {
          for (const fn of handlers[name] || []) fn();
        }
      };
      setTimeout(() => {
        if (socket.destroyed) return;
        if (listening) socket.fire('connect');
        else if (!hang) socket.fire('error');
      }, 5);
      return socket;
    }
  };
}

function launcherWith(overrides = {}) {
  const fsImpl = overrides.fsImpl || fakeFs(homeWith('launcher.bat'));
  const spawnImpl = overrides.spawnImpl || fakeSpawn();
  const netImpl = overrides.netImpl || fakeNet();
  const killCalls = [];
  const launcher = createNapcatLauncher({
    config: overrides.config || { qqNapcat: { homeDir: HOME, port: 3001 } },
    fsImpl: fsImpl.api,
    spawnImpl,
    netImpl,
    now: overrides.now || (() => 1700000000000),
    killImpl:
      overrides.killImpl ||
      ((pid) => {
        killCalls.push(pid);
      }),
    nodePath: overrides.nodePath || 'node',
    connectTimeoutMs: overrides.connectTimeoutMs || 20
  });
  return { launcher, fsImpl, spawnImpl, netImpl, killCalls };
}

// ---- 候选启动器挑选 ----

test('启动器挑选: 按候选顺序取第一个存在的，launcher-win10.bat 优先', () => {
  const all = {};
  for (const name of NAPCAT_LAUNCHERS) all[HOME + '\\' + name] = true;
  assert.equal(resolveLauncherCommand({ homeDir: HOME, exists: (p) => all[p] === true }).launcher, 'launcher-win10.bat');

  const only = {};
  only[HOME + '\\launcher.bat'] = true;
  only[HOME + '\\napcat.bat'] = true;
  assert.equal(resolveLauncherCommand({ homeDir: HOME, exists: (p) => only[p] === true }).launcher, 'launcher.bat');

  const later = {};
  later[HOME + '\\NapCatWinBootMain.exe'] = true;
  later[HOME + '\\napcat.mjs'] = true;
  assert.equal(resolveLauncherCommand({ homeDir: HOME, exists: (p) => later[p] === true }).launcher, 'NapCatWinBootMain.exe');

  assert.equal(resolveLauncherCommand({ homeDir: HOME, exists: () => false }), null);
  assert.equal(resolveLauncherCommand({ homeDir: '', exists: () => true }), null);
});

test('启动器挑选: .bat 走 cmd /c（路径是参数，不拼 shell 串）、.mjs 走 node、.exe 直接跑', () => {
  const bat = resolveLauncherCommand({ homeDir: HOME, exists: (p) => p.endsWith('launcher.bat'), nodePath: 'node' });
  assert.deepEqual(bat, { launcher: 'launcher.bat', file: 'cmd', args: ['/c', HOME + '\\launcher.bat'] });

  const mjs = resolveLauncherCommand({ homeDir: HOME, exists: (p) => p.endsWith('napcat.mjs'), nodePath: 'D:\\Node\\node.exe' });
  assert.deepEqual(mjs, { launcher: 'napcat.mjs', file: 'D:\\Node\\node.exe', args: [HOME + '\\napcat.mjs'] });

  const exe = resolveLauncherCommand({ homeDir: HOME, exists: (p) => p.endsWith('NapCatWinBootMain.exe') });
  assert.deepEqual(exe, { launcher: 'NapCatWinBootMain.exe', file: HOME + '\\NapCatWinBootMain.exe', args: [] });
});

// ---- start ----

test('start: 没填安装目录 -> 人话，且不 spawn、不探端口', async () => {
  const { launcher, spawnImpl, netImpl } = launcherWith({ config: { qqNapcat: { homeDir: '  ' } } });
  const result = await launcher.start();
  assert.equal(result.ok, false);
  assert.equal(result.error, MSG_NO_HOME);
  assert.equal(spawnImpl.calls.length, 0);
  assert.equal(netImpl.calls.length, 0);
});

test('start: 目录不存在 -> 说清路径，且不 spawn', async () => {
  const { launcher, spawnImpl } = launcherWith({ fsImpl: fakeFs({ dirs: [], files: {} }) });
  const result = await launcher.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /目录不存在/);
  assert.ok(result.error.includes(HOME), result.error);
  assert.equal(spawnImpl.calls.length, 0);
});

test('start: 目录在但一个启动器都没有 -> 列清楚找了哪些名字', async () => {
  const { launcher, spawnImpl } = launcherWith({ fsImpl: fakeFs({ dirs: [HOME], files: {} }) });
  const result = await launcher.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /没找到 NapCat 的启动器/);
  for (const name of NAPCAT_LAUNCHERS) assert.ok(result.error.includes(name), result.error);
  assert.equal(spawnImpl.calls.length, 0);
});

test('start: detached + stdio ignore + shell:false，参数是数组、不含命令行拼接', async () => {
  const spawnImpl = fakeSpawn({ pid: 9876 });
  const { launcher } = launcherWith({ spawnImpl });
  const result = await launcher.start();

  assert.equal(result.ok, true);
  assert.equal(result.pid, 9876);
  assert.equal(result.launcher, 'launcher.bat');
  const call = spawnImpl.calls[0];
  assert.equal(call.file, 'cmd');
  assert.deepEqual(call.args, ['/c', HOME + '\\launcher.bat']);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.notEqual(call.options.shell, true, '不许经 shell 执行');
  assert.equal(call.options.cwd, HOME);
  assert.equal(call.unref, true, '长驻子进程必须 unref，否则宿主退不出去');
});

test('start: 重复点一键启动不会重复拉起', async () => {
  const spawnImpl = fakeSpawn({ pid: 4321 });
  const { launcher } = launcherWith({ spawnImpl, fsImpl: fakeFs(homeWith('napcat.bat')) });

  const first = await launcher.start();
  const second = await launcher.start();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyRunning, true);
  assert.equal(second.pid, 4321);
  assert.equal(spawnImpl.calls.length, 1, '第二次不许再 spawn');
});

test('start: 端口已经在监听时不再起第二个 NapCat', async () => {
  const { launcher, spawnImpl } = launcherWith({ netImpl: fakeNet({ listening: true }) });
  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.listening, true);
  assert.equal(spawnImpl.calls.length, 0);
});

test('start: spawn 抛异常也只回 ok:false 人话，不向外抛', async () => {
  const { launcher } = launcherWith({ spawnImpl: fakeSpawn({ throwError: new Error('EPERM 起不来') }) });
  const result = await launcher.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /启动 NapCat 失败/);
  assert.match(result.error, /EPERM/);
});

// ---- qrcode ----

test('qrcode: 优先 napcat/cache/qrcode.png，没有才回退 cache/qrcode.png', async () => {
  const deep = pngBytes(400);
  const shallow = pngBytes(500);
  const both = launcherWith({
    fsImpl: fakeFs({ dirs: [HOME], files: { [QR_DEEP]: { bytes: deep, mtimeMs: 111 }, [QR_SHALLOW]: { bytes: shallow, mtimeMs: 222 } } })
  });
  const first = await both.launcher.qrcode();
  assert.equal(first.ok, true);
  assert.equal(first.mtimeMs, 111);
  assert.equal(first.dataUrl, 'data:image/png;base64,' + deep.toString('base64'));

  const onlyShallow = launcherWith({
    fsImpl: fakeFs({ dirs: [HOME], files: { [QR_SHALLOW]: { bytes: shallow, mtimeMs: 222 } } })
  });
  const second = await onlyShallow.launcher.qrcode();
  assert.equal(second.ok, true);
  assert.equal(second.mtimeMs, 222);
  assert.equal(second.dataUrl.split(',')[0], 'data:image/png;base64');
});

test('qrcode: 文件还不够大（<=100 字节）就当没有二维码，只给下一步怎么做', async () => {
  const tiny = fakeFs({ dirs: [HOME], files: { [QR_DEEP]: { bytes: pngBytes(QRCODE_MIN_BYTES), mtimeMs: 1 } } });
  const { launcher, fsImpl } = launcherWith({ fsImpl: tiny });
  const result = await launcher.qrcode();
  assert.equal(result.ok, false);
  assert.equal(result.error, MSG_NO_QRCODE);
  assert.equal(fsImpl.calls.readFile.length, 0, '图不够大就不该读它');
  assert.equal(fsImpl.calls.stat.length, 2, '两个候选位置都要试过');
});

test('qrcode: 只读不删——fs 注入面里没有写/删能力，命中第一个就不再找', async () => {
  const bytes = pngBytes(300);
  const fsImpl = fakeFs({ dirs: [HOME], files: { [QR_DEEP]: { bytes, mtimeMs: 5 } } });
  const { launcher } = launcherWith({ fsImpl });
  const result = await launcher.qrcode();
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(fsImpl.api).sort(), ['exists', 'readFile', 'stat'], '要删文件就必须先有删除能力——这里根本没有');
  assert.equal(fsImpl.calls.readFile.length, 1);
  assert.equal(fsImpl.calls.stat.length, 1, '第一个候选命中就不该再看下一个');
});

test('qrcode: 没填安装目录 -> 人话', async () => {
  const { launcher } = launcherWith({ config: { qqNapcat: { homeDir: '' } } });
  const result = await launcher.qrcode();
  assert.deepEqual(result, { ok: false, error: MSG_NO_HOME });
});

// ---- status ----

test('status: 端口不通 -> listening:false、loggedIn 为 null（不编登录状态）', async () => {
  const { launcher } = launcherWith({ netImpl: fakeNet({ listening: false }) });
  const result = await launcher.status();
  assert.equal(result.ok, true);
  assert.equal(result.listening, false);
  assert.equal(result.loggedIn, null);
  assert.equal(result.homeDir, HOME);
  assert.equal(result.port, 3001);
});

test('status: 端口通 + 二维码 60 秒没更新 -> 已登录；刚出码 -> 还没登录', async () => {
  const now = 1700000000000;
  const stale = launcherWith({
    now: () => now,
    netImpl: fakeNet({ listening: true }),
    fsImpl: fakeFs({ dirs: [HOME], files: { [QR_DEEP]: { bytes: pngBytes(300), mtimeMs: now - LOGIN_QUIET_MS - 1 } } })
  });
  const loggedIn = await stale.launcher.status();
  assert.equal(loggedIn.listening, true);
  assert.equal(loggedIn.loggedIn, true);
  assert.equal(loggedIn.qrcodeAt, now - LOGIN_QUIET_MS - 1);

  const fresh = launcherWith({
    now: () => now,
    netImpl: fakeNet({ listening: true }),
    fsImpl: fakeFs({ dirs: [HOME], files: { [QR_DEEP]: { bytes: pngBytes(300), mtimeMs: now - 5000 } } })
  });
  const waiting = await fresh.launcher.status();
  assert.equal(waiting.listening, true);
  assert.equal(waiting.loggedIn, false);
});

test('status: 探测超时/连不上都收敛成 listening:false，不抛', async () => {
  const hang = launcherWith({ netImpl: fakeNet({ hang: true }), connectTimeoutMs: 10 });
  const timedOut = await hang.launcher.status();
  assert.equal(timedOut.ok, true);
  assert.equal(timedOut.listening, false);

  const boom = launcherWith({ netImpl: fakeNet({ throwOnConnect: true }) });
  const threw = await boom.launcher.status();
  assert.equal(threw.ok, true);
  assert.equal(threw.listening, false);
});

test('status: 没填安装目录 -> ok:false + 人话，连端口都不探', async () => {
  const { launcher, netImpl } = launcherWith({ config: { qqNapcat: { homeDir: '' } } });
  const result = await launcher.status();
  assert.equal(result.ok, false);
  assert.equal(result.error, MSG_NO_HOME);
  assert.equal(result.loggedIn, null);
  assert.equal(netImpl.calls.length, 0);
});

// ---- stop ----

test('stop: 只结束自己拉起的那个 pid', async () => {
  const { launcher, killCalls } = launcherWith({ spawnImpl: fakeSpawn({ pid: 7777 }) });
  await launcher.start();
  const result = await launcher.stop();
  assert.equal(result.ok, true);
  assert.equal(result.pid, 7777);
  assert.deepEqual(killCalls, [7777], '只许杀自己那个 pid');
});

test('stop: 没启动过给人话；杀不掉时报原因且不谎称成功', async () => {
  const nothing = await launcherWith().launcher.stop();
  assert.equal(nothing.ok, false);
  assert.match(nothing.error, /没有由本插件启动/);

  const failing = launcherWith({
    spawnImpl: fakeSpawn({ pid: 8888 }),
    killImpl: () => {
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    }
  });
  await failing.launcher.start();
  const result = await failing.launcher.stop();
  assert.equal(result.ok, false);
  assert.equal(result.pid, 8888);
  assert.match(result.error, /停不掉 NapCat/);
  assert.match(result.error, /operation not permitted/);
});

test('stop 之后能重新拉起（标记被放开）', async () => {
  const { launcher, spawnImpl } = launcherWith({ spawnImpl: fakeSpawn({ pid: 5555 }) });
  await launcher.start();
  await launcher.stop();
  const again = await launcher.start();
  assert.equal(again.ok, true);
  assert.equal(again.alreadyRunning, false);
  assert.equal(spawnImpl.calls.length, 2);
});

// ---- HTTP 四条接口 ----

function fakeReq({ method = 'GET', url = API_PREFIX + '/napcat/status' } = {}) {
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {}
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
      return this;
    },
    end(chunk) {
      if (typeof chunk === 'string') this.body += chunk;
      return this;
    }
  };
}

async function call(handler, options) {
  const res = fakeRes();
  await handler(fakeReq(options), res);
  assert.equal(res.statusCode, 200, '四条接口必须恒 200');
  return JSON.parse(res.body || '{}');
}

function handlerWith(launcher, config = { qqNapcat: { homeDir: HOME, port: 3001 } }) {
  return createApiHandler({
    configStore: { read: () => ({ config }) },
    runtime: { status: () => ({ running: false, stats: {} }) },
    launcher
  });
}

function stubLauncher(result) {
  const seen = [];
  const wrap = (name) => () => {
    seen.push(name);
    return Promise.resolve(result);
  };
  return { seen, start: wrap('start'), status: wrap('status'), qrcode: wrap('qrcode'), stop: wrap('stop') };
}

test('POST /napcat/start: 成功时回 pid 与启动器', async () => {
  const stub = stubLauncher({ ok: true, pid: 1234, launcher: 'launcher.bat' });
  const json = await call(handlerWith(stub), { method: 'POST', url: API_PREFIX + '/napcat/start' });
  assert.deepEqual(json, { ok: true, pid: 1234, launcher: 'launcher.bat' });
  assert.deepEqual(stub.seen, ['start']);
});

test('GET /napcat/status 与 GET /napcat/qr: 原样透传宿主的结果', async () => {
  const status = stubLauncher({ ok: true, listening: true, loggedIn: null, homeDir: HOME, port: 3001 });
  const statusJson = await call(handlerWith(status), { url: API_PREFIX + '/napcat/status' });
  assert.equal(statusJson.listening, true);
  assert.equal(statusJson.loggedIn, null);
  assert.equal(statusJson.homeDir, HOME);

  const qr = stubLauncher({ ok: true, dataUrl: 'data:image/png;base64,AAA', mtimeMs: 99 });
  const qrJson = await call(handlerWith(qr), { url: API_PREFIX + '/napcat/qr' });
  assert.equal(qrJson.dataUrl, 'data:image/png;base64,AAA');
  assert.equal(qrJson.mtimeMs, 99);
  assert.deepEqual(qr.seen, ['qrcode'], 'GET /napcat/qr 对应 qrcode()');
});

test('POST /napcat/stop: 成功回 ok，失败原因照实回', async () => {
  const ok = stubLauncher({ ok: true, pid: 42 });
  assert.deepEqual(await call(handlerWith(ok), { method: 'POST', url: API_PREFIX + '/napcat/stop' }), { ok: true, pid: 42 });

  const bad = stubLauncher({ ok: false, error: '停不掉 NapCat（pid 42）：EPERM' });
  const json = await call(handlerWith(bad), { method: 'POST', url: API_PREFIX + '/napcat/stop' });
  assert.equal(json.ok, false);
  assert.match(json.error, /EPERM/);
});

test('四条接口: 未配置安装目录时回同一句人话（真实启动器，不 spawn）', async () => {
  const fsImpl = fakeFs({ dirs: [], files: {} });
  const spawnImpl = fakeSpawn();
  const netImpl = fakeNet();
  const launcher = createNapcatLauncher({
    config: { qqNapcat: { homeDir: '' } },
    fsImpl: fsImpl.api,
    spawnImpl,
    netImpl,
    connectTimeoutMs: 10
  });
  const handler = handlerWith(launcher, { qqNapcat: { homeDir: '', port: 3001 } });
  assert.deepEqual(await call(handler, { method: 'POST', url: API_PREFIX + '/napcat/start' }), { ok: false, error: MSG_NO_HOME });
  const status = await call(handler, { url: API_PREFIX + '/napcat/status' });
  assert.equal(status.ok, false);
  assert.equal(status.error, MSG_NO_HOME);
  assert.deepEqual(await call(handler, { url: API_PREFIX + '/napcat/qr' }), { ok: false, error: MSG_NO_HOME });
  const stop = await call(handler, { method: 'POST', url: API_PREFIX + '/napcat/stop' });
  assert.equal(stop.ok, false);
  assert.equal(spawnImpl.calls.length, 0);
});

test('四条接口: 方法不对 -> ok:false 且仍 200；没注入 launcher 也不炸', async () => {
  const handler = handlerWith(stubLauncher({ ok: true }));
  const wrong = await call(handler, { method: 'GET', url: API_PREFIX + '/napcat/start' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /POST \/napcat\/start/);
  assert.equal((await call(handler, { method: 'GET', url: API_PREFIX + '/napcat/stop' })).ok, false);
  assert.equal((await call(handler, { method: 'POST', url: API_PREFIX + '/napcat/status' })).ok, false);
  assert.equal((await call(handler, { method: 'POST', url: API_PREFIX + '/napcat/qr' })).ok, false);

  // 没注入 launcher：懒建一个真的（配置里没目录 -> 人话，绝不 spawn）
  const bare = createApiHandler({
    configStore: { read: () => ({ config: { qqNapcat: {} } }) },
    runtime: { status: () => ({}) }
  });
  assert.deepEqual(await call(bare, { method: 'POST', url: API_PREFIX + '/napcat/start' }), { ok: false, error: MSG_NO_HOME });
});

test('四条接口: 启动器自己抛异常 -> 翻成人话 ok:false，不打 500', async () => {
  const boom = {
    start() {
      throw new Error('意外炸了');
    }
  };
  const json = await call(handlerWith(boom), { method: 'POST', url: API_PREFIX + '/napcat/start' });
  assert.equal(json.ok, false);
  assert.match(json.error, /NapCat 操作失败/);
  assert.match(json.error, /意外炸了/);
});

test('createApiRoutes: 形态不变，launcher 会被透传下去', async () => {
  const stub = stubLauncher({ ok: true, listening: false, loggedIn: null, homeDir: HOME });
  const route = createApiRoutes({
    configStore: { read: () => ({ config: { qqNapcat: { homeDir: HOME } } }) },
    runtime: { status: () => ({}) },
    launcher: stub
  });
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, API_PREFIX);
  const json = await call(route.handler, { url: API_PREFIX + '/napcat/status' });
  assert.equal(json.ok, true);
  assert.deepEqual(stub.seen, ['status']);
});
