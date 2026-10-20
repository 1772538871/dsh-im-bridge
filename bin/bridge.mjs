#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";

const USAGE = `dsh-im-bridge · QQ(NapCat/OneBot 11) <-> 本机 DSH

用法：
  node bin/bridge.mjs --config <path>                启动桥接（连 OneBot 并转发到 DSH）
  node bin/bridge.mjs --config <path> --check        只校验配置并打印摘要后退出
  node bin/bridge.mjs --config <path> --dry-run "文本"  用假 client 走一遍 pipeline（真实调用 DSH）
  node bin/bridge.mjs --help

选项：
  --config <path>     配置文件路径；也可用环境变量 DSH_BRIDGE_CONFIG
  --check             只校验并打印摘要，不连 WebSocket
  --dry-run <text>    只处理这一条假消息，回复打印到 stdout，不发送到 QQ
  -h, --help          显示本帮助
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

/** createOneBotClient 的参数。重连节奏必须从 config 透传，否则改配置没有任何效果。 */
export function buildOneBotClientOptions({ config, logger, onEvent, onStatus }) {
  return {
    url: config?.onebot?.wsUrl,
    accessToken: config?.onebot?.accessToken ?? "",
    logger,
    onEvent,
    onStatus,
    // 显式传 undefined 时 client 会落回自己的默认值（1000/30000）
    reconnectMinMs: config?.onebot?.reconnectMinMs,
    reconnectMaxMs: config?.onebot?.reconnectMaxMs,
  };
}

export function buildDryRunEvent(text) {
  // 形态对齐 OneBot 11 的私聊消息事件；user_id 用固定哨兵值方便在白名单里放行
  return {
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    self_id: "0",
    user_id: "dry-run",
    time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text } }],
    raw_message: text,
    sender: { user_id: 0, nickname: "dry-run" },
  };
}

/**
 * CLI 主体。返回进程退出码（常驻模式下永不 resolve）。
 * io 只为测试注入 stdout/stderr，生产走 process 流。
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;

  const options = parseArgs(argv);
  if (options.help) {
    out.write(USAGE);
    return 0;
  }
  if (options.unknown.length > 0) {
    err.write(`未知参数：${options.unknown.join(" ")}\n\n${USAGE}`);
    return 2;
  }

  const configModule = await tryImport("../src/config.mjs");
  if (!configModule?.loadConfig || !configModule?.validateConfig) {
    err.write("找不到 src/config.mjs（或缺少 loadConfig/validateConfig），无法加载配置。\n");
    return 1;
  }

  let loaded;
  try {
    loaded = configModule.loadConfig({ filePath: options.configPath ?? undefined });
  } catch (error) {
    err.write(`配置加载失败：${error?.message ?? error}\n`);
    for (const problem of error?.problems ?? []) err.write(`  - ${problem}\n`);
    return 1;
  }

  const warnings = Array.isArray(loaded?.warnings) ? loaded.warnings : [];
  for (const warning of warnings) err.write(`警告：${warning}\n`);

  let verdict;
  try {
    verdict = configModule.validateConfig(loaded?.config ?? {});
  } catch (error) {
    err.write(`配置校验异常：${error?.message ?? error}\n`);
    return 1;
  }
  if (!verdict?.ok) {
    err.write(`配置校验失败（${loaded?.filePath ?? options.configPath ?? "?"}）：\n`);
    for (const problem of verdict?.problems ?? []) err.write(`  - ${problem}\n`);
    return 1;
  }

  const config = verdict.config ?? loaded.config;

  if (options.check) {
    if (typeof configModule.formatConfigSummary === "function") out.write(`${configModule.formatConfigSummary(config)}\n`);
    else out.write(`配置校验通过：${loaded?.filePath ?? options.configPath ?? "?"}\n`);
    return 0;
  }

  const modules = {};
  for (const [name, path] of [
    ["log", "../src/log.mjs"],
    ["storage", "../src/storage.mjs"],
    ["security", "../src/security.mjs"],
    ["queue", "../src/queue.mjs"],
    ["sessions", "../src/sessions.mjs"],
    ["pipeline", "../src/pipeline.mjs"],
    ["onebotClient", "../src/onebot/client.mjs"],
  ]) {
    modules[name] = await tryImport(path);
    if (!modules[name]) {
      err.write(`缺少依赖模块：${path}\n`);
      return 1;
    }
  }

  const { createLogger } = modules.log;
  const { createStorage } = modules.storage;
  const { createGuard } = modules.security;
  const { createSerialQueue, createSemaphore } = modules.queue;
  const { createSessionStore } = modules.sessions;
  const { createPipeline } = modules.pipeline;
  const { createOneBotClient } = modules.onebotClient;
  const { runDsh } = await import("../src/dsh.mjs");

  const logger = createLogger({ dir: config.log?.dir, level: config.log?.level ?? "info" });
  const storage = createStorage({ config, logger });
  const guard = createGuard({ config, logger });
  const serial = createSerialQueue();
  const semaphore = createSemaphore(config.security?.maxConcurrentRuns ?? 2);
  const sessions = createSessionStore({
    file: `${config.storage?.rootDir ?? "."}/sessions.json`,
    logger,
  });
  const pipelineLogger = typeof logger.child === "function" ? logger.child("pipeline") : logger;

  if (options.dryRun !== null) {
    const printed = [];
    const fakeClient = {
      start() {},
      async stop() {},
      isOpen: () => true,
      status: () => ({ open: true, lastError: null, attempts: 0 }),
      async call(action, params) {
        logger.info("dry-run: 跳过 OneBot 调用", { action, params });
        return { status: "ok", retcode: 0, data: {} };
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
        sendReply: async ({ text }) => {
          printed.push(text);
          out.write(`--- 将要发送到 QQ ---\n${text}\n--- 结束 ---\n`);
          return { sent: 1, failed: 0 };
        },
      },
    });

    out.write(`dry-run：DSH 工作目录 ${config.dsh?.cwd ?? "?"}（不存在会在调用 DSH 时自动创建）\n`);
    await pipeline.handleEvent(buildDryRunEvent(options.dryRun));
    const stats = pipeline.stats();
    out.write(`dry-run 统计：${JSON.stringify(stats)}\n`);
    if (printed.length === 0) {
      out.write("dry-run 没有产生任何回复：消息可能被安全策略拒绝（白名单需包含 dry-run 用户）。\n");
    }
    await logger.flush?.();
    return 0;
  }

  const client = createOneBotClient(
    buildOneBotClientOptions({
      config,
      logger,
      onEvent: (raw) => {
        pipeline.handleEvent(raw).catch((error) => {
          logger.error("handleEvent 未捕获异常", { error: String(error?.message ?? error) });
        });
      },
      onStatus: (status) => logger.info("OneBot 连接状态", status),
    }),
  );

  const pipeline = createPipeline({
    config,
    logger: pipelineLogger,
    client,
    storage,
    guard,
    serial,
    semaphore,
    sessions,
    runDsh,
  });

  let stopping = false;
  const shutdown = async (signalName) => {
    if (stopping) return;
    stopping = true;
    logger.info(`收到 ${signalName}，正在退出`);
    try {
      await client.stop();
    } catch (error) {
      logger.warn("停止 OneBot 连接失败", { error: String(error?.message ?? error) });
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
  client.start();
  out.write(
    `bridge 已启动：OneBot ${config.onebot?.wsUrl ?? "?"}；DSH 工作目录 ${config.dsh?.cwd ?? "?"}（不存在时会在调用 DSH 前自动创建）\n`,
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
      process.stderr.write(`启动失败：${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
