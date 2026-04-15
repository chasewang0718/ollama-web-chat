const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");

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

    // Light keep-warm request: minimal generation with keep_alive to reduce cold-start latency.
    const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
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
    });

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
