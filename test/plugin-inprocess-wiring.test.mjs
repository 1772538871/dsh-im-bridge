import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfigStore, defaultConfig } from "../src/plugin/config-store.mjs";
import { createRuntime } from "../src/plugin/runtime.mjs";

// 这一层测"接线"：真 pipeline + 真审批桥 + 真进程内 runner，只有平台连接与 DSH 服务是假的。
// 接线（onEvent 包装、chatKey 归属、发送路径）错了，在这里一定会露出来。
// 注意：适配器的 onEvent 是 fire-and-forget（它把 Promise 丢掉以免阻塞 WebSocket 收包），
// 所以这里不能用 await 等结果，只能用 waitFor 轮询观测点。

function quietLogger() {
  const logger = {
    lines: [],
    debug() {},
    info(message, extra) {
      logger.lines.push({ level: "info", message, extra });
    },
    warn(message, extra) {
      logger.lines.push({ level: "warn", message, extra });
    },
    error(message, extra) {
      logger.lines.push({ level: "error", message, extra });
    },
    child() {
      return logger;
    },
    flush() {
      return Promise.resolve();
    }
  };
  return logger;
}

async function waitFor(predicate, label = "条件") {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待超时：" + label);
}

function fakeSession() {
  const events = [];
  return {
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

/** 假 agents 服务：每次 create 造一个会吐固定回答的 agent，并记下它（测试要用它触发审批）。 */
function fakeAgents({ reply = "这是模型回答" } = {}) {
  const state = { created: [], followups: 0, disposed: [] };
  const service = {
    async create(options) {
      const session = fakeSession();
      const agent = {
        session,
        followup() {
          state.followups += 1;
          session.append({ type: "assistant/message", data: { message: { content: [{ type: "text", text: reply }] } } });
          session.append({ type: "turn/end", data: { reason: { kind: "completed" } } });
        },
        whenIdle: () => Promise.resolve(),
        cancel() {}
      };
      state.created.push({ options, agent });
      return {
        agent,
        async dispose() {
          state.disposed.push(options.sessionId);
        }
      };
    }
  };
  return { service, state };
}

/** 假 ctx：cordis 上下文（get/on/effect）+ webServer；审批监听器挂在这里，测试靠它派发审批。 */
function fakeCtx({ services = {}, logger = quietLogger() } = {}) {
  const listeners = [];
  const effects = [];
  return {
    logger,
    listeners,
    effects,
    webServer: { register: () => () => {} },
    get(name) {
      return services[name];
    },
    on(event, fn, opts) {
      const entry = { event, fn, opts, active: true };
      listeners.push(entry);
      return () => {
        entry.active = false;
      };
    },
    off(event, fn) {
      for (const entry of listeners) if (entry.event === event && entry.fn === fn) entry.active = false;
    },
    effect(fn) {
      const disposer = fn();
      effects.push(disposer);
      return disposer;
    },
    approvalListener() {
      const entry = listeners.find((item) => item.event === "approval/request" && item.active);
      return entry ? entry.fn : null;
    }
  };
}

/** 假 OneBot 客户端：把 runtime 传下来的 onEvent 抓住，测试据此投递入站消息。 */
function fakeOneBotApi() {
  const client = {
    sent: [],
    onEvent: null,
    start() {},
    async stop() {},
    status() {
      return { open: true, lastError: null, attempts: 0 };
    },
    async call(action, params) {
      client.sent.push({ action, params });
      return { message_id: client.sent.length };
    }
  };
  const segmentsText = (segments) =>
    Array.isArray(segments) ? segments.map((seg) => seg?.data?.text ?? "").join("") : "";
  client.texts = () =>
    client.sent.map((item) => {
      const raw = item.params?.message;
      if (typeof raw === "string") return raw;
      // OneBot 的 message 是分段数组；QQ 官方机器人那边才是 { message: [...] }
      if (Array.isArray(raw)) return segmentsText(raw);
      if (raw && typeof raw === "object" && Array.isArray(raw.message)) return segmentsText(raw.message);
      return "";
    });
  return {
    client,
    module: {
      createOneBotClient: (options) => {
        client.onEvent = options.onEvent;
        return client;
      }
    }
  };
}

function oneBotMessage(text) {
  return {
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: Math.floor(Math.random() * 100000),
    user_id: 1001,
    self_id: 999,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text } }],
    raw_message: text,
    sender: { user_id: 1001, nickname: "owner" }
  };
}

