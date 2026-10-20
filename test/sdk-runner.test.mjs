import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSdkRunner, textOfMessage } from "../src/sdk-runner.mjs";

const configFor = (overrides = {}) => ({
  dsh: {
    nodePath: "D:\\Node\\node.exe",
    binPath: "C:\\dsh\\lib\\bin.js",
    profile: "sdk",
    cwd: "",
    timeoutMs: 2000,
    permissionMode: "workspace-write",
    runner: "sdk",
    provider: "deepseek-official",
    model: "deepseek-flash",
    reasoningEffort: "high",
    ...overrides
  }
});

// 所有回包都排到下一个 tick：真子进程的 stdout 不可能在 write() 里同步回来，
// 同步回放会把"先登记再写"的时序掩盖掉
function later(fn) {
  setTimeout(fn, 0);
}

/**
 * 假子进程 + 假 SDK 服务端。
 * handler 每收到一条 JSON-RPC 请求就被调用一次，可自由 reply / notify。
 */
function fakeSpawn(handler = () => {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    const record = { command, args, options, requests: [], written: [], child };
    child.pid = 9000 + calls.length;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};

    const emit = (payload) => later(() => child.stdout.emit("data", JSON.stringify(payload) + "\n"));
    const reply = (id, result) => emit({ jsonrpc: "2.0", id, result });
    const replyError = (id, message) => emit({ jsonrpc: "2.0", id, error: { code: -32000, message } });
    const notify = (method, params) => emit({ jsonrpc: "2.0", method, params });

    child.stdin = {
      on() {},
      write(chunk) {
        const text = String(chunk);
        record.written.push(text);
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          let message;
          try {
            message = JSON.parse(trimmed);
          } catch {
            continue;
          }
          record.requests.push(message);
          handler({ message, child, record, reply, replyError, notify });
        }
        return true;
      },
      end() {}
    };

    child.kill = () => {
      child.killed = true;
      later(() => child.emit("close", null, "SIGTERM"));
    };
    calls.push(record);
    return child;
  };
  return { spawnImpl, calls };
}

/** 一轮完整的乐观回放：入队回执 + 一条 assistant/message + turn/end(completed)。 */
function happyTurn({ reply, notify, message, text }) {
  const sessionId = message.params.sessionId;
  reply(message.id, { messageId: "m-" + sessionId });
  notify("session.event", {
    sessionId,
    event: {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: text ?? "答:" + message.params.contentBlocks[0].text },
            { type: "tool-call", name: "read" }
          ]
        }
      }
    }
  });
  notify("session.event", { sessionId, event: { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
}

const HANDSHAKE = { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } };

function serveFactory(extra = () => {}) {
  return ({ message, reply, replyError, notify, child, record }) => {
    if (message.method === "initialize") return reply(message.id, HANDSHAKE);
    if (message.method === "session/prompt") {
      const handled = extra({ message, reply, replyError, notify, child, record });
      if (handled !== true) happyTurn({ reply, notify, message });
      return undefined;
    }
    if (message.method === "session/resume") return reply(message.id, {});
    if (message.method === "shutdown") return reply(message.id, {});
    return undefined;
  };
}

test("textOfMessage：只拼 text 块，非 text 块进不了用户可见答案", () => {
  assert.equal(textOfMessage({ content: [{ type: "text", text: "A" }, { type: "tool-call" }, { type: "text", text: "B" }] }), "AB");
  assert.equal(textOfMessage({ content: null }), "");
  assert.equal(textOfMessage(null), "");
});

test("sdk-runner：懒启动只握手一次，两轮 run 复用同一个子进程", async () => {
  const { spawnImpl, calls } = fakeSpawn(serveFactory());
  const runner = createSdkRunner({ config: configFor(), spawnImpl });

  assert.equal(calls.length, 0, "建 runner 不该 spawn：第一条消息进来才懒启动");

  const first = await runner.run({ prompt: "你好", sessionId: "sess-1" });
  const second = await runner.run({ prompt: "再来", sessionId: "sess-1" });

  assert.equal(calls.length, 1, "两轮必须复用同一个子进程");
  assert.equal(first.reason, "ok");
  assert.equal(first.ok, true);
  assert.equal(first.text, "答:你好");
  assert.equal(first.sessionId, "sess-1");
  assert.equal(second.text, "答:再来");
  assert.equal(calls[0].requests.filter((r) => r.method === "initialize").length, 1, "initialize 只做一次");
  assert.equal(calls[0].requests.filter((r) => r.method === "session/prompt").length, 2);
  assert.equal(runner.status().state, "ready");

  const init = calls[0].requests[0];
  assert.equal(init.params.provider, "deepseek-official");
  assert.equal(init.params.model, "deepseek-flash");
  assert.equal(init.params.reasoningEffort, "high");

  await runner.stop();
});

test("sdk-runner：不同 sessionId 也排队，同一条 stdio 通道不交错", async () => {
  const seq = [];
  const { spawnImpl } = fakeSpawn(
    serveFactory(({ message, reply, notify }) => {
      const sessionId = message.params.sessionId;
      seq.push(sessionId + ":prompt");
      reply(message.id, { messageId: "m" });
      // a 会话故意晚收尾：若没有串行队列，b 的 prompt 会插在 a 的 turn/end 之前
      setTimeout(() => {
        seq.push(sessionId + ":end");
        notify("session.event", { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: sessionId }] } } } });
        notify("session.event", { sessionId, event: { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
      }, sessionId === "a" ? 30 : 0);
      return true;
    })
  );
  const runner = createSdkRunner({ config: configFor(), spawnImpl });
  const [a, b] = await Promise.all([
    runner.run({ prompt: "1", sessionId: "a" }),
    runner.run({ prompt: "2", sessionId: "b" })
  ]);
  assert.deepEqual(seq, ["a:prompt", "a:end", "b:prompt", "b:end"]);
  assert.equal(a.text, "a");
  assert.equal(b.text, "b");
  await runner.stop();
});

