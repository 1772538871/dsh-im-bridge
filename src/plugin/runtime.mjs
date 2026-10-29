import { join } from 'node:path';
import { createPlatformAdapter } from './platforms.mjs';
import { resolveLogDir } from './config-store.mjs';
import { ensureDataLayout } from './data-layout.mjs';

// 内核模块一律按相对本文件的 URL 动态导入：插件被放到 <DSH_HOME>/profiles/*/plugins 下也能解析
const CORE_MODULES = {
  log: '../log.mjs',
  storage: '../storage.mjs',
  security: '../security.mjs',
  queue: '../queue.mjs',
  sessions: '../sessions.mjs',
  pipeline: '../pipeline.mjs',
  dsh: '../dsh.mjs',
  sdkRunner: '../sdk-runner.mjs',
  inprocessRunner: '../inprocess-runner.mjs',
  approvalBridge: '../approval-bridge.mjs',
  questionBridge: '../question-bridge.mjs',
  onebotParse: '../onebot/parse.mjs',
  onebotSend: '../onebot/send.mjs',
  onebotClient: '../onebot/client.mjs',
  qqbotAdapter: '../qqbot/adapter.mjs'
};

const PLATFORM_MODULE = { 'qq-napcat': 'onebotClient', 'qq-official': 'qqbotAdapter' };
const BASE_MODULES = ['log', 'storage', 'security', 'queue', 'sessions', 'pipeline', 'dsh', 'sdkRunner'];

function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

function moduleUrl(name) {
  return new URL(CORE_MODULES[name], import.meta.url).href;
}

/**
 * 只加一层"当前哪个会话在跑"的记录，串行/排队语义完全交给内核队列。
 * inprocess 的审批请求要发回触发它的那个会话，而 pipeline 调 runDsh 时不带 chatKey，
 * 不改 pipeline 逻辑的代价就是在这一层把归属反推回来。
 */
