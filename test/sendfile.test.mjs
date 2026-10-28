import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createPipeline,
  extractSendFilePaths,
  markersToPaths,
  stripSendFileMarkers,
} from "../src/pipeline.mjs";
import { buildPrompt } from "../src/prompt.mjs";
import { sendFile as oneBotSendFile } from "../src/onebot/send.mjs";
import { sendQqFile, qqFileTypeOf } from "../src/qqbot/send.mjs";

// 反斜杠路径用字符串拼出来，免得测试文件本身依赖转义写法
const WIN_PATH = ["C:", "Users", "me", "报告.docx"].join("\\");

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

function makeConfig(overrides = {}) {
  return {
    dsh: { cwd: "C:/work", timeoutMs: 1000 },
    storage: { rootDir: "C:/bridge", maxFileBytes: 104857600, retentionDays: 30 },
    security: { userWhitelist: [], allowPrivate: true, allowGroup: true, maxPromptChars: 8000 },
    reply: { maxChunkChars: 1500, errorPrefix: "[bridge] ", showSessionId: false },
    log: { level: "info" },
    ...overrides,
  };
}

function makeMessage(overrides = {}) {
  const text = overrides.text ?? "整理完把结果发我";
  return {
    messageId: "1001",
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

function makeHarness({ replyText = "处理完了", sendFile = null, deps = null, maxFileBytes = 1 << 20 } = {}) {
  const replies = [];
  const calls = [];
  const logger = makeLogger();
  const injected = {
    parseEvent: (raw) => ({ kind: "message", message: raw.message }),
    planMedia: () => null,
    sendReply: async ({ text }) => {
      replies.push(text);
      return { sent: 1, failed: 0 };
    },
    chatKeyOf: () => "private_u1",
    ...(deps ?? {}),
  };
  if (sendFile) {
    injected.sendFile = async (args) => {
      calls.push(args);
      return sendFile(args);
    };
  }
  const pipeline = createPipeline({
    config: makeConfig(),
    logger,
    client: { call: async () => ({ status: "ok", retcode: 0, data: {} }) },
    storage: { rootDir: os.tmpdir(), maxFileBytes },
    guard: { decide: () => ({ allow: true }) },
    serial: { run: (key, fn) => fn() },
    semaphore: { withPermit: (fn) => fn() },
    sessions: null,
    runDsh: async () => ({ ok: true, text: replyText, sessionId: "s1" }),
    deps: injected,
  });
  return { pipeline, replies, calls, logger };
}

async function makeTempFile(name, content) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-sendfile-"));
  const filePath = path.join(dir, name);
  await writeFile(filePath, content);
  return filePath;
}

// ---- 标记提取 ----

test("sendfile：提取标记，容忍两侧空格与 Windows 反斜杠路径", () => {
  const text = "整理好了\n[[sendfile:   " + WIN_PATH + "   ]]\n完事";
  assert.deepEqual(extractSendFilePaths(text), [WIN_PATH]);
});

test("sendfile：多个标记按出现顺序提取，重复项不去重（交给发送侧去重）", () => {
  const text = "[[sendfile: C:\\a.txt]]\n[[sendfile:C:\\b.txt]]\n[[sendfile: C:\\a.txt]]";
  assert.deepEqual(extractSendFilePaths(text), ["C:\\a.txt", "C:\\b.txt", "C:\\a.txt"]);
});

test("sendfile：全角冒号、引号包裹、无标记都处理得掉", () => {
  assert.deepEqual(extractSendFilePaths("[[sendfile：C:\\c.txt]]"), ["C:\\c.txt"]);
  assert.deepEqual(extractSendFilePaths('[[sendfile: "C:\\d.txt"]]'), ["C:\\d.txt"]);
  assert.deepEqual(extractSendFilePaths("没有标记"), []);
  assert.deepEqual(extractSendFilePaths(null), []);
});

// ---- 正文清理 ----

test("sendfile：只含标记的行整行删掉，空行不塌成一堆", () => {
  const text = "A\n\n[[sendfile: " + WIN_PATH + "]]\n\nB";
  assert.equal(stripSendFileMarkers(text), "A\n\nB");
});

test("sendfile：标记夹在句子里只挖掉标记本身", () => {
  const out = stripSendFileMarkers("结果在这儿 [[sendfile: C:\\a.txt]] 请查收");
  assert.equal(out.includes("[[sendfile"), false);
  assert.match(out, /^结果在这儿.*请查收$/);
});

test("sendfile：CRLF 正文也能清理干净", () => {
  assert.equal(stripSendFileMarkers("A\r\n[[sendfile: C:\\a.txt]]\r\nB"), "A\nB");
});

test("sendfile：没有 sendFile 能力时标记降级成纯路径", () => {
  assert.equal(markersToPaths("结果\n[[sendfile: " + WIN_PATH + "]]"), "结果\n" + WIN_PATH);
});

// ---- prompt 约定 ----

test("prompt：追加了 [[sendfile: 绝对路径]] 的约定", () => {
  const prompt = buildPrompt({ config: makeConfig(), message: makeMessage() });
  assert.match(prompt, /\[\[sendfile: 文件的绝对路径\]\]/);
  assert.match(prompt, /最多 3 行/);
});

// ---- pipeline 端到端 ----

test("pipeline：发文件成功，标记从正文里消失", async () => {
  const filePath = await makeTempFile("结果.txt", "hello");
  const h = makeHarness({
    replyText: "整理完成\n[[sendfile: " + filePath + "]]\n还要别的吗",
    sendFile: async () => ({ sent: 1, failed: 0 }),
  });
  await h.pipeline.handleEvent({ message: makeMessage() });

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, filePath);
  assert.equal(h.replies.at(-1), "整理完成\n还要别的吗");
});