test("sdk-runner：子进程中途崩溃 → runner_error，下一次 run 自动重启并重新握手", async () => {
  let crashed = false;
  const { spawnImpl, calls } = fakeSpawn(
    serveFactory(({ message, reply, child }) => {
      if (crashed) return undefined;
      crashed = true;
      reply(message.id, { messageId: "m" });
      setTimeout(() => child.emit("close", 137, null), 0);
      return true;
    })
  );
  const runner = createSdkRunner({ config: configFor(), spawnImpl });

  const first = await runner.run({ prompt: "1", sessionId: "s" });
  assert.equal(first.ok, false);
  assert.equal(first.reason, "runner_error");
  assert.match(runner.status().lastError ?? "", /退出/);
  assert.equal(runner.status().state, "dead");

  const second = await runner.run({ prompt: "2", sessionId: "s" });
  assert.equal(second.reason, "ok");
  assert.equal(second.text, "答:2");
  assert.equal(calls.length, 2, "崩溃后必须换一个新子进程");
  assert.equal(calls[1].requests.filter((r) => r.method === "initialize").length, 1, "新进程要重新握手");
  await runner.stop();
});

test("sdk-runner：单轮超时返回 timeout 并 kill 子进程", async () => {
  const { spawnImpl, calls } = fakeSpawn(
    serveFactory(({ message, reply }) => {
      // 只回入队回执，永不发 turn/end：模拟卡死的一轮
      reply(message.id, { messageId: "m" });
      return true;
    })
  );
  const runner = createSdkRunner({ config: configFor({ timeoutMs: 40 }), spawnImpl });

  const result = await runner.run({ prompt: "卡住", sessionId: "s" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.equal(result.text, "");
  assert.equal(calls[0].child.killed, true, "超时必须杀掉卡住的进程");
  assert.equal(runner.status().state, "dead");

  await runner.stop();
});

test("sdk-runner：stop 先发 shutdown 再 kill，且幂等", async () => {
  const { spawnImpl, calls } = fakeSpawn(serveFactory());
  const runner = createSdkRunner({ config: configFor(), spawnImpl });
  await runner.run({ prompt: "你好", sessionId: "s" });

  await runner.stop();
  assert.ok(calls[0].requests.some((r) => r.method === "shutdown"), "stop 必须先在协议层道别");
  assert.equal(calls[0].child.killed, true);
  assert.equal(runner.status().state, "idle");

  await runner.stop(); // 幂等：第二次不抛、不再 spawn
  assert.equal(calls.length, 1);

  const again = await runner.run({ prompt: "再来", sessionId: "s" });
  assert.equal(again.reason, "ok", "stop 之后还能再跑：下一次 run 重新拉起");
  assert.equal(calls.length, 2);
  await runner.stop();
});

test("sdk-runner：turn/end 带 error 判 model_error，completed 但无文字判 no_final", async () => {
  const script = { kind: "error" };
  const { spawnImpl } = fakeSpawn(
    serveFactory(({ message, reply, notify }) => {
      const sessionId = message.params.sessionId;
      reply(message.id, { messageId: "m" });
      if (script.kind === "error") {
        notify("session.event", { sessionId, event: { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "模型返回 401", code: "UNAUTHORIZED" } } } } });
      } else {
        notify("session.event", { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "tool-call", name: "read" }] } } } });
        notify("session.event", { sessionId, event: { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
      }
      return true;
    })
  );
  const runner = createSdkRunner({ config: configFor(), spawnImpl });

  const failed = await runner.run({ prompt: "x", sessionId: "s1" });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "model_error");
  assert.equal(failed.turnEndKind, "error");
  assert.equal(failed.turnError, "模型返回 401");

  script.kind = "empty";
  const empty = await runner.run({ prompt: "x", sessionId: "s2" });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "no_final");
  await runner.stop();
});

