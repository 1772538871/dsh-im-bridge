import test from "node:test";
import assert from "node:assert/strict";
import { createQuestionBridge, classifyQuestionReply } from "../src/question-bridge.mjs";

// 提问桥的超时窗口与审批共用一份：配置里只有 approval.timeoutMs
const configFor = (questions = {}, approval = {}) => ({
  questions: { enabled: true, ...questions },
  approval: { enabled: true, timeoutMs: 60000, ...approval }
});

/** 假 ctx：记下注册的参数，能手动"派发"一个瀑布事件，也能像 cordis 那样托管 effect。 */
function fakeCtx() {
  const listeners = [];
  const effects = [];
  return {
    listeners,
    effects,
    on(event, fn, opts) {
      const entry = { event, fn, opts, active: true };
      listeners.push(entry);
      return () => {
        entry.active = false;
      };
    },
    effect(fn) {
      const disposer = fn();
      effects.push(disposer);
      return disposer;
    },
    off(event, fn) {
      for (const entry of listeners) if (entry.event === event && entry.fn === fn) entry.active = false;
    },
    /** 模拟 DSH 问用户：返回第一个还活着的监听器的结果。 */
    fire(event, ...args) {
      for (const entry of listeners) if (entry.event === event && entry.active) return entry.fn(...args);
      throw new Error("没有可用的瀑布监听器");
    },
    liveCount() {
      return listeners.filter((entry) => entry.active).length;
    }
  };
}

function fakeSend() {
  const calls = [];
  const send = (chatKey, text) => {
    calls.push({ chatKey, text });
  };
  send.calls = calls;
  return send;
}

const agentFor = (name) => ({ name });

/** 真机里看到的"笔记形态"选择题：3 个选项 + 标题 + 补充说明。 */
function noteQuestion(overrides = {}) {
  return {
    id: "q1",
    header: "需要你选一个",
    question: "整理成什么形态，直接决定产物查得多细",
    options: [
      { label: "全文转录留底 + 精华笔记 + 索引" },
      { label: "只要结构化笔记 + 索引" },
      { label: "只要逐页全文转录" }
    ],
    ...overrides
  };
}

function requestFor(agent, overrides = {}) {
  return { agent, questions: [noteQuestion()], ...overrides };
}

const EVENT = "user-questions/request";
const unavailable = () => Promise.resolve({ answers: [{ id: "q1", selected: [] }] });

test("提问桥：attach 用 prepend 注册 user-questions/request（否则会被浏览器提问面板先认领）", () => {
  const ctx = fakeCtx();
  const bridge = createQuestionBridge({ ctx, send: fakeSend(), config: configFor() });
  const result = bridge.attach();
  assert.equal(result.ok, true);
  assert.equal(ctx.listeners.length, 1);
  assert.equal(ctx.listeners[0].event, EVENT);
  assert.equal(ctx.listeners[0].opts.prepend, true);
  assert.equal(bridge.status().attached, true);
  bridge.detach();
});

test("提问桥：非 owned agent 一律 next() 委托（不抢别人的会话）", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createQuestionBridge({ ctx, send, config: configFor() });
  bridge.attach();
  let delegated = 0;
  const outcome = await ctx.fire(EVENT, requestFor(agentFor("other")), () => {
    delegated += 1;
    return unavailable();
  });
  assert.equal(delegated, 1);
  assert.deepEqual(outcome, { answers: [{ id: "q1", selected: [] }] });
  assert.equal(send.calls.length, 0);
  assert.equal(bridge.pendingCount(), 0);
  bridge.detach();
});

test("提问桥：owned agent 的提问渲染成 QQ 卡片（标题 + 要点 + 选项 + 怎么回）", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createQuestionBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });

  const pending = ctx.fire(EVENT, requestFor(agent), unavailable);
  assert.equal(bridge.pendingCount(), 1);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].chatKey, "private_1001");
  const text = send.calls[0].text;
  assert.match(text, /^【提问 #1】需要你选一个$/mu);
  assert.match(text, /· 问题：整理成什么形态，直接决定产物查得多细/);
  assert.match(text, / {2}1\. 全文转录留底 \+ 精华笔记 \+ 索引/);
  assert.match(text, / {2}3\. 只要逐页全文转录/);
  assert.match(text, /回复 1-3 选择，或直接输入你的答案；回「跳过」跳过（1 分钟内有效）/);
  assert.equal(text.split("\n").length, 6);

  // 回 2 -> selected 填第 2 个选项的 label（d.ts: "Selected option labels"）
  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "2" }), true);
  assert.deepEqual(await pending, { answers: [{ id: "q1", selected: ["只要结构化笔记 + 索引"] }] });
  assert.equal(bridge.pendingCount(), 0);
  assert.match(send.calls[send.calls.length - 1].text, /已记下 #1：只要结构化笔记 \+ 索引。/);
  bridge.detach();
});

