import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

// stderr 只留尾部：DSH 前半段 stderr 多是启动噪音，排查时真正有用的只有末尾
const STDERR_TAIL_CHARS = 4000;

/**
 * 逐行切分 NDJSON 流。返回已解析的完整行与尚未收尾的残片，
 * 调用方把 rest 拼回下一块 chunk，就能跨块续接半行。
 */
export function parseNdjsonLines(chunkBuffer) {
  const text = Buffer.isBuffer(chunkBuffer) ? chunkBuffer.toString("utf8") : String(chunkBuffer ?? "");
  const parts = text.split("\n");
  const rest = parts.pop() ?? "";
  const events = [];
  for (const part of parts) {
    const line = part.trim();
    if (line === "") continue;
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === "object") events.push(value);
    } catch {
      // --json 流里偶尔混入非 JSON 的提示行；丢掉即可，不能因此中断整次调用
    }
  }
  return { events, rest };
}

/**
 * 跑一次 dsh headless 调用。
 * 任务文本走 stdin：文本里出现单独的 "-" 会被 CLI 当成多个位置参数而判 usage error。
 */
export function runDsh({
  config,
  prompt = "",
  sessionId = null,
  logger = null,
  signal = null,
  spawnImpl = nodeSpawn,
} = {}) {
  const dsh = config?.dsh ?? {};
  const startedAt = Date.now();
  const events = [];

  if (!dsh.binPath) {
    // 没有 binPath 只可能是配置问题；拿空路径去 spawn 会得到难以理解的 ENOENT
    return Promise.resolve({
      ok: false,
      text: "",
      sessionId: sessionId ?? null,
      reason: "not_configured",
      exitCode: null,
      durationMs: 0,
      events,
      stderrTail: "",
      cwd: typeof dsh.cwd === "string" && dsh.cwd !== "" ? dsh.cwd : null,
    });
  }

  const timeoutMs = Number.isFinite(dsh.timeoutMs) && dsh.timeoutMs > 0 ? dsh.timeoutMs : 300000;

  const cwd = typeof dsh.cwd === "string" && dsh.cwd !== "" ? dsh.cwd : null;
  let cwdEnsureError = null;
  if (cwd) {
    // 新用户第一次跑时 <rootDir>/workspace 还不存在，spawn 会直接 ENOENT；
    // 在这里自建，任何调用方（bridge / dry-run / 测试）都不必再操心目录
    try {
      mkdirSync(cwd, { recursive: true });
    } catch (error) {
      cwdEnsureError = error;
    }
  }
  const args = ["--profile", dsh.profile || "im-bridge"];
  // 续接旗标必须排在 --json 之前：启动器只认自己的旗标，其余参数原样下发给 headless app
  if (sessionId) args.push("--session-id", String(sessionId));
  args.push("--json", "-");

  const env = { ...process.env, DSH_PERMISSION_MODE: dsh.permissionMode, ...(dsh.env ?? {}) };
  if (env.DSH_PERMISSION_MODE === undefined) delete env.DSH_PERMISSION_MODE;

  const state = { sessionId: null, finalText: null, sawFinal: false, errorText: null, turnEndKind: null };

  return new Promise((resolve) => {
    let child = null;
    let buffer = "";
    let stderrTail = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    let spawnErrorCode = null;
    let exitCode = null;
    let timer = null;

    const settle = (reason) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          /* 已移除或不支持 removeEventListener，忽略 */
        }
      }
      const result = {
        ok: reason === "ok",
        text: state.finalText ?? "",
        sessionId: state.sessionId ?? (sessionId ?? null),
        reason,
        exitCode,
        durationMs: Date.now() - startedAt,
        events,
        stderrTail,
        cwd,
      };
      if (result.ok) logger?.debug?.("dsh 调用成功", { durationMs: result.durationMs, events: events.length });
      else logger?.warn?.("dsh 调用失败", { reason, exitCode, stderrTail: stderrTail.slice(-500) });
      resolve(result);
    };

    const record = (event) => {
      events.push(event);
      if (event.type === "session") {
        if (typeof event.sessionId === "string" && event.sessionId !== "") state.sessionId = event.sessionId;
      } else if (event.type === "final") {
        state.sawFinal = true;
        state.finalText = typeof event.text === "string" ? event.text : "";
      } else if (event.type === "error") {
        state.errorText = typeof event.message === "string" ? event.message : String(event.message ?? "error");
      } else if (event.type === "status" && event.phase === "turn_end") {
        state.turnEndKind = event.reason?.kind ?? "unknown";
      }
    };

    const flushBuffer = () => {
      if (buffer.trim() === "") {
        buffer = "";
        return;
      }
      const { events: tail } = parseNdjsonLines(`${buffer}\n`);
      buffer = "";
      for (const event of tail) record(event);
    };

    const decide = () => {
      if (spawnError) {
        // spawn 的 ENOENT 有两个来源：可执行文件找不到，或 cwd 不存在。
        // 后者是新用户第一次启动必踩的坑（目录还没建），必须单独分出来，否则错误文案会把人带偏
        const cwdUnusable = cwd !== null && !existsSync(cwd);
        if (spawnErrorCode === "ENOENT" && cwdUnusable) return "cwd_missing";
        if (cwdEnsureError !== null && (spawnErrorCode === "ENOENT" || spawnErrorCode === "ENOTDIR")) {
          return "cwd_missing";
        }
        return "spawn_error";
      }
      if (timedOut) return "timeout";
      if (aborted) return "cancelled";
      if (state.errorText !== null) return "runner_error";
      if (!state.sawFinal) return "no_final";
      if (state.turnEndKind === null) return "no_turn_end";
      // 模型中途失败时仍会写 final（通常是空串），所以必须有 turn_end.completed 才算成功
      if (state.turnEndKind !== "completed") return "model_error";
      if (exitCode !== 0) return "exit_nonzero";
      return "ok";
    };

    const killChild = () => {
      if (!child) return;
      try {
        child.kill();
      } catch {
        /* 进程可能已经退出 */
      }
      if (child.pid && process.platform === "win32") {
        // child.kill 只终止直接子进程；DSH 会再起孙进程，taskkill /T 才收得干净
        try {
          const killer = nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", () => {});
        } catch {
          /* 沙箱或环境不允许 taskkill，child.kill 已经尽力 */
        }
      }
    };

    const onAbort = () => {
      aborted = true;
      killChild();
    };

    try {
      child = spawnImpl(dsh.nodePath || process.execPath, [dsh.binPath, ...args], {
        cwd: cwd ?? undefined,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      spawnError = error?.message ?? String(error);
      spawnErrorCode = error?.code ?? null;
      settle(decide());
      return;
    }

    if (!child) {
      spawnError = "spawn 返回了空值";
      settle("spawn_error");
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killChild();
      // 不等 close：卡死的子进程可能永远不会关闭，等待会把整条串行队列堵死
      settle("timeout");
    }, timeoutMs);

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      spawnError = error?.message ?? String(error);
      spawnErrorCode = error?.code ?? null;
      settle(decide());
    });

    const stdout = child.stdout;
    if (stdout?.on) {
      stdout.setEncoding?.("utf8");
      stdout.on("data", (chunk) => {
        buffer += chunk;
        const { events: parsed, rest } = parseNdjsonLines(buffer);
        buffer = rest;
        for (const event of parsed) record(event);
      });
      stdout.on("end", flushBuffer);
    }

    const stderr = child.stderr;
    if (stderr?.on) {
      stderr.setEncoding?.("utf8");
      stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
      });
    }

    child.once("close", (code) => {
      exitCode = typeof code === "number" ? code : null;
      flushBuffer();
      settle(decide());
    });

    try {
      // 子进程提前退出时写 stdin 会 EPIPE，别让它变成未捕获异常
      child.stdin?.on?.("error", () => {});
      child.stdin?.end?.(prompt ?? "");
    } catch {
      /* stdin 已关闭，close 事件会给出结论 */
    }

    if (signal?.aborted) onAbort();
  });
}