test("sdk-runner：只认本会话的事件，别的会话（子代理）混不进来", async () => {
  const { spawnImpl } = fakeSpawn(
    serveFactory(({ message, reply, notify }) => {
      const sessionId = message.params.sessionId;
      reply(message.id, { messageId: "m" });
      // 先来一条别的会话的答案，再来本会话的：混了就会把子代理的字回给用户
      notify("session.event", { sessionId: "child-1", event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "子代理的话" }] } } } });
      notify("session.event", { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "本体的话" }] } } } });
      notify("session.event", { sessionId, event: { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
      return true;
    })
  );
  const runner = createSdkRunner({ config: configFor(), spawnImpl });
  const result = await runner.run({ prompt: "x", sessionId: "s" });
  assert.equal(result.text, "本体的话");
  await runner.stop();
});

test("sdk-runner：多步只取最后一条 assistant/message（对齐 headless 的 final）", async () => {
  const { spawnImpl } = fakeSpawn(
    serveFactory(({ message, reply, notify }) => {
      const sessionId = message.params.sessionId;
      reply(message.id, { messageId: "m" });
      notify("session.event", { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "我先看看文件" }] } } } });
      notify("session.event", { sessionId, event: { type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: "{}" } } });
      notify("session.event", { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "答案是 42" }] } } } });
      notify("session.event", { sessionId, event: { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
      return true;
    })
  );
  const runner = createSdkRunner({ config: configFor(), spawnImpl });
  const result = await runner.run({ prompt: "x", sessionId: "s" });
  assert.equal(result.text, "答案是 42");
  await runner.stop();
});

test("sdk-runner：stderr 只留最近 4KB，并带在失败结果上", async () => {
  const { spawnImpl, calls } = fakeSpawn(
    serveFactory(({ message, reply, child }) => {
      if (message.method === "session/prompt") {
        later(() => child.stderr.emit("data", "E".repeat(6000) + "-TAIL"));
        reply(message.id, { messageId: "m" });
        later(() => child.emit("close", 1, null));
        return true;
      }
      return undefined;
    })
  );
  const runner = createSdkRunner({ config: configFor(), spawnImpl });
  const result = await runner.run({ prompt: "x", sessionId: "s" });
  assert.equal(result.reason, "runner_error");
  assert.equal(result.stderrTail.length, 4096);
  assert.match(result.stderrTail, /-TAIL$/);
  assert.equal(calls.length, 1);
  await runner.stop();
});

test("sdk-runner：缺 binPath 直接 not_configured，不去 spawn", async () => {
  const { spawnImpl, calls } = fakeSpawn(serveFactory());
  const runner = createSdkRunner({ config: configFor({ binPath: "" }), spawnImpl });
  const result = await runner.run({ prompt: "x", sessionId: null });
  assert.equal(result.reason, "not_configured");
  assert.equal(calls.length, 0);
  assert.equal(result.sessionId, null);
});

