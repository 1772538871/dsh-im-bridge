import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import { createPipeline } from "../src/pipeline.mjs";
import { createGuard } from "../src/security.mjs";
import { defaultConfig, getByPath, normalizeConfig } from "../src/plugin/config-store.mjs";
import { listPlatforms } from "../src/plugin/platforms.mjs";

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
  };
  return logger;
}

const BASE_REPLY = { maxChunkChars: 1500, errorPrefix: "[bridge] ", showSessionId: false, ack: false, progressEveryMs: 0, progressMax: 0 };

function makeConfig(reply = {}) {
  return {
    dsh: { cwd: "C:/work", timeoutMs: 1000 },
    storage: { rootDir: "C:/bridge", maxFileBytes: 104857600, retentionDays: 30 },
    security: { userWhitelist: [], allowPrivate: true, allowGroup: true, maxPromptChars: 8000 },
    reply: { ...BASE_REPLY, ...reply },
    log: { level: "info" },
  };
}

function makeMessage(overrides = {}) {
  const text = overrides.text ?? "你好";
  return {
    messageId: "2001",
    chatType: "private",
    userId: "10001",
    groupId: null,
    selfId: "0",
    text,
    segments: [{ type: "text", data: { text } }],
    atTargets: [],
    replyTo: null,
    ...overrides,
  };
}

function makePipeline({ reply = {}, replyText = "处理完了", random = 0.5, runDsh = null } = {}) {
  const replies = [];
  const sleeps = [];
  const logger = makeLogger();
  const pipeline = createPipeline({
    config: makeConfig(reply),
    logger,
    client: {},
    storage: { rootDir: os.tmpdir(), maxFileBytes: 1 << 20 },
    guard: { decide: () => ({ allow: true }) },
    serial: { run: (key, fn) => fn() },
    semaphore: { withPermit: (fn) => fn() },
    sessions: null,
    runDsh: runDsh ?? (async () => ({ ok: true, text: replyText, sessionId: "s1" })),
    deps: {
      parseEvent: (raw) => ({ kind: "message", message: raw.message }),
      planMedia: () => null,
      sendReply: async ({ text }) => {
        replies.push(text);
        return { sent: 1, failed: 0 };
      },
      sendMedia: async () => ({ sent: 1, failed: 0 }),
      // 真等 3 秒的测试不叫测试：睡觉与骰子都走注入点
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => random,
      chatKeyOf: () => "private_u1"
    },
  });
  return { pipeline, replies, sleeps, logger };
}

// ---- 打字延迟 ----

test("延迟：sendDelayMs=0 时一次都不睡（默认就是不等）", async () => {
  const h = makePipeline({ replyText: "x".repeat(300), reply: { sendDelayMs: 0 } });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.deepEqual(h.sleeps, []);
});

test("延迟：字数 × 每字毫秒，随机取中位时等于基准值", async () => {
  const h = makePipeline({ replyText: "y".repeat(20), reply: { sendDelayMs: 10, sendDelayMaxMs: 3000 }, random: 0.5 });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.deepEqual(h.sleeps, [200]);
});

test("延迟：超过 sendDelayMaxMs 就封顶，长文不会让你干等半分钟", async () => {
  const h = makePipeline({ replyText: "z".repeat(500), reply: { sendDelayMs: 10, sendDelayMaxMs: 50 }, random: 0.5 });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.deepEqual(h.sleeps, [50]);
});

test("延迟：抖动落在基准的 ±20% 之间（两端与中间值都验）", async () => {
  const cases = [
    [0, 40],
    [0.25, 45],
    [0.75, 55],
    [0.9999999, 60],
  ];
  for (const [random, expected] of cases) {
    const h = makePipeline({ replyText: "w".repeat(100), reply: { sendDelayMs: 10, sendDelayMaxMs: 50 }, random });
    await h.pipeline.handleEvent({ message: makeMessage() });
    assert.deepEqual(h.sleeps, [expected], "random=" + random);
  }
});

test("延迟：回执和进度不受影响，只有最终回复才等", async () => {
  const h = makePipeline({ replyText: "b".repeat(50), reply: { sendDelayMs: 10, ack: true }, random: 0.5 });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.equal(h.replies.length, 2);
  assert.equal(h.sleeps.length, 1);
  assert.match(h.replies[0], /^收到，开始处理了/);
});

// ---- 回复总长上限 ----

