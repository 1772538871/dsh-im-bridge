import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEBUI_DEFAULT_PORT,
  createNapcatLauncher,
  onebotServerOf,
  uinFromOnebotName
} from '../src/plugin/napcat-launcher.mjs';
import { API_PREFIX, createApiHandler } from '../src/plugin/routes.mjs';

// 真机上的路径就是这两个：<安装目录>/napcat/config/{webui.json,onebot11_<uin>.json}
const HOME = 'D:\\NapCat';
const CONFIG_DIR = HOME + '\\napcat\\config';
const WEBUI_FILE = CONFIG_DIR + '\\webui.json';

function join2(dir, name) {
  return dir + '\\' + name;
}

// 只读假件：files 是"路径 -> 文件内容（字符串）"，names 是"目录 -> 条目名"。
// 没有列进 names 的目录就当读不到——这正是"还没建 OneBot 网络配置"的真机状态。
function fakeFs({ dirs = [HOME], names = {}, files = {} } = {}) {
  const calls = { readdir: [], readFile: [], stat: [], exists: [] };
  const has = (target) => Object.prototype.hasOwnProperty.call(files, target);
  const enoent = (target) => {
    const err = new Error('ENOENT: ' + target);
    err.code = 'ENOENT';
    return err;
  };
  return {
    calls,
    api: {
      exists(target) {
        calls.exists.push(target);
        return dirs.indexOf(target) !== -1 || has(target);
      },
      async stat(target) {
        calls.stat.push(target);
        if (!has(target)) throw enoent(target);
        return { size: Buffer.byteLength(files[target]), mtimeMs: 0 };
      },
      async readFile(target) {
        calls.readFile.push(target);
        if (!has(target)) throw enoent(target);
        return Buffer.from(files[target], 'utf8');
      },
      async readdir(target) {
        calls.readdir.push(target);
        if (!Array.isArray(names[target])) throw enoent(target);
        return names[target].slice();
      }
    }
  };
}

function fakeNet({ listening = false } = {}) {
  const calls = [];
  return {
    calls,
    connect(options) {
      calls.push(options);
      const handlers = Object.create(null);
      const socket = {
        once(name, fn) {
          (handlers[name] = handlers[name] || []).push(fn);
          return socket;
        },
        destroy() {},
        fire(name) {
          for (const fn of handlers[name] || []) fn();
        }
      };
      setTimeout(() => {
        socket.fire(listening ? 'connect' : 'error');
      }, 2);
      return socket;
    }
  };
}

function fakeSpawn({ pid = 4242 } = {}) {
  const calls = [];
  const impl = (file, args, options) => {
    calls.push({ file, args, options });
    return { pid, unref() {}, on() {} };
  };
  impl.calls = calls;
  return impl;
}

function makeLauncher({ fsImpl, netImpl, spawnImpl, openImpl } = {}) {
  const opened = [];
  const launcher = createNapcatLauncher({
    config: { qqNapcat: { homeDir: HOME, port: 3001 } },
    fsImpl: (fsImpl || fakeFs()).api,
    spawnImpl: spawnImpl || fakeSpawn(),
    netImpl: netImpl || fakeNet(),
    openImpl:
      openImpl ||
      ((url) => {
        opened.push(url);
        return { ok: true, via: 'cmd' };
      }),
    now: () => 1700000000000,
    killImpl: () => {},
    connectTimeoutMs: 20
  });
  return { launcher, opened };
}

const ONEBOT_JSON = JSON.stringify({
  network: {
    httpServers: [],
    websocketServers: [{ name: 'dsh-bridge', port: 3001, token: 'bridge-token', enable: true }]
  }
});

// ---------------- 1. 文件名 -> uin ----------------

test('uinFromOnebotName: 只认 onebot11_<纯数字>.json', () => {
  assert.equal(uinFromOnebotName('onebot11_2484026025.json'), '2484026025');
  assert.equal(uinFromOnebotName('onebot11_123.json'), '123');
  for (const bad of ['onebot11_abc.json', 'onebot11_.json', 'webui.json', 'onebot11_123.json.bak', '', 'onebot11_12x.json']) {
    assert.equal(uinFromOnebotName(bad), '', bad + ' 不该被当成小号');
  }
});

test('onebotServerOf: 取第一个 WebSocket 服务器，端口非法就是 null', () => {
  assert.deepEqual(onebotServerOf(JSON.parse(ONEBOT_JSON)), {
    wsUrl: 'ws://127.0.0.1:3001',
    token: 'bridge-token',
    name: 'dsh-bridge'
  });
  assert.equal(onebotServerOf({ network: { websocketServers: [] } }), null);
  assert.equal(onebotServerOf({ network: { websocketServers: [{ port: 0 }] } }), null);
  assert.equal(onebotServerOf({ network: { websocketServers: [{ port: 99999 }] } }), null);
  assert.equal(onebotServerOf({}), null);
  assert.equal(onebotServerOf(null), null);
});

// ---------------- 2. status(): 账号三档 + onebot 两态 ----------------