test("pipeline：正文只剩标记时，只回一句已发送 N 个文件", async () => {
  const filePath = await makeTempFile("a.txt", "x");
  const h = makeHarness({ replyText: "[[sendfile: " + filePath + "]]", sendFile: async () => ({ sent: 1, failed: 0 }) });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.equal(h.replies.at(-1), "已发送 1 个文件");
});

test("pipeline：路径不存在时跳过并说明", async () => {
  const missing = path.join(os.tmpdir(), "dsh-sendfile-不存在-" + Date.now() + ".txt");
  const h = makeHarness({ replyText: "结果\n[[sendfile: " + missing + "]]", sendFile: async () => ({ sent: 1, failed: 0 }) });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.equal(h.calls.length, 0);
  assert.equal(h.replies.at(-1), "结果\n⚠️ 跳过了 1 个文件：路径不存在");
});

test("pipeline：相对路径不发，按不是绝对路径说明", async () => {
  const h = makeHarness({ replyText: "结果\n[[sendfile: output/a.txt]]", sendFile: async () => ({ sent: 1, failed: 0 }) });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.equal(h.calls.length, 0);
  assert.match(h.replies.at(-1), /⚠️ 跳过了 1 个文件：不是绝对路径/);
});

test("pipeline：超过 maxFileBytes 的文件跳过", async () => {
  const filePath = await makeTempFile("big.bin", "x".repeat(64));
  const h = makeHarness({
    replyText: "结果\n[[sendfile: " + filePath + "]]",
    sendFile: async () => ({ sent: 1, failed: 0 }),
    maxFileBytes: 16,
  });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.equal(h.calls.length, 0);
  assert.match(h.replies.at(-1), /⚠️ 跳过了 1 个文件：超过大小上限/);
});

test("pipeline：最多发 3 个，多出来的说明原因", async () => {
  const files = [];
  for (const name of ["1.txt", "2.txt", "3.txt", "4.txt"]) files.push(await makeTempFile(name, "x"));
  const replyText = "结果\n" + files.map((f) => "[[sendfile: " + f + "]]").join("\n");
  const h = makeHarness({ replyText, sendFile: async () => ({ sent: 1, failed: 0 }) });
  await h.pipeline.handleEvent({ message: makeMessage() });

  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.map((c) => c.path), files.slice(0, 3));
  assert.equal(h.replies.at(-1), "结果\n⚠️ 跳过了 1 个文件：超过每轮上限（最多 3 个）");
});

