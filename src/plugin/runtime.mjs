import { join } from 'node:path';
import { createPlatformAdapter } from './platforms.mjs';
import { resolveLogDir } from './config-store.mjs';

// 内核模块一律按相对本文件的 URL 动态导入：插件被放到 <DSH_HOME>/profiles/*/plugins 下也能解析
const CORE_MODULES = {
  log: '../log.mjs',
  storage: '../storage.mjs',
  security: '../security.mjs',
  queue: '../queue.mjs',
  sessions: '../sessions.mjs',
  pipeline: '../pipeline.mjs',
  dsh: '../dsh.mjs',
  onebotClient: '../onebot/client.mjs',
  qqbotAdapter: '../qqbot/adapter.mjs'
};

const PLATFORM_MODULE = { 'qq-napcat': 'onebotClient', 'qq-official': 'qqbotAdapter' };
const BASE_MODULES = ['log', 'storage', 'security', 'queue', 'sessions', 'pipeline', 'dsh'];

function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

function moduleUrl(name) {
  return new URL(CORE_MODULES[name], import.meta.url).href;
}

async function resolveModules(names, injected) {
  const modules = {};
  const missing = [];
  for (const name of names) {
    const provided = injected ? injected[name] : undefined;
    if (provided) {
      modules[name] = provided;
      continue;
    }
    try {
      modules[name] = await import(moduleUrl(name));
    } catch (error) {
      // 缺依赖只记名字，具体错误详情留在 missing 里给上层拼人话
      missing.push({ name, error: errorText(error) });
    }
  }
  return { modules, missing };
}

/** 插件配置 -> 内核配置：内核只认 onebot/qqbot 段，插件侧字段名是 qqNapcat/qqOfficial。 */
export function coreConfigOf(config) {
  const napcat = config?.qqNapcat ?? {};
  const official = config?.qqOfficial ?? {};
  return {
    ...config,
    onebot: {
      wsUrl: napcat.wsUrl,
      accessToken: napcat.accessToken ?? '',
      reconnectMinMs: napcat.reconnectMinMs,
      reconnectMaxMs: napcat.reconnectMaxMs
    },
    qqbot: {
      appId: official.appId ?? '',
      clientSecret: official.appSecret ?? '',
      sandbox: official.sandbox === true
    }
  };
}

/**
 * 运行时管理器：同一时刻最多一个实例，start/stop/restart 幂等。
 * modules 是测试注入口（生产走动态 import），避免单测真的去连 WebSocket / 起子进程。
 */
