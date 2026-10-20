// 审批桥：把 DSH 的 approval/request 瀑布事件翻译成一条 QQ 消息，再按用户的回复作答。
//
// 为什么要 prepend：浏览器端 dsh-client-ui-approval 也挂在同一个瀑布上，它认领后会一直等页面点击。
// 排在它后面注册的监听器永远等不到机会，所以这里必须插到队首。
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// 回复词表宁窄勿宽：认不出来就交回正常消息流程，用户想发一个"1"给模型时不会被吞掉
const ALLOW_WORDS = ["1", "y", "yes", "ok", "okay", "同意", "允许", "放行", "确认", "好", "好的", "可以", "是的", "准"];
const REJECT_WORDS = ["2", "n", "no", "拒绝", "不行", "不同意", "不行", "不要", "不允许", "别", "驳回"];
const CANCEL_WORDS = ["0", "cancel", "取消"];

function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

/** 归一化一条 QQ 回复：去空白、统一小写、去掉句末标点（手机上"1。"很常见）。 */
export function normalizeApprovalReply(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s。.，,！!？?~～、]+$/u, "");
}

/**
 * 把一条回复映射成 ApprovalOutcome；认不出来返回 null（调用方据此交回正常流程）。
 * 导出是为了单测能直接钉住词表，不必每次都走一遍 handleReply。
 */
export function classifyApprovalReply(text) {
  const value = normalizeApprovalReply(text);
  if (value === "") return null;
  if (ALLOW_WORDS.indexOf(value) !== -1) return "allowed-once";
  if (REJECT_WORDS.indexOf(value) !== -1) return "rejected";
  if (CANCEL_WORDS.indexOf(value) !== -1) return "cancelled";
  return null;
}

function toolNameOf(req) {
  const name = req && typeof req.toolName === "string" ? req.toolName.trim() : "";
  return name !== "" ? name : "(未知工具)";
}

/** 人话原因：优先用 asker 给的本地化文案（displayReason），其次原始 reason。 */
function reasonTextOf(req) {
  const display = req && req.displayReason;
  if (display && typeof display === "object") {
    const localized = display.zh ?? display["zh-CN"] ?? display.en;
    if (typeof localized === "string" && localized.trim() !== "") return localized.trim();
  }
  const raw = req && typeof req.reason === "string" ? req.reason.trim() : "";
  return raw;
}

function askTextOf(entry, req, timeoutMs) {
  const minutes = Math.max(1, Math.round(timeoutMs / 60000));
  // QQ 里一行太长会挤成一段，所以拆成"标题 + 要点 + 怎么回"三段
  const lines = ["【审批 " + entry.label + "】需要你确认"];
  lines.push("· 操作：" + entry.toolName);
  const reason = reasonTextOf(req);
  if (reason !== "") lines.push("· 原因：" + reason);
  lines.push("回复 1 允许 / 2 拒绝 / 0 取消（" + minutes + " 分钟内有效，超时按拒绝处理）");
  return lines.join("\n");
}

function replyTextOf(outcome, entry) {
  if (outcome === "allowed-once") return "已放行 " + entry.label + "（仅这一次）。";
  if (outcome === "cancelled") return "已取消 " + entry.label + "。";
  return "已拒绝 " + entry.label + "。";
}

/**
 * 审批桥。runner 通过 own(agent, { chatKey }) 登记"自己建的 agent"，
 * 桥只认领这些 agent 的请求，其余一律 next() 委托给别的应答者（比如浏览器面板）。
 */
