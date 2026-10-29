import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';

// 候选启动器：各发行包/各版本放的启动文件不一样，全列出来按顺序试第一个存在的，
// 用户就不必自己去认哪个才是启动器（顺序 = 越"官方一键启动"越靠前）。
export const NAPCAT_LAUNCHERS = [
  'launcher-win10.bat',
  'launcher.bat',
  'napcat.bat',
  'NapCatWinBootMain.exe',
  'napcat.mjs'
];
// NapCat 自己把登录二维码写到磁盘上（社区实现读的就是这个文件）：只读，绝不删、绝不改
export const QRCODE_CANDIDATES = ['napcat/cache/qrcode.png', 'cache/qrcode.png'];
export const QRCODE_MIN_BYTES = 100;
// 端口通 + 二维码文件 60 秒没再更新 = 很可能已经扫完登录了。这是弱信号，拿不到就报 null
export const LOGIN_QUIET_MS = 60000;
// 二维码在这段时间内被写过 = 有活实例在出码，别再拉第二个（会撞「无法重复登录」）
export const QR_FRESH_MS = 120000;
export const DEFAULT_NAPCAT_PORT = 3001;
export const CONNECT_TIMEOUT_MS = 500;
// NapCat 的 WebUI(6099) 与 OneBot HTTP(3000)：用来判断它到底在不在跑
export const EXTRA_PORTS = [3000, 6099];
// NapCat 自己把网络配置写在这里：onebot11_<uin>.json（文件名带小号）与 webui.json（面板端口/令牌）
export const NAPCAT_CONFIG_DIR = 'napcat/config';
export const ONEBOT_FILE_PREFIX = 'onebot11_';
export const WEBUI_FILE = 'webui.json';
export const WEBUI_DEFAULT_PORT = 6099;

export const MSG_NO_HOME = '还没填 NapCat 安装目录：在高级设置里填一次（例如 D:\\NapCat），之后就只用点启动';
export const MSG_NO_QRCODE = '还没生成二维码：先点一键启动，等它出码（一般 5–20 秒）';

function toText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

function warn(logger, message, extra) {
  try {
    if (logger && typeof logger.warn === 'function') logger.warn(message, extra);
  } catch {
    // 日志坏掉不能连累启动流程
  }
}

/**
 * 启动器 -> 命令行。返回 { launcher, file, args }，一个都找不到时返回 null。
 * args 永远是数组：路径只作为参数交给 cmd/node，绝不拼进 shell 字符串。
 */
export function resolveLauncherCommand({ homeDir = '', exists = () => false, nodePath = '' } = {}) {
  const home = toText(homeDir).trim();
  if (home === '') return null;
  for (const name of NAPCAT_LAUNCHERS) {
    const full = join(home, name);
    let present = false;
    try {
      present = exists(full) === true;
    } catch {
      present = false;
    }
    if (!present) continue;
    const lower = name.toLowerCase();
    // .bat 必须经 cmd /c 跑：Windows 上直接 CreateProcess 一个 .bat 只会得到 ENOENT
    if (lower.endsWith('.bat') || lower.endsWith('.cmd')) {
      return { launcher: name, file: 'cmd', args: ['/c', full] };
    }
    if (lower.endsWith('.mjs') || lower.endsWith('.js')) {
      // 用宿主自己的 node：用户机器的 PATH 里不一定有 node，而宿主本身就是 node 跑起来的
      return { launcher: name, file: toText(nodePath).trim() || process.execPath, args: [full] };
    }
    return { launcher: name, file: full, args: [] };
  }
  return null;
}

/** 探一次端口。任何异常/超时都当成"没在监听"，绝不把错误抛给接口层。 */
function probePort(netApi, host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    let timer = null;
    const done = (listening) => {
      if (settled) return;
      settled = true;
      if (timer) {
        try {
          clearTimeout(timer);
        } catch {
          // 清不掉定时器也只是白白多醒一次
        }
      }
      try {
        if (socket && typeof socket.destroy === 'function') socket.destroy();
      } catch {
        // 已经关掉的 socket 再 destroy 会抛，忽略
      }
      resolve(listening === true);
    };
    try {
      timer = setTimeout(() => done(false), Math.max(1, Number(timeoutMs) || CONNECT_TIMEOUT_MS));
      if (timer && typeof timer.unref === 'function') timer.unref();
      socket = netApi.connect({ host, port });
    } catch {
      done(false);
      return;
    }
    try {
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.once('timeout', () => done(false));
    } catch {
      done(false);
    }
  });
}

