import { spawn as nodeSpawn } from "node:child_process";

const STDERR_TAIL_CHARS = 2000;

/**
 * 调外部 ASR 命令把语音文件转成文本。
 * 命令模板里的 {file} 会被替换成文件路径；模板没写 {file} 时把路径补在末尾。
 */
export async function transcribe({ config, filePath, logger = null, spawnImpl = nodeSpawn } = {}) {
  const asr = config?.asr ?? {};
  const command = typeof asr.command === "string" ? asr.command.trim() : "";
  if (command === "") return { ok: false, text: "", reason: "not_configured" };
  if (!filePath) return { ok: false, text: "", reason: "missing_file" };

  const timeoutMs = Number.isFinite(asr.timeoutMs) && asr.timeoutMs > 0 ? asr.timeoutMs : 60000;
  const template = Array.isArray(asr.args) ? asr.args.map((item) => String(item)) : [];
  const args = template.map((item) => item.replaceAll("{file}", filePath));
  if (!template.some((item) => item.includes("{file}"))) args.push(filePath);

  return await new Promise((resolve) => {
    let child = null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      logger?.warn?.("asr 启动失败", { error: String(error?.message ?? error) });
      finish({ ok: false, text: "", reason: "spawn_error" });
      return;
    }
    if (!child) {
      finish({ ok: false, text: "", reason: "spawn_error" });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 进程可能已退出 */
      }
      finish({ ok: false, text: "", reason: "timeout" });
    }, timeoutMs);

    child.once("error", (error) => {
      logger?.warn?.("asr 启动失败", { error: String(error?.message ?? error) });
      finish({ ok: false, text: "", reason: "spawn_error" });
    });

    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });

    child.once("close", (code) => {
      if (typeof code === "number" && code !== 0) {
        logger?.warn?.("asr 退出码非零", { code, stderr: stderr.slice(-300) });
        finish({ ok: false, text: "", reason: `exit_${code}` });
        return;
      }
      const text = stdout.trim();
      if (text === "") {
        finish({ ok: false, text: "", reason: "empty" });
        return;
      }
      finish({ ok: true, text, reason: "ok" });
    });
  });
}
