import { exec } from "node:child_process";
import { promisify } from "node:util";

const OLLAMA_HEALTH_TIMEOUT_MS = Number.parseInt(process.env.OLLAMA_HEALTH_TIMEOUT_MS || "", 10) || 1800;
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_AUTO_HEAL_ENABLED = process.env.OLLAMA_AUTO_HEAL === "true";
const OLLAMA_AUTO_HEAL_COOLDOWN_MS =
  Number.parseInt(process.env.OLLAMA_AUTO_HEAL_COOLDOWN_MS || "", 10) || 180_000;
const OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS =
  Number.parseInt(process.env.OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS || "", 10) || 15_000;
const OLLAMA_AUTO_HEAL_VERIFY_TIMEOUT_MS =
  Number.parseInt(process.env.OLLAMA_AUTO_HEAL_VERIFY_TIMEOUT_MS || "", 10) || 25_000;
const OLLAMA_QUARANTINE_MS = Number.parseInt(process.env.OLLAMA_QUARANTINE_MS || "", 10) || 10 * 60_000;

const execAsync = promisify(exec);
let ollamaAutoHealUntil = 0;
const modelQuarantineUntil = new Map<string, number>();

type OllamaHealthResult = { ok: true } | { ok: false; error: string };
type OllamaPsResponse = {
  models?: Array<{
    name?: string;
    until?: string;
  }>;
};
type EngineHealthResult = { ok: true } | { ok: false; error: string; stoppingModel?: string };

export function isModelLoadFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const maybe = error as { message?: string; responseBody?: string };
  const message = (maybe.message || "").toLowerCase();
  const responseBody = (maybe.responseBody || "").toLowerCase();
  return (
    message.includes("model failed to load") ||
    responseBody.includes("model failed to load") ||
    message.includes("resource limitations") ||
    responseBody.includes("resource limitations")
  );
}

export function isModelQuarantined(model: string): boolean {
  const until = modelQuarantineUntil.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    modelQuarantineUntil.delete(model);
    return false;
  }
  return true;
}

function quarantineModel(model: string): void {
  modelQuarantineUntil.set(model, Date.now() + OLLAMA_QUARANTINE_MS);
}

async function probeEngineHealthy(): Promise<EngineHealthResult> {
  try {
    const psResponse = await fetch(`${OLLAMA_HOST}/api/ps`, {
      cache: "no-store",
      signal: AbortSignal.timeout(OLLAMA_HEALTH_TIMEOUT_MS),
    });
    if (!psResponse.ok) {
      return { ok: false, error: `Ollama 引擎状态不可用（${psResponse.status}）。` };
    }
    const data = (await psResponse.json()) as OllamaPsResponse;
    const models = data.models || [];
    const stopping = models.find((m) => (m.until || "").toLowerCase().includes("stopping"));
    if (stopping) {
      return {
        ok: false,
        error: `Ollama 引擎正在停止模型（${stopping.name || "unknown"}）。`,
        stoppingModel: stopping.name,
      };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Ollama 引擎探测失败（${message}）。` };
  }
}

async function probeModelReady(activeModel: string): Promise<OllamaHealthResult> {
  try {
    const tagsResponse = await fetch(`${OLLAMA_HOST}/api/tags`, {
      cache: "no-store",
      signal: AbortSignal.timeout(OLLAMA_HEALTH_TIMEOUT_MS),
    });
    if (!tagsResponse.ok) {
      return { ok: false, error: `Ollama 模型列表不可用（${tagsResponse.status}）。` };
    }
    const tagsData = (await tagsResponse.json()) as { models?: Array<{ name?: string }> };
    const names = new Set((tagsData.models || []).map((item) => item.name).filter(Boolean));
    if (!names.has(activeModel)) {
      return { ok: false, error: `模型 ${activeModel} 不在 Ollama 列表中。` };
    }

    const showResponse = await fetch(`${OLLAMA_HOST}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: activeModel }),
      signal: AbortSignal.timeout(OLLAMA_HEALTH_TIMEOUT_MS),
    });
    if (!showResponse.ok) {
      const details = await showResponse.text();
      return { ok: false, error: `模型 ${activeModel} 当前不可用：${details || showResponse.status}` };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `无法连接 Ollama（${message}）。` };
  }
}