async function withRuntime(fn, { reply } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bot-inprocess-"));
  try {
    const raw = defaultConfig();
    raw.enabled = false;
    raw.storage.rootDir = join(dir, "data");
    raw.security.userWhitelist = ["1001"];
    raw.dsh.runner = "inprocess";
    raw.dsh.cwd = join(dir, "workspace");
    raw.approval.timeoutMs = 60000;
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(raw), "utf8");

    const configStore = createConfigStore({ env: { DSH_BOT_CONFIG: configPath } });
    const { service, state } = fakeAgents({ reply });
    const logger = quietLogger();
    const ctx = fakeCtx({
      logger,
      services: {
        agents: service,
        agentDefaultModel: { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-flash" }) },
        approval: { effectivePolicy: () => "ask" }
      }
    });
    const onebot = fakeOneBotApi();
    const runtime = createRuntime({
      configStore,
      logger,
      ctx,
      modules: { onebotClient: onebot.module }
    });
    try {
      await fn({ runtime, ctx, onebot, agents: state, logger, configStore });
    } finally {
      await runtime.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("接线：inprocess 的一条消息走真实 pipeline，回答原样回到 QQ", async () => {
  await withRuntime(
    async ({ runtime, ctx, onebot, agents }) => {
      const started = await runtime.start();
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(agents.created.length, 0, "启动本身不能建 agent（懒建）");
      assert.equal(typeof onebot.client.onEvent, "function", "runtime 必须把 onEvent 交给平台适配器");
      // 审批桥必须 prepend 挂上，否则会被浏览器审批面板先认领
      const entry = ctx.listeners.find((item) => item.event === "approval/request");
      assert.ok(entry, "inprocess 必须挂 approval/request 监听");
      assert.equal(entry.opts.prepend, true);

      onebot.client.onEvent(oneBotMessage("帮我看看这个仓库"));
      // 回执（"收到，开始处理了…"）会先到，所以要等真正的模型回答
      await waitFor(() => onebot.client.texts().some((text) => text.includes("我是进程内的回答")), "模型回答发出");
      assert.equal(agents.created.length, 1, "第一条消息才建 agent");
      const texts = onebot.client.texts();
      assert.ok(texts.some((text) => text.includes("我是进程内的回答")), JSON.stringify(texts));
      assert.match(onebot.client.sent[0].action, /send_private_msg/);
    },
    { reply: "我是进程内的回答" }
  );
});

test("接线：审批请求转到 QQ，回 1 放行；这条回复不会再被当成新任务", async () => {
  await withRuntime(async ({ runtime, ctx, onebot, agents }) => {
    const started = await runtime.start();
    assert.equal(started.ok, true, JSON.stringify(started));

    // 先把会话跑起来：审批消息要能回到这个 chatKey
    onebot.client.onEvent(oneBotMessage("改一下这个文件"));
    await waitFor(() => agents.followups === 1, "第一轮模型调用");

    const listener = ctx.approvalListener();
    const agent = agents.created[0].agent;
    const pending = listener({ agent, toolName: "bash", reason: "需要写到工作区之外" }, () => Promise.resolve("unavailable"));

    const approvalTexts = onebot.client.texts().filter((text) => text.includes("审批"));
    assert.equal(approvalTexts.length, 1, JSON.stringify(onebot.client.texts()));
    assert.match(approvalTexts[0], /bash/);
    assert.match(approvalTexts[0], /需要写到工作区之外/);
    assert.match(approvalTexts[0], /回复 1 允许/);

    // 用户回一个 "1"：包装层必须先把它当审批答复，不能派给 pipeline
    onebot.client.onEvent(oneBotMessage("1"));
    assert.equal(await pending, "allowed-once");
    const texts = onebot.client.texts();
    assert.match(texts[texts.length - 1], /已放行/);
    assert.equal(agents.followups, 1, "审批答复不能触发新的模型轮次");

    // 没有待审批时，"1" 就只是一条普通消息（走正常流程）
    onebot.client.onEvent(oneBotMessage("1"));
    await waitFor(() => agents.followups === 2, "普通消息照旧处理");
  });
});

test("接线：stop 会 dispose agent 并摘掉审批监听", async () => {
  await withRuntime(async ({ runtime, ctx, onebot, agents }) => {
    await runtime.start();
    onebot.client.onEvent(oneBotMessage("你好"));
    await waitFor(() => agents.created.length === 1, "agent 建好");
    assert.equal(agents.disposed.length, 0);
    await runtime.stop();
    assert.equal(agents.disposed.length, 1, "stop 必须 dispose 掉 agent");
    assert.equal(ctx.approvalListener(), null, "stop 必须摘掉审批监听");
  });
});
