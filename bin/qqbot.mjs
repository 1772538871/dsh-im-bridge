#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";

const USAGE = `dsh-im-bridge · 官方 QQ 机器人（QQ Bot API v2）<-> 本机 DSH

用法：
  node bin/qqbot.mjs --config <path>                启动桥接（连 QQ 网关并转发到 DSH）
  node bin/qqbot.mjs --config <path> --check        只校验配置并打印摘要后退出（不联网）
  node bin/qqbot.mjs --config <path> --dry-run "文本"  用假 client 走一遍 pipeline（真实调用 DSH）
  node bin/qqbot.mjs --help

选项：
  --config <path>     配置文件路径；也可用环境变量 DSH_BRIDGE_CONFIG
  --check             只校验并打印摘要，不连网关、不取 token
  --dry-run <text>    只处理这一条假消息，回复打印到 stdout，不发送到 QQ
  -h, --help          显示本帮助

环境变量：
  QQBOT_APP_ID        qqbot.appId 为空时的兜底
  QQBOT_CLIENT_SECRET qqbot.clientSecret 为空时的兜底（建议只走这个，别把密钥写进文件）
`;

export function parseArgs(argv = []) {
  const options = { configPath: null, check: false, dryRun: null, help: false, unknown: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--config") {
      options.configPath = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length);
    else if (arg === "--dry-run") {
      options.dryRun = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("--dry-run=")) options.dryRun = arg.slice("--dry-run=".length);
    else options.unknown.push(arg);
  }
  return options;
}

