import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPipeline, enrichFileCallSpec } from "../src/pipeline.mjs";
import { buildPrompt } from "../src/prompt.mjs";

const CHAT_KEY = "private_10001";
const CONFIG_MODULE_URL = new URL("../src/config.mjs", import.meta.url);

function makeConfig(overrides = {}) {
  return {
    onebot: { wsUrl: "ws://127.0.0.1:3001", accessToken: "", reconnectMinMs: 1000, reconnectMaxMs: 30000 },
    dsh: {
      nodePath: "D:\\Node\\node.exe",
      binPath: "C:\\dsh\\lib\\bin.js",
      profile: "im-bridge",
      cwd: "C:/work",
      timeoutMs: 1000,
      permissionMode: "workspace-write",
      env: {},
    },
    storage: { rootDir: "C:/bridge", maxFileBytes: 104857600, retentionDays: 30 },
    security: {
      userWhitelist: [],
      groupWhitelist: [],
      allowPrivate: true,
      allowGroup: true,
      groupRequireAt: true,
      rateLimitPerMinute: 6,
      maxConcurrentRuns: 2,
      maxPromptChars: 8000,
    },
    reply: { maxChunkChars: 1500, errorPrefix: "[bridge] ", showSessionId: false },
    asr: { command: "", args: [], timeoutMs: 1000 },
    log: { dir: "C:/bridge/logs", level: "info" },
    ...overrides,
  };
}

function makeMessage(overrides = {}) {
  const text = overrides.text ?? "帮我看看这个报错";
  return {
    messageId: "1001",
    chatType: "private",
    userId: "10001",
    groupId: null,
    selfId: "0",
    senderName: "tester",
    time: 1700000000,
    text,
    segments: [{ type: "text", data: { text } }],
    atTargets: [],
    replyTo: null,
    ...overrides,
  };
}

function makeLogger() {
  const lines = [];
  const logger = {
    lines,
    info: (msg, meta) => lines.push({ level: "info", msg, meta }),
    warn: (msg, meta) => lines.push({ level: "warn", msg, meta }),
    error: (msg, meta) => lines.push({ level: "error", msg, meta }),
    debug: (msg, meta) => lines.push({ level: "debug", msg, meta }),
    child: () => logger,
    flush: async () => {},
    filePath: "C:/bridge/logs/mem.log",
  };
  return logger;
}

// 同 key 串行、不同 key 并行：语义与 src/queue.mjs 的 createSerialQueue 一致
function makeSerial() {
  const chains = new Map();
  return {
    run(key, fn) {
      const previous = chains.get(key) ?? Promise.resolve();
      const next = previous.then(fn, fn);
      chains.set(
        key,
        next.then(
          () => {},
          () => {},
        ),
      );
      return next;
    },
    pending() {
      return 0;
    },
    size() {
      return chains.size;
    },
  };
}

// 会真正排队等待的信号量：上限只能靠等待才能观察到，直接自增是测不出来的
function makeSemaphore(limit) {
  const state = { active: 0, max: 0 };
  const waiters = [];
  return {
    state,
    limit,
    async withPermit(fn) {
      if (state.active >= limit) await new Promise((resolve) => waiters.push(resolve));
      state.active += 1;
      state.max = Math.max(state.max, state.active);
      try {
        return await fn();
      } finally {
        state.active -= 1;
        const next = waiters.shift();
        if (next) next();
      }
    },
    active() {
      return state.active;
    },
  };
}

