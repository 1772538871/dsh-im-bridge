// 提问桥：把 DSH 的 user-questions/request 瀑布事件翻译成一条 QQ 消息，再把用户的回复还原成答案批次。
//
// 为什么要 prepend：浏览器端 dsh-client-ui-user-questions 也挂在同一个瀑布上，它认领后这张卡就只在
// 页面里等点击——QQ 那边一片安静，用户以为卡死。排在它后面注册的监听器永远等不到这次机会。
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// 跳过词表宁窄勿宽：除这几个词以外的任何文本都会被当成"自由回答"顶上去，
// 词表宽一格，用户真正想说的话就可能少一句。
const SKIP_WORDS = ["跳过", "跳过此题", "跳過", "skip"];

const TRAILING = /[\s。.，,！!？?~～、]+$/u;
const OPTION_TOKEN_SPLIT = /[\s,、，\/]+/u;

function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

/** 归一化一条回复，只用来判词（是不是"跳过"、是不是选项号），不用于回填答案。 */
export function normalizeQuestionReply(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(TRAILING, "");
}

/** 选项序号 -> 选项 label（d.ts 里 selected 是"Selected option labels"）。认不出来返回 null。 */
function optionLabelsOf(value, options, multiSelect) {
  if (options.length === 0) return null;
  const tokens = multiSelect ? value.split(OPTION_TOKEN_SPLIT).filter((token) => token !== "") : [value];
  if (tokens.length === 0) return null;
  const picked = [];
  for (const token of tokens) {
    if (!/^\d+$/u.test(token)) return null;
    const index = Number(token) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= options.length) return null;
    const label = String(options[index]?.label ?? "");
    if (label === "" || picked.indexOf(label) !== -1) return null;
    picked.push(label);
  }
  return picked;
}

/**
 * 一条 QQ 文本 -> 这条问题的答案素材（跳过 / 选了几项 / 自由回答）。
 * 导出是为了单测能直接钉住"回什么 -> 填哪个字段"，不必每次都走一遍 handleReply。
 * 返回 null 表示这条消息不是答案（空消息，例如只发了一张图），调用方交回正常流程。
 */
export function classifyQuestionReply(text, question = null) {
  const raw = String(text ?? "").trim();
  if (raw === "") return null;
  const value = normalizeQuestionReply(raw);
  if (SKIP_WORDS.indexOf(value) !== -1) return { kind: "skip", selected: [], custom: null };
  const options = Array.isArray(question?.options) ? question.options : [];
  const picked = optionLabelsOf(value, options, question?.multiSelect === true);
  if (picked !== null) return { kind: "option", selected: picked, custom: null };
  // 认不出序号就整句当自由回答：原样上交，不改写用户的话
  return { kind: "custom", selected: [], custom: raw };
}

/** AskUserQuestionAnswerItem 的字段就这么三个（id / selected / custom），多一个都会被 strict 校验拒掉。 */
function answerItemOf(question, verdict) {
  const id = typeof question?.id === "string" ? question.id : "";
  if (verdict.kind === "option") return { id, selected: verdict.selected.slice() };
  if (verdict.kind === "custom") return { id, selected: [], custom: verdict.custom };
  return { id, selected: [] };
}

/** 跳过：一问一条，selected 留空且不带 custom——这是 DSH 里"用户明确跳过"的写法，回合会继续。 */
function skipAnswersOf(questions) {
  return (Array.isArray(questions) ? questions : []).map((question) => answerItemOf(question, { kind: "skip" }));
}

function isSkipItem(item) {
  return item.selected.length === 0 && item.custom === undefined;
}

function titleOf(entry) {
  const question = entry.questions[entry.index] ?? {};
  const header = typeof question.header === "string" && question.header.trim() !== "" ? question.header.trim() : "需要你回答";
  const position = entry.questions.length > 1 ? " · 第 " + (entry.index + 1) + "/" + entry.questions.length + " 问" : "";
  return "【提问 " + entry.label + position + "】" + header;
}

