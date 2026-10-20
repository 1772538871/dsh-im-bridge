import test from "node:test";
import assert from "node:assert/strict";
import { createInProcessRunner } from "../src/inprocess-runner.mjs";

const configFor = (overrides = {}) => ({
  dsh: {
    cwd: "",
    timeoutMs: 5000,
    runner: "inprocess",
    ...overrides
  }
});

function fakeSession() {
  const events = [];
  return {
    events,
    get seq() {
      return events.length;
    },
    eventAt(index) {
      return events[index];
    },
    append(event) {
      events.push(event);
    }
  };
}

function textEvent(text) {
  return { type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } };
}

function endEvent(reason = { kind: "completed" }) {
  return { type: "turn/end", data: { reason } };
}

/**
 * 假 agents 服务。script(message) 决定这次 followup 往会话里塞哪些事件，
 * 这样"最后一条 assistant/message 才是答案""turn/end 带 error"都能精确复现。
 */
function fakeAgents({
  script = () => [textEvent("done"), endEvent()],
  whenIdleHangs = false,
  createError = null,
  resumeError = null
} = {}) {
  const state = { created: [], resumed: [], disposed: [], prompted: [], cancelled: 0, sessions: [] };
  const service = {
    async create(options) {
      state.created.push(options);
      if (createError) throw new Error(createError);
      const session = fakeSession();
      state.sessions.push(session);
      const agent = {
        session,
        followup(message) {
          state.prompted.push(message);
          for (const event of script(message)) session.append(event);
        },
        whenIdle() {
          return whenIdleHangs ? new Promise(() => {}) : Promise.resolve();
        },
        cancel() {
          state.cancelled += 1;
        }
      };
      return {
        agent,
        async dispose() {
          state.disposed.push(options.sessionId);
        }
      };
    },
    async resume(options) {
      state.resumed.push(options);
      if (resumeError) throw new Error(resumeError);
      const session = fakeSession();
      state.sessions.push(session);
      const agent = {
        session,
        followup(message) {
          state.prompted.push(message);
          for (const event of script(message)) session.append(event);
        },
        whenIdle: () => Promise.resolve(),
        cancel() {}
      };
      return { agent, async dispose() { state.disposed.push(options.resumeSessionId); } };
    }
  };
  return { service, state };
}

function fakeCtx({ agents = null, selection = { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" }, approval = null, sessions = null } = {}) {
  const services = {
    agents,
    agentDefaultModel: { currentSelection: () => selection },
    approval,
    sessions
  };
  return {
    services,
    get(name) {
      return services[name];
    }
  };
}

function fakeLogger() {
  const lines = [];
  return {
    lines,
    debug() {},
    info(message, extra) {
      lines.push({ level: "info", message, extra });
    },
    warn(message, extra) {
      lines.push({ level: "warn", message, extra });
    },
    error(message, extra) {
      lines.push({ level: "error", message, extra });
    }
  };
}

test("inprocess：同 sessionId 复用同一个 agent handle，不重复 create", async () => {
  const { service, state } = fakeAgents();
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service }), config: configFor() });

  const first = await runner.run({ prompt: "第一句", sessionId: "s-1" });
  const second = await runner.run({ prompt: "第二句", sessionId: "s-1" });

  assert.equal(first.ok, true);
  assert.equal(first.text, "done");
  assert.equal(first.sessionId, "s-1");
  assert.equal(second.ok, true);
  assert.equal(state.created.length, 1, "同一个 sessionId 只能建一次 agent");
  assert.equal(state.prompted.length, 2);
  assert.equal(runner.status().sessions, 1);
  await runner.stop();
});

test("inprocess：没给 sessionId 时自己发一个并回传，调用方据此落盘", async () => {
  const { service, state } = fakeAgents();
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service }), config: configFor() });
  const result = await runner.run({ prompt: "首条消息" });
  assert.equal(result.ok, true);
  assert.match(result.sessionId, /^session-[0-9a-f-]{36}$/);
  assert.equal(state.created[0].sessionId, result.sessionId);
  await runner.stop();
});

test("inprocess：服务缺失报 not_configured，而不是抛", async () => {
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: null }), config: configFor() });
  const result = await runner.run({ prompt: "在吗" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_configured");
  assert.equal(result.text, "");
});

test("inprocess：只有 agentDefaultModel 缺失也报 not_configured", async () => {
  const { service } = fakeAgents();
  const ctx = { get: (name) => (name === "agents" ? service : undefined) };
  const runner = createInProcessRunner({ ctx, config: configFor() });
  const result = await runner.run({ prompt: "在吗" });
  assert.equal(result.reason, "not_configured");
});

test("inprocess：stop() 会 dispose 掉所有 handle，再次 run 报 runner_error", async () => {
  const { service, state } = fakeAgents();
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service }), config: configFor() });
  await runner.run({ prompt: "一", sessionId: "s-1" });
  await runner.run({ prompt: "二", sessionId: "s-2" });
  const status = await runner.stop();
  assert.deepEqual(state.disposed.sort(), ["s-1", "s-2"]);
  assert.equal(status.sessions, 0);
  const after = await runner.run({ prompt: "三", sessionId: "s-3" });
  assert.equal(after.ok, false);
  assert.equal(after.reason, "runner_error");
});

