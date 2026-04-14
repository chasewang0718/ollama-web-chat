/**
 * Step 2 — 目的：把「一句话」变成向量，供 pgvector 做相似度检索。
 * 使用本地 Ollama 的 /api/embeddings，无需额外云端 embedding 服务。
 */

const DEFAULT_HOST = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "nomic-embed-text";
/** 须与 Supabase `memories.embedding vector(N)` 的 N 一致；nomic-embed-text 为 768 */
const DEFAULT_DIM = 768;

export function getExpectedEmbeddingDimensions(): number {
  const raw = process.env.EMBEDDING_DIMENSIONS;
  if (!raw) return DEFAULT_DIM;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_DIM;
}

export async function embedText(text: string): Promise<number[]> {
  const host = (process.env.OLLAMA_HOST || DEFAULT_HOST).replace(/\/$/, "");
  const model = process.env.OLLAMA_EMBED_MODEL || DEFAULT_MODEL;

  const response = await fetch(`${host}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ollama embeddings failed: ${response.status} ${err}`);
  }

  const data = (await response.json()) as { embedding?: number[] };
  if (!data.embedding?.length) {
    throw new Error("Ollama embeddings: empty embedding");
  }

  const expected = getExpectedEmbeddingDimensions();
  if (data.embedding.length !== expected) {
    throw new Error(
      `Embedding dim mismatch: got ${data.embedding.length}, expected ${expected}. Set EMBEDDING_DIMENSIONS or fix SQL vector(N).`,
    );
  }

  return data.embedding;
}

export function vectorToPgString(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