function hintOf(count, multiSelect, minutes) {
  let head;
  if (count === 0) head = "直接回复你的答案";
  else if (count === 1) head = "回复 1 选择";
  else if (multiSelect) head = "回复 1-" + count + " 选择，可多选（用逗号分隔）";
  else head = "回复 1-" + count + " 选择";
  return head + "，或直接输入你的答案；回「跳过」跳过（" + minutes + " 分钟内有效）";
}

/** 与审批卡同一版式：标题行 + "· 要点"，QQ 里才不会挤成一团。一问一条，序号永远不歧义。 */
function askTextOf(entry, timeoutMs) {
  const question = entry.questions[entry.index] ?? {};
  const minutes = Math.max(1, Math.round(timeoutMs / 60000));
  const lines = [titleOf(entry)];
  const detail = typeof question.detail === "string" ? question.detail.trim() : "";
  if (detail !== "") lines.push("· 说明：" + detail);
  const text = typeof question.question === "string" ? question.question.trim() : "";
  if (text !== "") lines.push("· 问题：" + text);
  const options = Array.isArray(question.options) ? question.options : [];
  options.forEach((option, index) => {
    const label = String(option?.label ?? "");
    const description = typeof option?.description === "string" ? option.description.trim() : "";
    lines.push("  " + (index + 1) + ". " + label + (description === "" ? "" : "（" + description + "）"));
  });
  lines.push(hintOf(options.length, question.multiSelect === true, minutes));
  return lines.join("\n");
}

function summaryOf(verdict) {
  if (verdict.kind === "option") return verdict.selected.join("、");
  if (verdict.kind === "custom") return "「" + verdict.custom + "」";
  return "跳过";
}

/**
 * 提问桥。runner 通过 own(agent, { chatKey }) 登记"自己建的 agent"，
 * 桥只认领这些 agent 的提问，其余一律 next() 委托给别的应答者（浏览器里的提问面板）。
 */
