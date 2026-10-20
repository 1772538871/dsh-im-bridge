import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalBridge, classifyApprovalReply } from "../src/approval-bridge.mjs";

const configFor = (approval = {}) => ({ approval: { enabled: true, timeoutMs: 60000, ...approval } });

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
    /** 模拟 DSH 询问审批：返回第一个还活着的监听器的结果。 */
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

function requestFor(agent, overrides = {}) {
  return { agent, toolName: "bash", reason: "需要写入工作区之外", ...overrides };
}

test("审批桥：attach 用 prepend 注册 approval/request（否则会被浏览器面板先认领）", () => {
  const ctx = fakeCtx();
  const bridge = createApprovalBridge({ ctx, send: fakeSend(), config: configFor() });
  const result = bridge.attach();
  assert.equal(result.ok, true);
  assert.equal(ctx.listeners.length, 1);
  assert.equal(ctx.listeners[0].event, "approval/request");
  assert.equal(ctx.listeners[0].opts.prepend, true);
  assert.equal(bridge.status().attached, true);
  bridge.detach();
});

test("审批桥：非 owned agent 一律 next() 委托（不抢别人的会话）", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createApprovalBridge({ ctx, send, config: configFor() });
  bridge.attach();
  let delegated = 0;
  const outcome = await ctx.fire("approval/request", requestFor(agentFor("other")), () => {
    delegated += 1;
    return Promise.resolve("unavailable");
  });
  assert.equal(delegated, 1);
  assert.equal(outcome, "unavailable");
  assert.equal(send.calls.length, 0);
  assert.equal(bridge.pendingCount(), 0);
  bridge.detach();
});

test("审批桥：owned agent 的请求转发到 IM，回复 1 放行一次", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createApprovalBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });

  const pending = ctx.fire("approval/request", requestFor(agent), () => Promise.resolve("unavailable"));
  assert.equal(bridge.pendingCount(), 1);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].chatKey, "private_1001");
  assert.match(send.calls[0].text, /bash/);
  assert.match(send.calls[0].text, /写入工作区之外/);
  assert.match(send.calls[0].text, /#1/);
  assert.match(send.calls[0].text, /超时按拒绝处理/);

  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "1" }), true);
  assert.equal(await pending, "allowed-once");
  assert.equal(bridge.pendingCount(), 0);
  // 第二条是给用户的确认
  assert.match(send.calls[1].text, /已放行/);
  bridge.detach();
});

test("审批桥：回复 2 拒绝、回复 0 取消、乱七八糟交回正常流程", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createApprovalBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "group_555" });

  const first = ctx.fire("approval/request", requestFor(agent), () => Promise.resolve("unavailable"));
  assert.equal(bridge.handleReply({ chatKey: "group_555", text: "随便聊聊" }), false);
  assert.equal(bridge.pendingCount(), 1, "认不出的回复不能把待审批吞掉");
  assert.equal(bridge.handleReply({ chatKey: "group_555", text: "2" }), true);
  assert.equal(await first, "rejected");

  const second = ctx.fire("approval/request", requestFor(agent), () => Promise.resolve("unavailable"));
  assert.equal(bridge.handleReply({ chatKey: "group_555", text: "取消" }), true);
  assert.equal(await second, "cancelled");

  const third = ctx.fire("approval/request", requestFor(agent), () => Promise.resolve("unavailable"));
  assert.equal(bridge.handleReply({ chatKey: "group_555", text: "同意" }), true);
  assert.equal(await third, "allowed-once");
  bridge.detach();
});

test("审批桥：词表归一化能吃下手机输入（全角标点、空格、大小写）", () => {
  assert.equal(classifyApprovalReply(" 1。 "), "allowed-once");
  assert.equal(classifyApprovalReply("YES"), "allowed-once");
  assert.equal(classifyApprovalReply("2！"), "rejected");
  assert.equal(classifyApprovalReply("No"), "rejected");
  assert.equal(classifyApprovalReply("0"), "cancelled");
  assert.equal(classifyApprovalReply("你好"), null);
  assert.equal(classifyApprovalReply(""), null);
});

