import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { embedText, vectorToPgString } from "@/lib/ollama/embeddings";

type MatchRow = { id: number; content: string; similarity: number | null; importance?: number };

const TRANSIENT_PATTERNS = [
  /^(hi|hello|你好|在吗|早上好|晚上好)[!,.? ]*$/i,
  /^谢谢[!,.? ]*$/i,
  /^好的[!,.? ]*$/i,
];

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripMemoryMeta(content: string): string {
  return content
    .replace(/\[memory_key=[^\]]+\]/g, "")
    .replace(/\[version=\d+\]/g, "")
    .trim();
}

function stableMemoryKey(userText: string): string {
  const normalized = compactWhitespace(userText).toLowerCase();
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function shouldPersistMemory(userText: string, assistantText: string): boolean {
  const user = compactWhitespace(userText);
  const assistant = compactWhitespace(assistantText);
  if (!user || !assistant) return false;
  if (user.length < 8) return false;
  if (assistant.length < 24) return false;
  if (TRANSIENT_PATTERNS.some((p) => p.test(user))) return false;
  return true;
}

function rerankRows(rows: MatchRow[]): MatchRow[] {
  // 综合语义相似度 + importance，抑制低价值噪音召回
  return [...rows].sort((a, b) => {
    const sa = (a.similarity || 0) + (a.importance || 1) * 0.015;
    const sb = (b.similarity || 0) + (b.importance || 1) * 0.015;
    return sb - sa;
  });
}

/**
 * Step 4（检索部分）— 目的：根据「当前用户问题」从 memories 里捞出最相关的几条，
 * 拼成一段 system 上下文，让模型「带着记忆」回答（RAG）。
 */
export async function buildMemorySystemPrompt(
  supabase: SupabaseClient,
  filterUserId: string,
  filterOrgId: string,
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
    filter_org_id: filterOrgId,
    min_similarity: Number.parseFloat(process.env.MEMORY_MIN_SIMILARITY || "0.55") || 0.55,
  });

  if (error) {
    console.warn("memory retrieve: rpc match_memories failed", error.message);
    return undefined;
  }

  const rows = rerankRows((data || []) as MatchRow[]);
  if (rows.length === 0) return undefined;

  const lines = rows
    .slice(0, matchCount)
    .map((r) => `- ${compactWhitespace(stripMemoryMeta(r.content))}`);
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
  orgId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  if (!shouldPersistMemory(userText, assistantText)) {
    return;
  }

  const key = stableMemoryKey(userText);
  const user = compactWhitespace(userText);
  const assistant = compactWhitespace(assistantText);

  const baseContent = `User: ${user}\nAssistant: ${assistant}`.slice(
    0,
    8000,
  );
  let content = `[memory_key=${key}][version=1]\n${baseContent}`;

  // Step 2: 去重与冲突合并（轻量版）
  // 同一个 key 表示同类记忆：相同内容直接跳过；冲突则覆盖为新版本（version+1）
  const { data: existingRows } = await supabase
    .from("memories")
    .select("id,content")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .ilike("content", `%[memory_key=${key}]%`)
    .order("updated_at", { ascending: false })
    .limit(1);

  const existing = existingRows?.[0] as { id: number; content: string } | undefined;
  let updateExistingId: number | undefined;
  if (existing) {
    const existingPlain = compactWhitespace(stripMemoryMeta(existing.content));
    const currentPlain = compactWhitespace(baseContent);
    if (existingPlain === currentPlain) {
      return;
    }

    const match = existing.content.match(/\[version=(\d+)\]/);
    const previousVersion = match ? Number.parseInt(match[1], 10) || 1 : 1;
    content = `[memory_key=${key}][version=${previousVersion + 1}]\n${baseContent}`;
    updateExistingId = existing.id;
  }

  let embedding: number[];
  try {
    embedding = await embedText(content);
  } catch (e) {
    console.warn("memory persist: embed failed", e);
    return;
  }

  const payload = {
    org_id: orgId,
    user_id: userId,
    content,
    embedding: vectorToPgString(embedding),
    importance: 1,
  };

  const { error } = updateExistingId
    ? await supabase.from("memories").update(payload).eq("id", updateExistingId)
    : await supabase.from("memories").insert(payload);

  if (error) {
    console.error(
      "memory persist: insert failed",
      error.message,
      error.code,
      error.details,
      error.hint,
    );
  }
}

// Step 4: 记忆体检（轻量版）——定期清理过旧低价值记忆，抑制长期膨胀
export async function runMemoryHealthCheck(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<void> {
  const maxItems = Number.parseInt(process.env.MEMORY_MAX_ITEMS || "400", 10) || 400;
  const staleDays = Number.parseInt(process.env.MEMORY_STALE_DAYS || "120", 10) || 120;
  const staleCutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();

  const { count: exactCount, error: countError } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("org_id", orgId);

  if (countError) {
    console.warn("memory health: count failed", countError.message);
    return;
  }

  if ((exactCount || 0) > maxItems) {
    const overflow = (exactCount || 0) - maxItems;
    const { data: oldest } = await supabase
      .from("memories")
      .select("id")
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .order("updated_at", { ascending: true })
      .limit(overflow);
    const ids = (oldest || []).map((x: { id: number }) => x.id);
    if (ids.length) {
      await supabase.from("memories").delete().in("id", ids);
    }
  }

  const { data: staleRows } = await supabase
    .from("memories")
    .select("id")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .lte("importance", 1)
    .lt("updated_at", staleCutoff)
    .limit(200);
  const staleIds = (staleRows || []).map((x: { id: number }) => x.id);
  if (staleIds.length) {
    await supabase.from("memories").delete().in("id", staleIds);
  }
}