async function tryImport(path) {
  try {
    return await import(path);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

/** 形态对齐网关下发的 dispatch 帧（op:0 + t + d），单聊事件，user_openid 用固定哨兵值方便放行白名单。 */
export function buildDryRunPayload(text, { appId = "" } = {}) {
  return {
    op: 0,
    s: 0,
    t: "C2C_MESSAGE_CREATE",
    id: "dry-run-event",
    d: {
      id: "dry-run-message",
      author: { user_openid: "dry-run", username: "dry-run", bot: false },
      content: text,
      message_type: 0,
      timestamp: new Date().toISOString(),
      message_scene: { source: "default", ext: [] },
      _appId: appId,
    },
  };
}

function qqSummary(resolved) {
  return [
    "QQ Bot 参数",
    "  apiBase   : " + resolved.apiBase,
    "  appId     : " + (resolved.appId || "(未配置)"),
    "  secret    : " + (resolved.clientSecret ? "已配置" : "未配置"),
    "  intents   : " + resolved.intents + "（GROUP_AND_C2C_EVENT = 1<<25）",
    "  shard     : [" + resolved.shard.join(", ") + "]",
    "  重连      : " + resolved.reconnectMinMs + "-" + resolved.reconnectMaxMs + "ms",
  ].join("\n");
}

/**
 * CLI 主体。返回进程退出码（常驻模式下永不 resolve）。
 * io 只为测试注入 stdout/stderr，生产走 process 流。
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;

  const options = parseArgs(argv);
  if (options.help) {
    out.write(USAGE);
    return 0;
  }
  if (options.unknown.length > 0) {
    err.write("未知参数：" + options.unknown.join(" ") + "\n\n" + USAGE);
    return 2;
  }

  const configModule = await tryImport("../src/config.mjs");
  if (!configModule?.loadConfig || !configModule?.validateConfig) {
    err.write("找不到 src/config.mjs（或缺少 loadConfig/validateConfig），无法加载配置。\n");
    return 1;
  }

  let loaded;
  try {
    loaded = configModule.loadConfig({ filePath: options.configPath ?? undefined, env });
  } catch (error) {
    err.write("配置加载失败：" + (error?.message ?? error) + "\n");
    for (const problem of error?.problems ?? []) err.write("  - " + problem + "\n");
    return 1;
  }

  for (const warning of Array.isArray(loaded?.warnings) ? loaded.warnings : []) err.write("警告：" + warning + "\n");

  let verdict;
  try {
    verdict = configModule.validateConfig(loaded?.config ?? {}, { env });
  } catch (error) {
    err.write("配置校验异常：" + (error?.message ?? error) + "\n");
    return 1;
  }
  if (!verdict?.ok) {
    err.write("配置校验失败（" + (loaded?.filePath ?? options.configPath ?? "?") + "）：\n");
    for (const problem of verdict?.problems ?? []) err.write("  - " + problem + "\n");
    return 1;
  }

  const config = verdict.config ?? loaded.config;

  const adapterModule = await tryImport("../src/qqbot/adapter.mjs");
  if (!adapterModule?.createQqBotAdapter) {
    err.write("缺少依赖模块：../src/qqbot/adapter.mjs\n");
    return 1;
  }

  // QQ 侧必填项不放进 config.mjs：那里是两条腿共用的，缺 AppID 不该让 OneBot 配置报错
  const qqProblems = adapterModule.qqBotProblems(config, env);
  const resolved = adapterModule.resolveQqBotConfig(config, env);

  if (options.check) {
    if (typeof configModule.formatConfigSummary === "function") out.write(configModule.formatConfigSummary(config) + "\n");
    out.write(qqSummary(resolved) + "\n");
    if (qqProblems.length > 0) {
      err.write("QQ Bot 配置未就绪：\n");
      for (const problem of qqProblems) err.write("  - " + problem + "\n");
      return 1;
    }
    out.write("QQ Bot 配置校验通过（--check 不联网，未验证 AppID/Secret 是否有效）。\n");
    return 0;
  }

  if (qqProblems.length > 0) {
    err.write("QQ Bot 配置未就绪：\n");
    for (const problem of qqProblems) err.write("  - " + problem + "\n");
    return 1;
  }

  const modules = {};
  for (const [name, path] of [
    ["log", "../src/log.mjs"],
    ["storage", "../src/storage.mjs"],
    ["security", "../src/security.mjs"],
    ["queue", "../src/queue.mjs"],
    ["sessions", "../src/sessions.mjs"],
    ["pipeline", "../src/pipeline.mjs"],
  ]) {
    modules[name] = await tryImport(path);
    if (!modules[name]) {
      err.write("缺少依赖模块：" + path + "\n");
      return 1;
    }
  }

  const { createLogger } = modules.log;
  const { createStorage } = modules.storage;
  const { createGuard } = modules.security;
  const { createSerialQueue, createSemaphore } = modules.queue;
  const { createSessionStore } = modules.sessions;
  const { createPipeline } = modules.pipeline;
  const { runDsh } = await import("../src/dsh.mjs");

  const logger = createLogger({ dir: config.log?.dir, level: config.log?.level ?? "info" });
  const storage = createStorage({ config, logger });
  const guard = createGuard({ config, logger });
  const serial = createSerialQueue();
  const semaphore = createSemaphore(config.security?.maxConcurrentRuns ?? 2);
  const sessions = createSessionStore({ file: (config.storage?.rootDir ?? ".") + "/sessions.json", logger });
  const pipelineLogger = typeof logger.child === "function" ? logger.child("pipeline") : logger;

  const adapter = adapterModule.createQqBotAdapter({ config, logger: logger.child?.("qqbot") ?? logger, env });

  if (options.dryRun !== null) {
    const printed = [];
    const fakeClient = {
      start() {},
      async stop() {},
      isOpen: () => true,
      status: () => ({ open: true, lastError: null, attempts: 0 }),
      async sendMessage({ chatType, target, body }) {
        logger.info("dry-run: 跳过 QQ Bot 调用", { chatType, target, msgType: body?.msg_type });
        return { id: "dry-run", timestamp: new Date().toISOString() };
      },
      async call(action, params) {
        logger.info("dry-run: 跳过 QQ Bot 调用", { action, params });
        return {};
      },
    };
    const pipeline = createPipeline({
      config,
      logger: pipelineLogger,
      client: fakeClient,
      storage,
      guard,
      serial,
      semaphore,
      sessions,
      runDsh,
      deps: {
        ...adapter.deps,
        sendReply: async ({ text }) => {
          printed.push(text);
          out.write("--- 将要发送到 QQ ---\n" + text + "\n--- 结束 ---\n");
          return { sent: 1, failed: 0 };
        },
      },
    });

    out.write("dry-run：DSH 工作目录 " + (config.dsh?.cwd ?? "?") + "（不存在会在调用 DSH 时自动创建）\n");
    await pipeline.handleEvent(buildDryRunPayload(options.dryRun, { appId: resolved.appId }));
    out.write("dry-run 统计：" + JSON.stringify(pipeline.stats()) + "\n");
    if (printed.length === 0) {
      out.write("dry-run 没有产生任何回复：消息可能被安全策略拒绝（白名单需包含 dry-run 用户）。\n");
    }
    await logger.flush?.();
    return 0;
  }

  const pipeline = createPipeline({
    config,
    logger: pipelineLogger,
    client: adapter.client,
    storage,
    guard,
    serial,
    semaphore,
    sessions,
    runDsh,
    deps: adapter.deps,
  });

  let stopping = false;
  const shutdown = async (signalName) => {
    if (stopping) return;
    stopping = true;
    logger.info("收到 " + signalName + "，正在退出");
    try {
      await adapter.stop();
    } catch (error) {
      logger.warn("停止 QQ Bot 网关失败", { error: String(error?.message ?? error) });
    }
    try {
      await logger.flush?.();
    } catch {
      /* 退出阶段不再追问日志落盘 */
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("DSH 工作目录", { cwd: config.dsh?.cwd ?? null });
  await adapter.start((raw) => {
    pipeline.handleEvent(raw).catch((error) => {
      logger.error("handleEvent 未捕获异常", { error: String(error?.message ?? error) });
    });
  });
  out.write(
    "qqbot 已启动：apiBase " + resolved.apiBase + "，appId " + resolved.appId + "；DSH 工作目录 " + (config.dsh?.cwd ?? "?") + "\n",
  );
  return await new Promise(() => {});
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath !== "" && import.meta.url === invokedPath) {
  main()
    .then((code) => {
      if (typeof code === "number" && code !== 0) process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write("启动失败：" + (error?.stack ?? error) + "\n");
      process.exitCode = 1;
    });
}
