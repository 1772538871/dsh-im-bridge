import { transcribe as defaultTranscribe } from "./asr.mjs";
import { formatForQq } from './format.mjs';
import { buildPrompt } from "./prompt.mjs";

const DEFAULT_ERROR_PREFIX = "[bridge] ";

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
  deps = null,
} = {}) {
  if (typeof runDsh !== "function") throw new Error("createPipeline: runDsh 必填");
  if (typeof serial?.run !== "function") throw new Error("createPipeline: serial 必填");
  if (typeof semaphore?.withPermit !== "function") throw new Error("createPipeline: semaphore 必填");

  const counters = { received: 0, handled: 0, failed: 0, denied: 0, ignored: 0, parseErrors: 0 };
  let depsPromise = null;

  const resolveDeps = () => {
    const injected = deps ?? {};
    const missing = CORE_DEPS.filter((name) => typeof injected[name] !== "function");
    depsPromise ??= (missing.length === 0 ? Promise.resolve({}) : loadDefaultDeps(missing)).then((base) => ({
      transcribe: defaultTranscribe,
      ...base,
      ...injected,
    }));
    return depsPromise;
  };

  const errorPrefix = config?.reply?.errorPrefix ?? DEFAULT_ERROR_PREFIX;

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

  async function deliver(message, text) {
  // 交给 QQ 之前统一压成纯文本版式（模型经常输出 markdown，QQ 不渲染）
  text = formatForQq(text);
    try {
      const resolved = await resolveDeps();
      return await resolved.sendReply({ client, message, text, config, logger });
    } catch (error) {
      logger?.error?.("发送回复失败", { error: String(error?.message ?? error) });
      return { sent: 0, failed: 1 };
    }
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

  async function readSession(key) {
    try {
      const value = await sessions?.get?.(key);
      return typeof value === "string" && value !== "" ? value : null;
    } catch (error) {
      logger?.warn?.("读取会话映射失败", { key, error: String(error?.message ?? error) });
      return null;
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
        // 会话 id 必须在串行体内读：排在后面的消息要用前一条刚落盘的新 id
        const sessionId = await readSession(chatKey);
        const prompt = buildPrompt({ config, message, savedAttachments: saved, voiceTranscript });

        let result;
        try {
          result = await semaphore.withPermit(() => runDsh({ config, prompt, sessionId, logger }));
        } catch (error) {
          counters.failed += 1;
          logger?.error?.("runDsh 抛错", { chatKey, error: String(error?.message ?? error) });
          await deliver(message, `${errorPrefix}调用 DSH 失败，这次没有结果。`);
          return;
        }

        if (result?.ok) {
          if (result.sessionId && result.sessionId !== sessionId) {
            try {
              await sessions?.set?.(chatKey, result.sessionId);
            } catch (error) {
              logger?.warn?.("写会话映射失败", { chatKey, error: String(error?.message ?? error) });
            }
          }
          let text = typeof result.text === "string" ? result.text.trim() : "";
          if (text === "") text = "（DSH 这次没有返回文字内容）";
          if (config?.reply?.showSessionId && result.sessionId) text += `\n[session ${result.sessionId}]`;
          await deliver(message, text);
          counters.handled += 1;
          return;
        }

        counters.failed += 1;
        logger?.warn?.("DSH 调用失败", { chatKey, reason: result?.reason, exitCode: result?.exitCode });
        await deliver(message, `${errorPrefix}${failureText(result?.reason, result)}`);
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

  return { handleEvent, stats: () => ({ ...counters }) };
}
