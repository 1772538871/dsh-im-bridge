import { createConfigStore } from '../src/plugin/config-store.mjs';
import { createApiRoutes } from '../src/plugin/routes.mjs';
import { createRuntime } from '../src/plugin/runtime.mjs';

// 行 id 决定设置命名空间，必须与 cordis.patch.yml 的 insert id 一致
export const name = 'dsh-bot';
export const inject = ['webServer'];

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
    // console 都没有就彻底静默：插件降级不能因为日志把 DSH 启动带崩
  }
}

function webServerOf(ctx) {
  if (ctx && ctx.webServer) return ctx.webServer;
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get('webServer');
  } catch {
    // 服务未注册时 ctx.get 可能抛，按"没有 webServer"处理
  }
  return undefined;
}

function setup(ctx, options) {
  const env = options && options.env ? options.env : process.env;
  const hostLogger = ctx && ctx.logger ? ctx.logger : null;
  const configStore = createConfigStore({ env, filePath: (options && options.configPath) || '', logger: hostLogger });
  const runtime = createRuntime({ configStore, logger: hostLogger });

  const webServer = webServerOf(ctx);
  if (!webServer || typeof webServer.register !== 'function') {
    // 整体降级：没有 webServer 就没有设置页，此时偷偷起一个 bot 只会让用户没有任何止血手段
    warn(hostLogger, 'dsh-bot: 当前会话没有 webServer 服务，设置页接口与运行时均已禁用（已降级）');
    const noop = async () => {};
    return { degraded: true, configStore, runtime, route: null, dispose: noop, teardown: noop };
  }

  const route = createApiRoutes({ configStore, runtime, logger: hostLogger });
  let disposeRoute = null;

  const teardown = async () => {
    try {
      if (disposeRoute) disposeRoute();
    } catch (error) {
      warn(hostLogger, 'dsh-bot: 注销路由失败', { error: String(error?.message ?? error) });
    }
    disposeRoute = null;
    try {
      await runtime.stop();
    } catch (error) {
      warn(hostLogger, 'dsh-bot: 停止运行时失败', { error: String(error?.message ?? error) });
    }
  };

  let dispose = teardown;
  const bindEffect = ctx && typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : null;
  if (bindEffect) {
    // 路由注册放进 effect：卸载时由 cordis 调回 teardown，保证没有悬挂的监听
    dispose = bindEffect(() => {
      disposeRoute = webServer.register(route);
      return async () => {
        await teardown();
      };
    });
  } else {
    disposeRoute = webServer.register(route);
  }

  const view = configStore.read();
  for (const warning of view.warnings) warn(hostLogger, 'dsh-bot: ' + warning);

  if (view.config.enabled === true) {
    // 不 await：DSH 启动流程绝不能被一个外部连接拖住，失败只记录
    Promise.resolve()
      .then(() => runtime.start())
      .then((result) => {
        if (result && result.ok === false) warn(hostLogger, 'dsh-bot: 运行时启动失败', { error: result.error });
      })
      .catch((error) => warn(hostLogger, 'dsh-bot: 运行时启动异常', { error: String(error?.message ?? error) }));
  }

  return { degraded: false, configStore, runtime, route, dispose, teardown };
}

/**
 * 契约 §4：apply 全程 try/catch，任何失败都只写日志，绝不让 DSH 启动失败。
 */
export function apply(ctx, options = {}) {
  try {
    return setup(ctx, options);
  } catch (error) {
    warn(ctx && ctx.logger ? ctx.logger : null, 'dsh-bot: 插件加载失败，已降级（不影响 DSH 启动）', {
      error: String(error?.message ?? error)
    });
    return undefined;
  }
}