function makeHarness(options = {}) {
  const logger = makeLogger();
  const config = options.config ?? makeConfig();
  const message = options.message ?? makeMessage();
  const sent = [];
  const runCalls = [];
  const setCalls = [];
  const clientCalls = [];
  const sessionMap = new Map();
  const serial = makeSerial();
  const semaphore = options.semaphore ?? makeSemaphore(2);
  const decision = options.decision ?? { allow: true, reason: "ok" };

  const storage = options.storage ?? {
    rootDir: "C:/bridge",
    async saveFromUrl(url, opts) {
      return {
        path: `C:/bridge/media/2024-01-01/private_10001/1-${opts.kind}-${opts.filename}`,
        bytes: 12,
        sha256: "sha",
      };
    },
  };

  const pipeline = createPipeline({
    config,
    logger,
    client: {
      isOpen: () => true,
      async call(action, params) {
        clientCalls.push({ action, params });
        return { status: "ok", retcode: 0, data: { url: "http://onebot/img" } };
      },
    },
    storage,
    guard: { decide: () => decision },
    serial,
    semaphore,
    sessions: {
      get: (key) => sessionMap.get(key),
      async set(key, value) {
        setCalls.push([key, value]);
        sessionMap.set(key, value);
      },
      async clear(key) {
        sessionMap.delete(key);
      },
      all: () => Object.fromEntries(sessionMap),
    },
    runDsh: async (args) => {
      runCalls.push(args);
      if (typeof options.runDshImpl === "function") return await options.runDshImpl(args);
      return options.runDshResult ?? { ok: true, text: "ANSWER", sessionId: "session-new" };
    },
    deps: {
      parseEvent: options.parseEvent ?? ((raw) => ({ kind: "message", message: raw?.message ?? message })),
      planMedia: options.planMedia ?? (() => ({ needsFetch: true, url: "http://onebot/url", filename: "a.png", ext: "png" })),
      sendReply: async ({ message: target, text }) => {
        sent.push({ chatKey: CHAT_KEY, text, target });
        return { sent: 1, failed: 0 };
      },
      chatKeyOf: options.chatKeyOf ?? (() => CHAT_KEY),
      transcribe: options.transcribe ?? (async () => ({ ok: false, text: "", reason: "not_configured" })),
      ...(options.deps ?? {}),
    },
  });

  return {
    pipeline,
    config,
    message,
    logger,
    sent,
    runCalls,
    setCalls,
    clientCalls,
    sessionMap,
    serial,
    semaphore,
  };
}

test("buildPrompt：纯文本 + 附件路径 + 语音转写都写进去", () => {
  const prompt = buildPrompt({
    config: makeConfig(),
    message: makeMessage({ text: "这张图是什么？" }),
    savedAttachments: [{ kind: "image", filename: "a.png", path: "C:/bridge/media/a.png" }],
    voiceTranscript: "这是语音转写内容",
  });
  assert.match(prompt, /QQ 机器人/);
  assert.match(prompt, /纯文本/);
  assert.match(prompt, /1500 字以内/);
  assert.match(prompt, /图片（a\.png）：C:\/bridge\/media\/a\.png/);
  assert.match(prompt, /这是语音转写内容/);
  assert.match(prompt, /这张图是什么？/);
});

test("buildPrompt：超长原文截断到 security.maxPromptChars", () => {
  const longText = "字".repeat(200);
  const prompt = buildPrompt({
    config: makeConfig({ security: { ...makeConfig().security, maxPromptChars: 10 } }),
    message: makeMessage({ text: longText }),
  });
  assert.match(prompt, /原文过长已截断，共 200 字符/);
  assert.equal(prompt.includes(longText), false);
  assert.equal(prompt.includes("字".repeat(10) + "字"), false);
  assert.match(prompt, new RegExp("字".repeat(10) + "\n"));
});

test("buildPrompt：空文本 + 仅附件也能构造合法 prompt", () => {
  const prompt = buildPrompt({
    config: makeConfig(),
    message: makeMessage({ text: "" }),
    savedAttachments: [{ kind: "file", filename: "b.zip", path: "C:/bridge/media/b.zip" }],
  });
  assert.match(prompt, /用户只发了附件/);
  assert.match(prompt, /文件（b\.zip）：C:\/bridge\/media\/b\.zip/);
});

test("buildPrompt：空文本且无附件也有兜底说明", () => {
  const prompt = buildPrompt({ config: makeConfig(), message: makeMessage({ text: "" }) });
  assert.match(prompt, /用户没有发送文字内容/);
});

