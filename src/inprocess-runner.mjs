import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { textOfMessage } from "./sdk-runner.mjs";

const DEFAULT_TIMEOUT_MS = 300000;
// whenIdle 与"刚排进队的 prompt"之间有竞态：唤醒还没被循环消费时它会立刻返回。
// 见到"一条新事件都没有"就隔一小会儿再问一次，避免把空结果当成答案。
const IDLE_RECHECK_TIMES = 3;
const IDLE_RECHECK_MS = 25;

function errorText(error) {
  return error && error.message ? String(error.message) : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 进程内 runner：不 spawn 任何子进程，直接用 DSH 主进程的 agents 服务建一个 Agent 干活。
 * 好处是审批请求本身就发生在本进程的事件总线上，可以转发到 IM（见 approval-bridge）。
 * 代价是它依赖 DSH 内部服务名（agents / agentDefaultModel / approval / sessions），
 * 所以缺服务时只报 not_configured，绝不抛。
 */
/**
 * 尽力拿到 DSH 内部的 installModelSelection：GUI 建会话时（session-controller）会先装模型选择
 * 再挂预设，缺了这一步，模型请求里可能只剩"延迟加载"的工具，服务端会直接拒
 * （"at least one tool must have defer_loading=false"）。拿不到就跳过，不影响其余功能。
 */
async function loadModelSelectionInstaller(logger) {
  try {
    const anchor = process.argv[1];
    if (typeof anchor !== "string" || anchor === "") return null;
    const requireFromCli = createRequire(anchor);
    const mod = await import(pathToFileURL(requireFromCli.resolve("@deepseek-ai/dsh-agent")).href);
    return typeof mod.installModelSelection === "function" ? mod.installModelSelection : null;
  } catch (error) {
    try { logger?.warn?.("拿不到 installModelSelection（不影响启动，但工具集可能不完整）", { error: String(error?.message ?? error).slice(0, 200) }); } catch {}
    return null;
  }
}

/**
 * 预设（如 liangshen）会在首轮工具调用之后把 wire 呈现从 native 切到 PTC。
 * 切换后基线 header 变了，新工具会被当成"新增"并统一标记为 deferLoading:true，
 * 而 addition-only 路由会把旧工具全部剔除 —— 请求里只剩延迟加载的工具，服务端 400。
 * 修法：切换发生后，下一轮让 agent 开启一条新的声明序列（基线重置为当前工具集）。
 * 依据：dsh-agent-loop 的 agent/pre-step 决策支持 startsRequestSeries，dsh-goal-round-driver 就是这么用的。
 */
export function installSeriesReset(agentCtx, logger = null) {
  if (!agentCtx || typeof agentCtx.on !== "function") return false;
  let pending = false;
  try {
    agentCtx.on("tools/presentation-changed", () => {
      pending = true;
    });
    agentCtx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      if (!pending) return decision;
      pending = false;
      if (!decision || decision.kind !== "enter") return decision;
      return { ...decision, startsRequestSeries: true };
    });
    return true;
  } catch (error) {
    try { logger?.warn?.("注册呈现切换自愈失败（不影响启动）", { error: String(error?.message ?? error).slice(0, 200) }); } catch {}
    return false;
  }
}