test("审批桥：没有待审批时 handleReply 返回 false（正常任务照旧）", () => {
  const ctx = fakeCtx();
  const bridge = createApprovalBridge({ ctx, send: fakeSend(), config: configFor() });
  bridge.attach();
  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "1" }), false);
  assert.equal(bridge.handleReply({ chatKey: "", text: "1" }), false);
  bridge.detach();
});

test("审批桥：超时按 rejected 收尾（不是 cancelled，否则模型会立刻重试）", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createApprovalBridge({ ctx, send, config: configFor({ timeoutMs: 20 }) });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });

  const outcome = await ctx.fire("approval/request", requestFor(agent), () => Promise.resolve("unavailable"));
  assert.equal(outcome, "rejected");
  assert.equal(bridge.pendingCount(), 0);
  const last = send.calls[send.calls.length - 1];
  assert.match(last.text, /超时/);
  assert.equal(bridge.status().counters.timeouts, 1);
  bridge.detach();
});

test("审批桥：req.signal abort 立刻 cancelled 并清理挂起", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createApprovalBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });
  const controller = new AbortController();

  const pending = ctx.fire("approval/request", requestFor(agent, { signal: controller.signal }), () =>
    Promise.resolve("unavailable")
  );
  assert.equal(bridge.pendingCount(), 1);
  controller.abort();
  assert.equal(await pending, "cancelled");
  assert.equal(bridge.pendingCount(), 0);
  // signal 已经 abort 之后再来的请求直接 cancelled，不再发消息打扰用户
  assert.equal(await ctx.fire("approval/request", requestFor(agent, { signal: controller.signal }), () => Promise.resolve("unavailable")), "cancelled");
  bridge.detach();
});

test("审批桥：同一 chatKey 的第二条请求不会被静默吞掉（按拒绝并说明原因）", async () => {
  const ctx = fakeCtx();
  const send = fakeSend();
  const bridge = createApprovalBridge({ ctx, send, config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });

  const first = ctx.fire("approval/request", requestFor(agent, { toolName: "bash" }), () => Promise.resolve("unavailable"));
  const second = await ctx.fire("approval/request", requestFor(agent, { toolName: "edit" }), () => Promise.resolve("unavailable"));
  assert.equal(second, "rejected");
  assert.equal(bridge.pendingCount(), 1, "第一条仍然在等");
  assert.equal(bridge.status().counters.conflicts, 1);
  assert.match(send.calls[send.calls.length - 1].text, /已有待审批/);

  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "1" }), true);
  assert.equal(await first, "allowed-once");
  bridge.detach();
});

test("审批桥：detach 摘监听、把还挂着的审批按取消收尾，ctx.effect 负责托管卸载", async () => {
  const ctx = fakeCtx();
  const bridge = createApprovalBridge({ ctx, send: fakeSend(), config: configFor() });
  bridge.attach();
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });
  const pending = ctx.fire("approval/request", requestFor(agent), () => Promise.resolve("unavailable"));

  assert.equal(ctx.effects.length, 1);
  ctx.effects[0]();
  assert.equal(await pending, "cancelled");
  assert.equal(bridge.status().attached, false);
  assert.equal(ctx.liveCount(), 0);
});

test("审批桥：approval.enabled=false 时不注册、也不认领", async () => {
  const ctx = fakeCtx();
  const bridge = createApprovalBridge({ ctx, send: fakeSend(), config: configFor({ enabled: false }) });
  assert.equal(bridge.attach().ok, false);
  assert.equal(ctx.listeners.length, 0);
  // 即使登记了 agent，没有挂监听也不会有任何请求被转发
  const agent = agentFor("mine");
  bridge.own(agent, { chatKey: "private_1001" });
  assert.equal(bridge.handleReply({ chatKey: "private_1001", text: "1" }), false);
});