test("inprocess：答案取本轮最后一条 assistant/message", async () => {
  const { service } = fakeAgents({
    script: () => [textEvent("先解释一下"), textEvent("最终答案"), endEvent()]
  });
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service }), config: configFor() });
  const result = await runner.run({ prompt: "问", sessionId: "s-1" });
  assert.equal(result.text, "最终答案");
  assert.equal(result.ok, true);
  await runner.stop();
});

test("inprocess：turn/end 带 error 报 model_error", async () => {
  const { service } = fakeAgents({
    script: () => [textEvent("半截回答"), endEvent({ kind: "error", error: { message: "模型被限流" } })]
  });
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service }), config: configFor() });
  const result = await runner.run({ prompt: "问", sessionId: "s-1" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "model_error");
  assert.equal(result.turnError, "模型被限流");
  assert.equal(result.text, "半截回答");
  await runner.stop();
});

test("inprocess：跑完没吐文字报 no_final，不冒充成功", async () => {
  const { service } = fakeAgents({ script: () => [endEvent()] });
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service }), config: configFor() });
  const result = await runner.run({ prompt: "问", sessionId: "s-1" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_final");
  await runner.stop();
});

test("inprocess：超时报 timeout 并取消+释放卡住的 agent", async () => {
  const { service, state } = fakeAgents({ whenIdleHangs: true });
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service }), config: configFor() });
  const result = await runner.run({ prompt: "问", sessionId: "s-1", timeoutMs: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.equal(state.cancelled, 1);
  assert.deepEqual(state.disposed, ["s-1"]);
  assert.equal(runner.status().sessions, 0);
  await runner.stop();
});

test("inprocess：create 报 already exists 时改用 resume 接上历史会话", async () => {
  const { service, state } = fakeAgents({ createError: "session already exists: s-1" });
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service }), config: configFor() });
  const result = await runner.run({ prompt: "续上", sessionId: "s-1" });
  assert.equal(result.ok, true);
  assert.equal(state.resumed.length, 1);
  assert.equal(state.resumed[0].resumeSessionId, "s-1");
  await runner.stop();
});

test("inprocess：create 报别的错直接 runner_error，不去瞎 resume", async () => {
  const { service, state } = fakeAgents({ createError: "provider adapter 未注册" });
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service }), config: configFor() });
  const result = await runner.run({ prompt: "问", sessionId: "s-1" });
  assert.equal(result.reason, "runner_error");
  assert.match(result.error, /provider adapter/);
  assert.equal(state.resumed.length, 0);
});

test("inprocess：把 agent 登记给审批桥（带 chatKey），stop 时 release", async () => {
  const { service } = fakeAgents();
  const owned = [];
  const released = [];
  const bridge = { own: (agent, meta) => owned.push({ agent, meta }), release: (agent) => released.push(agent) };
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service }), config: configFor(), bridge });
  await runner.run({ prompt: "问", sessionId: "s-1", chatKey: "private_1001" });
  assert.equal(owned.length, 1);
  assert.equal(owned[0].meta.chatKey, "private_1001");
  await runner.stop();
  assert.equal(released.length, 1);
});

test("inprocess：approval 策略不是 ask 时只 warn 一次", async () => {
  const { service } = fakeAgents();
  const logger = fakeLogger();
  const approval = { effectivePolicy: () => "never" };
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service, approval }), config: configFor(), logger });
  await runner.run({ prompt: "一", sessionId: "s-1" });
  await runner.run({ prompt: "二", sessionId: "s-2" });
  const warns = logger.lines.filter((line) => line.level === "warn" && /approval 策略/.test(line.message));
  assert.equal(warns.length, 1);
  assert.equal(warns[0].extra.policy, "never");
  await runner.stop();
});

test("inprocess：策略是 ask 时不告警（正常路径静默）", async () => {
  const { service } = fakeAgents();
  const logger = fakeLogger();
  const approval = { effectivePolicy: () => "ask" };
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service, approval }), config: configFor(), logger });
  await runner.run({ prompt: "问", sessionId: "s-1" });
  assert.equal(logger.lines.filter((line) => line.level === "warn").length, 0);
  await runner.stop();
});

test("inprocess：并发 run 内部排队，不会交叉驱动同一个 agent", async () => {
  const { service, state } = fakeAgents();
  const runner = createInProcessRunner({ ctx: fakeCtx({ agents: service }), config: configFor() });
  const [a, b] = await Promise.all([
    runner.run({ prompt: "一", sessionId: "s-1" }),
    runner.run({ prompt: "二", sessionId: "s-1" })
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(state.created.length, 1);
  assert.deepEqual(state.prompted.map((message) => message.content[0].text), ["一", "二"]);
  await runner.stop();
});