export function createApprovalBridge({ ctx = null, logger = null, send = null, config = null, now = () => Date.now() } = {}) {
  const approvalConfig = config?.approval ?? {};
  const enabled = approvalConfig.enabled !== false;
  // 下限（≥10000）在 config-store 里校验，这里只做"能算出正数就用它"的兜底，
  // 免得同一个规则写两遍、两处不一致
  // own：只认领本插件建的会话（安全默认）；all：连 GUI 里手动开的会话的审批也转发到 QQ
  const scope = approvalConfig.scope === "all" ? "all" : "own";
  const explicitChatKey = typeof approvalConfig.chatKey === "string" ? approvalConfig.chatKey.trim() : "";
  let lastActiveChatKey = "";
  const wanted = Number(approvalConfig.timeoutMs);
  const timeoutMs = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : DEFAULT_TIMEOUT_MS;

  // agent -> { chatKey }：用 WeakMap 以免把 agent 的生命周期拖长
  const owned = new WeakMap();
  // chatKey -> entry：一个会话同时只能挂一条审批，因为 QQ 里一条"1"无法区分是哪一条在等
  const pending = new Map();
  const counters = { asked: 0, allowed: 0, rejected: 0, cancelled: 0, timeouts: 0, conflicts: 0, sendFailures: 0 };
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
      // 日志后端坏掉不能影响一次审批
    }
  };

  function sendText(chatKey, text) {
    if (typeof send !== "function") return false;
    try {
      const ret = send(chatKey, text);
      if (ret && typeof ret.then === "function") {
        ret.then(undefined, (error) => {
          counters.sendFailures += 1;
          lastError = "审批消息发送失败：" + errorText(error);
          diag("warn", lastError, { chatKey });
        });
      }
      return true;
    } catch (error) {
      counters.sendFailures += 1;
      lastError = "审批消息发送失败：" + errorText(error);
      diag("warn", lastError, { chatKey });
      return false;
    }
  }

  /** 收尾一条审批：清定时器/监听、从表里摘掉、写计数，最后才 resolve 让 asker 拿到结果。 */
  function settle(entry, outcome, { notify = false, text = "" } = {}) {
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
    if (outcome === "allowed-once") counters.allowed += 1;
    else if (outcome === "cancelled") counters.cancelled += 1;
    else counters.rejected += 1;
    if (notify && text !== "") sendText(entry.chatKey, text);
    entry.resolve(outcome);
    return true;
  }

  async function handleRequest(req, next) {
    const delegate = typeof next === "function" ? next : () => Promise.resolve("unavailable");
    // 只认领自家 runner 建的 agent；别把设置页/其他插件里的会话也抢过来
    const meta = req && req.agent && typeof req.agent === "object" ? owned.get(req.agent) : undefined;
    const isOwn = meta !== undefined;
    // 默认只认领自家会话；scope=all 时才接管别人的（发到最近活跃的机器人会话）
    if (!isOwn && scope !== "all") return delegate();
    if (!enabled) return delegate();
    const chatKey = isOwn
      ? typeof meta.chatKey === "string" ? meta.chatKey : ""
      : explicitChatKey !== "" ? explicitChatKey : lastActiveChatKey;
    if (chatKey === "") {
      // 问不到人就别抢：交给默认应答者（无应答者时 fail-closed 成 unavailable）
      diag("warn", "审批请求没有可用的 chatKey，已委托给其他应答者", { toolName: req?.toolName ?? null });
      return delegate();
    }
    if (req?.signal?.aborted) return "cancelled";
    const busy = pending.get(chatKey);
    if (busy) {
      counters.conflicts += 1;
      // 不静默吞掉第二条：告诉用户"有一条还在等"，并明确这条按拒绝处理（fail-closed）
      sendText(chatKey, "已有待审批 " + busy.label + "（" + busy.toolName + "），这条先按拒绝处理。回复 1 放行 / 2 拒绝 / 0 取消。");
      lastError = "同一会话出现并发审批，后续请求按拒绝处理";
      diag("warn", "同一 chatKey 出现第二条审批请求，按拒绝处理", { chatKey, waitingFor: busy.label, toolName: req?.toolName ?? null });
      return "rejected";
    }

    seq += 1;
    const entry = {
      label: "#" + seq,
      chatKey,
      toolName: toolNameOf(req),
      signal: req?.signal ?? null,
      createdAt: now(),
      timer: null,
      onAbort: null,
      settled: false,
      resolve: null
    };
    counters.asked += 1;
    // 先登记再发问：用户可能秒回，登记晚一步就会被当成普通消息
    const decision = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    pending.set(chatKey, entry);

    entry.timer = setTimeout(() => {
      counters.timeouts += 1;
      // 超时必须是 rejected 而不是 cancelled：cancelled 的模型侧文案是中性的"被取消"，
      // 模型往往会立刻重试同一个操作，形成"审批-超时-重试"的死循环；
      // rejected 的文案是"保持拒绝并停下来解释"，正是我们要的行为。
      settle(entry, "rejected", { notify: true, text: entry.label + " 等待超时，按拒绝处理。" });
    }, timeoutMs);
    entry.timer.unref?.();

    if (entry.signal && typeof entry.signal.addEventListener === "function") {
      entry.onAbort = () => settle(entry, "cancelled");
      try {
        entry.signal.addEventListener("abort", entry.onAbort, { once: true });
      } catch {
        entry.onAbort = null;
      }
    }

    sendText(chatKey, askTextOf(entry, req, timeoutMs));
    diag("info", "审批请求已转发到 IM", { id: entry.label, toolName: entry.toolName, chatKey, timeoutMs });
    return decision;
  }

  /** 命中返回 true：调用方据此知道这条消息是"审批答复"，不能再当新任务派下去。 */
  function handleReply({ chatKey, text } = {}) {
    const key = typeof chatKey === "string" ? chatKey : "";
    if (key === "") return false;
    const entry = pending.get(key);
    // 没有待审批就是普通消息：正常任务照旧
    if (!entry) return false;
    const outcome = classifyApprovalReply(text);
    // 认不出来的回复也不要吞：用户可能就是在跟模型说话，交回 pipeline
    if (outcome === null) return false;
    settle(entry, outcome, { notify: true, text: replyTextOf(outcome, entry) });
    diag("info", "用户在 IM 里回答了审批", { id: entry.label, outcome, chatKey: key });
    return true;
  }

  function own(agent, meta = null) {
    if (!agent || (typeof agent !== "object" && typeof agent !== "function")) return false;
    const chatKey = typeof meta === "string" ? meta : typeof meta?.chatKey === "string" ? meta.chatKey : "";
    owned.set(agent, { chatKey });
    // 记下最近活跃的机器人会话：scope=all 时，别的会话的审批就发到这里
    if (typeof chatKey === "string" && chatKey !== "") lastActiveChatKey = chatKey;
    return true;
  }

  function release(agent) {
    if (!agent || (typeof agent !== "object" && typeof agent !== "function")) return false;
    return owned.delete(agent);
  }

  function attach() {
    if (attached) return { ok: true, attached: true };
    if (!enabled) {
      diag("info", "approval.enabled=false，不注册 approval/request 监听");
      return { ok: false, error: "approval.disabled" };
    }
    if (!ctx || typeof ctx.on !== "function") {
      lastError = "当前上下文没有 ctx.on，审批桥未启用";
      diag("warn", lastError);
      return { ok: false, error: lastError };
    }
    listener = (req, next) => handleRequest(req, next);
    try {
      // prepend:true 是硬要求：不插队就会被浏览器审批面板先认领，等的是页面点击而不是 QQ 回复
      off = ctx.on("approval/request", listener, { prepend: true });
    } catch (error) {
      lastError = "注册 approval/request 监听失败：" + errorText(error);
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
    diag("info", "审批桥已挂上 approval/request（prepend）", { timeoutMs });
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
      else if (current && ctx && typeof ctx.off === "function") ctx.off("approval/request", current);
    } catch (error) {
      diag("debug", "移除 approval/request 监听失败", { error: errorText(error) });
    }
    off = null;
    // 卸载时把还挂着的审批按取消收尾：让卡住的工具调用立刻返回，不必等 5 分钟超时
    for (const entry of Array.from(pending.values())) settle(entry, "cancelled");
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
        toolName: entry.toolName,
        ageMs: Math.max(0, now() - entry.createdAt)
      })),
      counters: { ...counters },
      lastError
    };
  }

  return { attach, detach, handleReply, own, release, pendingCount, status };
}
