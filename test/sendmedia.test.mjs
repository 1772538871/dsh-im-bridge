import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createPipeline,
  extractSendFilePaths,
  extractSendImagePaths,
  extractSendMedia,
  extractSendVoicePaths,
  markersToPaths,
  stripSendFileMarkers,
} from "../src/pipeline.mjs";
import { buildPrompt } from "../src/prompt.mjs";
import { sendFile as oneBotSendFile, sendMedia as oneBotSendMedia } from "../src/onebot/send.mjs";
import { sendQqFile, sendQqMedia } from "../src/qqbot/send.mjs";
import { createQqBotAdapter } from "../src/qqbot/adapter.mjs";

const WIN_IMG = ["C:", "Users", "me", "图.png"].join("\\");

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
  const text = overrides.text ?? "把图和语音发我";
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

function makeHarness({ replyText = "处理完了", sendMedia = null, sendFile = null } = {}) {
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
  };
  if (sendMedia) {
    injected.sendMedia = async (args) => {
      calls.push(args);
      return sendMedia(args);
    };
  }
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
    storage: { rootDir: os.tmpdir(), maxFileBytes: 1 << 20 },
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-sendmedia-"));
  const filePath = path.join(dir, name);
  await writeFile(filePath, content);
  return filePath;
}

// ---- 标记提取与校验 ----

test("sendimage/sendvoice：三种标记按出现顺序提取，kind 分清", () => {
  const text = [
    "结果如下",
    "[[sendfile: C:\\a.txt]]",
    "[[sendimage: " + WIN_IMG + "]]",
    "[[sendvoice:C:\\b.amr]]",
  ].join("\n");
  assert.deepEqual(extractSendMedia(text), [
    { kind: "file", path: "C:\\a.txt" },
    { kind: "image", path: WIN_IMG },
    { kind: "voice", path: "C:\\b.amr" },
  ]);
});

test("sendimage/sendvoice：各自的便捷提取器互不串味，extractSendFilePaths 不受影响", () => {
  const text = "[[sendimage: C:\\1.png]]\n[[sendvoice: C:\\2.amr]]\n[[sendfile: C:\\3.txt]]";
  assert.deepEqual(extractSendImagePaths(text), ["C:\\1.png"]);
  assert.deepEqual(extractSendVoicePaths(text), ["C:\\2.amr"]);
  assert.deepEqual(extractSendFilePaths(text), ["C:\\3.txt"]);
  assert.deepEqual(extractSendMedia("没有标记"), []);
  assert.deepEqual(extractSendMedia(null), []);
});

test("sendimage/sendvoice：全角冒号、大写标记名、引号包裹都认", () => {
  assert.deepEqual(extractSendMedia("[[sendimage：C:\\图 1.png]]"), [{ kind: "image", path: "C:\\图 1.png" }]);
  assert.deepEqual(extractSendMedia("[[SENDVOICE: C:\\a.amr]]"), [{ kind: "voice", path: "C:\\a.amr" }]);
  assert.deepEqual(extractSendMedia('[[sendimage: "C:\\b.png"]]'), [{ kind: "image", path: "C:\\b.png" }]);
});

test("sendimage/sendvoice：三种标记都能从正文里清干净（整行删、行内只挖标记）", () => {
  const text = "A\n[[sendimage: C:\\1.png]]\n[[sendvoice: C:\\2.amr]]\n\nB [[sendfile: C:\\3.txt]] 请查收";
  const out = stripSendFileMarkers(text);
  assert.equal(out.includes("[[send"), false);
  assert.match(out, /^A\n\nB .*请查收$/);
});

test("sendimage/sendvoice：平台不支持时降级成纯路径，三种都算", () => {
  const out = markersToPaths("图\n[[sendimage: C:\\1.png]]\n[[sendvoice: C:\\2.amr]]");
  assert.equal(out, "图\nC:\\1.png\nC:\\2.amr");
});

// ---- pipeline：三种 kind 走 sendMedia ----

test("pipeline：[[sendimage:]] 交给 sendMedia，kind=image，正文不留标记", async () => {
  const image = await makeTempFile("图.png", "png");
  const h = makeHarness({ replyText: "图来了\n[[sendimage: " + image + "]]", sendMedia: async () => ({ sent: 1, failed: 0 }) });
  await h.pipeline.handleEvent({ message: makeMessage() });

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].kind, "image");
  assert.equal(h.calls[0].path, image);
  assert.equal(h.replies.at(-1), "图来了");
});

test("pipeline：[[sendvoice:]] 交给 sendMedia，kind=voice，正文只剩标记时说明已发送几条", async () => {
  const voice = await makeTempFile("说话.amr", "amr");
  const h = makeHarness({ replyText: "[[sendvoice: " + voice + "]]", sendMedia: async () => ({ sent: 1, failed: 0 }) });
  await h.pipeline.handleEvent({ message: makeMessage() });

  assert.equal(h.calls[0].kind, "voice");
  assert.equal(h.replies.at(-1), "已发送 1 条语音");
});

