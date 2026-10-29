import { stat } from 'node:fs/promises';
import { isAbsolute, join, posix, win32 } from 'node:path';
import { transcribe as defaultTranscribe } from "./asr.mjs";
import {
  commandAdoptDoneText,
  commandAdoptMissingText,
  commandExportDoneText,
  commandExportFailedText,
  commandHelpText,
  commandJournalDoneText,
  commandJournalFailedText,
  commandNewSessionText,
  commandStatusText,
  defaultDshHome,
  exportSessionMarkdown,
  parseCommand,
} from './commands.mjs';
import { formatForQq } from './format.mjs';
import { appendLesson, isTeaching } from './lessons.mjs';
import {
  adoptSuggestedPersona,
  appendJournalEntry,
  buildIntrospectionPrompt,
  parseIntrospection,
  promptsDirOf,
  readJournalTail,
  readPersona,
  writeSuggestedPersona,
} from './journal.mjs';
import { buildPrompt } from "./prompt.mjs";
import { createSessionBinding } from './session-binding.mjs';

const DEFAULT_ERROR_PREFIX = "[bridge] ";
const NO_TEXT_PLACEHOLDER = "（DSH 这次没有返回文字内容）";

// 出站媒体：一条回复最多带 3 个同类（再多平台会拒，用户一次也看不过来）
const SENDFILE_LIMIT = 3;
const DEFAULT_MAX_FILE_BYTES = 104857600;
// 模拟打字的停顿上限：真人不会因为一段长文就让你等半分钟
const DEFAULT_SEND_DELAY_MAX_MS = 3000;
const SEND_DELAY_JITTER = 0.2;

// 回执与进度的口语池。写死一句"收到，开始处理了（预计半分钟左右）"再拼上项目符号，
// 是"一眼就是 AI"的根因：真人每次说法都不一样，也不会先报一个预计时间。
// 三组句子因此都按"一口气能说完"来写：一处 ≤ 12 字、不带符号、不带任何数字或时间词。
export const PHRASE_MAX_CHARS = 12;
// 估时超过这个秒数才算"要等一会儿"，短活儿说长话反而更假
export const LONG_TASK_SECONDS = 12;

// 两套口吻，一套一套地读：casual 是会跟你在同一个群里混的那种口气（小傲娇、带点嘴臭，
// 但不脏、不攻击人），plain 是纯中性。作者自己都不知道你喜欢哪种，所以由配置选。
export const DEFAULT_ACK_TONE = 'casual';
export const ACK_TONES = {
  casual: {
    short: [
      '行吧，我看看',
      '急啥，瞅一眼',
      '好好好，我看',
      '来了来了',
      '等着，看一眼',
      '嗯？我看看',
      '看呢看呢',
      '别催，这不看了',
      '瞅一眼的事',
      '行行行，我来',
    ],
    long: [
      '这活儿有点麻烦',
      '别催，正弄着呢',
      '慢慢等吧你',
      '我先折腾会儿',
      '这得磨叽一下',
      '弄完喊你',
      '急不来，得弄会儿',
      '有点费劲，等着',
      '忙上了，别敲门',
      '这个真得花点时间',
      '我啃一下这活儿',
    ],
    progress: ['还没好，急啥', '手还占着呢', '快了快了', '别盯了', '马上完事', '就快了就快了', '耐心点，快了', '我这不忙着呢'],
  },
  plain: {
    short: ['马上看', '这就看', '我看看', '等我一下', '好，我看看', '收到，马上看', '稍等，我看下', '这就开始', '行，我看下', '我这就弄'],
    long: [
      '这个要一会儿',
      '得弄一会儿',
      '这个稍微久点',
      '我先弄着',
      '等我一下，稍久',
      '活儿不小，等我',
      '这个得慢慢来',
      '弄好了叫你',
      '好了我跟你说',
      '先弄着，别急',
      '这个要花点时间',
    ],
    progress: ['还在弄', '快了快了', '马上就好', '快了，稍等', '还在弄，别急', '快弄完了', '就快好了'],
  },
};

/** 认不出来的口吻一律退回默认：配置里写错一个词不该让回执哑掉。 */
export function toneOf(raw) {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(ACK_TONES, key) ? key : DEFAULT_ACK_TONE;
}

export function toneLines(raw, kind) {
  return ACK_TONES[toneOf(raw)][kind];
}

/**
 * 从池子里抽一句，但绝不让同一句连着出现两次。
 * 抽到上一句就重抽（最多 maxTries 次）；随机源被卡死（测试里就这么造）时退一句，
 * 因为"连着两条一模一样的回执"比随机得不均匀难看得多。
 */
export function pickLine(list, { random = Math.random, previous = null, maxTries = 3 } = {}) {
  if (!Array.isArray(list) || list.length === 0) return typeof previous === "string" ? previous : "";
  const length = list.length;
  const drawAt = () => {
    const value = typeof random === "function" ? Number(random()) : NaN;
    if (!Number.isFinite(value)) return list[(Math.max(0, list.indexOf(previous)) + 1) % length];
    const index = Math.floor(value * length);
    return list[((index % length) + length) % length];
  };
  const tries = Number.isFinite(maxTries) && maxTries >= 1 ? Math.floor(maxTries) : 1;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const line = drawAt();
    if (line !== previous) return line;
  }
  return list[(list.indexOf(previous) + 1) % length];
}