test("提问桥：自由文本当作 custom 回答，原样上交不改写", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createQuestionBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });

  const pending = ctx.fire(EVENT, requestFor(agent), unavailable);
  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "  要一份带目录的精简版本。 " }), true);
  assert.deepEqual(await pending, { answers: [{ id: "q1", selected: [], custom: "要一份带目录的精简版本。" }] });
  bridge.detach();
});

test("提问桥：回「跳过」按跳过收尾（selected 空且不带 custom，回合继续）", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createQuestionBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "group_555" });

  for (const word of ["跳过", "跳过此题", "SKIP", " 跳过。 "]) {
    const pending = ctx.fire(EVENT, requestFor(agent), unavailable);
    assert.equal(bridge.handleReply({ chatKey: "group_555", text: word }), true);
    assert.deepEqual(await pending, { answers: [{ id: "q1", selected: [] }] }, word);
    assert.equal(bridge.pendingCount(), 0);
  }
  assert.equal(bridge.status().counters.skipped, 4);
  bridge.detach();
});

test("提问桥：空消息不当答案（只发图片的情况仍等用户开口）", () => {
  const ctx = fakeCtx();
  const bridge = createQuestionBridge({ ctx, send: fakeSend(), config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });
  ctx.fire(EVENT, requestFor(agent), unavailable);
  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "   " }), false);
  assert.equal(bridge.pendingCount(), 1);
  bridge.detach();
});

test("提问桥：多问的 call 逐问下发，一次只认一个序号", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createQuestionBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });

  const request = {
    agent,
    questions: [noteQuestion(), noteQuestion({ id: "q2", header: "", question: "索引要几层？", options: undefined })]
  };
  const pending = ctx.fire(EVENT, request, unavailable);
  assert.match(send.calls[0].text, /^【提问 #1 · 第 1\/2 问】需要你选一个$/mu);

  // 第 1 问答完，第 2 问立刻下发，答案先不 resolve
  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "3" }), true);
  assert.equal(bridge.pendingCount(), 1);
  assert.match(send.calls[1].text, /^【提问 #1 · 第 2\/2 问】需要你回答$/mu);
  assert.match(send.calls[1].text, /· 问题：索引要几层？/);
  assert.match(send.calls[1].text, /直接回复你的答案/);

  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "两层就够" }), true);
  assert.deepEqual(await pending, {
    answers: [
      { id: "q1", selected: ["只要逐页全文转录"] },
      { id: "q2", selected: [], custom: "两层就够" }
    ]
  });
  bridge.detach();
});

test("提问桥：超时返回跳过（不是 reject，否则整轮工具调用报错收场）", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createQuestionBridge({ ctx, send, config: configFor({}, { timeoutMs: 20 }) });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });

  const outcome = await ctx.fire(EVENT, requestFor(agent), unavailable);
  assert.deepEqual(outcome, { answers: [{ id: "q1", selected: [] }] });
  assert.equal(bridge.pendingCount(), 0);
  assert.equal(bridge.status().counters.timeouts, 1);
  assert.match(send.calls[send.calls.length - 1].text, /等待超时，先按跳过处理/);
  bridge.detach();
});

test("提问桥：同一 chatKey 的第二条提问按跳过处理并说明（不死等）", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createQuestionBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });

  const first = ctx.fire(EVENT, requestFor(agent), unavailable);
  const second = await ctx.fire(EVENT, requestFor(agent, { questions: [noteQuestion({ id: "q9" })] }), unavailable);
  assert.deepEqual(second, { answers: [{ id: "q9", selected: [] }] });
  assert.equal(bridge.pendingCount(), 1, "第一条仍然在等");
  assert.equal(bridge.status().counters.conflicts, 1);
  assert.match(send.calls[send.calls.length - 1].text, /已有待回答的提问 #1，这条先按跳过处理/);

  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "1" }), true);
  assert.deepEqual(await first, { answers: [{ id: "q1", selected: ["全文转录留底 + 精华笔记 + 索引"] }] });
  bridge.detach();
});

