import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseNdjsonLines, runDsh } from "../src/dsh.mjs";
import { transcribe } from "../src/asr.mjs";

const configFor = (overrides = {}) => ({
  dsh: {
    nodePath: "D:\\Node\\node.exe",
    binPath: "C:\\dsh\\lib\\bin.js",
    profile: "im-bridge",
    cwd: "C:/work",
    timeoutMs: 5000,
    permissionMode: "workspace-write",
    env: { BRIDGE_EXTRA: "1" },
    ...overrides,
  },
});

/** 假 spawn：按 plan 在下一个 tick 里回放 stdout/stderr/close，用来模拟真实子进程。 */
function fakeSpawn(plan = {}) {
  const calls = [];
  const impl = (command, args, options) => {
    const child = new EventEmitter();
    const stdinChunks = [];
    child.pid = plan.pid;
    child.killed = false;
    child.stdin = {
      on() {},
      write(chunk) {
        stdinChunks.push(String(chunk));
      },
      end(chunk) {
        if (chunk !== undefined) stdinChunks.push(String(chunk));
      },
    };
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => {
      child.killed = true;
      if (plan.killCloses === true) setTimeout(() => child.emit("close", null, "SIGKILL"), 0);
    };
    calls.push({ command, args, options, stdin: () => stdinChunks.join(""), child });
    setTimeout(() => {
      for (const line of plan.lines ?? []) child.stdout.emit("data", line);
      if (plan.stderr) child.stderr.emit("data", plan.stderr);
      if (plan.close !== false) child.emit("close", plan.exitCode ?? 0, null);
    }, 0);
    return child;
  };
  return { impl, calls };
}

const SESSION_LINE = '{"type":"session","sessionId":"session-abc","cwd":"C:/work"}\n';

test("parseNdjsonLines：跨 chunk 的半行留到下一次拼接", () => {
  const first = parseNdjsonLines('{"type":"sess');
  assert.deepEqual(first.events, []);
  assert.equal(first.rest, '{"type":"sess');

  const second = parseNdjsonLines(first.rest + 'ion","sessionId":"session-1"}\n');
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].sessionId, "session-1");
  assert.equal(second.rest, "");
});

test("parseNdjsonLines：一行多个事件、空行、非法 JSON 行都不抛", () => {
  const { events, rest } = parseNdjsonLines(
    '\n{"type":"text","text":"a"}\nnot-json-at-all\n\n{"type":"final","text":"OK"}\n{"type":"status"',
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["text", "final"],
  );
  assert.equal(rest, '{"type":"status"');
});

test("parseNdjsonLines：接受 Buffer，也吃 CRLF", () => {
  const { events, rest } = parseNdjsonLines(Buffer.from('{"type":"final","text":"OK"}\r\n'));
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "OK");
  assert.equal(rest, "");
});

test("runDsh：session + turn_end(completed) + final 判成功", async () => {
  const fake = fakeSpawn({
    lines: [
      SESSION_LINE,
      '{"type":"status","phase":"turn_start","turn":1}\n',
      '{"type":"text","text":"OK"}\n',
      '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}\n',
      '{"type":"final","text":"OK"}\n',
    ],
    stderr: "只是启动噪音",
  });

  const result = await runDsh({
    config: configFor(),
    prompt: "你好",
    sessionId: "session-old",
    spawnImpl: fake.impl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "ok");
  assert.equal(result.sessionId, "session-abc");
  assert.equal(result.text, "OK");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderrTail, "只是启动噪音");
  assert.ok(result.durationMs >= 0);
  assert.equal(result.events.length, 5);

  const call = fake.calls[0];
  assert.equal(call.command, "D:\\Node\\node.exe");
  assert.deepEqual(call.args, [
    "C:\\dsh\\lib\\bin.js",
    "--profile",
    "im-bridge",
    "--session-id",
    "session-old",
    "--json",
    "-",
  ]);
  assert.equal(call.options.cwd, "C:/work");
  assert.equal(call.options.env.DSH_PERMISSION_MODE, "workspace-write");
  assert.equal(call.options.env.BRIDGE_EXTRA, "1");
  assert.equal(call.stdin(), "你好");
});