test("pipeline：三种混发按 file→image→voice 顺序，各自计数", async () => {
  const file = await makeTempFile("报告.txt", "x");
  const image = await makeTempFile("图.png", "x");
  const voice = await makeTempFile("说话.amr", "x");
  const replyText = ["[[sendvoice: " + voice + "]]", "[[sendimage: " + image + "]]", "[[sendfile: " + file + "]]"].join("\n");
  const h = makeHarness({ replyText, sendMedia: async () => ({ sent: 1, failed: 0 }) });
  await h.pipeline.handleEvent({ message: makeMessage() });

  assert.deepEqual(h.calls.map((c) => c.kind), ["file", "image", "voice"]);
  assert.equal(h.replies.at(-1), "已发送 1 个文件\n已发送 1 张图片\n已发送 1 条语音");
});

test("pipeline：平台降级说明（QQ 语音不支持）追加到正文，且计为发送成功", async () => {
  const voice = await makeTempFile("说话.amr", "x");
  const h = makeHarness({
    replyText: "语音在这儿\n[[sendvoice: " + voice + "]]",
    sendMedia: async () => ({ sent: 1, failed: 0, note: "QQ 官方机器人不支持语音消息，这段语音已按文件发送。" }),
  });
  await h.pipeline.handleEvent({ message: makeMessage() });

  const last = h.replies.at(-1);
  assert.match(last, /^语音在这儿/);
  assert.match(last, /⚠️ QQ 官方机器人不支持语音消息/);
  assert.equal(h.pipeline.stats().failed, 0);
});

test("pipeline：只有老式 sendFile 的平台，文件照发、图片降级成路径且不算失败", async () => {
  const file = await makeTempFile("报告.txt", "x");
  const image = await makeTempFile("图.png", "x");
  const replyText = "结果\n[[sendfile: " + file + "]]\n[[sendimage: " + image + "]]";
  const h = makeHarness({ replyText, sendFile: async () => ({ sent: 1, failed: 0 }) });
  await h.pipeline.handleEvent({ message: makeMessage() });

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, file);
  const last = h.replies.at(-1);
  assert.equal(last.includes("[[sendimage"), false);
  assert.ok(last.includes(image));
  assert.equal(h.pipeline.stats().failed, 0);
});

test("pipeline：sendMedia 抛错不冒泡，图片按张补一句发送失败", async () => {
  const image = await makeTempFile("图.png", "x");
  const h = makeHarness({
    replyText: "图\n[[sendimage: " + image + "]]",
    sendMedia: async () => {
      throw new Error("连接断了");
    },
  });
  await h.pipeline.handleEvent({ message: makeMessage() });

  assert.equal(h.replies.at(-1), "图\n⚠️ 1 张图片发送失败");
  assert.ok(h.logger.lines.some((line) => line.level === "warn" && line.msg === "发送图片失败"));
});

test("pipeline：每种最多 3 个，第 4 张图片说明超限", async () => {
  const images = [];
  for (const name of ["1.png", "2.png", "3.png", "4.png"]) images.push(await makeTempFile(name, "x"));
  const replyText = "图\n" + images.map((f) => "[[sendimage: " + f + "]]").join("\n");
  const h = makeHarness({ replyText, sendMedia: async () => ({ sent: 1, failed: 0 }) });
  await h.pipeline.handleEvent({ message: makeMessage() });

  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.map((c) => c.path), images.slice(0, 3));
  assert.equal(h.replies.at(-1), "图\n⚠️ 跳过了 1 张图片：超过每轮上限（最多 3 个）");
});

test("pipeline：图片路径不存在时跳过并说明，语音相对路径同样跳过", async () => {
  const missing = path.join(os.tmpdir(), "dsh-sendmedia-不存在-" + Date.now() + ".png");
  const h = makeHarness({
    replyText: "结果\n[[sendimage: " + missing + "]]\n[[sendvoice: 说话.amr]]",
    sendMedia: async () => ({ sent: 1, failed: 0 }),
  });
  await h.pipeline.handleEvent({ message: makeMessage() });

  assert.equal(h.calls.length, 0);
  assert.equal(h.replies.at(-1), "结果\n⚠️ 跳过了 1 张图片：路径不存在\n⚠️ 跳过了 1 条语音：不是绝对路径");
});

// ---- OneBot 侧 ----

test("onebot sendMedia：image 走 image 段，voice 走 record 段", async () => {
  const image = await makeTempFile("图.png", "x");
  const voice = await makeTempFile("说话.amr", "x");
  const calls = [];
  const client = {
    call: async (action, params) => {
      calls.push({ action, params });
      return { status: "ok", retcode: 0 };
    },
  };
  await oneBotSendMedia({ client, message: makeMessage(), path: image, kind: "image", logger: makeLogger() });
  await oneBotSendMedia({ client, message: makeMessage(), path: voice, kind: "voice", logger: makeLogger() });

  assert.deepEqual(calls[0].params.message, [{ type: "image", data: { file: pathToFileURL(image).href } }]);
  assert.deepEqual(calls[1].params.message, [{ type: "record", data: { file: pathToFileURL(voice).href } }]);
});