test("提问桥：req.signal abort 立刻清挂起并回跳过", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createQuestionBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });
  const controller = new AbortController();

  const pending = ctx.fire(EVENT, requestFor(agent, { signal: controller.signal }), unavailable);
  assert.equal(bridge.pendingCount(), 1);
  controller.abort();
  assert.deepEqual(await pending, { answers: [{ id: "q1", selected: [] }] });
  assert.equal(bridge.pendingCount(), 0);
  assert.equal(bridge.status().counters.aborts, 1);
  // signal 已 abort 之后再来的请求直接跳过，不再发消息打扰用户
  const textsBefore = send.calls.length;
  assert.deepEqual(await ctx.fire(EVENT, requestFor(agent, { signal: controller.signal }), unavailable), {
    answers: [{ id: "q1", selected: [] }]
  });
  assert.equal(send.calls.length, textsBefore);
  bridge.detach();
});

test("提问桥：detach 摘监听、把挂着的提问按跳过收尾，之后不再认领", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createQuestionBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });
  const pending = ctx.fire(EVENT, requestFor(agent), unavailable);

  assert.equal(ctx.effects.length, 1);
  ctx.effects[0]();
  assert.deepEqual(await pending, { answers: [{ id: "q1", selected: [] }] });
  assert.equal(bridge.status().attached, false);
  assert.equal(ctx.liveCount(), 0);
  // 监听已经摘掉：这条回复不再被认领，交回 pipeline 当普通消息
  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "2" }), false);
});

test("提问桥：questions.enabled=false 时不注册、也不认领", async () => {
  const ctx = fakeCtx();
  const bridge = createQuestionBridge({ ctx, send: fakeSend(), config: configFor({ enabled: false }) });
  const result = bridge.attach();
  assert.equal(result.ok, false);
  assert.equal(result.error, "questions.disabled");
  assert.equal(ctx.listeners.length, 0);
  bridge.own(agentFor("mine"), { chatKey: "private_1001" });
  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "1" }), false);
});

test("提问桥：没有待回答的提问 / 空 chatKey 时 handleReply 返回 false", () => {
  const ctx = fakeCtx();
  const bridge = createQuestionBridge({ ctx, send: fakeSend(), config: configFor() });
  bridge.attach();
  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "1" }), false);
  assert.equal(bridge.handleReply({ chatKey: "", text: "1" }), false);
  bridge.detach();
});

test("提问桥：词表归一化能吃下手机输入（全角标点、空格、大小写、非法序号）", () => {
  assert.deepEqual(classifyQuestionReply(" 2。 ", noteQuestion()), { kind: "option", selected: ["只要结构化笔记 + 索引"], custom: null });
  assert.deepEqual(classifyQuestionReply("SKIP", noteQuestion()), { kind: "skip", selected: [], custom: null });
  assert.deepEqual(classifyQuestionReply("跳过。", noteQuestion()), { kind: "skip", selected: [], custom: null });
  // 选项号越界或没有选项：整句当自由回答，原始输入不动
  assert.deepEqual(classifyQuestionReply("9", noteQuestion()), { kind: "custom", selected: [], custom: "9" });
  assert.deepEqual(classifyQuestionReply("1", { id: "q", question: "随便说" }), { kind: "custom", selected: [], custom: "1" });
  assert.equal(classifyQuestionReply("", noteQuestion()), null);
  assert.equal(classifyQuestionReply(null, noteQuestion()), null);
});

test("提问桥：多选题能一次选多个（用逗号分隔）", () => {
  const question = noteQuestion({ multiSelect: true });
  assert.deepEqual(classifyQuestionReply("1,3", question), {
    kind: "option",
    selected: ["全文转录留底 + 精华笔记 + 索引", "只要逐页全文转录"],
    custom: null
  });
  // 单选问题上 "1,3" 这种写法不猜：整句当自由回答
  assert.deepEqual(classifyQuestionReply("1,3", noteQuestion()), { kind: "custom", selected: [], custom: "1,3" });
});

test("提问桥：没有 chatKey 的 owned agent 不认领（问不到人就别抢）", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createQuestionBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, {});
  let delegated = 0;
  await ctx.fire(EVENT, requestFor(agent), () => {
    delegated += 1;
    return unavailable();
  });
  assert.equal(delegated, 1);
  assert.equal(send.calls.length, 0);
  bridge.detach();
});

test("提问桥：own/release 控制认领范围，release 后不再认领", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createQuestionBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  assert.equal(bridge.own(agent, { chatKey: "private_1001" }), true);
  assert.equal(bridge.release(agent), true);
  let delegated = 0;
  await ctx.fire(EVENT, requestFor(agent), () => {
    delegated += 1;
    return unavailable();
  });
  assert.equal(delegated, 1);
  assert.equal(send.calls.length, 0);
  bridge.detach();
});