export function createInProcessRunner({ ctx = null, config = null, logger = null, bridge = null, now = () => Date.now() } = {}) {
  const dsh = config?.dsh ?? {};
  // sessionId -> { agent, dispose, chatKey, ... }：同一个会话复用同一个 handle，天然续接上下文
  const handles = new Map();
  let selectionInstallerPromise = null;
  const installerOf = () => (selectionInstallerPromise ??= loadModelSelectionInstaller(logger));
  const state = { busy: false, lastError: null, created: 0, runs: 0, policyWarned: false };
  let chain = Promise.resolve();
  let sessionSeq = 0;
  let stopped = false;

  const diag = (level, message, extra) => {
    try {
      if (logger && typeof logger[level] === "function") logger[level](message, extra);
    } catch {
      // 日志后端坏掉不能影响一轮调用
    }
  };

  /** ctx.get 对未注册的服务返回 undefined，但服务解析过程本身可能抛，统一吞成 undefined。 */
  function service(name) {
    try {
      if (ctx && typeof ctx.get === "function") return ctx.get(name);
    } catch {
      // 服务尚未注册时 ctx.get 可能抛
    }
    return undefined;
  }

  function presetOf() {
    const wanted = dsh.agentPreset;
    return typeof wanted === "string" ? wanted.trim() : "";
  }

  function cwdOf() {
    return typeof dsh.cwd === "string" && dsh.cwd !== "" ? dsh.cwd : "";
  }

  /**
   * danger-full-access 时 approval 策略是 never：DSH 在派发瀑布之前就判掉，
   * 监听器一个请求都收不到。这里必须告警一次，否则用户会以为"审批没弹"是桥坏了。
   */
  function checkPolicyOnce(agent) {
    if (state.policyWarned) return;
    const approval = service("approval");
    let policy = null;
    try {
      if (approval && typeof approval.effectivePolicy === "function") policy = approval.effectivePolicy(agent?.session);
    } catch (error) {
      policy = null;
      diag("debug", "读取 approval.effectivePolicy 失败", { error: errorText(error) });
    }
    if (policy === "ask") return;
    state.policyWarned = true;
    diag("warn", "inprocess 审批转发不会生效：当前 approval 策略不是 ask，DSH 会直接判拒绝而不发审批请求", {
      policy: policy === null || policy === undefined ? "unknown" : policy
    });
  }

  function agentOptionsOf() {
    const models = service("agentDefaultModel");
    let selection = null;
    try {
      if (models && typeof models.currentSelection === "function") selection = models.currentSelection() ?? {};
    } catch (error) {
      diag("debug", "读取 agentDefaultModel.currentSelection 失败", { error: errorText(error) });
    }
    const options = {};
    // 只写有值的字段：显式传 undefined 会被适配器当成"指定了一个空路由"
    if (selection && typeof selection.provider === "string" && selection.provider !== "") options.provider = selection.provider;
    if (selection && typeof selection.model === "string" && selection.model !== "") options.model = selection.model;
    if (selection && typeof selection.reasoningEffort === "string" && selection.reasoningEffort !== "") {
      options.reasoningEffort = selection.reasoningEffort;
    }
    return options;
  }

  /**
   * GUI 的"工作区"分组不是按 cwd 自动归类的，而是一张显式成员表（workspace.json 的 sessionIds）。
   * 我们自建的会话不在表里，于是永远显示在"未分组"。这里把新会话登记进 cwd 对应的工作区。
   * 找不到就建一个（path 必须是已存在的目录，否则 registry 会拒）。
   */
  async function attachToWorkspace(sessionId) {
    const registry = service("workspaceRegistry");
    if (!registry || typeof registry.resolveByPath !== "function") return;
    const cwd = cwdOf();
    if (cwd === "") return;
    try {
      let workspace = await registry.resolveByPath(cwd);
      if (!workspace && typeof registry.create === "function") {
        workspace = await registry.create(cwd);
      }
      if (workspace && typeof workspace.attachSession === "function") {
        await workspace.attachSession(sessionId);
        diag("info", "会话已登记到工作区", { sessionId, workspace: workspace.path ?? cwd });
      }
    } catch (error) {
      diag("warn", "登记到工作区失败（不影响本次回答）", { sessionId, error: errorText(error).slice(0, 200) });
    }
  }

  async function openHandle(sessionId, chatKey, options0 = {}) {
    const agents = service("agents");
    const models = service("agentDefaultModel");
    // 服务缺失只可能是"这次装在了没有这些服务的 profile 里"，用 not_configured 让人去查配置
    if (!agents || typeof agents.create !== "function") return { error: "not_configured" };
    if (!models || typeof models.currentSelection !== "function") return { error: "not_configured" };

    const agentOptions = agentOptionsOf();
    const cwd = cwdOf();
    // 预设决定人格与工具集：web profile 里 selectedDefault 是 liangshen，不显式 mount 的话
    // 进程内 agent 只能拿到基座作用域的工具，和 GUI 里同名的会话体验会不一致
    const presets = service("agentPresets");
    const wantedPreset = options0.skipPreset === true ? "" : presetOf();
    let presetId = "";
    if (presets && typeof presets.resolve === "function" && wantedPreset !== "") {
      try {
        presetId = String((await presets.resolve(wantedPreset))?.id ?? "");
      } catch (error) {
        diag("warn", "解析 agentPreset 失败，退回不挂预设", { preset: wantedPreset, error: errorText(error) });
        presetId = "";
      }
    }
    // 会话头里的 cwd 必须真的存在且是绝对路径：PTC 的 win_bash 之类工具要求
    // "calling session with a working directory"，缺了它连 echo 都跑不起来
    const meta = {};
    if (cwd !== "") meta.cwd = cwd;
    if (presetId !== "") meta.agentPreset = presetId;
    const options = {
      sessionId,
      ...(Object.keys(meta).length === 0 ? {} : { meta }),
      agentOptions,
      // setup 只做组合、不驱动 agent：真正的驱动在 runTurn 里
      setup: async (agentCtx) => {
        // 与 web session-controller 同样的顺序：先装模型选择，再挂预设。
        // 缺前一步时，模型请求里可能只剩延迟加载的工具，服务端会以
        // "at least one tool must have defer_loading=false" 拒绝。
        const installer = await installerOf();
        if (installer !== null) {
          try {
            installer(agentCtx, { current: agentOptions, assembled: undefined });
          } catch (error) {
            diag("warn", "安装模型选择失败", { error: errorText(error) });
          }
        }
        if (presetId !== "" && presets && typeof presets.mount === "function") {
          await presets.mount(agentCtx, presetId);
        }
        installSeriesReset(agentCtx, logger);
      }
    };

    let handle;
    try {
      handle = await agents.create(options);
    } catch (error) {
      // DSH 重启后 sessions.json 里还留着上一轮的 sessionId，create 会以"已存在"拒绝：
      // 只在这种错误上退回 resume 接上历史，其它错误原样上抛（别用第二次尝试掩盖真原因）
      if (!/already|exist|duplicate|opening/i.test(errorText(error)) || typeof agents.resume !== "function") throw error;
      diag("debug", "agents.create 被拒，改用 agents.resume 接上历史会话", { sessionId, error: errorText(error) });
      handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup: options.setup });
    }
    if (!handle || !handle.agent) throw new Error("agents.create 没有返回 agent");

    const record = {
      sessionId,
      cwd: cwd === "" ? null : cwd,
      preset: presetId === "" ? null : presetId,
      provider: agentOptions?.provider ?? null,
      model: agentOptions?.model ?? null,
      agent: handle.agent,
      dispose: typeof handle.dispose === "function" ? handle.dispose.bind(handle) : null,
      chatKey: typeof chatKey === "string" ? chatKey : "",
      createdAt: now()
    };
    handles.set(sessionId, record);
    // 新建会话后登记到 cwd 对应的工作区（resume 时 handles 里已有记录，不会重复登记）
    void attachToWorkspace(sessionId);
    state.created += 1;
    // 登记给审批桥：只有登记过的 agent，桥才会把它的审批请求转发到 IM
    if (bridge && typeof bridge.own === "function") {
      try {
        bridge.own(record.agent, { chatKey: record.chatKey });
      } catch (error) {
        diag("warn", "登记 agent 到审批桥失败", { sessionId, error: errorText(error) });
      }
    }
    checkPolicyOnce(record.agent);
    diag("info", "进程内 agent 配置", {
      sessionId: record.sessionId,
      cwd: record.cwd ?? null,
      preset: record.preset ?? null,
      provider: record.provider ?? null,
      model: record.model ?? null
    });
    diag("info", "进程内建了一个 Agent", { sessionId, chatKey: record.chatKey || null, created: state.created });
    return { record };
  }

  async function ensureHandle(sessionId, chatKey) {
    const existing = handles.get(sessionId);
    if (existing) {
      // 复用同一个 handle 比 resume 更强：上下文天然续接，也不必每轮重建
      if (existing.chatKey === "" && typeof chatKey === "string" && chatKey !== "") {
        existing.chatKey = chatKey;
        if (bridge && typeof bridge.own === "function") {
          try {
            bridge.own(existing.agent, { chatKey });
          } catch {
            // 补登记失败不影响这一轮；真出审批时桥会委托给别人
          }
        }
      }
      return { record: existing };
    }
    return openHandle(sessionId, chatKey);
  }

  /** 只扫"本轮窗口"里的事件：startSeq 之前的是历史，之后混进来的才是这次回答。 */
  function collectTurn(session, startSeq) {
    const texts = [];
    let endKind = null;
    let endError = null;
    const total = typeof session?.seq === "number" ? session.seq : startSeq;
    for (let seq = startSeq; seq < total; seq += 1) {
      let event = null;
      try {
        event = typeof session?.eventAt === "function" ? session.eventAt(seq) : null;
      } catch {
        event = null;
      }
      if (!event) continue;
      if (event.type === "assistant/message") {
        // 一步一条 assistant/message：全都留着，最后一条非空的才是这一轮的回答
        const text = textOfMessage(event.data?.message);
        if (text !== "") texts.push(text);
        continue;
      }
      if (event.type === "turn/end") {
        const reason = event.data?.reason ?? {};
        endKind = typeof reason.kind === "string" ? reason.kind : "unknown";
        if (typeof reason.error?.message === "string") endError = reason.error.message;
        else if (typeof reason.reason?.reason === "string") endError = reason.reason.reason;
      }
    }
    return { texts, endKind, endError };
  }

  /** 驱动一轮：followup 之后等 whenIdle，并且用定时器保证卡住的回合不会把整个 runner 拖死。 */
  async function runTurn(record, prompt, budget) {
    const agent = record.agent;
    const session = agent?.session ?? null;
    const startSeq = typeof session?.seq === "number" ? session.seq : 0;
    // 手写消息对象即可：不用 createUserMessage，少一条对内部构造器的依赖
    const message = { id: randomUUID(), role: "user", content: [{ type: "text", text: prompt }], source: { kind: "user" } };

    let timer = null;
    let timedOut = false;
    try {
      const work = (async () => {
        agent.followup(message);
        await agent.whenIdle();
        for (let i = 0; i < IDLE_RECHECK_TIMES; i += 1) {
          const seqNow = typeof session?.seq === "number" ? session.seq : startSeq;
          if (seqNow !== startSeq) return;
          await delay(IDLE_RECHECK_MS);
          await agent.whenIdle();
        }
      })();
      const guard = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, Math.max(1, budget));
        timer.unref?.();
      });
      await Promise.race([work, guard]);
      return { startSeq, timedOut };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function dropHandle(sessionId, { cancel = false } = {}) {
    const record = handles.get(sessionId);
    if (!record) return false;
    handles.delete(sessionId);
    if (bridge && typeof bridge.release === "function") {
      try {
        bridge.release(record.agent);
      } catch {
        // release 失败只会让 WeakMap 多留一个键，随 agent 一起被回收
      }
    }
    if (cancel && typeof record.agent?.cancel === "function") {
      try {
        record.agent.cancel();
      } catch (error) {
        diag("debug", "取消卡住的回合失败", { sessionId, error: errorText(error) });
      }
    }
    try {
      if (record.dispose) await record.dispose();
    } catch (error) {
      diag("warn", "释放 agent 失败", { sessionId, error: errorText(error) });
    }
    return true;
  }

  async function execute({ prompt = "", sessionId = null, timeoutMs = null, chatKey = null } = {}) {
    const startedAt = now();
    const givenId = sessionId === null || sessionId === undefined || String(sessionId) === "" ? null : String(sessionId);
    let sid = givenId;
    if (sid === null) {
      // 调用方没给 id（首条消息）：自己发一个，并随 result.sessionId 交回去由 sessions.json 落盘
      sessionSeq += 1;
      // 用 DSH 自己的 id 约定（session-<uuid>）：自造前缀撞过内部对会话 id 的假设
      sid = "session-" + randomUUID();
    }
    const budget =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : Number.isFinite(dsh.timeoutMs) && dsh.timeoutMs > 0
          ? dsh.timeoutMs
          : DEFAULT_TIMEOUT_MS;

    const finish = (reason, { text = "", echoId = sid, extra = {} } = {}) => {
      const result = { ok: reason === "ok", text, sessionId: echoId, reason, durationMs: now() - startedAt, ...extra };
      if (result.ok) diag("debug", "inprocess 调用成功", { durationMs: result.durationMs });
      else
        diag("warn", "inprocess 调用失败", {
          reason,
          turnEndKind: extra.turnEndKind ?? null,
          turnError: typeof extra.turnError === "string" ? extra.turnError.slice(0, 300) : null,
          error: typeof extra.error === "string" ? extra.error.slice(0, 300) : null
        });
      return result;
    };

    if (stopped) return finish("runner_error", { extra: { error: "runner 已停止" } });
    if (!service("agents")) return finish("not_configured", { echoId: givenId });

    let retriedWithoutPreset = false;
    state.busy = true;
    state.runs += 1;
    try {
      let opened;
      try {
        opened = await ensureHandle(sid, chatKey);
      } catch (error) {
        state.lastError = errorText(error);
        return finish("runner_error", { extra: { error: state.lastError } });
      }
      if (opened.error) return finish(opened.error, { echoId: givenId });
      const record = opened.record;

      let turn;
      try {
        turn = await runTurn(record, prompt, budget);
      } catch (error) {
        state.lastError = errorText(error);
        return finish("runner_error", { extra: { error: state.lastError } });
      }
      if (turn.timedOut) {
        // 卡住的这一轮必须先掐掉：它后面吐的事件会串进下一轮的回答里
        await dropHandle(sid, { cancel: true });
        return finish("timeout");
      }

      const { texts, endKind, endError } = collectTurn(record.agent?.session, turn.startSeq);
      // 预设可能只提供"延迟加载"的工具，模型服务端会拒绝整次请求；这时去掉预设重建会话再试一次，
      // 让基座工具（默认非延迟）顶上来——比把整条链路判死更有用（只重试一次）
      if (record.preset !== null && !retriedWithoutPreset && /defer_loading|deferred/i.test(String(endError ?? ""))) {
        retriedWithoutPreset = true;
        diag("warn", "工具集全为延迟加载，已去掉预设重试一次", { sessionId: sid, preset: record.preset, turnError: String(endError).slice(0, 160) });
        await dropHandle(sid, { cancel: true });
        const retryOpened = await ensureHandle(sid, chatKey, { skipPreset: true });
        if (retryOpened && retryOpened.record) {
          const retryTurn = await runTurn(retryOpened.record, prompt, budget);
          if (!retryTurn.timedOut) {
            const again = collectTurn(retryOpened.record.agent?.session, retryTurn.startSeq);
            const retryText = again.texts.length > 0 ? again.texts[again.texts.length - 1] : "";
            if (typeof again.endError === "string" && again.endError !== "") {
              return finish("model_error", { text: retryText, extra: { turnEndKind: again.endKind, turnError: again.endError, withoutPreset: true } });
            }
            return finish(retryText === "" ? "no_final" : "ok", { text: retryText, extra: { withoutPreset: true } });
          }
        }
      }

      const sessionService = service("sessions");
      if (sessionService && typeof sessionService.flush === "function") {
        try {
          await sessionService.flush(record.agent.session);
        } catch (error) {
          diag("debug", "会话落盘失败（不影响本次回答）", { sessionId: sid, error: errorText(error) });
        }
      }

      const text = texts.length > 0 ? texts[texts.length - 1] : "";
      if (typeof endError === "string" && endError !== "") {
        return finish("model_error", { text, extra: { turnEndKind: endKind, turnError: endError } });
      }
      // endKind 为空表示这批事件里没有 turn/end（不同 DSH 版本的事件粒度不同），按正常完成处理
      if (endKind === null || endKind === "completed") {
        // 活着但没吐出文字：和 headless 的 no_final 对齐，别报成成功
        return finish(text === "" ? "no_final" : "ok", { text });
      }
      return finish("model_error", { text, extra: { turnEndKind: endKind } });
    } finally {
      state.busy = false;
    }
  }

  function run(options = {}) {
    // 一个 agent 同时只能跑一轮：并发 followup 会把不同会话的步交错，所以内部排队
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
    stopped = true;
    const ids = Array.from(handles.keys());
    for (const id of ids) await dropHandle(id);
    state.busy = false;
    state.lastError = null;
    return status();
  }

  function status() {
    return {
      runner: "inprocess",
      state: state.busy ? "running" : handles.size > 0 ? "ready" : "idle",
      sessions: handles.size,
      created: state.created,
      runs: state.runs,
      policyWarned: state.policyWarned,
      lastError: state.lastError
    };
  }

  return { run, stop, status };
}
