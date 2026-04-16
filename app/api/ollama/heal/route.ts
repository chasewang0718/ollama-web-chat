import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = (process.env.OLLAMA_FALLBACK_MODEL || process.env.OLLAMA_MODEL || "gemma2:9b").trim();
const HEALTH_TIMEOUT_MS = Number.parseInt(process.env.OLLAMA_HEALTH_TIMEOUT_MS || "", 10) || 1800;
const RESTART_TIMEOUT_MS = Number.parseInt(process.env.OLLAMA_AUTO_HEAL_RESTART_TIMEOUT_MS || "", 10) || 15_000;
const VERIFY_TIMEOUT_MS = Number.parseInt(process.env.OLLAMA_AUTO_HEAL_VERIFY_TIMEOUT_MS || "", 10) || 25_000;

type OllamaPsResponse = {
  models?: Array<{
    name?: string;
    until?: string;
  }>;
};

async function probeStoppingModel(): Promise<string | undefined> {
  const psResponse = await fetch(`${OLLAMA_HOST}/api/ps`, {
    cache: "no-store",
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  if (!psResponse.ok) return undefined;
  const data = (await psResponse.json()) as OllamaPsResponse;
  const models = data.models || [];
  const stopping = models.find((m) => (m.until || "").toLowerCase().includes("stopping"));
  return stopping?.name;
}

async function restartOllamaProcess(): Promise<void> {
  if (process.platform === "win32") {
    const cmd = process.env.ComSpec || "cmd.exe";
    await execAsync(`${cmd} /d /s /c "taskkill /IM ollama.exe /F"`, { timeout: RESTART_TIMEOUT_MS }).catch(
      () => undefined,
    );
    await execAsync(`${cmd} /d /s /c "taskkill /IM \"ollama app.exe\" /F"`, { timeout: RESTART_TIMEOUT_MS }).catch(
      () => undefined,
    );
    await execAsync(`${cmd} /d /s /c "set OLLAMA_MODELS=&& start \"\" ollama serve"`, { timeout: RESTART_TIMEOUT_MS });
    return;
  }
  await execAsync(`pkill -f "ollama"`, { timeout: RESTART_TIMEOUT_MS }).catch(() => undefined);
  await execAsync(`nohup ollama serve >/tmp/ollama-autorestart.log 2>&1 &`, { timeout: RESTART_TIMEOUT_MS });
}

async function verifyModelReady(model: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const startedAt = Date.now();
  let last = "model not ready";
  while (Date.now() - startedAt < VERIFY_TIMEOUT_MS) {
    try {
      const showResponse = await fetch(`${OLLAMA_HOST}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        cache: "no-store",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (showResponse.ok) return { ok: true };
      last = await showResponse.text();
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return { ok: false, error: last || "verify timeout" };
}

export async function POST() {
  try {
    const stoppingModel = await probeStoppingModel();

    let restarted = false;
    if (stoppingModel) {
      await restartOllamaProcess();
      restarted = true;
    }

    let verified = await verifyModelReady(MODEL);
    if (!verified.ok) {
      // If the engine is wedged but /api/ps didn't report "Stopping...",
      // still attempt one forced restart to recover.
      await restartOllamaProcess();
      restarted = true;
      verified = await verifyModelReady(MODEL);
    }

    if (!verified.ok) {
      return Response.json(
        {
          ok: false,
          error: `heal verify failed: ${verified.error}`,
          stoppingModel: stoppingModel || null,
          model: MODEL,
          restarted,
        },
        { status: 503 },
      );
    }

    return Response.json({
      ok: true,
      model: MODEL,
      restarted,
      stoppingModel: stoppingModel || null,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error), model: MODEL },
      { status: 503 },
    );
  }
}