test("sdk-runner：spawn 连败 3 次才返回 spawn_error（指数退避）", async () => {
  let attempts = 0;
  const spawnImpl = () => {
    attempts += 1;
    throw new Error("ENOENT: 找不到 dsh");
  };
  const runner = createSdkRunner({ config: configFor(), spawnImpl, retryBaseMs: 1 });
  const result = await runner.run({ prompt: "x", sessionId: "s" });
  assert.equal(result.reason, "spawn_error");
  assert.equal(attempts, 3);
  assert.match(runner.status().lastError ?? "", /ENOENT/);
});

test("sdk-runner：空闲超时自动退出子进程，下次 run 再起", async () => {
  const { spawnImpl, calls } = fakeSpawn(serveFactory());
  const runner = createSdkRunner({ config: configFor(), spawnImpl, idleExitMs: 20 });
  await runner.run({ prompt: "1", sessionId: "s" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls[0].child.killed, true, "空闲超时要主动退场");
  assert.equal(runner.status().state, "idle");

  const again = await runner.run({ prompt: "2", sessionId: "s" });
  assert.equal(again.reason, "ok");
  assert.equal(calls.length, 2);
  await runner.stop();
});

test("sdk-runner：session/prompt 报 already exists 时先 session/resume 再重试", async () => {
  const { spawnImpl, calls } = fakeSpawn(
    serveFactory(({ message, reply, replyError, notify, record }) => {
      if (message.method === "session/prompt") {
        const seen = record.requests.filter((r) => r.method === "session/prompt").length;
        if (seen === 1) {
          replyError(message.id, "session already exists: s");
          return true;
        }
        const resumed = record.requests.some((r) => r.method === "session/resume");
        reply(message.id, { messageId: "m" });
        notify("session.event", { sessionId: message.params.sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: resumed ? "续接成功" : "没续接" }] } } } });
        notify("session.event", { sessionId: message.params.sessionId, event: { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
        return true;
      }
      return undefined;
    })
  );
  const runner = createSdkRunner({ config: configFor(), spawnImpl });
  const result = await runner.run({ prompt: "x", sessionId: "s" });
  assert.equal(result.reason, "ok", JSON.stringify(result));
  assert.equal(result.text, "续接成功");
  assert.equal(calls[0].requests.filter((r) => r.method === "session/resume").length, 1);
  await runner.stop();
});

test("sdk-runner：协议层报错（非 already exists）直接 runner_error，不瞎重试", async () => {
  const { spawnImpl, calls } = fakeSpawn(
    serveFactory(({ message, replyError }) => {
      if (message.method === "session/prompt") {
        replyError(message.id, "SDK server is not initialized");
        return true;
      }
      return undefined;
    })
  );
  const runner = createSdkRunner({ config: configFor(), spawnImpl });
  const result = await runner.run({ prompt: "x", sessionId: "s" });
  assert.equal(result.reason, "runner_error");
  assert.match(result.error, /not initialized/);
  assert.equal(calls[0].requests.filter((r) => r.method === "session/resume").length, 0);
  await runner.stop();
});

test("sdk-runner：没给 sessionId 时自己发一个并回传，调用方据此落盘", async () => {
  const { spawnImpl, calls } = fakeSpawn(serveFactory());
  const runner = createSdkRunner({ config: configFor(), spawnImpl });
  const result = await runner.run({ prompt: "第一句" });
  assert.equal(result.reason, "ok");
  assert.match(result.sessionId, /^sdk-/);
  assert.equal(calls[0].requests.find((r) => r.method === "session/prompt").params.sessionId, result.sessionId);
  await runner.stop();
});

test("sdk-runner：spawn 参数与 env 与 headless 对齐", async () => {
  const { spawnImpl, calls } = fakeSpawn(serveFactory());
  const runner = createSdkRunner({ config: configFor({ env: { EXTRA_FLAG: "1" } }), spawnImpl });
  await runner.run({ prompt: "x", sessionId: "s" });
  assert.equal(calls[0].command, "D:\\Node\\node.exe");
  assert.deepEqual(calls[0].args, ["C:\\dsh\\lib\\bin.js", "--profile", "sdk"]);
  assert.equal(calls[0].options.env.DSH_PERMISSION_MODE, "workspace-write");
  assert.equal(calls[0].options.env.EXTRA_FLAG, "1");
  assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
  await runner.stop();
});