// 三种媒体标记语义完全一致（单独一行、绝对路径、最多 3 个），只有平台侧的段类型不同。
// 顺序即发送顺序，也即说明文字的先后顺序。
const MEDIA_KINDS = [
  { kind: "file", marker: "sendfile", label: "文件", unit: "个文件" },
  { kind: "image", marker: "sendimage", label: "图片", unit: "张图片" },
  { kind: "voice", marker: "sendvoice", label: "语音", unit: "条语音" },
];
const MEDIA_KIND_BY_MARKER = new Map(MEDIA_KINDS.map((item) => [item.marker, item]));
const ALL_MEDIA_KINDS = new Set(MEDIA_KINDS.map((item) => item.kind));
const NO_MEDIA_KINDS = new Set();
// 全角冒号也认：模型偶尔会把 : 写成 ：
const MEDIA_MARKER_SOURCE = "\\[\\[\\s*(sendfile|sendimage|sendvoice)\\s*[:：]\\s*([^\\]\\n]+?)\\s*\\]\\]";
const mediaMarkerRe = () => new RegExp(MEDIA_MARKER_SOURCE, "gi");
// 跳过原因的顺序固定（测试与文案都依赖这个顺序），一次合并成一行人话
const SENDFILE_SKIP = [
  ["relative", "不是绝对路径"],
  ["missing", "路径不存在"],
  ["too_large", "超过大小上限"],
  ["over_limit", "超过每轮上限（最多 3 个）"],
];

function normalizeNewlines(text) {
  const source = typeof text === "string" ? text : text === null || text === undefined ? "" : String(text);
  return source.replace(/\r\n?/g, "\n");
}