export function createQuestionBridge({ ctx = null, logger = null, send = null, config = null, now = () => Date.now() } = {}) {
  const questionConfig = config?.questions ?? {};
  const enabled = questionConfig.enabled !== false;
  // 超时窗口与审批共用一份：用户对"它会等我多久"只该记一个数字
  const wanted = Number(config?.approval?.timeoutMs);
  const timeoutMs = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : DEFAULT_TIMEOUT_MS;

  // agent -> { chatKey }：用 WeakMap 以免把 agent 的生命周期拖长
  const owned = new WeakMap();
  // chatKey -> entry：一个会话同时只挂一条提问，因为 QQ 里一条"1"分不清是哪一条在等
  const pending = new Map();
  const counters = { asked: 0, answered: 0, skipped: 0, timeouts: 0, conflicts: 0, aborts: 0, sendFailures: 0 };
  let seq = 0;
  let attached = false;
  let listener = null;
  let off = null;
  let effectDisposer = null;
  let lastError = null;

  const diag = (level, message, extra) => {
    try {
      if (logger && typeof logger[level] === "function") logger[level](message, extra);
    } catch {
      // 日志后端坏掉不能影响一条提问
    }
  };

  function sendText(chatKey, text) {
    if (typeof send !== "function") return false;
    try {
      const ret = send(chatKey, text);
      if (ret && typeof ret.then === "function") {
        ret.then(undefined, (error) => {
          counters.sendFailures += 1;
          lastError = "提问消息发送失败：" + errorText(error);
          diag("warn", lastError, { chatKey });
        });
      }
      return true;
    } catch (error) {
      counters.sendFailures += 1;
      lastError = "提问消息发送失败：" + errorText(error);
      diag("warn", lastError, { chatKey });
      return false;
    }
  }

  /** 收尾一条提问：清定时器/监听、从表里摘掉、写计数，最后才 resolve 让 asker 拿到答案。 */
  function settle(entry, answers, { notify = false, text = "" } = {}) {
    if (!entry || entry.settled === true) return false;
    entry.settled = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.onAbort && entry.signal) {
      try {
        entry.signal.removeEventListener("abort", entry.onAbort);
      } catch {
        // 已经断开的 signal 不能再摘监听，忽略
      }
    }
    if (pending.get(entry.chatKey) === entry) pending.delete(entry.chatKey);
    if (answers.every(isSkipItem)) counters.skipped += 1;
    else counters.answered += 1;
    if (notify && text !== "") sendText(entry.chatKey, text);
    entry.resolve({ answers });
    return true;
  }

  async function handleRequest(request, next) {
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    // 没有 next 也不能把回合吊死：给一份"全跳过"的答案，让模型自己往下走
    const delegate = typeof next === "function" ? next : () => Promise.resolve({ answers: skipAnswersOf(questions) });
    // 和审批桥同一把尺子：只认领自家 runner 建的 agent
    const meta = request && request.agent && typeof request.agent === "object" ? owned.get(request.agent) : undefined;
    if (meta === undefined) return delegate();
    if (!enabled || questions.length === 0) return delegate();
    const chatKey = typeof meta.chatKey === "string" ? meta.chatKey : "";
    if (chatKey === "") {
      diag("warn", "提问没有可用的 chatKey，已委托给其他应答者", { count: questions.length });
      return delegate();
    }

    const skipped = { answers: skipAnswersOf(questions) };
    if (request?.signal?.aborted) {
      counters.aborts += 1;
      return skipped;
    }
    const busy = pending.get(chatKey);
    if (busy) {
      counters.conflicts += 1;
      // 不静默吞掉第二条：告诉用户"有一条还在等"，并明确这条按跳过处理（否则两边都卡着）
      sendText(chatKey, "已有待回答的提问 " + busy.label + "，这条先按跳过处理（先回上面那条）。");
      lastError = "同一会话出现并发提问，后续请求按跳过处理";
      diag("warn", "同一 chatKey 出现第二条提问请求，按跳过处理", { chatKey, waitingFor: busy.label });
      return skipped;
    }

    seq += 1;
    const entry = {
      label: "#" + seq,
      chatKey,
      questions,
      index: 0,
      answers: [],
      signal: request?.signal ?? null,
      createdAt: now(),
      timer: null,
      onAbort: null,
      settled: false,
      resolve: null
    };
    counters.asked += 1;
    // 先登记再发问：用户可能秒回，登记晚一步就会被当成普通消息派下去
    const decision = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    pending.set(chatKey, entry);

    entry.timer = setTimeout(() => {
      counters.timeouts += 1;
      // 超时必须回"跳过"而不是 reject：reject 会让整轮工具调用报错收场，
      // 而跳过只是"这一问没人答"，模型还能接着说下去
      settle(entry, skipAnswersOf(entry.questions), { notify: true, text: entry.label + " 等待超时，先按跳过处理。" });
    }, timeoutMs);
    entry.timer.unref?.();

    if (entry.signal && typeof entry.signal.addEventListener === "function") {
      entry.onAbort = () => {
        counters.aborts += 1;
        settle(entry, skipAnswersOf(entry.questions), { notify: true, text: entry.label + " 已撤销，不用回答了。" });
      };
      try {
        entry.signal.addEventListener("abort", entry.onAbort, { once: true });
      } catch {
        entry.onAbort = null;
      }
    }

    sendText(chatKey, askTextOf(entry, timeoutMs));
    diag("info", "提问已转发到 IM", { id: entry.label, chatKey, questions: questions.length, timeoutMs });
    return decision;
  }

  /** 命中返回 true：调用方据此知道这条消息是"提问答复"，不能再当新任务派下去。 */
  function handleReply({ chatKey, text } = {}) {
    const key = typeof chatKey === "string" ? chatKey : "";
    if (key === "") return false;
    const entry = pending.get(key);
    // 没有待回答的提问就是普通消息：正常任务照旧
    if (!entry) return false;
    const question = entry.questions[entry.index] ?? null;
    const verdict = classifyQuestionReply(text, question);
    // 空消息（比如只发了一张图）不算答案，这条提问继续等
    if (verdict === null) return false;
    entry.answers.push(answerItemOf(question, verdict));
    entry.index += 1;

    if (entry.index < entry.questions.length) {
      // 还有下一问：跳过/回答都往下走，序号按当前这一问重新从 1 数
      sendText(key, askTextOf(entry, timeoutMs));
      diag("info", "用户回答了提问，继续问下一问", { id: entry.label, index: entry.index, chatKey: key });
      return true;
    }
    settle(entry, entry.answers, { notify: true, text: "已记下 " + entry.label + "：" + summaryOf(verdict) + "。" });
    diag("info", "用户在 IM 里回答了提问", { id: entry.label, kind: verdict.kind, chatKey: key });
    return true;
  }

  function own(agent, meta = null) {
    if (!agent || (typeof agent !== "object" && typeof agent !== "function")) return false;
    const chatKey = typeof meta === "string" ? meta : typeof meta?.chatKey === "string" ? meta.chatKey : "";
    owned.set(agent, { chatKey });
    return true;
  }

  function release(agent) {
    if (!agent || (typeof agent !== "object" && typeof agent !== "function")) return false;
    return owned.delete(agent);
  }

  function attach() {
    if (attached) return { ok: true, attached: true };
    if (!enabled) {
      diag("info", "questions.enabled=false，不注册 user-questions/request 监听");
      return { ok: false, error: "questions.disabled" };
    }
    if (!ctx || typeof ctx.on !== "function") {
      lastError = "当前上下文没有 ctx.on，提问桥未启用";
      diag("warn", lastError);
      return { ok: false, error: lastError };
    }
    listener = (request, next) => handleRequest(request, next);
    try {
      // prepend:true 是硬要求：不插队就会被浏览器提问面板先认领，等的是页面点击而不是 QQ 回复
      off = ctx.on("user-questions/request", listener, { prepend: true });
    } catch (error) {
      lastError = "注册 user-questions/request 监听失败：" + errorText(error);
      diag("warn", lastError, { error: errorText(error) });
      listener = null;
      return { ok: false, error: lastError };
    }
    attached = true;
    if (typeof off !== "function") off = null;
    if (typeof ctx.effect === "function") {
      try {
        // 交给 cordis 托管卸载：插件重载/DSH 卸载时监听器必须跟着消失，
        // 否则旧实例还会认领请求（尤其是 owned 里还有残留 agent 的时候）
        effectDisposer = ctx.effect(() => () => {
          detach();
        });
      } catch (error) {
        diag("debug", "ctx.effect 不可用，改由显式 detach() 卸载", { error: errorText(error) });
      }
    }
    diag("info", "提问桥已挂上 user-questions/request（prepend）", { timeoutMs });
    return { ok: true, attached: true };
  }

  function detach() {
    if (effectDisposer) {
      const run = effectDisposer;
      effectDisposer = null;
      try {
        run();
      } catch {
        // effect 已随 ctx 卸载过一次，再调一次是无害的
      }
    }
    if (!attached) return;
    attached = false;
    const current = listener;
    listener = null;
    try {
      if (typeof off === "function") off();
      else if (current && ctx && typeof ctx.off === "function") ctx.off("user-questions/request", current);
    } catch (error) {
      diag("debug", "移除 user-questions/request 监听失败", { error: errorText(error) });
    }
    off = null;
    // 卸载时把还挂着的提问按跳过收尾：让卡住的工具调用立刻返回，不必等 5 分钟超时
    for (const entry of Array.from(pending.values())) settle(entry, skipAnswersOf(entry.questions));
  }

  function pendingCount() {
    return pending.size;
  }

  function status() {
    return {
      attached,
      enabled,
      timeoutMs,
      pending: pending.size,
      pendingEntries: Array.from(pending.values()).map((entry) => ({
        id: entry.label,
        chatKey: entry.chatKey,
        question: entry.questions[entry.index]?.id ?? null,
        index: entry.index,
        total: entry.questions.length,
        ageMs: Math.max(0, now() - entry.createdAt)
      })),
      counters: { ...counters },
      lastError
    };
  }

  return { attach, detach, handleReply, own, release, pendingCount, status };
}