test("pipeline：放行 → 落地附件 → runDsh → sendReply", async () => {
  const h = makeHarness({
    message: makeMessage({
      text: "看下这张图",
      segments: [
        { type: "text", data: { text: "看下这张图" } },
        { type: "image", data: { file: "a.png" } },
      ],
    }),
  });

  await h.pipeline.handleEvent({ post_type: "message" });

  assert.equal(h.runCalls.length, 1);
  assert.equal(h.runCalls[0].sessionId, null);
  assert.match(h.runCalls[0].prompt, /C:\/bridge\/media\/2024-01-01\/private_10001\/1-image-a\.png/);
  assert.match(h.runCalls[0].prompt, /看下这张图/);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, "ANSWER");
  assert.deepEqual(h.setCalls, [[CHAT_KEY, "session-new"]]);
  assert.deepEqual(h.pipeline.stats(), {
    received: 1,
    handled: 1,
    failed: 0,
    denied: 0,
    ignored: 0,
    parseErrors: 0,
  });
});

test("pipeline：已有会话时把 sessionId 传给 runDsh", async () => {
  const h = makeHarness();
  h.sessionMap.set(CHAT_KEY, "session-old");
  await h.pipeline.handleEvent({ post_type: "message" });
  assert.equal(h.runCalls[0].sessionId, "session-old");
  assert.deepEqual(h.setCalls, [[CHAT_KEY, "session-new"]]);
});

test("pipeline：被拒 → 不发消息，只记日志", async () => {
  const h = makeHarness({ decision: { allow: false, reason: "user_not_allowed" } });
  await h.pipeline.handleEvent({ post_type: "message" });

  assert.equal(h.runCalls.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.pipeline.stats().denied, 1);
  const rejected = h.logger.lines.find((line) => line.msg === "消息被安全策略拒绝");
  assert.ok(rejected, "应记录拒绝日志");
  assert.equal(rejected.level, "debug");
  assert.equal(rejected.meta.reason, "user_not_allowed");
});

test("pipeline：非 message 事件直接忽略", async () => {
  const h = makeHarness({ parseEvent: () => ({ kind: "meta_event" }) });
  await h.pipeline.handleEvent({ post_type: "meta_event" });
  assert.equal(h.pipeline.stats().ignored, 1);
  assert.equal(h.runCalls.length, 0);
  assert.equal(h.sent.length, 0);
});

test("pipeline：runDsh 失败 → 发带 errorPrefix 的错误回复，不带堆栈", async () => {
  const h = makeHarness({ runDshResult: { ok: false, reason: "timeout", exitCode: null, text: "" } });
  await h.pipeline.handleEvent({ post_type: "message" });

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, "[bridge] 处理超时了，请稍后再发一次。");
  assert.equal(/Stack|\n\s+at /.test(h.sent[0].text), false);
  assert.equal(h.pipeline.stats().failed, 1);
  assert.deepEqual(h.setCalls, []);
});

test("pipeline：runDsh 抛错也降级成错误回复", async () => {
  const h = makeHarness({
    runDshImpl: () => {
      throw new Error("boom");
    },
  });
  await h.pipeline.handleEvent({ post_type: "message" });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /^\[bridge\] /);
  assert.equal(h.sent[0].text.includes("boom"), false);
});

test("pipeline：附件下载失败降级成文字说明，不整条失败", async () => {
  const h = makeHarness({
    message: makeMessage({
      text: "看图",
      segments: [
        { type: "text", data: { text: "看图" } },
        { type: "image", data: { file: "a.png" } },
      ],
    }),
    storage: {
      rootDir: "C:/bridge",
      async saveFromUrl() {
        throw new Error("HTTP 404");
      },
    },
  });

  await h.pipeline.handleEvent({ post_type: "message" });
  assert.equal(h.runCalls.length, 1);
  assert.match(h.runCalls[0].prompt, /未能保存（HTTP 404）/);
  assert.equal(h.sent[0].text, "ANSWER");
});

test("pipeline：语音附件走 asr，转写文本进 prompt", async () => {
  const h = makeHarness({
    message: makeMessage({ text: "", segments: [{ type: "record", data: { file: "c.amr" } }] }),
    planMedia: () => ({ needsFetch: true, url: "http://onebot/voice", filename: "c.amr", ext: "amr" }),
    transcribe: async () => ({ ok: true, text: "转写出来的话", reason: "ok" }),
  });

  await h.pipeline.handleEvent({ post_type: "message" });
  assert.match(h.runCalls[0].prompt, /转写出来的话/);
  assert.match(h.runCalls[0].prompt, /语音（c\.amr）/);
});