function createTrackingSerial(serial, inFlight) {
  return {
    run(key, fn) {
      const name = String(key);
      return serial.run(name, async () => {
        inFlight.add(name);
        try {
          return await fn();
        } finally {
          inFlight.delete(name);
        }
      });
    },
    pending(key) {
      return typeof serial.pending === 'function' ? serial.pending(key) : 0;
    },
    size() {
      return typeof serial.size === 'function' ? serial.size() : 0;
    }
  };
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

export const TEST_MESSAGE_TEXT = '【测试】消息接入已连通，这是一条来自你电脑的消息。';

// 官方机器人拿不到 QQ 号，只有 openid——一串 ≥20 位的小写十六进制
const OPENID_LIKE = /^[0-9a-f]{20,}$/i;

/**
 * 测试消息发给谁：显式 target > 配置 testTarget > 按平台从白名单里猜。
 * 猜是刻意的：新手填完白名单只想点一下"看看通不通"，不该被迫先搞懂
 * 官方机器人只有 openid、NapCat 只有 QQ 号这件事。
 */
export function resolveTestTarget(config, explicit = '') {
  const wanted = typeof explicit === 'string' ? explicit.trim() : '';
  if (wanted !== '') return { ok: true, target: wanted, source: 'explicit' };
  const configured = typeof config?.testTarget === 'string' ? config.testTarget.trim() : '';
  if (configured !== '') return { ok: true, target: configured, source: 'config' };
  const list = Array.isArray(config?.security?.userWhitelist) ? config.security.userWhitelist : [];
  const candidates = list.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '');
  let pick;
  if (config?.platform === 'qq-official') {
    pick = candidates.filter((item) => OPENID_LIKE.test(item))[0];
  } else if (config?.platform === 'qq-napcat') {
    pick = candidates.filter((item) => /^\d+$/.test(item))[0];
  }
  if (pick) return { ok: true, target: pick, source: 'whitelist' };
  return {
    ok: false,
    error: '不知道该把测试消息发给谁：在「测试消息发给谁」里填一个号，或者先把你自己加进用户白名单。'
  };
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
export function createRuntime({ configStore, logger = null, modules = null, now = () => Date.now(), ctx = null } = {}) {
  if (!configStore || typeof configStore.read !== 'function') throw new Error('createRuntime: 需要 configStore');

  const state = {
    running: false,
    since: null,
    lastError: null,
    // 适配器是按哪个平台建的：配置改过但没重启时它和 config.platform 会不一致，
    // 而「测试消息只能从正在运行的平台发」要的就是这一个。
    platform: '',
    adapter: null,
    pipeline: null,
    logger: null,
    sdkRunner: null,
    inprocessRunner: null,
    approvalBridge: null,
    questionBridge: null
  };

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
    // 空白名单在核心库等于"放行所有人"，启动前必须拦住，否则等于把本机执行权开放给任何能给机器人发消息的人
    const userWhitelist = config.security && Array.isArray(config.security.userWhitelist) ? config.security.userWhitelist : [];
    const groupWhitelist = config.security && Array.isArray(config.security.groupWhitelist) ? config.security.groupWhitelist : [];
    if (userWhitelist.length === 0 && groupWhitelist.length === 0) {
      return fail('白名单为空：请先填写用户白名单（你自己的 QQ 号）或群白名单，否则任何人都能驱动本机 DSH');
    }
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
      // 启动时再补一次（幂等）：用户可能手改了 storage.rootDir，或删掉了某个子目录。
      // 失败只 warn，绝不能因为建不出文件夹就阻止机器人跑起来。
      await ensureDataLayout({ rootDir: core.storage?.rootDir ?? '', logger: runtimeLogger });

      const storage = resolved.modules.storage.createStorage({ config: core, logger: runtimeLogger });
      const guard = resolved.modules.security.createGuard({ config: core, logger: runtimeLogger });
      // 只有 inprocess 会用到 inFlight / chats，但它的开销是两次 Map 操作，没必要为别的 runner 分叉
      const jobState = { inFlight: new Set(), chats: new Map(), lastChatKey: null };
      const serial = createTrackingSerial(resolved.modules.queue.createSerialQueue(), jobState.inFlight);
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

      // --- 审批归属所需的辅助函数：只有 inprocess 会用，但 onEvent 的包装层也要同一份 ---
      // ext.modules 在 inprocess 分支里填（OneBot 的 parse/send 实现），注入式测试可以整体替换
      const ext = { modules: {} };
      const sendReplyOf = () => (typeof adapter.deps?.sendReply === 'function' ? adapter.deps.sendReply : ext.modules.onebotSend?.sendReply);
      const parseInbound = (raw) => {
        const fn = typeof adapter.deps?.parseEvent === 'function' ? adapter.deps.parseEvent : ext.modules.onebotParse?.parseEvent;
        if (typeof fn !== 'function') return null;
        try {
          return fn(raw);
        } catch (error) {
          diag('debug', '解析入站事件失败（只影响审批归属）', { error: errorText(error) });
          return null;
        }
      };
      const chatKeyFor = (message) => {
        try {
          if (typeof adapter.deps?.chatKeyOf === 'function') {
            const key = adapter.deps.chatKeyOf(message);
            if (typeof key === 'string' && key !== '') return key;
          }
        } catch {
          // 退回到下面与 pipeline 相同的兜底规则
        }
        // 必须和 pipeline.chatKeyOf 的兜底一致，否则 sessions.json 里的键对不上
        return message?.chatType === 'group' ? 'group_' + (message?.groupId ?? '') : 'private_' + (message?.userId ?? '');
      };
      // 桥不认识 QQ：它们只把"给这个会话发一段文字"委托出来；kind 只决定日志措辞
      const sendBridgeText = async (chatKey, text, kind = '审批') => {
        const message = jobState.chats.get(chatKey);
        if (!message) {
          diag('warn', kind + '消息没有可用的对话目标（该会话还没来过消息）', { chatKey });
          return;
        }
        const sendReply = sendReplyOf();
        if (typeof sendReply !== 'function') {
          diag('warn', kind + '消息发不出去：没有可用的 sendReply', { chatKey });
          return;
        }
        await sendReply({ client: adapter.client, message, text, config: core, logger: runtimeLogger });
      };
      const chatKeyForSession = (sessionId) => {
        if (sessionId === null || sessionId === undefined) return jobState.lastChatKey;
        try {
          const all = typeof sessions.all === 'function' ? sessions.all() : {};
          const hits = Object.keys(all).filter((key) => String(all[key]) === String(sessionId));
          // sessions.json 的键就是 pipeline 用的 chatKey，反查得到就是权威答案
          if (hits.length === 1) return hits[0];
        } catch {
          // 读不到就往下退
        }
        if (jobState.inFlight.size === 1) return Array.from(jobState.inFlight)[0];
        if (jobState.inFlight.size > 1) {
          diag('debug', '多个会话同时有任务在跑，审批消息发给最近活跃的会话', { sessionId });
        }
        return jobState.lastChatKey;
      };

      // dsh.runner 决定每条消息怎么调 DSH：headless 每条起一个进程，sdk 复用常驻子进程。
      // 默认 headless，切到 sdk 才需要额外握手参数，所以这里只在 sdk 分支建 runner。
      let runDsh = resolved.modules.dsh.runDsh;
      const startInProcess = async () => {
        const extra = await resolveModules(['inprocessRunner', 'approvalBridge', 'questionBridge', 'onebotParse', 'onebotSend'], modules);
        if (extra.missing.length > 0) {
          return fail('缺少进程内调用模块：' + extra.missing.map((item) => item.name + '（' + item.error + '）').join('；'));
        }
        const createInProcessRunner = extra.modules.inprocessRunner?.createInProcessRunner;
        const createApprovalBridge = extra.modules.approvalBridge?.createApprovalBridge;
        const createQuestionBridge = extra.modules.questionBridge?.createQuestionBridge;
        if (typeof createInProcessRunner !== 'function') return fail('进程内 runner 尚未就绪');
        if (!ctx || typeof ctx.get !== 'function') {
          return fail('inprocess 方式需要 DSH 主进程上下文，但插件没有拿到可用的 ctx（请改用 headless 或 sdk）');
        }

        // 平台的 parse/send 实现只在这个分支才需要，所以在这里懒填
        ext.modules = extra.modules;

        const inprocessLogger = typeof runtimeLogger.child === 'function' ? runtimeLogger.child('inprocess') : runtimeLogger;
        const bridgeLogger = typeof runtimeLogger.child === 'function' ? runtimeLogger.child('approval') : runtimeLogger;
        const questionLogger = typeof runtimeLogger.child === 'function' ? runtimeLogger.child('questions') : runtimeLogger;
        if (typeof createApprovalBridge === 'function') {
          state.approvalBridge = createApprovalBridge({
            ctx,
            logger: bridgeLogger,
            // 桥不认识 QQ：它只把"给这个会话发一段文字"这件事委托出来
            send: (chatKey, text) => sendBridgeText(chatKey, text, '审批'),
            config: core
          });
          const attached = state.approvalBridge.attach();
          if (attached && attached.ok === false && attached.error !== 'approval.disabled') {
            diag('warn', '审批转发未启用，进程内调用照常但没有 IM 审批', { error: attached.error });
          }
        }
        // 提问桥与审批桥同构：agent 提问也要能从 QQ 回答，否则网页弹卡、QQ 一片安静
        if (typeof createQuestionBridge === 'function') {
          state.questionBridge = createQuestionBridge({
            ctx,
            logger: questionLogger,
            send: (chatKey, text) => sendBridgeText(chatKey, text, '提问'),
            config: core
          });
          const attached = state.questionBridge.attach();
          if (attached && attached.ok === false && attached.error !== 'questions.disabled') {
            diag('warn', '提问转发未启用，进程内调用照常但没有 IM 提问', { error: attached.error });
          }
        }
        // runner 只认识一个 bridge：own/release 必须同时落到两座桥，否则提问桥永远认不到 agent。
        // 这里捕获局部引用而不是每次读 state：stopInProcess 会先清 state 再停 runner。
        const approvalBridge = state.approvalBridge;
        const questionBridge = state.questionBridge;
        const runnerBridge = {
          own(agent, meta) {
            if (approvalBridge && typeof approvalBridge.own === 'function') approvalBridge.own(agent, meta);
            if (questionBridge && typeof questionBridge.own === 'function') questionBridge.own(agent, meta);
          },
          release(agent) {
            if (approvalBridge && typeof approvalBridge.release === 'function') approvalBridge.release(agent);
            if (questionBridge && typeof questionBridge.release === 'function') questionBridge.release(agent);
          }
        };
        state.inprocessRunner = createInProcessRunner({
          ctx,
          config: core,
          logger: inprocessLogger,
          bridge: runnerBridge
        });
        runDsh = (args = {}) =>
          state.inprocessRunner.run({
            prompt: args.prompt ?? '',
            sessionId: args.sessionId ?? null,
            // 每条消息都要重新定位归属：会话是首次建立时还不存在 sessions.json 的映射
            chatKey: chatKeyForSession(args.sessionId ?? null)
          });
        runtimeLogger.info('已启用进程内 runner（审批与提问请求转发到 IM）', {
          approval: state.approvalBridge ? state.approvalBridge.status() : null,
          questions: state.questionBridge ? state.questionBridge.status() : null
        });
        return { ok: true };
      };

      if (config.dsh && config.dsh.runner === 'sdk') {
        const createSdkRunner = resolved.modules.sdkRunner?.createSdkRunner;
        if (typeof createSdkRunner !== 'function') return fail('SDK runner 尚未就绪');
        const sdkLogger = typeof runtimeLogger.child === 'function' ? runtimeLogger.child('sdk') : runtimeLogger;
        // 懒启动：这里只是建对象，真子进程要等第一条消息进来才 spawn
        state.sdkRunner = createSdkRunner({ config: core, logger: sdkLogger });
        runDsh = (args = {}) => state.sdkRunner.run({ prompt: args.prompt ?? '', sessionId: args.sessionId ?? null });
      } else if (config.dsh && config.dsh.runner === 'inprocess') {
        const started = await startInProcess();
        if (started && started.ok === false) {
          // 半启动（桥已挂上、runner 没建起来）也要收干净：否则监听器会留在 ctx 上等一个不存在的 runner
          await stopInProcess({ quiet: true });
          return started;
        }
      }

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
        runDsh,
        // /status 要报"有没有审批/提问挂着"：包一层是因为桥会随启停重建，pipeline 不能抓着旧引用
        approvalBridge: { pendingCount: () => (state.approvalBridge && typeof state.approvalBridge.pendingCount === 'function' ? state.approvalBridge.pendingCount() : 0) },
        questionBridge: { pendingCount: () => (state.questionBridge && typeof state.questionBridge.pendingCount === 'function' ? state.questionBridge.pendingCount() : 0) },
        deps: adapter.deps ?? null
      });

      // onEvent 外层再包一层：提问/审批答复必须先被桥看到，命中就只回一句确认，绝不落进 pipeline 当新任务
      await adapter.start(async (raw) => {
        if (state.questionBridge || state.approvalBridge) {
          try {
            const parsed = parseInbound(raw);
            const message = parsed && parsed.kind === 'message' ? parsed.message : null;
            if (message) {
              const chatKey = chatKeyFor(message);
              // 记下每个会话最近一条入站消息：桥的消息要能回到同一个会话（含 QQ 官方的回复目标）
              jobState.chats.set(chatKey, message);
              jobState.lastChatKey = chatKey;
              const text = typeof message.text === 'string' ? message.text : '';
              // 提问排在审批前面：两者同时挂着时，任何文本都可能是"问题的答案"，而审批只认很窄的词表
              if (state.questionBridge && state.questionBridge.handleReply({ chatKey, text })) return;
              // 命中就 return：这条是审批答复，不能再当新任务派下去
              if (state.approvalBridge && state.approvalBridge.handleReply({ chatKey, text })) return;
            }
          } catch (error) {
            diag('debug', '处理提问/审批答复时出错，按普通消息继续', { error: errorText(error) });
          }
        }
        return pipeline.handleEvent(raw).catch((error) => {
          diag('error', 'handleEvent 未捕获异常', { error: errorText(error) });
        });
      });

      state.adapter = adapter;
      state.pipeline = pipeline;
      state.platform = config.platform;
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
      state.platform = '';
      // 半启动的常驻子进程同样要收：否则它在后台永远占着一条 stdio 通道
      if (state.sdkRunner && typeof state.sdkRunner.stop === 'function') {
        try {
          await state.sdkRunner.stop();
        } catch {
          // 启动已经失败，停不下来也不再有别的补救手段
        }
      }
      state.sdkRunner = null;
      // 半启动的进程内 runner 同样要收：它建的 agent 还占着审批回调与模型额度
      await stopInProcess({ quiet: true });
      state.running = false;
      state.since = null;
      return fail('启动 dsh-bot 运行时失败：' + errorText(error));
    }
  }

  /** 收掉 inprocess 的 runner 与审批桥：先摘监听，再释放 agent，顺序反过来会漏掉"正在等的审批"。 */
  async function stopInProcess({ quiet = false } = {}) {
    const approvalBridge = state.approvalBridge;
    const questionBridge = state.questionBridge;
    const inprocessRunner = state.inprocessRunner;
    state.approvalBridge = null;
    state.questionBridge = null;
    state.inprocessRunner = null;
    if (questionBridge && typeof questionBridge.detach === 'function') {
      try {
        questionBridge.detach();
      } catch (error) {
        if (!quiet) diag('warn', '卸载提问桥失败', { error: errorText(error) });
      }
    }
    if (approvalBridge && typeof approvalBridge.detach === 'function') {
      try {
        approvalBridge.detach();
      } catch (error) {
        if (!quiet) diag('warn', '卸载审批桥失败', { error: errorText(error) });
      }
    }
    if (inprocessRunner && typeof inprocessRunner.stop === 'function') {
      try {
        await inprocessRunner.stop();
      } catch (error) {
        if (!quiet) diag('warn', '停止进程内 runner 失败', { error: errorText(error) });
      }
    }
  }

  async function stop() {
    const adapter = state.adapter;
    const stopping = state.logger;
    const sdkRunner = state.sdkRunner;
    state.adapter = null;
    state.pipeline = null;
    state.sdkRunner = null;
    state.platform = '';
    state.running = false;
    state.since = null;
    if (adapter && typeof adapter.stop === 'function') {
      try {
        await adapter.stop();
      } catch (error) {
        diag('warn', '停止平台适配器失败', { error: errorText(error) });
      }
    }
    // 审批桥先摘：否则 agent 释放时最后几条审批会尝试往已经停掉的适配器发消息
    await stopInProcess();
    // 先停适配器再停 sdk 子进程：反过来会让收消息和收进程同时进行，日志里全是干扰
    if (sdkRunner && typeof sdkRunner.stop === 'function') {
      try {
        await sdkRunner.stop();
      } catch (error) {
        diag('warn', '停止 SDK 子进程失败', { error: errorText(error) });
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

  /**
   * 「发送测试消息」：借已经启动的适配器发一句话，证明"配置 -> 连接 -> 送达"整条路是通的。
   * 全程返回 {ok:false, error} 而不抛：设置页要的是一句人话，不是堆栈。
   */
  async function sendTest(target = '') {
    const adapter = state.adapter;
    if (state.running !== true || !adapter) {
      return { ok: false, error: '机器人还没启动：先点「启动」，状态行显示「运行中」再发测试消息。' };
    }

    let config = {};
    try {
      config = configStore.read().config ?? {};
    } catch (error) {
      return { ok: false, error: '读不到配置：' + errorText(error) };
    }

    const resolved = resolveTestTarget(config, target);
    if (resolved.ok !== true) return { ok: false, error: resolved.error };

    const core = coreConfigOf(config);
    // QQ 官方适配器自带 deps.sendReply；OneBot 的 deps 由 pipeline 自己按需装配（adapter.deps 是 null），
    // 测试消息没有 pipeline 可用，只能在这里按同一份模块表补齐——否则默认平台反而测不了。
    let sendReply = typeof adapter.deps?.sendReply === 'function' ? adapter.deps.sendReply : null;
    if (!sendReply) {
      const extra = await resolveModules(['onebotSend'], modules);
      const injected = extra.modules.onebotSend?.sendReply;
      sendReply = typeof injected === 'function' ? injected : null;
    }
    if (!sendReply) {
      return { ok: false, error: '这个平台还不支持测试消息：适配器没有提供发送能力。' };
    }

    let result;
    try {
      // 私聊发：群聊必须 @ 才送达，测试消息不该逼用户先建一个群
      result = await sendReply({
        client: adapter.client,
        message: { chatType: 'private', userId: resolved.target },
        text: TEST_MESSAGE_TEXT,
        config: core,
        logger: state.logger
      });
    } catch (error) {
      return { ok: false, error: '发送测试消息失败：' + errorText(error) };
    }

    const sent = Number(result?.sent) || 0;
    const failed = Number(result?.failed) || 0;
    if (sent <= 0) {
      return {
        ok: false,
        error:
          '发不出去（目标 ' + resolved.target + '）：机器人可能没连上平台，或这个号收不了消息。' +
          '看一眼状态行的「最近错误」和今天的日志。'
      };
    }
    // chunkCount 把失败的分段也算进去：用户关心的是"我这条测试到底被拆成几段发过"
    return { ok: true, target: resolved.target, chunkCount: sent + failed };
  }

  // 正在跑的适配器属于哪个平台（没在跑就是空串）。配置里改过平台但还没重启时，
  // 它和 status().platform 是两个答案，而测试消息只能走这一个。
  function runningPlatform() {
    return state.running === true ? state.platform : '';
  }

  return { start, stop, restart, status, sendTest, runningPlatform, isRunning: () => state.running === true };
}
