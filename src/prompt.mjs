const KIND_LABEL = { image: "图片", file: "文件", record: "语音", text: "文本", other: "其他" };

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

/** 把一条 QQ 消息 + 落地好的附件 + 语音转写拼成给 DSH 的单一任务文本。 */
export function buildPrompt({ config, message, savedAttachments = [], voiceTranscript = null } = {}) {
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
    "- 排版用短行 + 空行分段；列举用「· 」开头，不要用 - 或 ###；一条回复别超过 15 行。",
    `- 尽量简短，控制在 ${chunkLimit} 字以内；超出会被自动分段发送。`,
    "- 需要把本机文件发给用户时（例如对方说「把结果发我」），在正文里单独一行写 [[sendfile: 文件的绝对路径]]。",
    "- 这种标记最多 3 行；路径必须是真实存在的绝对路径，写错或超限的文件会被跳过，正文照常发送。",
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

  return lines.join("\n");
}
