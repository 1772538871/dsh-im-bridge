import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JOURNAL_TAIL_CHARS, JOURNAL_TAIL_COUNT, readJournalTail } from './journal.mjs';

const KIND_LABEL = { image: "图片", file: "文件", record: "语音", text: "文本", other: "其他" };

// 数据目录下的两份模板（由 data-layout.mjs 建好）：有内容就按固定顺序插在用户消息前面。
const PROMPT_SECTIONS = [
  { key: "system", file: "system.md", title: "[系统要求]" },
  { key: "persona", file: "persona.md", title: "[角色设定]" },
];
const USER_SECTION_TITLE = "[用户消息]";
// 日记单独成段：它跟着角色卡走，但内容会自己长，所以标题和角色卡分开
export const JOURNAL_SECTION_TITLE = "[最近日记]";
// 模板骨架里的空占位：标题「# 角色名」和只有冒号没有内容的条目「- 性格：」。
// 刚建出来的角色卡因此等于"没写"，不会把一张空白卡塞进每轮对话。
const PLACEHOLDER_LINE = [/^#\s*角色名$/u, /^[-*·]\s*[^：:]{1,20}[：:]\s*$/u];

function normalizeAttachment(item) {
  if (typeof item === "string") return { kind: "file", path: item, filename: null, note: null };
  if (!item || typeof item !== "object") return null;
  return {
    kind: item.kind ?? "other",
    path: typeof item.path === "string" && item.path !== "" ? item.path : null,
    filename: item.filename ?? null,
    note: item.note ?? null,
  };
}

// 注释是写给编辑模板的人看的，绝不进提示词；没写结尾的注释也要吃掉，不能被当成正文。
function stripTemplateComments(text) {
  return String(text).replace(/<!--[\s\S]*?(?:-->|$)/gu, "");
}

/** 模板正文：去掉注释、空行和没填的空占位，剩下的行才算"用户真的写了内容"。 */
export function templateBody(text) {
  if (typeof text !== "string" || text === "") return [];
  const kept = [];
  for (const raw of stripTemplateComments(text).split(/\r?\n/u)) {
    const line = raw.replace(/\s+$/u, "");
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (PLACEHOLDER_LINE.some((pattern) => pattern.test(trimmed))) continue;
    kept.push(line);
  }
  return kept;
}

function dataDirOf(config) {
  const root = config?.storage?.rootDir;
  return typeof root === "string" ? root : "";
}

/**
 * 读 <dataDir>/prompts/{system,persona}.md，只返回"有内容"的段（顺序固定）。
 * 读不到（没建模板 / 没权限）就当没有这一节：提示词拼装绝不能因为读文件失败而中断。
 */
export function readPromptSections({ dataDir = "", fsImpl = null } = {}) {
  const dir = typeof dataDir === "string" ? dataDir.trim() : "";
  if (dir === "") return [];
  const read = fsImpl && typeof fsImpl.readFileSync === "function" ? fsImpl.readFileSync : readFileSync;
  const sections = [];
  for (const section of PROMPT_SECTIONS) {
    let text = "";
    try {
      text = read(join(dir, "prompts", section.file), "utf8");
    } catch {
      continue;
    }
    const body = templateBody(text);
    if (body.length > 0) sections.push({ key: section.key, title: section.title, body });
  }
  return sections;
}

/** 把一条 QQ 消息 + 落地好的附件 + 语音转写拼成给 DSH 的单一任务文本。 */
export function buildPrompt({ config, message, savedAttachments = [], voiceTranscript = null, dataDir = "", fsImpl = null } = {}) {
  const maxOriginal =
    Number.isFinite(config?.security?.maxPromptChars) && config.security.maxPromptChars > 0
      ? config.security.maxPromptChars
      : 8000;
  const chunkLimit =
    Number.isFinite(config?.reply?.maxChunkChars) && config.reply.maxChunkChars > 0
      ? config.reply.maxChunkChars
      : 1500;

  const rawText = typeof message?.text === "string" ? message.text : "";
  const original =
    rawText.length > maxOriginal
      ? `${rawText.slice(0, maxOriginal)}\n…（原文过长已截断，共 ${rawText.length} 字符，此处只保留前 ${maxOriginal} 字符）`
      : rawText;
  const attachments = (Array.isArray(savedAttachments) ? savedAttachments : [])
    .map(normalizeAttachment)
    .filter(Boolean);

  const lines = [
    "你正在通过 QQ 与用户对话，你的回复会被原样发送到对方的 QQ。不要自称是某个客户端或转发程序（例如 NapCat），你并不知道链路细节。",
    "回复要求：",
    "- 只输出纯文本，不要使用 Markdown 表格、代码围栏或加粗标记，QQ 不渲染它们。",
    "- 像群友聊天，不像客服：一句话能说清就别列点；不要「首先/其次/最后/综上」这种结构词。",
    "- 不要复述对方的话，不要结尾总结陈词，不要问「还需要我做什么吗」。",
    "- 语气跟着对方走：对方随口问就随口答，对方认真再展开；可以用「嗯 / 啊 / 哎」这类语气词，但一条回复最多一处。",
    "- 除对方主动用表情，不要堆 emoji。",
    "- 排版用短行，**不要留空行**（聊天窗口里空行很像机器人排版）；列举用「· 」开头，不要用 - 或 ###；一条回复别超过 15 行。",
    `- 尽量简短，控制在 ${chunkLimit} 字以内；超出会被自动分段发送。`,
    "- 需要把本机文件发给用户时（例如对方说「把结果发我」），在正文里单独一行写 [[sendfile: 文件的绝对路径]]。",
    "- 需要发图片写 [[sendimage: 图片的绝对路径]]，发语音写 [[sendvoice: 语音的绝对路径]]，写法与 sendfile 完全一样。",
    "- 这种标记最多 3 行（每种最多 3 个）；路径必须是真实存在的绝对路径，写错或超限的会被跳过，正文照常发送。",
    "- 群聊里没被 @ 时你也可能被问到：可以顺着当前话题接一句，但别刷屏，也别自说自话连发好几条。",
  ];

  if (attachments.length > 0) {
    lines.push("", "用户随消息发来的附件已保存到本机，路径可直接读取：");
    for (const item of attachments) {
      const label = KIND_LABEL[item.kind] ?? KIND_LABEL.other;
      const name = item.filename ? `（${item.filename}）` : "";
      if (item.path) lines.push(`- ${label}${name}：${item.path}`);
      else lines.push(`- ${label}${name}：未能保存${item.note ? `（${item.note}）` : ""}`);
    }
  }

  const transcript = typeof voiceTranscript === "string" ? voiceTranscript.trim() : "";
  if (transcript !== "") {
    lines.push("", "用户还发来一段语音，以下是自动转写出的文本（可能与原话有出入）：", transcript);
  }

  lines.push("", "用户原文：");
  if (original.trim() === "") {
    lines.push(attachments.length > 0 ? "（用户只发了附件，没有附文字说明）" : "（用户没有发送文字内容）");
  } else {
    lines.push(original);
  }

  const body = lines.join("\n");
  // 两份模板都没有内容、日记也还没开始写时，提示词与之前逐字一致（老用户的对话习惯不变）
  const dir = dataDir || dataDirOf(config);
  const sections = readPromptSections({ dataDir: dir, fsImpl });
  const read = fsImpl && typeof fsImpl.readFileSync === "function" ? fsImpl.readFileSync : readFileSync;
  const journal = readJournalTail({
    promptsDir: dir === "" ? "" : join(dir, "prompts"),
    readText: (file) => read(file, "utf8"),
    count: JOURNAL_TAIL_COUNT,
    maxChars: JOURNAL_TAIL_CHARS,
  });
  if (sections.length === 0 && journal.length === 0) return body;

  const blocks = sections.map((section) => section.title + "\n" + section.body.join("\n"));
  // 日记排在角色卡之后、"用户消息"之前：先说我是谁，再说我最近在想什么
  if (journal.length > 0) blocks.push(JOURNAL_SECTION_TITLE + "\n" + journal.join("\n\n"));
  blocks.push(USER_SECTION_TITLE + "\n" + body);
  return blocks.join("\n\n");
}