test('status: 扫到 onebot11_<uin>.json 就用文件名里的小号，并带上 OneBot 连接参数', async () => {
  const fsImpl = fakeFs({
    names: { [CONFIG_DIR]: ['webui.json', 'onebot11_2484026025.json'] },
    files: { [join2(CONFIG_DIR, 'onebot11_2484026025.json')]: ONEBOT_JSON, [WEBUI_FILE]: '{"port":6099,"token":"web"}' }
  });
  const { launcher } = makeLauncher({ fsImpl, netImpl: fakeNet({ listening: true }) });
  const status = await launcher.status();
  assert.equal(status.account, '2484026025');
  assert.deepEqual(status.onebot, { wsUrl: 'ws://127.0.0.1:3001', token: 'bridge-token', name: 'dsh-bridge' });
});

test('status: 没有 OneBot 配置时退回 webui.json.autoLoginAccount', async () => {
  const fsImpl = fakeFs({
    names: { [CONFIG_DIR]: ['webui.json'] },
    files: { [WEBUI_FILE]: '{"port":6099,"token":"web","autoLoginAccount":"2484026025"}' }
  });
  const { launcher } = makeLauncher({ fsImpl, netImpl: fakeNet({ listening: true }) });
  const status = await launcher.status();
  assert.equal(status.account, '2484026025');
  assert.equal(status.onebot, null, '只有账号没有网络配置：不给一个编出来的 ws 地址');
});

test('status: 文件名不是纯数字、autoLoginAccount 也空着 -> account 就是 null（不编）', async () => {
  const fsImpl = fakeFs({
    names: { [CONFIG_DIR]: ['onebot11_abc.json', 'webui.json'] },
    files: { [WEBUI_FILE]: '{"port":6099,"token":"web","autoLoginAccount":""}' }
  });
  const { launcher } = makeLauncher({ fsImpl, netImpl: fakeNet({ listening: true }) });
  const status = await launcher.status();
  assert.equal(status.account, null);
  assert.equal(status.onebot, null);
});

test('status: onebot11 的 JSON 坏掉时 onebot 为 null，account 仍然给，且不抛', async () => {
  const fsImpl = fakeFs({
    names: { [CONFIG_DIR]: ['onebot11_2484026025.json'] },
    files: { [join2(CONFIG_DIR, 'onebot11_2484026025.json')]: '{ 这不是 JSON' }
  });
  const { launcher } = makeLauncher({ fsImpl, netImpl: fakeNet({ listening: true }) });
  const status = await launcher.status();
  assert.equal(status.ok, true);
  assert.equal(status.account, '2484026025');
  assert.equal(status.onebot, null);
});

test('status: 没有 readdir 能力（老注入件）时降级成 autoLoginAccount，不炸', async () => {
  const fsImpl = fakeFs({ files: { [WEBUI_FILE]: '{"autoLoginAccount":"10001"}' } });
  fsImpl.api.readdir = undefined;
  const { launcher } = makeLauncher({ fsImpl, netImpl: fakeNet({ listening: true }) });
  const status = await launcher.status();
  assert.equal(status.ok, true);
  assert.equal(status.account, '10001');
  assert.equal(status.onebot, null);
});

test('status: 端口全不通也照样把账号读出来（账号与端口无关）', async () => {
  const fsImpl = fakeFs({
    names: { [CONFIG_DIR]: ['onebot11_2484026025.json'] },
    files: { [join2(CONFIG_DIR, 'onebot11_2484026025.json')]: ONEBOT_JSON }
  });
  const { launcher } = makeLauncher({ fsImpl, netImpl: fakeNet({ listening: false }) });
  const status = await launcher.status();
  assert.equal(status.listening, false);
  assert.equal(status.account, '2484026025');
  assert.equal(status.onebot.wsUrl, 'ws://127.0.0.1:3001');
});

// ---------------- 3. openWebUI ----------------

test('openWebUI: 读 webui.json 拿到端口与令牌，并用系统浏览器打开', async () => {
  const fsImpl = fakeFs({
    names: { [CONFIG_DIR]: ['webui.json'] },
    files: { [WEBUI_FILE]: '{"port":6099,"token":"49a78cfeb241"}' }
  });
  const { launcher, opened } = makeLauncher({ fsImpl, netImpl: fakeNet({ listening: true }) });
  const result = await launcher.openWebUI();
  assert.equal(result.ok, true);
  assert.equal(result.opened, true);
  assert.equal(result.url, 'http://127.0.0.1:6099/webui?token=49a78cfeb241');
  assert.equal(result.token, '49a78cfeb241');
  assert.deepEqual(opened, ['http://127.0.0.1:6099/webui?token=49a78cfeb241']);
});

test('openWebUI: 读不到 webui.json 就回落 6099 + 空令牌，仍然把面板打开', async () => {
  const { launcher, opened } = makeLauncher({ fsImpl: fakeFs({ names: {}, files: {} }) });
  const result = await launcher.openWebUI();
  assert.equal(result.ok, true);
  assert.equal(result.url, 'http://127.0.0.1:' + WEBUI_DEFAULT_PORT + '/webui');
  assert.equal(result.token, '');
  assert.equal(opened.length, 1);
});