test("onebot sendMedia：record 段被拒时降级成 file 段", async () => {
  const voice = await makeTempFile("说话.amr", "x");
  const calls = [];
  const client = {
    call: async (action, params) => {
      calls.push({ action, params });
      if (params.message[0].type === "record") throw new Error("不支持 record 段");
      return { status: "ok", retcode: 0 };
    },
  };
  const logger = makeLogger();
  const res = await oneBotSendMedia({ client, message: makeMessage(), path: voice, kind: "voice", logger });

  assert.deepEqual(res, { sent: 1, failed: 0 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.message[0].type, "record");
  assert.equal(calls[1].params.message[0].type, "file");
  assert.ok(logger.lines.some((line) => line.level === "warn" && line.msg === "语音段发不出去，已改成按文件发送"));
});

test("onebot sendMedia：kind=file 与老接口 sendFile 完全同款", async () => {
  const file = await makeTempFile("报告.pdf", "x");
  const calls = [];
  const client = {
    call: async (action, params) => {
      calls.push({ action, params });
      return { status: "ok", retcode: 0 };
    },
  };
  await oneBotSendMedia({ client, message: makeMessage(), path: file, kind: "file", logger: makeLogger() });
  await oneBotSendFile({ client, message: makeMessage(), path: file, logger: makeLogger() });

  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].params.message[0].type, "file");
});

// ---- QQ 官方侧 ----

test("qqbot sendQqMedia：image 按 file_type=1 上传", async () => {
  const image = await makeTempFile("图.png", "x");
  const uploaded = [];
  const client = {
    uploadFileContent: async (args) => {
      uploaded.push(args);
      return { file_info: "FI-IMG" };
    },
    sendMessage: async () => ({}),
  };
  const res = await sendQqMedia({ client, message: makeMessage(), path: image, kind: "image", logger: makeLogger() });

  assert.deepEqual(res, { sent: 1, failed: 0 });
  assert.equal(uploaded[0].fileType, 1);
});

test("qqbot sendQqMedia：语音平台不支持 → 按文件发 + 一句说明 + warn 日志，不抛", async () => {
  const voice = await makeTempFile("说话.amr", "x");
  const uploaded = [];
  const posted = [];
  const client = {
    uploadFileContent: async (args) => {
      uploaded.push(args);
      return { file_info: "FI-VOICE" };
    },
    sendMessage: async (args) => {
      posted.push(args);
      return {};
    },
  };
  const logger = makeLogger();
  const res = await sendQqMedia({ client, message: makeMessage(), path: voice, kind: "voice", logger });

  assert.equal(res.sent, 1);
  assert.equal(res.failed, 0);
  assert.match(res.note, /不支持语音消息/);
  assert.equal(uploaded[0].fileType, 4);
  assert.equal(posted[0].body.msg_type, 7);
  assert.ok(logger.lines.some((line) => line.level === "warn" && line.msg.includes("不支持语音消息")));
});

test("qqbot sendQqMedia：语音上传失败也只计失败，不抛", async () => {
  const voice = await makeTempFile("说话.amr", "x");
  const client = {
    uploadFileContent: async () => {
      throw new Error("400");
    },
    sendMessage: async () => ({}),
  };
  const res = await sendQqMedia({ client, message: makeMessage(), path: voice, kind: "voice", logger: makeLogger() });
  assert.deepEqual(res, { sent: 0, failed: 1 });
});

test("qqbot sendQqFile 仍然等价于 kind=file（返回值不多字段）", async () => {
  const file = await makeTempFile("报告.pdf", "x");
  const client = { uploadFileContent: async () => ({ file_info: "FI" }), sendMessage: async () => ({}) };
  const res = await sendQqFile({ client, message: makeMessage(), path: file, logger: makeLogger() });
  assert.deepEqual(res, { sent: 1, failed: 0 });
});

test("qqbot adapter：deps 同时挂 sendMedia 与兼容用的 sendFile", () => {
  const adapter = createQqBotAdapter({ config: { qqbot: { appId: "1", clientSecret: "s" } }, logger: makeLogger() });
  assert.equal(typeof adapter.deps.sendMedia, "function");
  assert.equal(typeof adapter.deps.sendFile, "function");
});

// ---- prompt 约定 ----

test("prompt：写明 sendimage/sendvoice 与「没被 @ 也能接话」", () => {
  const prompt = buildPrompt({ config: makeConfig(), message: makeMessage() });
  assert.match(prompt, /\[\[sendimage: 图片的绝对路径\]\]/);
  assert.match(prompt, /\[\[sendvoice: 语音的绝对路径\]\]/);
  assert.match(prompt, /别刷屏/);
});