test("截断：超过 maxReplyChars 就截到上限并追加总字数", async () => {
  const body = "a".repeat(100);
  const h = makePipeline({ replyText: body, reply: { maxReplyChars: 20 } });
  await h.pipeline.handleEvent({ message: makeMessage() });
  const last = h.replies.at(-1);
  assert.equal(last, "a".repeat(20) + "……（太长截断了，总共 100 字）");
});

test("截断：maxReplyChars=0 表示不限，原样发出", async () => {
  const body = "b".repeat(120);
  const h = makePipeline({ replyText: body, reply: { maxReplyChars: 0 } });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.equal(h.replies.at(-1), body);
});

test("截断：没超上限时不加任何说明", async () => {
  const h = makePipeline({ replyText: "短回复", reply: { maxReplyChars: 100 } });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.equal(h.replies.at(-1), "短回复");
});

test("截断：截断发生在交给分段器之前（先截后分）", async () => {
  const h = makePipeline({ replyText: "c".repeat(200), reply: { maxReplyChars: 30, maxChunkChars: 10 } });
  await h.pipeline.handleEvent({ message: makeMessage() });
  const last = h.replies.at(-1);
  assert.equal(last.length, 30 + "……（太长截断了，总共 200 字）".length);
  assert.match(last, /……（太长截断了，总共 200 字）$/);
});

// ---- 群聊必答词 / 概率接话 ----

function guardConfig(security = {}, social = {}) {
  return {
    security: {
      userWhitelist: [],
      groupWhitelist: [],
      allowPrivate: true,
      allowGroup: true,
      groupRequireAt: true,
      rateLimitPerMinute: 0,
      ...security
    },
    social,
  };
}

function groupMsg(text, overrides = {}) {
  return { chatType: "group", userId: "1001", groupId: "9001", selfId: "7777", text, segments: [{ type: "text", data: { text } }], atTargets: [], ...overrides };
}

test("必答词：群里没 @ 但命中关键词就回，并留下可查的日志", () => {
  const logger = makeLogger();
  const guard = createGuard({
    config: guardConfig({}, { mustReplyKeywords: ["发布", "上线"], replyProbability: 0 }),
    logger,
    random: () => {
      throw new Error("命中必答词时不该掷骰子");
    },
  });
  const decision = guard.decide(groupMsg("明天几点发布新版本？"));
  assert.equal(decision.allow, true);
  const line = logger.lines.find((item) => item.level === "info" && item.msg.includes("必答词"));
  assert.ok(line, "缺必答词命中日志");
  assert.match(line.msg, /群里出现必答词「发布」，没 @ 也回：userId=1001 groupId=9001/);
});

test("必答词：没命中就照旧当没听见（need_at）", () => {
  const guard = createGuard({ config: guardConfig({}, { mustReplyKeywords: ["发布"], replyProbability: 0 }), random: () => 0 });
  assert.deepEqual(guard.decide(groupMsg("今天天气不错")), { allow: false, reason: "need_at" });
});

test("必答词：空列表等于没配，仍然只认 @", () => {
  const guard = createGuard({ config: guardConfig({}, { mustReplyKeywords: [] }), random: () => 0 });
  assert.deepEqual(guard.decide(groupMsg("发布了吗")), { allow: false, reason: "need_at" });
});

test("必答词：命中判定也看文本消息段（官方机器人事件没有 text 字段）", () => {
  const guard = createGuard({ config: guardConfig({}, { mustReplyKeywords: ["报错"] }) });
  const message = groupMsg("", { text: undefined, segments: [{ type: "text", data: { text: "这里报错了" } }] });
  assert.equal(guard.decide(message).allow, true);
});

test("必答词优先于 groupRequireAt：@ 与关键词同时存在时不重复判定", () => {
  const guard = createGuard({ config: guardConfig({}, { mustReplyKeywords: ["发布"] }) });
  const message = groupMsg("发布吧", { selfId: "7777", atTargets: ["7777"] });
  assert.equal(guard.decide(message).allow, true);
});

test("概率：replyProbability=1 时没 @ 也一定接话", () => {
  const guard = createGuard({ config: guardConfig({}, { replyProbability: 1 }), random: () => 0.999999 });
  assert.equal(guard.decide(groupMsg("随便聊聊")).allow, true);
});