test("pipeline：同 chatKey 串行执行", async () => {
  let active = 0;
  let maxActive = 0;
  const pending = [];
  let index = 0;

  const h = makeHarness({
    runDshImpl: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      index += 1;
      const mine = index;
      await new Promise((resolve) => pending.push(resolve));
      active -= 1;
      return { ok: true, text: `reply-${mine}`, sessionId: null };
    },
  });

  const first = h.pipeline.handleEvent({ post_type: "message" });
  const second = h.pipeline.handleEvent({ post_type: "message" });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(maxActive, 1);
  assert.equal(h.runCalls.length, 1);

  pending.shift()();
  await new Promise((resolve) => setTimeout(resolve, 20));
  pending.shift()();
  await Promise.all([first, second]);

  assert.equal(maxActive, 1);
  assert.equal(h.runCalls.length, 2);
  assert.deepEqual(
    h.sent.map((item) => item.text),
    ["reply-1", "reply-2"],
  );
});

test("pipeline：不同 chatKey 之间也受 semaphore 并发上限约束", async () => {
  const pending = [];
  const h = makeHarness({
    semaphore: makeSemaphore(1),
    chatKeyOf: (message) => `private_${message.userId}`,
    runDshImpl: async () => {
      await new Promise((resolve) => pending.push(resolve));
      return { ok: true, text: "ok", sessionId: null };
    },
  });

  const first = h.pipeline.handleEvent({ message: makeMessage({ userId: "1" }) });
  const second = h.pipeline.handleEvent({ message: makeMessage({ userId: "2" }) });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.semaphore.state.max, 1);
  assert.equal(h.runCalls.length, 1);

  pending.shift()();
  await new Promise((resolve) => setTimeout(resolve, 20));
  pending.shift()();
  await Promise.all([first, second]);

  assert.equal(h.runCalls.length, 2);
  assert.equal(h.semaphore.state.max, 1);
});

test("bin/bridge.mjs --help 打印用法并返回 0", async () => {
  const { main } = await import("../bin/bridge.mjs");
  const chunks = [];
  const code = await main(["--help"], { stdout: { write: (s) => chunks.push(s) }, stderr: { write: () => {} } });
  assert.equal(code, 0);
  assert.match(chunks.join(""), /--dry-run/);
});

test("bin/bridge.mjs 未知参数返回 2", async () => {
  const { main, parseArgs } = await import("../bin/bridge.mjs");
  assert.deepEqual(parseArgs(["--config", "a.json", "--check"]), {
    configPath: "a.json",
    check: true,
    dryRun: null,
    help: false,
    unknown: [],
  });
  const code = await main(["--nope"], { stdout: { write: () => {} }, stderr: { write: () => {} } });
  assert.equal(code, 2);
});

test("bin/bridge.mjs --check 对合法 config 打印摘要并返回 0", async (t) => {
  if (!existsSync(CONFIG_MODULE_URL)) {
    t.skip("模块 A 的 src/config.mjs 还不存在，跳过 --check（在报告里说明）");
    return;
  }
  const { main } = await import("../bin/bridge.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-check-"));
  const rootDir = path.join(dir, "bridge-data");
  const filePath = path.join(dir, "bridge.config.json");
  // 模块 A 会校验 binPath 指向的文件真实存在，所以先把假 bin 落盘
  await writeFile(path.join(dir, "bin.js"), "// fake dsh bin\n", "utf8");
  await writeFile(
    filePath,
    JSON.stringify(
      {
        onebot: { wsUrl: "ws://127.0.0.1:3001", accessToken: "", reconnectMinMs: 1000, reconnectMaxMs: 30000 },
        dsh: {
          nodePath: process.execPath,
          binPath: path.join(dir, "bin.js"),
          profile: "im-bridge",
          cwd: "",
          timeoutMs: 60000,
          permissionMode: "workspace-write",
          env: {},
        },
        storage: { rootDir, maxFileBytes: 104857600, retentionDays: 30 },
        security: {
          userWhitelist: ["10001"],
          groupWhitelist: [],
          allowPrivate: true,
          allowGroup: true,
          groupRequireAt: true,
          rateLimitPerMinute: 6,
          maxConcurrentRuns: 2,
          maxPromptChars: 8000,
        },
        reply: { maxChunkChars: 1500, errorPrefix: "[bridge] ", showSessionId: false },
        asr: { command: "", args: [], timeoutMs: 60000 },
        log: { dir: path.join(dir, "logs"), level: "info" },
      },
      null,
      2,
    ),
    "utf8",
  );

  const out = [];
  const err = [];
  const code = await main(["--check", "--config", filePath], {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  });

  assert.equal(code, 0, `--check 应返回 0，stderr：${err.join("")}`);
  assert.ok(out.join("").trim().length > 0, "--check 应打印配置摘要");
});