test('openWebUI: NapCat 已经在跑就不再拉第二个进程', async () => {
  const fsImpl = fakeFs({ files: { [WEBUI_FILE]: '{"port":6099,"token":"t"}' } });
  const spawnImpl = fakeSpawn({ pid: 999 });
  const { launcher, opened } = makeLauncher({ fsImpl, spawnImpl, netImpl: fakeNet({ listening: true }) });
  const result = await launcher.openWebUI();
  assert.equal(result.ok, true);
  assert.equal(spawnImpl.calls.length, 0, '端口已在听：一个进程都不该再起');
  assert.equal(opened.length, 1);
});

test('openWebUI: 没在跑就先拉起 NapCat，再打开面板', async () => {
  // 安装目录里得真有一个启动器，start() 才会去 spawn（和真机一致）
  const fsImpl = fakeFs({ files: { [WEBUI_FILE]: '{"port":6099,"token":"t"}', [HOME + '\\launcher.bat']: 'launcher' } });
  const spawnImpl = fakeSpawn({ pid: 888 });
  const { launcher, opened } = makeLauncher({ fsImpl, spawnImpl, netImpl: fakeNet({ listening: false }) });
  const result = await launcher.openWebUI();
  assert.equal(result.ok, true);
  assert.equal(spawnImpl.calls.length, 1, '先起程序');
  assert.equal(opened.length, 1, '再开浏览器');
});

test('openWebUI: 浏览器打不开时降级成人话 + 手动地址，绝不抛', async () => {
  const fsImpl = fakeFs({ files: { [WEBUI_FILE]: '{"port":6099,"token":"t"}' } });
  const { launcher } = makeLauncher({
    fsImpl,
    netImpl: fakeNet({ listening: true }),
    openImpl: () => ({ ok: false, error: 'EPERM 起不来浏览器' })
  });
  const result = await launcher.openWebUI();
  assert.equal(result.ok, false);
  assert.equal(result.opened, false);
  assert.match(result.error, /没法自动打开浏览器/);
  assert.match(result.error, /EPERM/);
  assert.ok(result.error.includes('http://127.0.0.1:6099/webui?token=t'), '要给出能手动点的地址：' + result.error);
  assert.equal(result.token, 't', '打开失败也该把令牌带回去，人还能手抄');
});

test('openWebUI: 没填安装目录 -> ok:false + 人话，不 spawn 也不开浏览器', async () => {
  const spawnImpl = fakeSpawn();
  const opened = [];
  const launcher = createNapcatLauncher({
    config: { qqNapcat: { homeDir: '' } },
    fsImpl: fakeFs().api,
    spawnImpl,
    netImpl: fakeNet(),
    openImpl: (url) => {
      opened.push(url);
      return { ok: true };
    }
  });
  const result = await launcher.openWebUI();
  assert.equal(result.ok, false);
  assert.match(result.error, /还没填 NapCat 安装目录/);
  assert.equal(spawnImpl.calls.length, 0);
  assert.deepEqual(opened, []);
});

// ---------------- 4. HTTP 路由 ----------------

function fakeReq({ method = 'POST', url = API_PREFIX + '/napcat/open-webui' } = {}) {
  return { method, url, headers: {}, async *[Symbol.asyncIterator]() {} };
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

async function callRoute(launcher, options) {
  const handler = createApiHandler({
    configStore: { read: () => ({ config: { qqNapcat: { homeDir: HOME, port: 3001 } } }) },
    runtime: { status: () => ({ running: false, stats: {} }) },
    launcher
  });
  const res = fakeRes();
  await handler(fakeReq(options), res);
  assert.equal(res.statusCode, 200, '这条接口也必须恒 200');
  return JSON.parse(res.body || '{}');
}

test('POST /napcat/open-webui: 透传宿主结果，只认 POST', async () => {
  const seen = [];
  const stub = {
    start: () => Promise.resolve({ ok: true, alreadyRunning: true }),
    status: () => Promise.resolve({ ok: true }),
    qrcode: () => Promise.resolve({ ok: false }),
    stop: () => Promise.resolve({ ok: false }),
    openWebUI: () => {
      seen.push('openWebUI');
      return Promise.resolve({ ok: true, url: 'http://127.0.0.1:6099/webui?token=49a78cfeb241', token: 'abc', opened: true });
    }
  };
  const ok = await callRoute(stub, { method: 'POST' });
  assert.deepEqual(ok, { ok: true, url: 'http://127.0.0.1:6099/webui?token=49a78cfeb241', token: 'abc', opened: true });
  assert.deepEqual(seen, ['openWebUI']);

  const rejected = await callRoute(stub, { method: 'GET' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /只接受 POST \/napcat\/open-webui/);
});

test('POST /napcat/open-webui: 宿主方法抛异常也折成 ok:false 人话', async () => {
  const stub = {
    openWebUI: () => {
      throw new Error('shell 炸了');
    }
  };
  const json = await callRoute(stub, { method: 'POST' });
  assert.equal(json.ok, false);
  assert.match(json.error, /NapCat 操作失败/);
  assert.match(json.error, /shell 炸了/);
});