test("runDsh：没有 sessionId 时不带 --session-id 旗标", async () => {
  const fake = fakeSpawn({
    lines: [SESSION_LINE, '{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\n', '{"type":"final","text":"hi"}\n'],
  });
  const result = await runDsh({ config: configFor(), prompt: "x", spawnImpl: fake.impl });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls[0].args, [
    "C:\\dsh\\lib\\bin.js",
    "--profile",
    "im-bridge",
    "--json",
    "-",
  ]);
});

test("runDsh：模型中途失败（final 空 + turn_end error）判失败", async () => {
  const fake = fakeSpawn({
    lines: [
      SESSION_LINE,
      '{"type":"error","message":"provider 掉线了"}\n',
      '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error"}}\n',
      '{"type":"final","text":""}\n',
    ],
  });
  const result = await runDsh({ config: configFor(), prompt: "x", spawnImpl: fake.impl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "runner_error");
  assert.equal(result.text, "");
});

test("runDsh：只有 final 但 turn_end 不是 completed 也算失败", async () => {
  const fake = fakeSpawn({
    lines: [SESSION_LINE, '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error"}}\n', '{"type":"final","text":"半截"}\n'],
  });
  const result = await runDsh({ config: configFor(), prompt: "x", spawnImpl: fake.impl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "model_error");
  assert.equal(result.text, "半截");
});

test("runDsh：只有 error 事件（用法级错误）判 runner_error", async () => {
  const fake = fakeSpawn({
    lines: ['{"type":"error","message":"error: a task is required"}\n'],
    exitCode: 1,
  });
  const result = await runDsh({ config: configFor(), prompt: "", spawnImpl: fake.impl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "runner_error");
  assert.equal(result.exitCode, 1);
  assert.equal(result.sessionId, null);
  assert.equal(result.text, "");
});

test("runDsh：超时后 kill 并返回 timeout", async () => {
  const fake = fakeSpawn({ close: false, killCloses: false });
  const result = await runDsh({ config: configFor({ timeoutMs: 20 }), prompt: "慢任务", spawnImpl: fake.impl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.equal(fake.calls[0].child.killed, true);
});

test("runDsh：AbortSignal 触发 cancelled", async () => {
  const fake = fakeSpawn({ close: false, killCloses: true });
  const controller = new AbortController();
  const running = runDsh({
    config: configFor(),
    prompt: "x",
    signal: controller.signal,
    spawnImpl: fake.impl,
  });
  controller.abort();
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
});

test("runDsh：缺 binPath 直接 not_configured，不去 spawn", async () => {
  const fake = fakeSpawn();
  const result = await runDsh({ config: configFor({ binPath: "" }), prompt: "x", spawnImpl: fake.impl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_configured");
  assert.equal(fake.calls.length, 0);
});

test("runDsh：spawn 抛错转成 spawn_error", async () => {
  const result = await runDsh({
    config: configFor(),
    prompt: "x",
    spawnImpl: () => {
      throw new Error("EPERM: spawn 被拒绝");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "spawn_error");
});

test("runDsh：跨 chunk 的半行 session 事件也能拼出来", async () => {
  const fake = fakeSpawn({
    lines: [
      '{"type":"sess',
      'ion","sessionId":"session-split"}\n{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\n',
      '{"type":"final","text":"split"}\n',
    ],
  });
  const result = await runDsh({ config: configFor(), prompt: "x", spawnImpl: fake.impl });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "session-split");
  assert.equal(result.text, "split");
});


test("runDsh：cwd 不存在时先自建目录再 spawn", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dsh-cwd-create-"));
  const cwdPath = path.join(base, "bridge-data", "workspace");
  assert.equal(existsSync(cwdPath), false);

  const fake = fakeSpawn({
    lines: [SESSION_LINE, '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}\n', '{"type":"final","text":"OK"}\n'],
  });
  const seen = [];
  const result = await runDsh({
    config: configFor({ cwd: cwdPath }),
    prompt: "x",
    spawnImpl: (command, args, options) => {
      seen.push({ cwd: options.cwd, existedAtSpawn: existsSync(options.cwd) });
      return fake.impl(command, args, options);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(existsSync(cwdPath), true, "runDsh 应把 cwd 建出来");
  assert.deepEqual(seen, [{ cwd: cwdPath, existedAtSpawn: true }]);
  assert.equal(result.cwd, cwdPath);
});

test("runDsh：cwd 建不出来 + spawn ENOENT → reason 是 cwd_missing 并带路径", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dsh-cwd-blocked-"));
  const blocker = path.join(base, "blocked");
  await writeFile(blocker, "我是个文件，不是目录", "utf8");
  const cwdPath = path.join(blocker, "workspace");

  const result = await runDsh({
    config: configFor({ cwd: cwdPath }),
    prompt: "x",
    spawnImpl: () => {
      const error = new Error("spawn ENOENT");
      error.code = "ENOENT";
      throw error;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "cwd_missing");
  assert.equal(result.cwd, cwdPath);
});

test("runDsh：cwd 正常但 spawn ENOENT 仍算 spawn_error（可执行文件找不到）", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dsh-cwd-fine-"));
  const result = await runDsh({
    config: configFor({ cwd: base }),
    prompt: "x",
    spawnImpl: () => {
      const error = new Error("spawn ENOENT");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "spawn_error");
});

test("pipeline：cwd_missing 的错误回复带出中文工作目录提示", async () => {
  const { createPipeline } = await import("../src/pipeline.mjs");
  const cwdPath = path.join("E:", "dsh-im-bridge-data", "workspace");
  const sent = [];

  const pipeline = createPipeline({
    config: { ...configFor({ cwd: cwdPath }), reply: { maxChunkChars: 1500, errorPrefix: "[bridge] ", showSessionId: false } },
    logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; }, flush: async () => {} },
    client: { isOpen: () => true, async call() { return { status: "ok", data: {} }; } },
    storage: { async saveFromUrl() { return { path: "C:/x", bytes: 1, sha256: "s" }; } },
    guard: { decide: () => ({ allow: true, reason: "ok" }) },
    serial: { run: (key, fn) => fn(), pending: () => 0, size: () => 0 },
    semaphore: { withPermit: (fn) => fn(), active: () => 0 },
    sessions: { get: () => undefined, set: async () => {}, clear: async () => {}, all: () => ({}) },
    runDsh: async () => ({ ok: false, text: "", sessionId: null, reason: "cwd_missing", exitCode: null, cwd: cwdPath }),
    deps: {
      parseEvent: () => ({
        kind: "message",
        message: {
          messageId: "1",
          chatType: "private",
          userId: "10001",
          groupId: null,
          selfId: "0",
          senderName: "tester",
          time: 1700000000,
          text: "只回答两个字：OK",
          segments: [],
          atTargets: [],
          replyTo: null,
        },
      }),
      planMedia: () => null,
      sendReply: async ({ text }) => {
        sent.push(text);
        return { sent: 1, failed: 0 };
      },
      chatKeyOf: () => "private_10001",
    },
  });

  await pipeline.handleEvent({ post_type: "message" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0], `[bridge] DSH 工作目录不存在或无法进入：${cwdPath}`);
});

test("asr：未配置命令返回 not_configured", async () => {
  const result = await transcribe({
    config: { asr: { command: "", args: [], timeoutMs: 1000 } },
    filePath: "C:/media/a.amr",
  });
  assert.deepEqual(result, { ok: false, text: "", reason: "not_configured" });
});

test("asr：stdout 去空白即转写结果，{file} 会被替换", async () => {
  const fake = fakeSpawn({ lines: ["  你好世界  \n"], exitCode: 0 });
  const result = await transcribe({
    config: { asr: { command: "asr-tool", args: ["--input", "{file}"], timeoutMs: 2000 } },
    filePath: "C:/media/a.amr",
    spawnImpl: fake.impl,
  });
  assert.deepEqual(result, { ok: true, text: "你好世界", reason: "ok" });
  assert.equal(fake.calls[0].command, "asr-tool");
  assert.deepEqual(fake.calls[0].args, ["--input", "C:/media/a.amr"]);
});

test("asr：模板没写 {file} 时把路径补在末尾；非零退出码带出来", async () => {
  const fake = fakeSpawn({ lines: [], exitCode: 3 });
  const result = await transcribe({
    config: { asr: { command: "asr-tool", args: ["--json"], timeoutMs: 2000 } },
    filePath: "C:/media/b.amr",
    spawnImpl: fake.impl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "exit_3");
  assert.deepEqual(fake.calls[0].args, ["--json", "C:/media/b.amr"]);
});

test("asr：超时返回 timeout", async () => {
  const fake = fakeSpawn({ close: false });
  const result = await transcribe({
    config: { asr: { command: "asr-tool", args: [], timeoutMs: 20 } },
    filePath: "C:/media/c.amr",
    spawnImpl: fake.impl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
});