export function createRuntime({ configStore, logger = null, modules = null, now = () => Date.now() } = {}) {
  if (!configStore || typeof configStore.read !== 'function') throw new Error('createRuntime: 需要 configStore');

  const state = { running: false, since: null, lastError: null, adapter: null, pipeline: null, logger: null };

  const diag = (level, message, extra) => {
    const target = state.logger && typeof state.logger[level] === 'function' ? state.logger : logger;
    try {
      if (target && typeof target[level] === 'function') target[level](message, extra);
    } catch {
      // 日志后端坏掉不能影响运行时生命周期
    }
  };

  function status() {
    let config = {};
    try {
      config = configStore.read().config ?? {};
    } catch (error) {
      return {
        enabled: false,
        running: false,
        platform: 'unknown',
        since: null,
        lastError: state.lastError ?? '读取配置失败：' + errorText(error),
        stats: { received: 0, handled: 0, denied: 0, failed: 0 }
      };
    }
    let raw = {};
    try {
      raw = state.pipeline && typeof state.pipeline.stats === 'function' ? state.pipeline.stats() : {};
    } catch {
      raw = {};
    }
    return {
      enabled: config.enabled === true,
      running: state.running === true,
      platform: config.platform,
      since: state.since,
      lastError: state.lastError,
      // 契约 §3 只列这四个计数，多出来的 ignored/parseErrors 不外泄
      stats: {
        received: raw.received ?? 0,
        handled: raw.handled ?? 0,
        denied: raw.denied ?? 0,
        failed: raw.failed ?? 0
      }
    };
  }

  function fail(error) {
    state.lastError = typeof error === 'string' ? error : errorText(error);
    diag('warn', 'dsh-bot 运行时启动失败', { error: state.lastError });
    return { ok: false, error: state.lastError, status: status() };
  }

  async function start() {
    if (state.running) return { ok: true, status: status() };
    state.lastError = null;

    let view;
    try {
      view = configStore.read();
    } catch (error) {
      return fail('读取 dsh-bot 配置失败：' + errorText(error));
    }
    const config = view.config;
    if (config.platform === 'wechat') return fail('平台 wechat 未实现');

    const adapterModule = PLATFORM_MODULE[config.platform];
    if (adapterModule === undefined) return fail('未知平台：' + String(config.platform));

    const wanted = BASE_MODULES.concat([adapterModule]);
    const resolved = await resolveModules(wanted, modules);
    if (resolved.missing.length > 0) {
      const onlyAdapter = resolved.missing.every((item) => item.name === adapterModule);
      if (onlyAdapter) return fail('平台适配器尚未就绪');
      return fail('缺少内核模块：' + resolved.missing.map((item) => item.name + '（' + item.error + '）').join('；'));
    }

    const core = coreConfigOf(config);
    let runtimeLogger = null;
    let adapter = null;
    try {
      runtimeLogger = resolved.modules.log.createLogger({ dir: resolveLogDir(core), level: core.log?.level ?? 'info' });
      state.logger = runtimeLogger;

      const storage = resolved.modules.storage.createStorage({ config: core, logger: runtimeLogger });
      const guard = resolved.modules.security.createGuard({ config: core, logger: runtimeLogger });
      const serial = resolved.modules.queue.createSerialQueue();
      const semaphore = resolved.modules.queue.createSemaphore(core.security?.maxConcurrentRuns ?? 2);
      const sessions = resolved.modules.sessions.createSessionStore({
        file: join(core.storage?.rootDir || '.', 'sessions.json'),
        logger: runtimeLogger
      });

      const built = createPlatformAdapter({
        platform: config.platform,
        coreConfig: core,
        logger: runtimeLogger,
        modules: resolved.modules
      });
      if (!built.ok) return fail(built.error);
      adapter = built.adapter;

      const pipelineLogger = typeof runtimeLogger.child === 'function' ? runtimeLogger.child('pipeline') : runtimeLogger;
      const pipeline = resolved.modules.pipeline.createPipeline({
        config: core,
        logger: pipelineLogger,
        client: adapter.client,
        storage,
        guard,
        serial,
        semaphore,
        sessions,
        runDsh: resolved.modules.dsh.runDsh,
        deps: adapter.deps ?? null
      });

      await adapter.start((raw) =>
        pipeline.handleEvent(raw).catch((error) => {
          diag('error', 'handleEvent 未捕获异常', { error: errorText(error) });
        })
      );

      state.adapter = adapter;
      state.pipeline = pipeline;
      state.running = true;
      state.since = now();
      runtimeLogger.info('dsh-bot 运行时已启动', { platform: config.platform, rootDir: core.storage?.rootDir ?? null });
      return { ok: true, status: status() };
    } catch (error) {
      // 半启动状态必须回收：适配器起了一半的连接不能留着重连定时器
      if (adapter && typeof adapter.stop === 'function') {
        try {
          await adapter.stop();
        } catch {
          // 启动已经失败，停不下来也不再有别的补救手段
        }
      }
      state.adapter = null;
      state.pipeline = null;
      state.running = false;
      state.since = null;
      return fail('启动 dsh-bot 运行时失败：' + errorText(error));
    }
  }

  async function stop() {
    const adapter = state.adapter;
    const stopping = state.logger;
    state.adapter = null;
    state.pipeline = null;
    state.running = false;
    state.since = null;
    if (adapter && typeof adapter.stop === 'function') {
      try {
        await adapter.stop();
      } catch (error) {
        diag('warn', '停止平台适配器失败', { error: errorText(error) });
      }
    }
    if (stopping) {
      try {
        await stopping.flush?.();
      } catch {
        // 停运行时的收尾里不再追问日志落盘
      }
      try {
        stopping.info('dsh-bot 运行时已停止');
      } catch {
        // 同上
      }
    }
    return { ok: true, status: status() };
  }

  async function restart() {
    await stop();
    return start();
  }

  return { start, stop, restart, status, isRunning: () => state.running === true };
}
