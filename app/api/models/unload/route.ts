const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const UNLOAD_TIMEOUT_MS = Number.parseInt(process.env.OLLAMA_UNLOAD_TIMEOUT_MS || "", 10) || 6_000;

type UnloadRequest = {
  model?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as UnloadRequest;
    const model = body.model?.trim();
    if (!model) {
      return Response.json({ error: "model is required" }, { status: 400 });
    }

    const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",
        stream: false,
        keep_alive: 0,
        options: {
          num_predict: 0,
        },
      }),
      signal: AbortSignal.timeout(UNLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
      const details = await response.text();
      return Response.json(
        { error: `unload failed: ${response.status}`, details },
        { status: 500 },
      );
    }

    return Response.json({ ok: true, model });
  } catch (error) {
    return Response.json(
      { error: "unload request failed", details: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