/** 纯数字才认："2484026025abd" / "" 这类一律当没有，绝不编一个号。 */
function digitsOf(value) {
  const text = toText(value).trim();
  return /^\d+$/.test(text) ? text : '';
}

/** 从 onebot11_<uin>.json 的文件名取 uin：NapCat 的命名就是唯一的事实来源。 */
export function uinFromOnebotName(name) {
  const matched = /^onebot11_(\d+)\.json$/i.exec(toText(name).trim());
  return matched ? matched[1] : '';
}

/** onebot11_<uin>.json -> 第一个 WebSocket 服务器的连接信息；结构不对就是 null，不猜端口。 */
export function onebotServerOf(value) {
  const root = value && typeof value === 'object' ? value : {};
  const network = root.network && typeof root.network === 'object' ? root.network : {};
  const servers = Array.isArray(network.websocketServers) ? network.websocketServers : [];
  const first = servers.length > 0 && servers[0] && typeof servers[0] === 'object' ? servers[0] : null;
  if (first === null) return null;
  const port = Number(first.port);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return {
    wsUrl: 'ws://127.0.0.1:' + Math.floor(port),
    token: toText(first.token).trim(),
    name: toText(first.name).trim()
  };
}

/**
 * 打开系统默认浏览器的两条路：先 cmd start，再 rundll32。
 * URL 只作为参数交给 cmd，绝不拼进 shell 字符串。
 */
export function browserOpenPlans(url) {
  const target = toText(url).trim();
  if (target === '') return [];
  return [
    { file: 'cmd', args: ['/c', 'start', '', target] },
    { file: 'rundll32', args: ['url.dll,FileProtocolHandler', target] }
  ];
}