function isRecoverableOllamaError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("无法连接 ollama") ||
    lower.includes("headers timeout") ||
    lower.includes("当前不可用") ||
    lower.includes("stopping") ||
    lower.includes("connection")
  );
}

async function restartOllamaProcess(): Promise<void> {
  if (process.platform === "win32") {
    const cmd = process.env.ComSpec || "cmd.exe";
    await execAsync(`${cmd} /d /s /c "taskkill /IM ollama.exe /F"`, {
      timeout: OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS,
    }).catch(() => undefined);
    await execAsync(`${cmd} /d /s /c "taskkill /IM \"ollama app.exe\" /F"`, {
      timeout: OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS,
    }).catch(() => undefined);
    await execAsync(`${cmd} /d /s /c "set OLLAMA_MODELS=&& start \"\" ollama serve"`, {
      timeout: OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS,
    });
    return;
  }
  await execAsync(`pkill -f "ollama"`, {
    timeout: OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS,
  }).catch(() => undefined);
  await execAsync(`nohup ollama serve >/tmp/ollama-autorestart.log 2>&1 &`, {
    timeout: OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS,
  });
}

async function verifyModelAfterRestart(activeModel: string): Promise<OllamaHealthResult> {
  const startedAt = Date.now();
  let lastError = "Ollama 重启后模型仍不可用。";
  while (Date.now() - startedAt < OLLAMA_AUTO_HEAL_VERIFY_TIMEOUT_MS) {
    const engine = await probeEngineHealthy();
    if (!engine.ok) {
      lastError = engine.error;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      continue;
    }
    const model = await probeModelReady(activeModel);
    if (model.ok) return model;
    lastError = model.error;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return { ok: false, error: `自动自愈后校验超时：${lastError}` };
}

async function tryAutoHealOllama(
  activeModel: string,
  options?: { force?: boolean; reason?: string },
): Promise<OllamaHealthResult> {
  if (!OLLAMA_AUTO_HEAL_ENABLED) {
    return { ok: false, error: "Ollama 自动自愈未开启。" };
  }
  const now = Date.now();
  const force = options?.force === true;
  if (!force && now < ollamaAutoHealUntil) {
    const left = Math.ceil((ollamaAutoHealUntil - now) / 1000);
    return { ok: false, error: `Ollama 自动自愈冷却中（剩余 ${left}s）。` };
  }

  ollamaAutoHealUntil = now + (force ? 15_000 : OLLAMA_AUTO_HEAL_COOLDOWN_MS);
  try {
    if (options?.reason) {
      console.warn(`chat route: ollama auto-heal triggered (${options.reason}) for model ${activeModel}`);
    }
    await restartOllamaProcess();
    return await verifyModelAfterRestart(activeModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `自动自愈重启失败：${message}` };
  }
}

export async function ensureModelReady(activeModel: string): Promise<OllamaHealthResult> {
  if (isModelQuarantined(activeModel)) {
    return { ok: false, error: `模型 ${activeModel} 已被临时隔离（近期触发 Ollama Stopping）。` };
  }
  const engine = await probeEngineHealthy();
  if (!engine.ok) {
    if (engine.stoppingModel) {
      quarantineModel(engine.stoppingModel);
    }
    if (!isRecoverableOllamaError(engine.error)) return engine;
    const healedEngine = await tryAutoHealOllama(activeModel, {
      force: Boolean(engine.stoppingModel),
      reason: engine.stoppingModel ? `engine stopping (${engine.stoppingModel})` : "engine unhealthy",
    });
    if (healedEngine.ok) {
      console.warn(`chat route: ollama auto-heal (engine) succeeded for model ${activeModel}`);
      return healedEngine;
    }
    if (engine.stoppingModel && engine.stoppingModel === activeModel) {
      quarantineModel(activeModel);
      console.warn(`chat route: quarantined model due to stopping: ${activeModel}`);
    }
    return { ok: false, error: `${engine.error}；${healedEngine.error}` };
  }

  const first = await probeModelReady(activeModel);
  if (first.ok) return first;
  if (!isRecoverableOllamaError(first.error)) return first;

  const healed = await tryAutoHealOllama(activeModel);
  if (healed.ok) {
    console.warn(`chat route: ollama auto-heal succeeded for model ${activeModel}`);
    return healed;
  }
  return { ok: false, error: `${first.error}；${healed.error}` };
}