test("pipeline：同一个路径写两遍只发一次", async () => {
  const filePath = await makeTempFile("dup.txt", "x");
  const h = makeHarness({
    replyText: "[[sendfile: " + filePath + "]]\n[[sendfile: " + filePath + "]]",
    sendFile: async () => ({ sent: 1, failed: 0 }),
  });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.equal(h.calls.length, 1);
  assert.equal(h.replies.at(-1), "已发送 1 个文件");
});

test("pipeline：sendFile 抛错不冒泡，只补一句发送失败", async () => {
  const filePath = await makeTempFile("boom.txt", "x");
  const h = makeHarness({
    replyText: "结果\n[[sendfile: " + filePath + "]]",
    sendFile: async () => {
      throw new Error("连接断了");
    },
  });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.equal(h.replies.at(-1), "结果\n⚠️ 1 个文件发送失败");
  assert.ok(h.logger.lines.some((line) => line.level === "warn" && line.msg === "发送文件失败"));
});

test("pipeline：sendFile 返回失败也计成发送失败", async () => {
  const filePath = await makeTempFile("fail.txt", "x");
  const h = makeHarness({ replyText: "[[sendfile: " + filePath + "]]", sendFile: async () => ({ sent: 0, failed: 1 }) });
  await h.pipeline.handleEvent({ message: makeMessage() });
  assert.equal(h.replies.at(-1), "⚠️ 1 个文件发送失败");
});

test("pipeline：缺 sendFile 依赖时降级成只回文字路径，不失败", async () => {
  const filePath = await makeTempFile("degrade.txt", "x");
  const h = makeHarness({ replyText: "结果\n[[sendfile: " + filePath + "]]" });
  await h.pipeline.handleEvent({ message: makeMessage() });

  const last = h.replies.at(-1);
  assert.equal(h.calls.length, 0);
  assert.equal(last.includes("[[sendfile"), false);
  assert.ok(last.includes(filePath));
  assert.equal(h.pipeline.stats().failed, 0);
});

// ---- OneBot 侧 ----

test("onebot sendFile：图片走 image 段，file:// 绝对路径", async () => {
  const filePath = await makeTempFile("图.png", "x");
  const calls = [];
  const client = {
    call: async (action, params) => {
      calls.push({ action, params });
      return { status: "ok", retcode: 0 };
    },
  };
  const res = await oneBotSendFile({
    client,
    message: makeMessage({ chatType: "group", groupId: "G1" }),
    path: filePath,
    logger: makeLogger(),
  });

  assert.deepEqual(res, { sent: 1, failed: 0 });
  assert.equal(calls[0].action, "send_group_msg");
  assert.equal(calls[0].params.group_id, "G1");
  assert.deepEqual(calls[0].params.message, [{ type: "image", data: { file: pathToFileURL(filePath).href } }]);
});

test("onebot sendFile：普通文件走 file 段并带名字", async () => {
  const filePath = await makeTempFile("报告.pdf", "x");
  const calls = [];
  const client = {
    call: async (action, params) => {
      calls.push({ action, params });
      return { status: "ok", retcode: 0 };
    },
  };
  await oneBotSendFile({ client, message: makeMessage(), path: filePath, logger: makeLogger() });

  assert.equal(calls[0].action, "send_private_msg");
  assert.equal(calls[0].params.user_id, "10001");
  assert.deepEqual(calls[0].params.message, [
    { type: "file", data: { file: pathToFileURL(filePath).href, name: "报告.pdf" } },
  ]);
});

