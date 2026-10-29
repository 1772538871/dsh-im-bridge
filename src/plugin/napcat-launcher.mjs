import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
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
export const DEFAULT_NAPCAT_PORT = 3001;
export const CONNECT_TIMEOUT_MS = 500;
// NapCat 的 WebUI(6099) 与 OneBot HTTP(3000)：用来判断它到底在不在跑
export const EXTRA_PORTS = [3000, 6099];

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
    connectTimeoutMs = CONNECT_TIMEOUT_MS
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
    readFile: (target) => readFile(target)
  };
  const spawnFn = typeof spawnImpl === 'function' ? spawnImpl : spawn;
  const netApi = netImpl || net;
  // 只结束自己拉起的那个 pid：默认实现就是 process.kill(pid)，注入只是为了能验"没有杀别的进程"
  const kill = typeof killImpl === 'function' ? killImpl : (pid) => process.kill(pid);
  const clock = typeof now === 'function' ? now : () => Date.now();

  // 内存标记（不落盘：pid 文件过期比没有更坑）：记着"这个进程是本插件拉起来的"
  const own = { pid: 0, launcher: '' };

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

  function existsPath(target) {
    try {
      return fsApi.exists(target) === true;
    } catch {
      return false;
    }
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
    try {
      if (home === '') return { ok: false, listening: false, loggedIn: null, homeDir: '', port, error: MSG_NO_HOME };
      // NapCat 可能只开了 WebUI(6099) 与 OneBot HTTP(3000)，WS 端口还没开：
      // 只要任一端口在听，就说明它确实在跑（否则界面会误报「未启动」）
      const candidates = [port, ...EXTRA_PORTS.filter((item) => item !== port)];
      const probed = await Promise.all(candidates.map((item) => probePort(netApi, '127.0.0.1', item, connectTimeoutMs)));
      const ports = {};
      candidates.forEach((item, index) => { ports[item] = probed[index] === true; });
      const listening = probed.some((hit) => hit === true);
      if (!listening) return { ok: true, listening: false, loggedIn: null, homeDir: home, port, ports };
      const qr = await readQrCode(home);
      if (!qr.ok) {
        // 端口通但没有图：可能刚登录完把图删了，也可能还没出码。两种都说不准，如实给 null
        return { ok: true, listening: true, loggedIn: null, homeDir: home, port, ports, qrHint: qr.error };
      }
      const ageMs = Math.max(0, Number(clock()) - qr.mtimeMs);
      return {
        ok: true,
        listening: true,
        loggedIn: ageMs >= LOGIN_QUIET_MS,
        homeDir: home,
        port,
        ports,
        qrcodeAt: qr.mtimeMs,
        qrcodeAgeMs: ageMs
      };
    } catch (error) {
      return { ok: false, listening: false, loggedIn: null, homeDir: home, port, error: '探测 NapCat 端口失败：' + errorText(error) };
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

  return { start, status, qrcode, stop };
}
