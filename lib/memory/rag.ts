import type { SupabaseClient } from "@supabase/supabase-js";

import { embedText, vectorToPgString } from "@/lib/ollama/embeddings";

type MatchRow = { id: number; content: string; similarity: number | null };

/**
 * Step 4（检索部分）— 目的：根据「当前用户问题」从 memories 里捞出最相关的几条，
 * 拼成一段 system 上下文，让模型「带着记忆」回答（RAG）。
 */
export async function buildMemorySystemPrompt(
  supabase: SupabaseClient,
  filterUserId: string,
  userQuery: string,
  matchCount: number,
): Promise<string | undefined> {
  const trimmed = userQuery.trim();
  if (!trimmed) return undefined;

  let embedding: number[];
  try {
    embedding = await embedText(trimmed);
  } catch (e) {
    console.warn("memory retrieve: embed failed", e);
    return undefined;
  }

  const { data, error } = await supabase.rpc("match_memories", {
    query_embedding: vectorToPgString(embedding),
    match_count: matchCount,
    filter_user_id: filterUserId,
  });

  if (error) {
    console.warn("memory retrieve: rpc match_memories failed", error.message);
    return undefined;
  }

  const rows = (data || []) as MatchRow[];
  if (rows.length === 0) return undefined;

  const lines = rows.map((r) => `- ${r.content.replace(/\s+/g, " ").trim()}`);
  return [
    "以下为与用户问题可能相关的长期记忆（仅作参考，不要编造未提供的信息）：",
    ...lines,
  ].join("\n");
}

/**
 * Step 4（写入部分）— 目的：把本轮「用户话 + 助手回复」写入 memories，
 * 下次相似问题就能被检索出来，形成「永久记忆」闭环。
 */
export async function persistConversationMemory(
  supabase: SupabaseClient,
  userId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const content = `User: ${userText.trim()}\nAssistant: ${assistantText.trim()}`.slice(
    0,
    8000,
  );

  let embedding: number[];
  try {
    embedding = await embedText(content);
  } catch (e) {
    console.warn("memory persist: embed failed", e);
    return;
  }

  const { error } = await supabase.from("memories").insert({
    user_id: userId,
    content,
    embedding: vectorToPgString(embedding),
    importance: 1,
  });

  if (error) {
    console.warn("memory persist: insert failed", error.message);
  }
}
