import { OllamaBusyError, tryRunOllamaExclusive } from "@/lib/ollama/scheduler";

const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const WARMUP_TIMEOUT_MS = Number.parseInt(process.env.OLLAMA_WARMUP_TIMEOUT_MS || "", 10) || 8_000;
const WARMUP_LOCK_WAIT_MS = Number.parseInt(process.env.OLLAMA_WARMUP_LOCK_WAIT_MS || "", 10) || 0;

type WarmupRequest = {
  model?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as WarmupRequest;
    const model = body.model?.trim();
    if (!model) {
      return Response.json({ error: "model is required" }, { status: 400 });
    }

    // Best-effort keep-warm: do not contend with chat/embeddings.
    const response = await tryRunOllamaExclusive(
      () =>
        fetch(`${OLLAMA_HOST}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: "ping",
            stream: false,
            keep_alive: "10m",
            options: {
              num_predict: 1,
              temperature: 0,
            },
          }),
          signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
        }),
      { waitMs: WARMUP_LOCK_WAIT_MS },
    ).catch((error: unknown) => {
      if (error instanceof OllamaBusyError) {
        return null;
      }
      throw error;
    });

    if (response === null) {
      return Response.json({ ok: true, skipped: true });
    }

    if (!response.ok) {
      const err = await response.text();
      return Response.json(
        { error: `warmup failed: ${response.status}`, details: err },
        { status: 500 },
      );
    }

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: "warmup request failed", details: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
