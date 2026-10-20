import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";

// stderr 只留尾部：SDK 冷启动的噪音堆在前半段，真正能定位问题的在末尾
const STDERR_TAIL_CHARS = 4096;
// 常驻是为了省掉每条消息 4.2s 的冷启动，不是为了永远白占一个 Node 进程
const DEFAULT_IDLE_EXIT_MS = 10 * 60 * 1000;
// 握手实测 ~4.2s，和"一轮 1.1~1.3s"不是一个量级，所以它单独一个超时
const DEFAULT_INIT_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 300000;
// 连败三次才把 spawn_error 交给用户：偶发的文件锁/杀软扫描不该变成一条"调用失败"
const MAX_SPAWN_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 200;
// stop() 等 shutdown 回执的上限：子进程半死时不能把 dispose 拖住
const SHUTDOWN_GRACE_MS = 300;

function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 取一条 assistant/message 里的文字块；非 text 块（思考、工具调用）不进用户可见答案。 */
export function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  let text = "";
  for (const block of blocks) {
    if (block && block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * 常驻 SDK runner：一个 `dsh --profile sdk` 子进程 + 换行分隔 JSON-RPC（stdin/stdout）。
 * 懒启动、一次握手、多轮复用；同一时刻只放一个 run 进通道。
 */
export function createSdkRunner({
  config = null,
  logger = null,
  spawnImpl = null,
  now = () => Date.now(),
  idleExitMs = DEFAULT_IDLE_EXIT_MS,
  initTimeoutMs = DEFAULT_INIT_TIMEOUT_MS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS
} = {}) {
  const dsh = config?.dsh ?? {};
  // 只有走默认 spawn 时才允许顺带 taskkill：注入的假 spawn 意味着"这次不碰真进程"
  const useDefaultSpawn = typeof spawnImpl !== "function";
  const spawn = useDefaultSpawn ? nodeSpawn : spawnImpl;

  const state = {
    child: null,
    generation: 0, // 每次换进程自增，旧进程迟到的事件据此作废
    initialized: false,
    pid: null,
    readyAt: null,
    startedAt: null,
    busy: false,
    dead: false,
    spawnFailures: 0,
    lastError: null,
    stderrTail: ""
  };

  // 本进程内已经出现过的会话 id：决定 prompt 报错后要不要试 session/resume
  const knownSessions = new Set();
  const pending = new Map(); // id -> { resolve, reject, timer }
  let requestId = 0;
  let buffer = "";
  let activeTurn = null;
  let idleTimer = null;
  let chain = Promise.resolve();
  let sessionSeq = 0;

  const diag = (level, message, extra) => {
    try {
      if (logger && typeof logger[level] === "function") logger[level](message, extra);
    } catch {
      // 日志后端坏掉不能影响一次调用
    }
  };

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer() {
    clearIdleTimer();
    if (!state.child) return;
    if (!Number.isFinite(idleExitMs) || idleExitMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (state.busy || !state.child) return;
      diag("info", "SDK 子进程空闲超时，主动退出以释放内存", { idleExitMs });
      // 空闲退场是设计内的收尾，不是崩溃：下次 run 重新拉起
      killChild({ clean: true, source: "idle_exit" });
    }, idleExitMs);
    idleTimer.unref?.();
  }

  function rejectPending(message) {
    for (const [id, entry] of pending) {
      pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      try {
        entry.reject(new Error(message));
      } catch {
        // 已经在别处 settle
      }
    }
  }

  function sendLine(payload) {
    const child = state.child;
    if (!child || !child.stdin || typeof child.stdin.write !== "function") return false;
    try {
      child.stdin.write(JSON.stringify(payload) + "\n");
      return true;
    } catch (error) {
      state.lastError = errorText(error);
      return false;
    }
  }

  function request(method, params, timeoutMs) {
    const id = (requestId += 1);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      // 先登记再写：响应可能是同步到达的（测试里的假子进程就是）
      pending.set(id, entry);
      entry.timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("JSON-RPC 请求超时：" + method));
      }, Math.max(1, timeoutMs));
      if (!sendLine({ jsonrpc: "2.0", id, method, params })) {
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(new Error("写入 sdk 子进程 stdin 失败：" + method));
      }
    });
  }

  function settleTurn(source, errorMessage = null) {
    const turn = activeTurn;
    if (!turn) return;
    activeTurn = null;
    if (turn.timer) clearTimeout(turn.timer);
    turn.resolve({ source, errorMessage });
  }

  function detachChild() {
    const child = state.child;
    state.child = null;
    state.initialized = false;
    state.pid = null;
    state.startedAt = null;
    state.generation += 1; // 旧进程的 stdout/close 回调靠这个作废
    buffer = "";
    return child;
  }

  /** 放弃当前子进程并（尽力）杀干净。clean=true 表示设计内收尾，不算崩溃。 */
  function killChild({ clean = false, source = "stopped", message = null } = {}) {
    const child = state.child;
    if (!child) {
      if (clean) state.dead = false;
      return false;
    }
    state.dead = clean !== true;
    if (message) state.lastError = message;
    // 先让等待中的这一轮结束，否则它会一直等到自己超时
    settleTurn(source, message ?? "sdk 子进程已停止");
    const pid = state.pid;
    detachChild();
    try {
      child.kill?.();
    } catch {
      // 进程可能已经退出
    }
    if (useDefaultSpawn && pid && process.platform === "win32") {
      // child.kill 只结束直接子进程；DSH 还会起孙进程，taskkill /T 才收得干净
      try {
        const killer = nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on?.("error", () => {});
      } catch {
        // 沙箱或环境不允许 taskkill，child.kill 已经尽力
      }
    }
    rejectPending(message ?? "sdk 子进程已停止");
    return true;
  }

  function onChildGone(generation, message) {
    if (generation !== state.generation) return; // 我们自己刚 kill 掉的旧进程
    state.lastError = message;
    diag("warn", "SDK 子进程意外退出，下一次 run 会重新拉起", { error: message, stderrTail: state.stderrTail.slice(-500) });
    killChild({ clean: false, source: "child_gone", message });
  }

  function handleSessionEvent(params) {
    const turn = activeTurn;
    if (!turn || !params) return;
    // 子代理、以及其他会话的事件都不归这一轮，混进来会把上一轮的文字串进答案
    if (params.sessionId !== turn.sessionId) return;
    const event = params.event ?? {};
    const data = event.data ?? {};
    if (event.type === "assistant/message") {
      const text = textOfMessage(data.message);
      // 一步一条 assistant/message：保留每一条，收敛时只取最后一条非空的（对齐 headless 的 final）
      if (text !== "") turn.texts.push(text);
      return;
    }
    if (event.type === "turn/end") {
      const reason = data.reason ?? {};
      turn.endKind = typeof reason.kind === "string" ? reason.kind : "unknown";
      if (reason.kind === "error") {
        turn.endError = typeof reason.error?.message === "string" ? reason.error.message : null;
      } else if (reason.reason && typeof reason.reason.reason === "string") {
        turn.endError = reason.reason.reason;
      }
      settleTurn("event");
    }
  }

  function handleLine(line) {
    const text = line.trim();
    if (text === "") return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // 协议帧之间偶尔混入非 JSON 行（启动提示）；丢掉，不能因此中断整次调用
      return;
    }
    if (message === null || typeof message !== "object") return;
    if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id);
      if (!entry) return; // 超时后迟到的回执
      pending.delete(message.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (message.error) {
        const detail = typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error);
        entry.reject(new Error(detail));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method === "session.event") handleSessionEvent(message.params);
  }

  function spawnChild() {
    const cwd = typeof dsh.cwd === "string" && dsh.cwd !== "" ? dsh.cwd : null;
    if (cwd) {
      // 新用户第一次跑时 <rootDir>/workspace 还不存在，spawn 会直接 ENOENT
      try {
        mkdirSync(cwd, { recursive: true });
      } catch {
        // 建不出来就交给 spawn 报错，别在这里吞掉真正的失败原因
      }
    }
    const args = [dsh.binPath, "--profile", dsh.profile || "im-bridge"];
    const env = { ...process.env, DSH_PERMISSION_MODE: dsh.permissionMode, ...(dsh.env ?? {}) };
    if (env.DSH_PERMISSION_MODE === undefined) delete env.DSH_PERMISSION_MODE;

    const child = spawn(dsh.nodePath || process.execPath, args, {
      cwd: cwd ?? undefined,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    if (!child || typeof child.once !== "function") throw new Error("spawn 返回了空值");

    state.generation += 1;
    const generation = state.generation;
    state.child = child;
    state.pid = child.pid ?? null;
    state.initialized = false;
    state.startedAt = now();
    state.readyAt = null;
    state.dead = false;
    state.stderrTail = "";
    knownSessions.clear();
    buffer = "";

    child.once("error", (error) => onChildGone(generation, "sdk 子进程不可用：" + errorText(error)));
    child.once("close", (code, signal) =>
      onChildGone(generation, "sdk 子进程退出（code=" + String(code) + "，signal=" + String(signal) + "）")
    );

    const stdout = child.stdout;
    if (stdout?.on) {
      stdout.setEncoding?.("utf8");
      stdout.on("data", (chunk) => {
        if (generation !== state.generation) return;
        buffer += chunk;
        const parts = String(buffer).split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) handleLine(part);
      });
    }

    const stderr = child.stderr;
    if (stderr?.on) {
      stderr.setEncoding?.("utf8");
      stderr.on("data", (chunk) => {
        if (generation !== state.generation) return;
        state.stderrTail = (state.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
      });
    }

    return child;
  }

  async function handshake() {
    const startedAt = now();
    const params = {
      cwd: typeof dsh.cwd === "string" && dsh.cwd !== "" ? dsh.cwd : process.cwd(),
      provider: dsh.provider || "deepseek-official",
      model: dsh.model || "deepseek-flash"
    };
    if (typeof dsh.reasoningEffort === "string" && dsh.reasoningEffort !== "") params.reasoningEffort = dsh.reasoningEffort;
    const result = await request("initialize", params, initTimeoutMs);
    state.initialized = true;
    state.readyAt = now();
    diag("info", "SDK 运行时握手完成", {
      durationMs: state.readyAt - startedAt,
      provider: params.provider,
      model: params.model,
      server: result?.serverInfo?.name ?? null
    });
  }

  /** 确保有一个握好手的子进程；连败 MAX_SPAWN_ATTEMPTS 次才放弃。 */
  async function ensureReady() {
    if (state.child && state.initialized) return;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS; attempt += 1) {
      try {
        if (!state.child) spawnChild();
        if (!state.initialized) await handshake();
        state.spawnFailures = 0;
        return;
      } catch (error) {
        lastError = error;
        state.spawnFailures = attempt;
        state.lastError = errorText(error);
        diag("warn", "SDK 子进程启动失败", { attempt, error: state.lastError, stderrTail: state.stderrTail.slice(-500) });
        killChild({ clean: true, source: "spawn_failed" });
        if (attempt < MAX_SPAWN_ATTEMPTS) {
          // 指数退避：冷启动失败常伴随瞬时争用（杀软扫描、文件锁），立刻重试只会连败
          await delay(retryBaseMs * 3 ** (attempt - 1));
        }
      }
    }
    throw lastError ?? new Error("sdk 子进程启动失败");
  }

  async function sendPrompt(sessionId, prompt, timeoutMs) {
    try {
      return await request("session/prompt", { sessionId, contentBlocks: [{ type: "text", text: prompt }] }, timeoutMs);
    } catch (error) {
      // 磁盘上已存在同 id 时会话时，"惰性新建"会被拒（例如子进程重启后想续接）：
      // 只在这种错误上试一次 resume，其余错误原样上抛，不要用第二次请求掩盖真原因
      if (!/already|exist|duplicate|opening/i.test(errorText(error))) throw error;
      diag("debug", "session/prompt 被拒，尝试 session/resume 后重试", { sessionId, error: errorText(error) });
      try {
        await request("session/resume", { sessionId }, initTimeoutMs);
      } catch {
        throw error; // resume 也救不回来：报原始错误，别用二层错误盖住它
      }
      return await request("session/prompt", { sessionId, contentBlocks: [{ type: "text", text: prompt }] }, timeoutMs);
    }
  }

  async function runTurn(sessionId, prompt, timeoutMs) {
    const turn = { sessionId, texts: [], endKind: null, endError: null, timer: null, resolve: null };
    const done = new Promise((resolve) => {
      turn.resolve = resolve;
    });
    activeTurn = turn;
    knownSessions.add(sessionId);

    try {
      await sendPrompt(sessionId, prompt, timeoutMs);
    } catch (error) {
      activeTurn = null;
      throw error;
    }

    // 入队回执到了才开计时：入队本身 9–47ms，真正的耗时在模型那一侧
    turn.timer = setTimeout(() => {
      // 卡死的回合没法从协议层取消，只能杀掉常驻进程；下次 run 重新拉起并重连会话
      settleTurn("timeout");
    }, timeoutMs);

    const outcome = await done;
    if (turn.timer) clearTimeout(turn.timer);
    return { turn, outcome };
  }

  async function execute({ prompt = "", sessionId = null, timeoutMs = null } = {}) {
    const startedAt = now();
    const givenId = sessionId === null || sessionId === undefined || String(sessionId) === "" ? null : String(sessionId);
    let sid = givenId;
    if (sid === null) {
      // 调用方没给 id（首条消息）：自己发一个，并随 result.sessionId 交回去由 sessions.json 落盘
      sessionSeq += 1;
      sid = "sdk-" + now().toString(36) + "-" + sessionSeq;
    }
    const budget =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : Number.isFinite(dsh.timeoutMs) && dsh.timeoutMs > 0
          ? dsh.timeoutMs
          : DEFAULT_TIMEOUT_MS;

    const finish = (reason, { text = "", echoId = sid, extra = {} } = {}) => {
      const result = {
        ok: reason === "ok",
        text,
        sessionId: echoId,
        reason,
        durationMs: now() - startedAt,
        stderrTail: state.stderrTail,
        ...extra
      };
      if (result.ok) diag("debug", "sdk 调用成功", { durationMs: result.durationMs });
      else diag("warn", "sdk 调用失败", { reason, stderrTail: state.stderrTail.slice(-500) });
      return result;
    };

    if (!dsh.binPath) {
      // 没有 binPath 只可能是配置问题；拿空路径去 spawn 只会得到难懂的 ENOENT
      return finish("not_configured", { echoId: givenId });
    }

    clearIdleTimer();
    state.busy = true;
    try {
      try {
        await ensureReady();
      } catch (error) {
        return finish("spawn_error", { extra: { error: errorText(error) } });
      }

      let outcome;
      try {
        outcome = await runTurn(sid, prompt, budget);
      } catch (error) {
        return finish("runner_error", { extra: { error: errorText(error) } });
      }

      const { turn, outcome: settled } = outcome;
      if (settled.source === "timeout") {
        // 超时必须换进程：卡住的那一轮还占着 stdio 通道
        killChild({ clean: false, source: "timeout", message: "单轮超时 " + budget + "ms" });
        return finish("timeout");
      }
      if (settled.source === "child_gone" || settled.source === "spawn_failed") {
        return finish("runner_error", { extra: { error: settled.errorMessage } });
      }
      if (settled.source === "stopped" || settled.source === "idle_exit") {
        return finish("runner_error", { extra: { error: settled.errorMessage } });
      }

      const text = turn.texts.length > 0 ? turn.texts[turn.texts.length - 1] : "";
      if (turn.endKind === "completed") {
        // 活着但没吐出文字：和 headless 的 no_final 对齐，别报成成功
        return finish(text === "" ? "no_final" : "ok", { text });
      }
      // error / aborted / blocked / max-tokens / interrupted 都不算正常完成
      return finish("model_error", { text, extra: { turnEndKind: turn.endKind, turnError: turn.endError } });
    } finally {
      state.busy = false;
      armIdleTimer();
    }
  }

  function run(options = {}) {
    // 一个子进程只有一条 stdio 通道：并发 run 会把不同会话的事件交错，所以内部排队
    const next = chain.then(
      () => execute(options ?? {}),
      () => execute(options ?? {})
    );
    chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async function stop() {
    clearIdleTimer();
    const child = state.child;
    if (child) {
      // 先礼后兵：shutdown 让 SDK 把会话落盘（下次才能续接），再 kill 兜底
      if (state.initialized && !state.busy) {
        sendLine({ jsonrpc: "2.0", id: (requestId += 1), method: "shutdown", params: {} });
        await delay(SHUTDOWN_GRACE_MS);
      }
    }
    killChild({ clean: true, source: "stopped" });
    state.spawnFailures = 0;
    state.lastError = null;
    return status();
  }

  function status() {
    const alive = state.child !== null;
    return {
      runner: "sdk",
      state: state.busy ? "running" : alive ? (state.initialized ? "ready" : "starting") : state.dead ? "dead" : "idle",
      pid: state.pid,
      initialized: state.initialized,
      readyAt: state.readyAt,
      sessions: knownSessions.size,
      spawnFailures: state.spawnFailures,
      lastError: state.lastError,
      stderrTail: state.stderrTail
    };
  }

  return { run, stop, status };
}