/** 起一个 detached 的进程去开链接：NapCat 是长驻程序，浏览器也不该把宿主挂住。 */
export function openInSystemBrowser(spawnFn, url) {
  let lastError = null;
  for (const plan of browserOpenPlans(url)) {
    try {
      const child = spawnFn(plan.file, plan.args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
      try {
        if (child && typeof child.unref === 'function') child.unref();
      } catch {
        // unref 失败不影响它已经被拉起来了
      }
      return { ok: true, via: plan.file };
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: errorText(lastError || new Error('没有可用的浏览器打开方式')) };
}

function configOf(config) {
  if (typeof config === 'function') {
    try {
      const value = config();
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }
  return config && typeof config === 'object' ? config : {};
}

/**
 * 本机 NapCat 的一键启动器。全部依赖注入（fs/spawn/net/now/kill），
 * 于是"真机没装 NapCat"时每个分支都能用假件验，而真机上用的还是同一份代码。
 * 返回值恒是 { ok, ... }：接口层只按 ok 分支，不 try/catch。
 */
export function createNapcatLauncher(deps = {}) {
  const {
    config = {},
    logger = null,
    fsImpl = null,
    spawnImpl = null,
    netImpl = null,
    now = () => Date.now(),
    killImpl = null,
    nodePath = '',
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    openImpl = null,
    fetchImpl = null
  } = deps;

  const fsApi = fsImpl || {
    exists: (target) => {
      try {
        return existsSync(target);
      } catch {
        return false;
      }
    },
    stat: (target) => stat(target),
    readFile: (target) => readFile(target),
    readdir: (target) => readdir(target)
  };
  const spawnFn = typeof spawnImpl === 'function' ? spawnImpl : spawn;
  const netApi = netImpl || net;
  // 只结束自己拉起的那个 pid：默认实现就是 process.kill(pid)，注入只是为了能验"没有杀别的进程"
  const kill = typeof killImpl === 'function' ? killImpl : (pid) => process.kill(pid);
  const clock = typeof now === 'function' ? now : () => Date.now();

  // 内存标记（不落盘：pid 文件过期比没有更坑）：记着"这个进程是本插件拉起来的"
  const own = { pid: 0, launcher: '' };
  // 打开浏览器失败要能降级成人话，注入点只是为了测试不去真的开窗口
  const openTarget = typeof openImpl === 'function' ? openImpl : (url) => openInSystemBrowser(spawnFn, url);

  function napcatConfig() {
    const root = configOf(config);
    const section = root.qqNapcat;
    return section && typeof section === 'object' ? section : {};
  }

  function homeDirValue() {
    return toText(napcatConfig().homeDir).trim();
  }

  function portValue() {
    const port = Number(napcatConfig().port);
    return Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.floor(port) : DEFAULT_NAPCAT_PORT;
  }

  /** 只判断"这个地址能不能回一次 HTTP"，不关心内容。 */
  async function probeHttp(url, timeoutMs) {
    if (typeof fetchImpl !== 'function') return false;
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      const res = await fetchImpl(url, controller ? { signal: controller.signal } : {});
      if (timer) clearTimeout(timer);
      return !!(res && res.ok !== false);
    } catch {
      return false;
    }
  }

  function existsPath(target) {
    try {
      return fsApi.exists(target) === true;
    } catch {
      return false;
    }
  }

  function configDirOf(home) {
    return join(home, NAPCAT_CONFIG_DIR);
  }

  /** 读一个 JSON 文件。读不到 / 不是 JSON / 不是对象 → null，永不抛。 */
  async function readJsonFile(file) {
    let raw;
    try {
      raw = await fsApi.readFile(file);
    } catch {
      return null;
    }
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 列目录名。没有 readdir 能力（老注入件）或读不到 → null，调用方当"没扫到"。 */
  async function listNames(dir) {
    if (typeof fsApi.readdir !== 'function') return null;
    try {
      const items = await fsApi.readdir(dir);
      return Array.isArray(items) ? items.map((item) => String(item)) : null;
    } catch {
      return null;
    }
  }

  /**
   * 小号账号 + OneBot 连接信息，只读、只降级：
   * uin 先看 onebot11_<uin>.json 的文件名，再看 webui.json.autoLoginAccount，都没有就是 null。
   */
  async function probeAccount(home) {
    try {
      const root = toText(home).trim();
      if (root === '') return { account: null, onebot: null };
      const dir = configDirOf(root);
      const names = await listNames(dir);
      let uin = '';
      let file = '';
      for (const name of names || []) {
        const found = uinFromOnebotName(name);
        if (found !== '') {
          uin = found;
          file = name;
          break;
        }
      }
      if (uin === '') {
        const webui = await readJsonFile(join(dir, WEBUI_FILE));
        const auto = digitsOf(webui && webui.autoLoginAccount);
        if (auto !== '') {
          uin = auto;
          file = ONEBOT_FILE_PREFIX + auto + '.json';
        }
      }
      if (uin === '') return { account: null, onebot: null };
      const onebot = await readJsonFile(join(dir, file));
      return { account: uin, onebot: onebotServerOf(onebot) };
    } catch {
      return { account: null, onebot: null };
    }
  }

  /** WebUI 面板的端口与令牌：读不到就回落 6099 / 空令牌，不编。 */
  async function readWebui(home) {
    const root = toText(home).trim();
    const info = root === '' ? null : await readJsonFile(join(configDirOf(root), WEBUI_FILE));
    const port = Number(info && info.port);
    return {
      port: Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.floor(port) : WEBUI_DEFAULT_PORT,
      token: toText(info && info.token).trim()
    };
  }

  /**
   * 找第一个"够大"的 qrcode.png 并读成 dataUrl。
   * >100 字节是刻意的最小门槛：NapCat 会先建个空文件再写，读到 0 字节那种等于给用户看破图。
   */
  async function readQrCode(home) {
    for (const rel of QRCODE_CANDIDATES) {
      const file = join(home, rel);
      let info = null;
      try {
        info = await fsApi.stat(file);
      } catch {
        continue; // 这个候选位置还没有图：换下一个
      }
      const size = Number(info && info.size);
      if (!Number.isFinite(size) || size <= QRCODE_MIN_BYTES) continue;
      let bytes;
      try {
        bytes = await fsApi.readFile(file);
      } catch (error) {
        return { ok: false, error: '读取二维码图片失败：' + errorText(error) };
      }
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '');
      const mtimeMs = Number(info && info.mtimeMs);
      return {
        ok: true,
        file,
        dataUrl: 'data:image/png;base64,' + buf.toString('base64'),
        mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0,
        size: buf.length
      };
    }
    return { ok: false, error: MSG_NO_QRCODE };
  }

  async function start() {
    try {
      // 端口不通但刚出过码 → 已有实例活着：不重复拉起，直接让用户扫那张码
      const freshQr = await readQrCode(homeDirValue());
      if (freshQr.ok && Number(clock()) - freshQr.mtimeMs < QR_FRESH_MS) {
        return { ok: true, alreadyRunning: true, reason: 'qr-fresh', qrcodeAt: freshQr.mtimeMs };
      }
      const home = homeDirValue();
      if (home === '') return { ok: false, error: MSG_NO_HOME };
      if (!existsPath(home)) {
        return { ok: false, error: 'NapCat 目录不存在：' + home + '（要填实际安装位置，例如 D:\\NapCat）' };
      }
      // 已经拉起过就不再拉第二次：重复启动只会得到两个抢同一个 QQ 号的进程
      if (own.pid > 0) {
        return { ok: true, pid: own.pid, launcher: own.launcher, alreadyRunning: true };
      }
      const probe = await probePort(netApi, '127.0.0.1', portValue(), connectTimeoutMs);
      if (probe) {
        // 端口已经在监听：不管是上一个实例还是用户自己开的窗口，都不该再起一个
        return { ok: true, listening: true, alreadyRunning: true };
      }
      const plan = resolveLauncherCommand({ homeDir: home, exists: existsPath, nodePath });
      if (!plan) {
        return {
          ok: false,
          error: '这个目录里没找到 NapCat 的启动器（找了 ' + NAPCAT_LAUNCHERS.join(' / ') + '）：' + home
        };
      }
      // detached + stdio ignore：NapCat 是长驻窗口程序，绝不能让它的输出把宿主进程挂住
      const child = spawnFn(plan.file, plan.args, {
        cwd: home,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false
      });
      const pid = Number(child && child.pid);
      if (!Number.isFinite(pid) || pid <= 0) {
        return { ok: false, error: '启动 NapCat 失败：拿不到进程号（' + plan.launcher + '）' };
      }
      own.pid = Math.floor(pid);
      own.launcher = plan.launcher;
      try {
        if (typeof child.unref === 'function') child.unref();
      } catch {
        // unref 失败不影响它已经在跑这件事
      }
      const mine = own.pid;
      try {
        if (typeof child.on === 'function') {
          // 进程真的退了就把标记放开，下次点"一键启动"才会重新拉起；
          // 只清"自己那次"的标记，避免旧进程的迟到事件把新进程的状态抹掉
          const forget = () => {
            if (own.pid === mine) {
              own.pid = 0;
              own.launcher = '';
            }
          };
          child.on('exit', forget);
          child.on('error', forget);
        }
      } catch {
        // 挂不上监听就退化成"标记一直在"，最多是多点一次 stop 才能重启
      }
      warn(logger, 'dsh-bot: 已拉起 NapCat', { pid: own.pid, launcher: plan.launcher });
      return { ok: true, pid: own.pid, launcher: plan.launcher, alreadyRunning: false };
    } catch (error) {
      return { ok: false, error: '启动 NapCat 失败：' + errorText(error) };
    }
  }

  async function status() {
    const home = homeDirValue();
    const port = portValue();
    // 账号与 OneBot 参数是"顺带告诉前端一声"：读不到就 null，端口探测该怎么走还怎么走
    const probe = await probeAccount(home);
    const known = { account: probe.account, onebot: probe.onebot };
    try {
      if (home === '') return { ok: false, listening: false, loggedIn: null, homeDir: '', port, ...known, error: MSG_NO_HOME };
      // NapCat 可能只开了 WebUI(6099) 与 OneBot HTTP(3000)，WS 端口还没开：
      // 只要任一端口在听，就说明它确实在跑（否则界面会误报「未启动」）
      const candidates = [port, ...EXTRA_PORTS.filter((item) => item !== port)];
      const probed = await Promise.all(candidates.map((item) => probePort(netApi, '127.0.0.1', item, connectTimeoutMs)));
      let webui = null;
      try {
        const w = await findLiveWebUi(home);
        webui = { port: w.port, token: w.token, url: 'http://127.0.0.1:' + w.port + '/webui' + (w.token === '' ? '' : '?token=' + encodeURIComponent(w.token)) };
      } catch { webui = null; }
      const ports = {};
      candidates.forEach((item, index) => { ports[item] = probed[index] === true; });
      // 只认配置端口（默认 3001）—— 本机 3000/6099 可能是别的程序，拿它们当「NapCat 在跑」会误报
      const listening = probed[0] === true;
      if (!listening) return { ok: true, listening: false, loggedIn: null, homeDir: home, port, ports, ...known };
      const qr = await readQrCode(home);
      if (!qr.ok) {
        // 端口通但没有图：可能刚登录完把图删了，也可能还没出码。两种都说不准，如实给 null
        return { ok: true, listening: true, loggedIn: null, homeDir: home, port, ports, ...known, qrHint: qr.error };
      }
      const ageMs = Math.max(0, Number(clock()) - qr.mtimeMs);
      return {
        ok: true,
        listening: true,
        loggedIn: ageMs >= LOGIN_QUIET_MS,
        homeDir: home,
        port,
        ports,
        ...known,
        qrcodeAt: qr.mtimeMs,
        qrcodeAgeMs: ageMs
      };
    } catch (error) {
      return { ok: false, listening: false, loggedIn: null, homeDir: home, port, ...known, error: '探测 NapCat 端口失败：' + errorText(error) };
    }
  }

  /**
   * 「打开 NapCat 面板」：确保程序在跑，再用系统浏览器打开它的 WebUI，并把令牌一起回给前端。
   * 端口/令牌来自 NapCat 自己的 webui.json；读不到就是 6099 + 空令牌（那就让人自己输）。
   */
  /**
   * webui.json 里写的端口不一定真的通：本机 6099 曾被 IDE 的 java 占着，
   * NapCat 自己绑在 IPv6 [::]:6099 上，浏览器打 127.0.0.1:6099 命中的是别人。
   * 所以这里按"谁能真的响应 /webui"来选端口，从配置端口往上找 12 个。
   */
  async function findLiveWebUi(home) {
    const base = await readWebui(home);
    const tried = [];
    for (let offset = 0; offset < 12; offset += 1) {
      const port = base.port + offset;
      tried.push(port);
      const ok = await probeHttp('http://127.0.0.1:' + port + '/webui', 1500);
      if (ok) return { port, token: base.token, tried };
    }
    return { port: base.port, token: base.token, tried };
  }

  async function openWebUI() {
    const home = homeDirValue();
    let webui = { port: WEBUI_DEFAULT_PORT, token: '' };
    try {
      webui = await findLiveWebUi(home);
    } catch {
      // 读不到面板配置就只能按默认端口开，别把整件事搞失败
    }
    // NapCat 只在 /webui 下服务，且接受 token 查询参数（它自己日志里就是这么打印的）
    const url = 'http://127.0.0.1:' + webui.port + '/webui' + (webui.token === '' ? '' : '?token=' + encodeURIComponent(webui.token));
    const answer = { url, token: webui.token };
    try {
      if (home === '') return { ok: false, ...answer, opened: false, error: MSG_NO_HOME };
      // start() 自己会跳过"已经在跑"的情况：这里绝不重复拉起第二个 NapCat
      const started = await start();
      let opened;
      try {
        opened = await Promise.resolve(openTarget(url));
      } catch (error) {
        opened = { ok: false, error: errorText(error) };
      }
      if (!opened || opened.ok === false) {
        const why = errorText((opened && opened.error) || new Error('未知原因'));
        return { ok: false, ...answer, opened: false, error: '没法自动打开浏览器（' + why + '）：请手动访问 ' + url };
      }
      const result = { ok: true, ...answer, opened: true };
      // 程序和浏览器都动了，但程序本身没起来：仍然算"打开了"，把人话提示一起带回去
      if (started && started.ok === false) result.note = started.error;
      return result;
    } catch (error) {
      return { ok: false, ...answer, opened: false, error: '打开 NapCat 面板失败：' + errorText(error) };
    }
  }

  async function qrcode() {
    try {
      const home = homeDirValue();
      if (home === '') return { ok: false, error: MSG_NO_HOME };
      const found = await readQrCode(home);
      if (!found.ok) return { ok: false, error: found.error };
      return { ok: true, dataUrl: found.dataUrl, mtimeMs: found.mtimeMs };
    } catch (error) {
      return { ok: false, error: '读取二维码失败：' + errorText(error) };
    }
  }

  async function stop() {
    if (own.pid <= 0) {
      return { ok: false, error: '现在没有由本插件启动的 NapCat 进程（你自己开的窗口请在它自己的界面里关）' };
    }
    const pid = own.pid;
    try {
      kill(pid);
      own.pid = 0;
      own.launcher = '';
      return { ok: true, pid };
    } catch (error) {
      if (error && error.code === 'ESRCH') {
        own.pid = 0;
        own.launcher = '';
        return { ok: true, pid, note: '这个进程已经不在了' };
      }
      // 杀不掉就留着标记：用户可以再点一次，而不是变成"谁也不知道它还开着"的状态
      return { ok: false, pid, error: '停不掉 NapCat（pid ' + pid + '）：' + errorText(error) };
    }
  }

  return { start, status, qrcode, stop, openWebUI };
}
