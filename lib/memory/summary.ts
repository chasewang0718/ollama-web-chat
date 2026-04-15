import type { SupabaseClient } from "@supabase/supabase-js";

type SummaryRow = {
  id: number;
  summary: string;
  turn_count: number;
  updated_at: string;
};

export async function getLatestSummary(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<SummaryRow | undefined> {
  const { data, error } = await supabase
    .from("memory_summaries")
    .select("id,summary,turn_count,updated_at")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("summary read failed", error.message);
    return undefined;
  }
  return (data as SummaryRow | null) || undefined;
}

export function shouldRefreshSummary(userTurns: number, interval: number): boolean {
  if (interval <= 0) return false;
  if (userTurns <= 0) return false;
  return userTurns % interval === 0;
}

export async function persistSummary(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  summary: string,
  turnCount: number,
): Promise<void> {
  const { error } = await supabase.from("memory_summaries").upsert(
    {
      user_id: userId,
      org_id: orgId,
      summary,
      turn_count: turnCount,
    },
    { onConflict: "user_id,org_id" },
  );

  if (error) {
    console.error("summary upsert failed", error.message, error.code);
  }
}

export async function summarizeConversationWithOllama(
  conversationText: string,
  activeModel?: string,
): Promise<string | undefined> {
  const host = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
  const configured = process.env.MEMORY_SUMMARY_MODEL;
  const model =
    !configured || configured === "auto"
      ? activeModel || process.env.OLLAMA_MODEL || "gemma2:9b"
      : configured;

  const system =
    "You are a memory summarizer. Produce concise stable memory in Chinese with bullet points.\n" +
    "Keep only durable facts: user preferences, decisions, constraints, style requirements, and unresolved tasks.\n" +
    "Do not include transient chitchat.";

  const response = await fetch(`${host}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer ollama" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Please summarize this conversation:\n\n${conversationText}` },
      ],
      stream: false,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.warn("summary generation failed", response.status, err);
    return undefined;
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content?.trim();
  return text || undefined;
}