test("概率：replyProbability=0 时连骰子都不掷（不引入多余随机）", () => {
  const guard = createGuard({
    config: guardConfig({}, { replyProbability: 0 }),
    random: () => {
      throw new Error("概率为 0 时不该掷骰子");
    },
  });
  assert.deepEqual(guard.decide(groupMsg("随便聊聊")), { allow: false, reason: "need_at" });
});

test("概率：0.5 这类中间值按掷骰结果分叉", () => {
  const at = (random) => createGuard({ config: guardConfig({}, { replyProbability: 0.5 }), random: () => random }).decide(groupMsg("在吗"));
  assert.equal(at(0.49).allow, true);
  assert.deepEqual(at(0.51), { allow: false, reason: "need_at" });
  assert.deepEqual(at(0.5), { allow: false, reason: "need_at" });
});

test("概率：必答词命中时完全不看概率", () => {
  const guard = createGuard({
    config: guardConfig({}, { mustReplyKeywords: ["上线"], replyProbability: 0 }),
    random: () => 1,
  });
  assert.equal(guard.decide(groupMsg("上线了吗")).allow, true);
});

test("私聊：social 配了必答词与概率也不影响私聊", () => {
  const guard = createGuard({
    config: guardConfig({}, { mustReplyKeywords: ["发布"], replyProbability: 0 }),
    random: () => 0,
  });
  assert.deepEqual(guard.decide(makeMessage({ text: "今天天气不错" })), { allow: true, reason: "ok" });
});

// ---- 配置与设置页字段 ----

test("config-store：新增字段的默认值", () => {
  const config = defaultConfig();
  assert.equal(config.reply.sendDelayMs, 0);
  assert.equal(config.reply.sendDelayMaxMs, 3000);
  assert.equal(config.reply.maxReplyChars, 0);
  assert.deepEqual(config.social.mustReplyKeywords, []);
  assert.equal(config.social.replyProbability, 0);
});

test("config-store：normalize 保留小数概率、清掉空关键词、拒绝越界值", () => {
  const ok = normalizeConfig({
    storage: { rootDir: "E:\\dsh-im-bridge-data" },
    reply: { sendDelayMs: "25", sendDelayMaxMs: 4000, maxReplyChars: 600 },
    social: { mustReplyKeywords: [" 发布 ", "", 42], replyProbability: 0.25 },
  });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.config.reply.sendDelayMs, 25);
  assert.equal(ok.config.reply.sendDelayMaxMs, 4000);
  assert.equal(ok.config.reply.maxReplyChars, 600);
  assert.deepEqual(ok.config.social.mustReplyKeywords, ["发布", "42"]);
  assert.equal(ok.config.social.replyProbability, 0.25);

  const bad = normalizeConfig({
    storage: { rootDir: "E:\\dsh-im-bridge-data" },
    reply: { sendDelayMs: -1 },
    social: { replyProbability: 2 },
  });
  assert.ok(bad.problems.some((item) => item.includes("reply.sendDelayMs")));
  assert.ok(bad.problems.some((item) => item.includes("social.replyProbability")));
  // 坏值不该把功能静默打开：回落到默认的 0
  assert.equal(bad.config.social.replyProbability, 0);
});

test("设置页：六个新字段都在 advanced 组，文案是人话且带说明", () => {
  const fields = listPlatforms().find((item) => item.id === "qq-napcat").fields;
  const byKey = new Map(fields.map((item) => [item.key, item]));
  const expected = {
    "reply.sendDelayMs": "发送前停顿（毫秒/每字，模拟打字）",
    "reply.sendDelayMaxMs": "上面那个停顿最多等多久（毫秒）",
    "reply.maxReplyChars": "单条回复最多多少字（0=不限）",
    "social.mustReplyKeywords": "这些词出现就一定回（一行一个，群聊免 @）",
    "social.replyProbability": "没 @ 也接话的概率（0~1）",
  };
  for (const [key, label] of Object.entries(expected)) {
    const field = byKey.get(key);
    assert.ok(field, "缺字段：" + key);
    assert.equal(field.label, label);
    assert.equal(field.group, "advanced", key + " 不该留在首屏");
    assert.ok(field.help.length > 10, key + " 缺人话说明");
    assert.notEqual(getByPath(defaultConfig(), key), undefined, key + " 不在配置形状里");
  }
  assert.equal(byKey.get("social.mustReplyKeywords").type, "stringList");
  assert.equal(byKey.get("reply.maxReplyChars").type, "number");
});