test("bin/bridge.mjs：重连节奏透传给 createOneBotClient 的参数", async () => {
  const { buildOneBotClientOptions } = await import("../bin/bridge.mjs");
  const logger = makeLogger();
  const onEvent = () => {};
  const onStatus = () => {};

  const options = buildOneBotClientOptions({
    config: makeConfig({
      onebot: { wsUrl: "ws://127.0.0.1:3001", accessToken: "tk", reconnectMinMs: 500, reconnectMaxMs: 8000 },
    }),
    logger,
    onEvent,
    onStatus,
  });
  assert.equal(options.reconnectMinMs, 500);
  assert.equal(options.reconnectMaxMs, 8000);
  assert.equal(options.url, "ws://127.0.0.1:3001");
  assert.equal(options.accessToken, "tk");
  assert.equal(options.logger, logger);
  assert.equal(options.onEvent, onEvent);
  assert.equal(options.onStatus, onStatus);

  // 配置里没写时必须是 undefined，让 client 落回自己的默认值
  const fallback = buildOneBotClientOptions({
    config: makeConfig({ onebot: { wsUrl: "ws://127.0.0.1:3001" } }),
    logger,
    onEvent,
    onStatus,
  });
  assert.equal(fallback.reconnectMinMs, undefined);
  assert.equal(fallback.reconnectMaxMs, undefined);
  assert.equal(fallback.accessToken, "");
});

test("enrichFileCallSpec：群文件补 group_id / busid，不覆盖已有值，不碰其它动作", () => {
  const plan = {
    needsFetch: true,
    filename: "报告.pdf",
    ext: "pdf",
    callSpec: { action: "get_group_file_url", params: { file_id: "f1" } },
  };
  const enriched = enrichFileCallSpec({
    plan,
    message: { chatType: "group", groupId: "88888" },
    raw: { group_id: 88888, busid: 77 },
  });
  assert.deepEqual(enriched.callSpec.params, { file_id: "f1", group_id: "88888", busid: 77 });
  assert.equal(enriched.callSpec.action, "get_group_file_url");

  const kept = enrichFileCallSpec({
    plan: { callSpec: { action: "get_group_file_url", params: { group_id: "111" } } },
    message: { groupId: "88888" },
  });
  assert.equal(kept.callSpec.params.group_id, "111");

  const privatePlan = { callSpec: { action: "get_private_file_url", params: { file: "x" } } };
  assert.deepEqual(enrichFileCallSpec({ plan: privatePlan, message: { groupId: "88888" } }), privatePlan);
});

test("pipeline：群文件附件调用 get_group_file_url 时 params 里带 group_id", async () => {
  const groupMessage = makeMessage({
    chatType: "group",
    groupId: "88888",
    text: "",
    segments: [{ type: "file", data: { file: "报告.pdf" } }],
  });
  const h = makeHarness({
    message: groupMessage,
    planMedia: () => ({
      needsFetch: true,
      filename: "报告.pdf",
      ext: "pdf",
      callSpec: { action: "get_group_file_url", params: { file: "报告.pdf" } },
    }),
  });

  await h.pipeline.handleEvent({ post_type: "message" });

  assert.equal(h.clientCalls.length, 1);
  assert.equal(h.clientCalls[0].action, "get_group_file_url");
  assert.equal(h.clientCalls[0].params.group_id, "88888");
  assert.equal(h.clientCalls[0].params.file, "报告.pdf");
  assert.equal(h.runCalls.length, 1);
  assert.ok(h.runCalls[0].prompt.includes("报告.pdf"), "附件落地后应写进 prompt");
  assert.equal(h.sent[0].text, "ANSWER");
});