test("onebot sendFile：段直传被拒时退回上传接口", async () => {
  const filePath = await makeTempFile("报告.pdf", "x");
  const calls = [];
  const client = {
    call: async (action, params) => {
      calls.push({ action, params });
      if (action === "send_group_msg") throw new Error("不支持 file 段");
      return { status: "ok", retcode: 0 };
    },
  };
  const res = await oneBotSendFile({
    client,
    message: makeMessage({ chatType: "group", groupId: "G1" }),
    path: filePath,
    logger: makeLogger(),
  });

  assert.deepEqual(res, { sent: 1, failed: 0 });
  assert.equal(calls[1].action, "upload_group_file");
  assert.equal(calls[1].params.file, filePath);
  assert.equal(calls[1].params.name, "报告.pdf");
});

test("onebot sendFile：两条路都失败时如实计失败", async () => {
  const client = { call: async () => { throw new Error("boom"); } };
  const logger = makeLogger();
  const res = await oneBotSendFile({ client, message: makeMessage(), path: WIN_PATH, logger });
  assert.deepEqual(res, { sent: 0, failed: 1 });
  assert.ok(logger.lines.some((line) => line.level === "warn"));
});

// ---- QQ 官方侧 ----

test("qqbot sendQqFile：上传拿 file_info，再发 msg_type=7 富媒体", async () => {
  const filePath = await makeTempFile("报告.pdf", "PDF");
  const uploaded = [];
  const posted = [];
  const client = {
    uploadFileContent: async (args) => {
      uploaded.push(args);
      return { file_info: "FI-1" };
    },
    sendMessage: async (args) => {
      posted.push(args);
      return {};
    },
  };

  const res = await sendQqFile({ client, message: makeMessage({ messageId: "MID-1" }), path: filePath, logger: makeLogger() });

  assert.deepEqual(res, { sent: 1, failed: 0 });
  assert.equal(uploaded[0].chatType, "private");
  assert.equal(uploaded[0].target, "10001");
  assert.equal(uploaded[0].fileType, 4);
  assert.equal(uploaded[0].filename, "报告.pdf");
  assert.equal(posted[0].chatType, "private");
  assert.equal(posted[0].body.msg_type, 7);
  assert.deepEqual(posted[0].body.media, { file_info: "FI-1" });
  assert.equal(posted[0].body.msg_id, "MID-1");
  assert.ok(posted[0].body.msg_seq >= 1);
});

test("qqbot sendQqFile：图片按 file_type=1 上传", async () => {
  const filePath = await makeTempFile("图.png", "x");
  const uploaded = [];
  const client = {
    uploadFileContent: async (args) => {
      uploaded.push(args);
      return { file_info: "FI-2" };
    },
    sendMessage: async () => ({}),
  };
  await sendQqFile({ client, message: makeMessage({ chatType: "group", groupId: "G1" }), path: filePath, logger: makeLogger() });
  assert.equal(uploaded[0].chatType, "group");
  assert.equal(uploaded[0].target, "G1");
  assert.equal(uploaded[0].fileType, 1);
  assert.equal(qqFileTypeOf("a.PNG"), 1);
  assert.equal(qqFileTypeOf("a.pdf"), 4);
});

test("qqbot sendQqFile：上传失败记 warn 并计失败，不抛", async () => {
  const filePath = await makeTempFile("x.txt", "x");
  const logger = makeLogger();
  const client = {
    uploadFileContent: async () => {
      throw new Error("400");
    },
    sendMessage: async () => ({}),
  };
  const res = await sendQqFile({ client, message: makeMessage(), path: filePath, logger });
  assert.deepEqual(res, { sent: 0, failed: 1 });
  assert.ok(logger.lines.some((line) => line.level === "warn" && line.msg === "QQ 富媒体上传失败"));
});

test("qqbot sendQqFile：client 不支持富媒体上传时降级成失败而不是抛", async () => {
  const res = await sendQqFile({ client: {}, message: makeMessage(), path: WIN_PATH, logger: makeLogger() });
  assert.deepEqual(res, { sent: 0, failed: 1 });
});