// 模型经常把路径裹在引号或反引号里；两侧空白也要吃掉，否则绝对路径判断会挂
function cleanMarkerPath(raw) {
  return String(raw ?? "").trim().replace(/^[`'"]+|[`'"]+$/g, "").trim();
}

function isAbsolutePath(path) {
  // 宿主可能是 Windows 也可能是 Linux：两边都认，别让路径形态决定功能是否可用
  return isAbsolute(path) || win32.isAbsolute(path) || posix.isAbsolute(path);
}

/** 按行套用标记替换：整行只剩标记的行直接丢掉，其余的只挖掉标记本身。 */
function mapMarkerLines(text, replacer) {
  const kept = [];
  for (const line of normalizeNewlines(text).split("\n")) {
    let touched = false;
    const replaced = line.replace(mediaMarkerRe(), (match, name, raw) => {
      touched = true;
      const item = MEDIA_KIND_BY_MARKER.get(String(name).toLowerCase());
      return replacer(item, cleanMarkerPath(raw), match);
    });
    if (!touched) {
      kept.push(line);
      continue;
    }
    const cleaned = replaced.replace(/^[`'"\s]+|[`'"\s]+$/g, "");
    if (cleaned !== "") kept.push(cleaned);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 按出现顺序取出所有出站媒体标记；重复项留给调用方去重。 */
export function extractSendMedia(text) {
  const source = normalizeNewlines(text);
  const items = [];
  for (const match of source.matchAll(mediaMarkerRe())) {
    const item = MEDIA_KIND_BY_MARKER.get(String(match[1]).toLowerCase());
    const path = cleanMarkerPath(match[2]);
    if (item && path !== "") items.push({ kind: item.kind, path });
  }
  return items;
}

function pathsOfKind(text, kind) {
  return extractSendMedia(text)
    .filter((item) => item.kind === kind)
    .map((item) => item.path);
}

/** 只想要文件路径的老调用方：行为与三合一之前完全一致。 */
export function extractSendFilePaths(text) {
  return pathsOfKind(text, "file");
}

export function extractSendImagePaths(text) {
  return pathsOfKind(text, "image");
}

export function extractSendVoicePaths(text) {
  return pathsOfKind(text, "voice");
}

function renderMarkers(text, keptKinds) {
  return mapMarkerLines(text, (item, path) => (keptKinds.has(item.kind) ? path : ""));
}

/** 把标记从正文里拿掉：只含标记的行整行消失，标记夹在句子里就只删标记。 */
export function stripSendFileMarkers(text) {
  return renderMarkers(text, NO_MEDIA_KINDS);
}

/** 平台没有发媒体能力时的降级形态：标记换成纯路径，用户至少知道文件在哪。 */
export function markersToPaths(text) {
  return renderMarkers(text, ALL_MEDIA_KINDS);
}

/** 发送一个文件算不算失败：抛错由调用方接，这里只读返回值。 */
function fileSendFailed(outcome) {
  if (!outcome || typeof outcome !== "object") return false;
  if (outcome.ok === false) return true;
  const sent = Number(outcome.sent);
  const failed = Number(outcome.failed);
  if (Number.isFinite(sent) && sent > 0) return false;
  return Number.isFinite(failed) && failed > 0;
}

// 只写人话、不带任何堆栈：这些字符串会被直接发到 QQ
const REASON_TEXT = {
  timeout: "处理超时了，请稍后再发一次。",
  runner_error: "DSH 返回了错误，这次没有结果。",
  model_error: "DSH 这次没有正常完成。",
  blocked: "这一步需要你先确认（审批或提问）。我发过确认请求；没收到回复时我会在超时后放弃。",
  no_final: "DSH 没有返回结果。",
  no_turn_end: "DSH 的返回不完整。",
  exit_nonzero: "DSH 异常退出了。",
  spawn_error: "启动 DSH 失败，请检查 bridge 配置。",
  not_configured: "DSH 路径没配置好，请先用 --check 检查配置。",
  cancelled: "本次调用已被取消。",
};

const CORE_DEPS = ["parseEvent", "planMedia", "sendReply"];

async function loadDefaultDeps(names) {
  const loads = {
    parseEvent: () => import("./onebot/parse.mjs").then((mod) => mod.parseEvent),
    planMedia: () => import("./onebot/media.mjs").then((mod) => mod.planMedia),
    sendReply: () => import("./onebot/send.mjs").then((mod) => mod.sendReply),
    sendFile: () => import("./onebot/send.mjs").then((mod) => mod.sendFile),
    sendMedia: () => import("./onebot/send.mjs").then((mod) => mod.sendMedia),
  };
  const resolved = {};
  await Promise.all(
    names.map(async (name) => {
      resolved[name] = await loads[name]();
    }),
  );
  return resolved;
}

function pickUrl(response) {
  if (!response) return null;
  const candidates = [
    response.data?.url,
    response.url,
    response.data?.file,
    typeof response.data === "string" ? response.data : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return null;
}

function chatKeyOf(message, deps) {
  try {
    if (typeof deps.chatKeyOf === "function") {
      const key = deps.chatKeyOf(message);
      if (typeof key === "string" && key !== "") return key;
    }
  } catch {
    /* paths.mjs 不可用时退回本地规则，不能让整个 pipeline 崩 */
  }
  return message?.chatType === "group" ? `group_${message.groupId ?? ""}` : `private_${message.userId ?? ""}`;
}

/**
 * 群文件接口（get_group_file_url）要 group_id/busid，但 OneBot 的文件段里通常只有 file/file_id，
 * 这两个值在事件层；media.mjs 是纯函数拿不到，所以由这里补齐。
 */
export function enrichFileCallSpec({ plan, message = null, raw = null, segment = null } = {}) {
  const action = plan?.callSpec?.action;
  if (action !== "get_group_file_url") return plan;

  const params = { ...(plan.callSpec.params ?? {}) };
  if (params.group_id === undefined || params.group_id === null || params.group_id === "") {
    const groupId = message?.groupId ?? raw?.group_id;
    if (groupId !== undefined && groupId !== null && groupId !== "") params.group_id = String(groupId);
  }
  if (params.busid === undefined || params.busid === null || params.busid === "") {
    const busid = message?.busid ?? message?.raw?.busid ?? raw?.busid ?? segment?.data?.busid;
    if (busid !== undefined && busid !== null && busid !== "") params.busid = busid;
  }
  return { ...plan, callSpec: { ...plan.callSpec, params } };
}

/**
 * 消息处理管线。deps 只用于注入/替换 onebot 侧的纯函数（生产上用默认动态 import），
 * 这样单测不必依赖还没写完的相邻模块。
 */
export function createPipeline({
  config,
  logger,
  client,
  storage,
  guard,
  serial,
  semaphore,
  sessions,
  runDsh,
  binding = null,
  approvalBridge = null,
  questionBridge = null,
  deps = null,
} = {}) {
  if (typeof runDsh !== "function") throw new Error("createPipeline: runDsh 必填");
  if (typeof serial?.run !== "function") throw new Error("createPipeline: serial 必填");
  if (typeof semaphore?.withPermit !== "function") throw new Error("createPipeline: semaphore 必填");

  const counters = { received: 0, handled: 0, failed: 0, denied: 0, ignored: 0, parseErrors: 0 };
  let depsPromise = null;
  // 会话绑定事务的锁：并发消息不能同时读到同一个空绑定
  const sessionBinding = binding ?? createSessionBinding({ sessions, logger });

  const resolveDeps = () => {
    const injected = deps ?? {};
    const missing = CORE_DEPS.filter((name) => typeof injected[name] !== "function");
    // sendFile/sendMedia 只在调用方完全没注入 deps 时补 OneBot 默认实现（命令行那条路）。
    // 注入了 deps 的一方自己负责这张能力表：缺 sendMedia = 这个平台不发媒体，
    // 由 sendMarkedMedia 降级成文字路径，而不是报错。
    if (deps == null) missing.push("sendFile", "sendMedia");
    depsPromise ??= (missing.length === 0 ? Promise.resolve({}) : loadDefaultDeps(missing)).then((base) => ({
      transcribe: defaultTranscribe,
      // 打字的停顿与抖动都走注入点：测试不许真等 3 秒，也不许依赖真随机
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
      ...base,
      ...injected,
    }));
    return depsPromise;
  };

  const errorPrefix = config?.reply?.errorPrefix ?? DEFAULT_ERROR_PREFIX;

  // 上一次说过的那句话：回执与进度各记一份，连发两条一样的话最像机器
  const lastLine = { ack: null, progress: null };
  const ackTone = toneOf(config?.reply?.ackTone);
  // 内省要回顾"刚才聊了什么"，只留最近 20 轮；它不进提示词，也不落盘
  const RECENT_TURNS_MAX = 20;
  const recentTurns = [];
  // 后台内省挂在这里，测试用 settle() 等它落盘；生产上没人等它
  const background = new Set();
  let turnsSinceJournal = 0;

  // cwd_missing 的文案要带具体路径，静态表办不到，单独处理
  const failureText = (reason, result) => {
    if (reason === "cwd_missing") {
      return `DSH 工作目录不存在或无法进入：${result?.cwd ?? config?.dsh?.cwd ?? "(未配置)"}`;
    }
    const base = REASON_TEXT[reason] ?? "处理失败。";
    // runner 若给出具体原因（turn/end 的 error），附一句短的：否则用户只看到"没有正常完成"，没法排查
    const detail = typeof result?.turnError === "string" ? result.turnError : typeof result?.detail === "string" ? result.detail : typeof result?.error === "string" ? result.error : "";
    return detail === "" ? base : base + "（" + String(detail).replace(/\s+/g, " ").slice(0, 160) + "）";
  };

  function maxReplyChars() {
    const raw = Number(config?.reply?.maxReplyChars);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }

  /** 单条回复超长就截断。截断排在分段之前：分得太碎会先把被动回复次数用光。 */
  function truncateReply(text) {
    const cap = maxReplyChars();
    if (cap <= 0 || text.length <= cap) return text;
    const total = text.length;
    let end = cap;
    const code = text.charCodeAt(end - 1);
    // 硬切不能把 emoji 的代理对劈成两半
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return text.slice(0, Math.max(0, end)) + "……（太长截断了，总共 " + total + " 字）";
  }

  /**
   * 模拟打字的停顿：字数 × 每字毫秒，封顶后再叠 ±20% 抖动（真人不会每次一样快）。
   * 只用在最终回复上；回执和进度都是"让人安心"的消息，等它们只会更慌。
   */
  function typingPauseMs(charCount, resolved) {
    const perChar = Number(config?.reply?.sendDelayMs);
    if (!Number.isFinite(perChar) || perChar <= 0) return 0;
    const capRaw = Number(config?.reply?.sendDelayMaxMs);
    const cap = Number.isFinite(capRaw) && capRaw >= 0 ? Math.floor(capRaw) : DEFAULT_SEND_DELAY_MAX_MS;
    const base = Math.min(Math.max(0, charCount) * perChar, cap);
    if (base <= 0) return 0;
    const draw = typeof resolved?.random === "function" ? Number(resolved.random()) : NaN;
    // 随机源坏了也必须能发出去：拿不到合法值时按中位抖动
    const unit = Number.isFinite(draw) && draw >= 0 && draw <= 1 ? draw : 0.5;
    return Math.max(0, Math.round(base * (1 - SEND_DELAY_JITTER + 2 * SEND_DELAY_JITTER * unit)));
  }

  async function deliver(message, text, { humanDelay = false } = {}) {
    // 交给 QQ 之前统一压成纯文本版式（模型经常输出 markdown，QQ 不渲染）
    text = truncateReply(formatForQq(text));
    try {
      const resolved = await resolveDeps();
      if (humanDelay) {
        const pause = typingPauseMs(text.length, resolved);
        if (pause > 0) {
          const sleep = typeof resolved.sleep === "function" ? resolved.sleep : null;
          try {
            if (sleep) await sleep(pause);
            else await new Promise((resolve) => setTimeout(resolve, pause));
          } catch {
            // 等待失败也要把回复发出去：停顿只是拟人，不是前置条件
          }
        }
      }
      return await resolved.sendReply({ client, message, text, config, logger });
    } catch (error) {
      logger?.error?.("发送回复失败", { error: String(error?.message ?? error) });
      return { sent: 0, failed: 1 };
    }
  }

  function maxFileBytes() {
    const fromStorage = Number(storage?.maxFileBytes);
    if (Number.isFinite(fromStorage) && fromStorage > 0) return fromStorage;
    const fromConfig = Number(config?.storage?.maxFileBytes);
    return Number.isFinite(fromConfig) && fromConfig > 0 ? Math.floor(fromConfig) : DEFAULT_MAX_FILE_BYTES;
  }

  /**
   * 出站媒体：把正文里的 [[sendfile:]] / [[sendimage:]] / [[sendvoice:]] 变成真正发出去的媒体。
   * 校验不过的、超上限的、发失败的都不抛，只在正文末尾补一行人话。
   */
  async function sendMarkedMedia({ message, text, resolved }) {
    const items = extractSendMedia(text);
    if (items.length === 0) return { text: stripSendFileMarkers(text), sent: 0, failed: 0, skipped: 0 };

    // 能力表：sendMedia(kind) 优先；只注入了老式 sendFile 的平台仍能发普通文件
    const shared = resolved?.sendMedia;
    const legacyFile = resolved?.sendFile;
    const senderOf = (kind) => {
      if (typeof shared === "function") return (args) => shared({ ...args, kind });
      if (kind === "file" && typeof legacyFile === "function") return (args) => legacyFile(args);
      return null;
    };

    const limit = maxFileBytes();
    const keptKinds = new Set();
    const notes = [];
    const headLines = [];
    const degraded = [];
    let sent = 0;
    let failed = 0;
    let skippedCount = 0;

    for (const meta of MEDIA_KINDS) {
      const paths = items.filter((item) => item.kind === meta.kind).map((item) => item.path);
      if (paths.length === 0) continue;

      const send = senderOf(meta.kind);
      if (send === null) {
        // 这个平台没有发这类媒体的能力：降级成"只回文字路径"，不失败
        logger?.debug?.("当前平台没有发送能力，标记降级为文字路径", { kind: meta.kind, count: paths.length });
        keptKinds.add(meta.kind);
        continue;
      }

      const skipped = new Map();
      const accepted = [];
      const seen = new Set();
      const bump = (key) => skipped.set(key, (skipped.get(key) ?? 0) + 1);
      for (const path of paths) {
        // 同一路径写两遍只发一次：模型常在结尾把同一个资源再列一遍
        if (seen.has(path)) continue;
        seen.add(path);
        if (!isAbsolutePath(path)) {
          bump("relative");
          continue;
        }
        let info = null;
        try {
          info = await stat(path);
        } catch {
          info = null; // 不存在或没权限都算"拿不到"，细因只在日志里
        }
        if (!info?.isFile()) {
          bump("missing");
          continue;
        }
        if (info.size > limit) {
          bump("too_large");
          continue;
        }
        if (accepted.length >= SENDFILE_LIMIT) {
          bump("over_limit");
          continue;
        }
        accepted.push(path);
      }

      let sentOfKind = 0;
      let failedOfKind = 0;
      for (const path of accepted) {
        try {
          const outcome = await send({ client, message, path, config, logger });
          if (fileSendFailed(outcome)) {
            failedOfKind += 1;
            logger?.warn?.("发送" + meta.label + "失败", { kind: meta.kind, path, sent: outcome?.sent, failed: outcome?.failed });
          } else {
            sentOfKind += 1;
            // 平台主动降级时的说明（例如 QQ 官方没有语音消息，只能当文件发）
            if (typeof outcome?.note === "string" && outcome.note !== "") degraded.push("⚠️ " + outcome.note);
          }
        } catch (error) {
          failedOfKind += 1;
          logger?.warn?.("发送" + meta.label + "失败", { kind: meta.kind, path, error: String(error?.message ?? error) });
        }
      }

      sent += sentOfKind;
      failed += failedOfKind;
      if (sentOfKind > 0) headLines.push(`已发送 ${sentOfKind} ${meta.unit}`);
      for (const [key, label] of SENDFILE_SKIP) {
        const count = skipped.get(key) ?? 0;
        if (count > 0) notes.push(`⚠️ 跳过了 ${count} ${meta.unit}：${label}`);
      }
      const skippedOfKind = [...skipped.values()].reduce((sum, n) => sum + n, 0);
      skippedCount += skippedOfKind;
      if (failedOfKind > 0) notes.push(`⚠️ ${failedOfKind} ${meta.unit}发送失败`);
    }

    const body = renderMarkers(text, keptKinds);
    const head = body !== "" ? body : headLines.join("\n");
    const lines = [head, ...notes, ...degraded].filter((line) => line !== "");
    return { text: lines.join("\n"), sent, failed, skipped: skippedCount };
  }

  async function resolveUrl({ plan }) {
    if (plan.url) return plan.url;
    if (plan.callSpec?.action) {
      const response = await client.call(plan.callSpec.action, plan.callSpec.params ?? {});
      return pickUrl(response);
    }
    return null;
  }

  async function landAttachments({ message, raw, resolved }) {
    const saved = [];
    let voiceTranscript = null;
    const segments = Array.isArray(message?.segments) ? message.segments : [];

    for (const segment of segments) {
      if (!segment || !["image", "file", "record"].includes(segment.type)) continue;
      const kind = segment.type;

      let plan = null;
      try {
        plan = resolved.planMedia?.(segment, { chatType: message.chatType }) ?? null;
      } catch (error) {
        logger?.warn?.("附件规划失败", { kind, error: String(error?.message ?? error) });
      }
      if (!plan) {
        saved.push({ kind, filename: null, path: null, note: "无法识别附件" });
        continue;
      }
      plan = enrichFileCallSpec({ plan, message, raw, segment });

      try {
        const url = await resolveUrl({ plan });
        if (!url) throw new Error("拿不到可下载地址");
        const record = await storage.saveFromUrl(url, {
          chat: message,
          kind,
          filename: plan.filename,
          ext: plan.ext,
        });
        saved.push({
          kind,
          filename: plan.filename ?? null,
          path: record.path,
          bytes: record.bytes,
        });

        if (kind === "record" && voiceTranscript === null) {
          const spoken = await resolved.transcribe({ config, filePath: record.path, logger });
          if (spoken?.ok) voiceTranscript = spoken.text;
          else logger?.debug?.("语音转写不可用", { reason: spoken?.reason });
        }
      } catch (error) {
        // 单个附件失败只降级成文字说明，不能让整条消息失败
        const reason = error?.message ? String(error.message) : "下载失败";
        logger?.warn?.("附件落地失败", { kind, error: reason });
        saved.push({ kind, filename: plan.filename ?? null, path: null, note: reason });
      }
    }

    return { saved, voiceTranscript };
  }

  // 最近几轮的真实耗时：估时用上一次的实际值压着，避免永远报同一个数
  const recentDurations = [];

  /**
   * 估个时长。字数/附件反映的是要读多少，真跑多久取决于模型和工具，
   * 所以这里只用来定量级，再被上一次真实耗时兜底。
   */
  const TEACH_REPLIES = ["记下了", "行，记着了", "记住了，下次就这么说"];

  function pickTeachReply() {
    return TEACH_REPLIES[Math.floor(Math.random() * TEACH_REPLIES.length)];
  }

  const UNCLEAR_REPLIES = ["？", "啥？", "嗯？你说哪件事", "在，说"];

  /** 模糊回复就回一句短的问回去：比猜一件事去做更像人 */
  function pickUnclearReply() {
    return UNCLEAR_REPLIES[Math.floor(Math.random() * UNCLEAR_REPLIES.length)];
  }

  function estimateSecondsOf(message, saved) {
    const text = typeof message?.text === "string" ? message.text : "";
    const chars = text.length;
    const attachments = Array.isArray(saved) ? saved.length : 0;
    // 需要动手干的活（读文件/整理/分析）比纯问答慢一个量级
    const heavy = /(整理|分析|总结|归纳|阅读|读一下|读完|遍历|批量|全部|每个|扫描|重构|改代码|修\s*bug|写成|生成|导出|翻译|对比)/.test(text);
    let raw = 5 + Math.ceil(chars / 120) + attachments * 20 + (heavy ? 60 : 0);
    // 只用"同类任务"的历史耗时校准：长任务之后紧接着问一句短问题，
    // 不该也跟着报"几分钟"
    const sameKind = recentDurations.filter((item) => item.heavy === heavy);
    if (sameKind.length > 0) {
      const last = sameKind[sameKind.length - 1];
      raw = Math.max(raw, Math.round(last.ms / 1000));
    }
    return Math.min(1800, Math.max(5, raw));
  }

  function nextLine(list, channel, resolved) {
    const line = pickLine(list, { random: resolved?.random, previous: lastLine[channel] ?? null });
    lastLine[channel] = line;
    return line;
  }

  /** 附件只说一句人话，而且只在长任务里说：短活儿还报一遍"收到 2 个文件"很像报销。 */
  function attachmentNoteOf(saved) {
    const items = (Array.isArray(saved) ? saved : []).filter(
      (item) => item && typeof item.path === "string" && item.path !== "",
    );
    if (items.length === 0) return "";
    const kinds = new Set(items.map((item) => item.kind));
    const unit =
      kinds.size === 1 ? (kinds.has("image") ? "张图片" : kinds.has("record") ? "条语音" : "个文件") : "个附件";
    return "收到 " + items.length + " " + unit;
  }

  function ackTextOf({ saved, seconds, resolved }) {
    const longTask = seconds > LONG_TASK_SECONDS;
    const lines = [nextLine(toneLines(ackTone, longTask ? "long" : "short"), "ack", resolved)];
    if (longTask) {
      const note = attachmentNoteOf(saved);
      if (note !== "") lines.push(note);
    }
    return lines.join("\n");
  }

  function dataRootDir() {
    const fromStorage = typeof storage?.rootDir === "string" && storage.rootDir !== "" ? storage.rootDir : "";
    if (fromStorage !== "") return fromStorage;
    const fromConfig = config?.storage?.rootDir;
    return typeof fromConfig === "string" ? fromConfig : "";
  }

  function promptsDir() {
    return promptsDirOf(dataRootDir());
  }

  function journalEveryTurns() {
    const raw = Number(config?.journal?.everyTurns);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }

  function rememberTurn(message, replyText) {
    const user = typeof message?.text === "string" ? message.text.replace(/\s+/gu, " ").trim().slice(0, 400) : "";
    const assistant = typeof replyText === "string" ? replyText.replace(/\s+/gu, " ").trim().slice(0, 400) : "";
    if (user === "" && assistant === "") return;
    recentTurns.push({ user, assistant });
    if (recentTurns.length > RECENT_TURNS_MAX) recentTurns.shift();
  }

  /**
   * 一次内省：角色卡 + 日记尾巴 + 最近这些对话 → 独立提示词 → 日记追加、人格建议覆盖。
   * 用新会话跑：日记是本子，不是正在聊的那条上下文。
   */
  async function runIntrospection({ now = new Date() } = {}) {
    const dir = promptsDir();
    if (dir === "") return { ok: false, reason: "没有数据目录（storage.rootDir 为空）" };

    const persona = await readPersona({ promptsDir: dir });
    const journal = readJournalTail({ promptsDir: dir });
    const prompt = buildIntrospectionPrompt({ recent: recentTurns.slice(-RECENT_TURNS_MAX), persona, journal, now });

    let outcome;
    try {
      outcome = await semaphore.withPermit(() => runDsh({ config, prompt, sessionId: null, logger }));
    } catch (error) {
      return { ok: false, reason: "调用 DSH 失败：" + String(error?.message ?? error) };
    }
    if (!outcome?.ok || typeof outcome.text !== "string" || outcome.text.trim() === "") {
      return { ok: false, reason: failureText(outcome?.reason ?? "no_final", outcome) };
    }

    const parsed = parseIntrospection(outcome.text);
    if (parsed.diary === "" && parsed.suggestion === "") {
      return { ok: false, reason: "模型这次没按格式写（没有可用段落）" };
    }
    const wrote = await appendJournalEntry({ promptsDir: dir, body: parsed.diary, now });
    const suggested = await writeSuggestedPersona({ promptsDir: dir, text: parsed.suggestion });
    if (!wrote.ok && !suggested.ok) return { ok: false, reason: wrote.reason };
    return {
      ok: true,
      diaryLines: wrote.ok ? wrote.lines : 0,
      suggestionLines: suggested.ok ? suggested.lines : 0,
    };
  }

  function trackJournal(promise) {
    const task = Promise.resolve(promise)
      .catch((error) => {
        logger?.warn?.("内省出错", { error: String(error?.message ?? error) });
      })
      .finally(() => {
        background.delete(task);
      });
    background.add(task);
    return task;
  }

  /** 等所有后台内省落盘（只有测试需要；生产上没人等它）。 */
  async function settle() {
    while (background.size > 0) await Promise.all([...background]);
  }

  /** 每 N 轮自动写一次日记：回复已经发出去了，只写文件、不再打扰用户。 */
  function maybeJournalAfterTurn() {
    const every = journalEveryTurns();
    if (every === 0) return;
    turnsSinceJournal += 1;
    if (turnsSinceJournal < every) return;
    turnsSinceJournal = 0;
    void trackJournal(runIntrospection()).then((outcome) => {
      if (outcome?.ok) {
        logger?.info?.("已自动写日记", { diaryLines: outcome.diaryLines, suggestionLines: outcome.suggestionLines });
      } else {
        logger?.warn?.("自动写日记没成功", { reason: outcome?.reason });
      }
    });
  }

  async function readSession(key) {
    try {
      const value = await sessions?.get?.(key);
      return typeof value === "string" && value !== "" ? value : null;
    } catch (error) {
      logger?.warn?.("读取会话映射失败", { key, error: String(error?.message ?? error) });
      return null;
    }
  }

  function platformOf() {
    const platform = typeof config?.platform === 'string' ? config.platform : '';
    // 命令行模式（bin/bridge.mjs）没有 platform 字段：那条路只有 OneBot 一种走法
    return platform === '' ? 'onebot' : platform;
  }

  function runnerOf() {
    const runner = config?.dsh?.runner;
    return typeof runner === 'string' && runner !== '' ? runner : 'headless';
  }

  function historyDir() {
    const rootDir = dataRootDir();
    return rootDir === '' ? '' : join(rootDir, 'history');
  }

  function pendingCountOf(bridgeService) {
    try {
      if (typeof bridgeService?.pendingCount === 'function') return Number(bridgeService.pendingCount()) || 0;
      if (typeof bridgeService?.status === 'function') return Number(bridgeService.status()?.pending ?? 0) || 0;
    } catch {
      // 桥没挂上就当没有挂起：状态命令不该因为读桥而失败
    }
    return 0;
  }

  function lastDurationMs() {
    return recentDurations.length === 0 ? null : recentDurations[recentDurations.length - 1].ms;
  }

  /** 命令不进 DSH：就地回一句，不占并发额度、也不产生一轮对话（/日记 例外，它要跑一轮内省）。 */
  async function handleCommand({ command, message, chatKey, resolved }) {
    if (command.name === 'help') {
      await deliver(message, commandHelpText({ sessionId: await readSession(chatKey) }));
      return;
    }
    if (command.name === 'new') {
      // reset 排在正在跑的那一轮后面，所以这里的"下一条消息开始生效"是真的
      const cleared = await sessionBinding.reset(chatKey);
      logger?.info?.('收到 /new，已清空会话绑定', { chatKey, previousSessionId: cleared.sessionId });
      await deliver(message, commandNewSessionText(cleared.sessionId));
      return;
    }
    if (command.name === 'status') {
      await deliver(
        message,
        commandStatusText({
          platform: platformOf(),
          runner: runnerOf(),
          sessionId: await readSession(chatKey),
          lastDurationMs: lastDurationMs(),
          approvalPending: pendingCountOf(approvalBridge),
          questionPending: pendingCountOf(questionBridge),
        }),
      );
      return;
    }
    if (command.name === 'journal') {
      // 写日记要跑一轮模型，先给一句人话，免得用户以为命令没被认出来
      await deliver(message, nextLine(toneLines(ackTone, "short"), "ack", resolved));
      const outcome = await runIntrospection({});
      if (outcome.ok) {
        logger?.info?.('已写日记', { chatKey, diaryLines: outcome.diaryLines, suggestionLines: outcome.suggestionLines });
        await deliver(message, commandJournalDoneText(outcome));
      } else {
        logger?.warn?.('写日记失败', { chatKey, reason: outcome.reason });
        await deliver(message, commandJournalFailedText(outcome.reason));
      }
      return;
    }
    if (command.name === 'adopt') {
      const outcome = await adoptSuggestedPersona({ promptsDir: promptsDir() });
      if (!outcome.ok) {
        logger?.info?.('没有可采纳的人格建议', { chatKey, reason: outcome.reason });
        await deliver(message, commandAdoptMissingText());
        return;
      }
      logger?.info?.('已采纳人格建议', {
        chatKey,
        replaced: outcome.replaced,
        appended: outcome.appended,
        backupPath: outcome.backupPath,
      });
      await deliver(message, commandAdoptDoneText(outcome));
      return;
    }
    if (command.name === 'export') {
      const outcome = await exportSessionMarkdown({
        dshHome: defaultDshHome(),
        cwd: typeof config?.dsh?.cwd === 'string' ? config.dsh.cwd : '',
        sessionId: await readSession(chatKey),
        outDir: historyDir(),
      });
      if (outcome.ok) logger?.info?.('会话已导出', { chatKey, path: outcome.path, count: outcome.count });
      else logger?.warn?.('导出会话失败', { chatKey, reason: outcome.message });
      await deliver(message, outcome.ok ? commandExportDoneText(outcome) : commandExportFailedText(outcome.message));
    }
  }

  async function handleEvent(raw) {
    let resolved;
    try {
      resolved = await resolveDeps();
    } catch (error) {
      counters.parseErrors += 1;
      logger?.error?.("加载 pipeline 依赖失败", { error: String(error?.message ?? error) });
      return;
    }

    let message = null;
    let chatKey = null;
    try {
      let parsed;
      try {
        parsed = resolved.parseEvent(raw);
      } catch (error) {
        counters.parseErrors += 1;
        logger?.warn?.("事件解析失败", { error: String(error?.message ?? error) });
        return;
      }

      if (parsed?.kind !== "message" || !parsed.message) {
        counters.ignored += 1;
        return;
      }

      message = parsed.message;
      counters.received += 1;
      chatKey = chatKeyOf(message, resolved);

      const decision = guard?.decide?.(message) ?? { allow: false, reason: "guard_unavailable" };
      if (!decision.allow) {
        counters.denied += 1;
        logger?.debug?.("消息被安全策略拒绝", { chatKey, reason: decision.reason });
        return;
      }

      const { saved, voiceTranscript } = await landAttachments({ message, raw, resolved });

      await serial.run(chatKey, async () => {
        const command = parseCommand(typeof message?.text === 'string' ? message.text : '');
        if (command !== null) {
          await handleCommand({ command, message, chatKey, resolved });
          return;
        }

        // "读绑定 → 跑 → 写绑定"整段进锁：两条并发消息同时读到空绑定会各建一个会话，
        // 后写的把先写的覆盖掉，还会同时占住同一份写句柄（网页里点开就是空白）
        await sessionBinding.withBinding(chatKey, async (scope) => {
          // 会话 id 必须在锁里读：排在后面的消息要用前一条刚落盘的新 id
          // newSessionPerMessage 只是调试开关：永远不撞写句柄，代价是跨消息没有上下文
          const freshEveryTime = config?.dsh?.newSessionPerMessage === true;
          const sessionId = freshEveryTime ? null : await scope.get();
          const prompt = buildPrompt({ config, message, savedAttachments: saved, voiceTranscript });

          // 长任务最怕"静默"：先回一条回执，超过阈值再报进度（用主动消息，不占被动回复配额）
          const heavyTask = /(整理|分析|总结|归纳|阅读|读一下|读完|遍历|批量|全部|每个|扫描|重构|改代码|修\s*bug|写成|生成|导出|翻译|对比)/.test(typeof message?.text === "string" ? message.text : "");
          // 用户在手把手教我怎么回：存进 prompts/lessons.md，之后每轮都带着
        const rawText = typeof message?.text === "string" ? message.text : "";
        const taught = /^\/记住\s+/u.test(rawText) ? rawText.replace(/^\/记住\s+/u, "") : rawText;
        if ((isTeaching(rawText) || /^\/记住\s+/u.test(rawText)) && saved.length === 0) {
          const dataDir = config?.storage?.rootDir ?? "";
          const saved2 = await appendLesson({ dataDir, text: taught });
          if (saved2.ok) {
            await deliver(message, pickTeachReply());
            return;
          }
          await deliver(message, "想记下来但是写文件失败了：" + String(saved2.error ?? "未知原因").slice(0, 120));
          return;
        }

        // 「ok」「嗯」「好的」这种没有指向的回复：先问清楚，别自己猜一件事去做
        const unclearText = typeof message?.text === "string" ? message.text.trim() : "";
        const UNCLEAR_WORDS = /^(ok|okay|嗯+|好|好的|好滴|收到|行|可以|👌|👍|在吗|在么)$/iu;
        if (config?.reply?.askWhenUnclear === true && saved.length === 0 && UNCLEAR_WORDS.test(unclearText)) {
          await deliver(message, pickUnclearReply(resolved));
          return;
        }
        const ackOn = config?.reply?.ack === true;
          const seconds = estimateSecondsOf(message, saved);
          const everyMs = Number(config?.reply?.progressEveryMs);
          const progressEvery = Number.isFinite(everyMs) && everyMs >= 10000 ? Math.floor(everyMs) : 45000;
          const maxRaw = Number(config?.reply?.progressMax);
          const progressMax = Number.isFinite(maxRaw) && maxRaw >= 0 ? Math.floor(maxRaw) : 2;
          // 回执只给"真的要等"的活儿：两三秒就答完的短问答再冒一句"行行行我来"很像机器
        const ackMin = Number(config?.reply?.ackMinSeconds);
        const ackMinSeconds = Number.isFinite(ackMin) && ackMin >= 0 ? Math.floor(ackMin) : 20;
        const needAck = ackOn && seconds >= ackMinSeconds;
        if (needAck) await deliver(message, ackTextOf({ saved, seconds, resolved }));
          const startedAt = Date.now();
          let progressTimer = null;
          let progressSent = 0;
          if (needAck && progressEvery > 0 && progressMax > 0) {
            progressTimer = setInterval(() => {
              if (progressSent >= progressMax) return;
              progressSent += 1;
              // 不报秒数：真人不会掐着表告诉你"已用 45 秒"，那正是最刺眼的一句机器话
              void deliver({ ...message, messageId: "" }, nextLine(toneLines(ackTone, "progress"), "progress", resolved));
            }, progressEvery);
            progressTimer.unref?.();
          }

          let result;
          try {
            result = await semaphore.withPermit(() => runDsh({ config, prompt, sessionId, logger }));
          } catch (error) {
            counters.failed += 1;
            logger?.error?.("runDsh 抛错", { chatKey, error: String(error?.message ?? error) });
            await deliver(message, `${errorPrefix}调用 DSH 失败，这次没有结果。`);
            return;
          } finally {
            if (progressTimer) clearInterval(progressTimer);
            recentDurations.push({ ms: Date.now() - startedAt, heavy: heavyTask });
            if (recentDurations.length > 5) recentDurations.shift();
          }

          if (result?.ok) {
            if (!freshEveryTime && result.sessionId && result.sessionId !== sessionId) {
              await scope.set(result.sessionId);
            }
            // 换新会话是兜底成功、不是故障：只记日志，用户不必知道上下文断了一次
            if (result.rebound === true) {
              logger?.warn?.("会话写句柄一直被占用，已换新会话继续", { chatKey, sessionId: result.sessionId });
            }
            // 先发正文里点名的媒体、再清理标记，最后才发这一段文字（这一段才等"打字"）
            const media = await sendMarkedMedia({
              message,
              text: typeof result.text === "string" ? result.text : "",
              resolved,
            });
            let text = media.text === "" ? NO_TEXT_PLACEHOLDER : media.text;
            if (config?.reply?.showSessionId && result.sessionId) text += `\n[session ${result.sessionId}]`;
            await deliver(message, text, { humanDelay: true });
            counters.handled += 1;
            rememberTurn(message, typeof result.text === "string" ? result.text : "");
            // 排在回复之后：自动日记只写文件，不该让用户多收到一条消息
            maybeJournalAfterTurn();
            return;
          }

          counters.failed += 1;
          logger?.warn?.("DSH 调用失败", { chatKey, reason: result?.reason, exitCode: result?.exitCode });
          await deliver(message, `${errorPrefix}${failureText(result?.reason, result)}`);
        });
      });
    } catch (error) {
      counters.failed += 1;
      logger?.error?.("处理消息时出现未预期异常", {
        chatKey,
        error: String(error?.message ?? error),
      });
      if (message) {
        // 发给用户的一句话绝不含堆栈，细节只在日志里
        await deliver(message, `${errorPrefix}内部错误，这次没有处理成功。`);
      }
    }
  }

  return { handleEvent, stats: () => ({ ...counters }), settle };
}
