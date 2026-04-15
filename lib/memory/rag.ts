import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { embedText, vectorToPgString } from "@/lib/ollama/embeddings";

type MatchRow = { id: number; content: string; similarity: number | null; importance?: number };
type MemoryVersionAction = "insert" | "update";

const TRANSIENT_PATTERNS = [
  /^(hi|hello|你好|在吗|早上好|晚上好)[!,.? ]*$/i,
  /^谢谢[!,.? ]*$/i,
  /^好的[!,.? ]*$/i,
];

const ASSISTANT_NOISE_PATTERNS = [
  /(is there anything else|what can i help|would you like to brainstorm|let me know how i can help)/i,
  /(还有什么我可以帮你|需要我继续|你想不想一起头脑风暴)/i,
];

const RULE_HINT_PATTERNS = [
  /(规则|约束|禁止|禁用|必须|不要|固定|风格|语气|目标|代号|主角|设定)/i,
  /\b(rule|constraint|must|forbidden|style|tone|objective|id|setting)\b/i,
];

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLikelyChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function englishCharRatio(text: string): number {
  const chars = text.match(/[A-Za-z]/g);
  if (!chars || !text.length) return 0;
  return chars.length / text.length;
}

function stripMemoryMeta(content: string): string {
  return content
    .replace(/\[memory_key=[^\]]+\]/g, "")
    .replace(/\[version=\d+\]/g, "")
    .trim();
}

function getConversationTag(content: string): string | undefined {
  const match = content.match(/\[conversation_id=([^\]]+)\]/);
  return match?.[1];
}

function stableMemoryKey(userText: string): string {
  const normalized = compactWhitespace(userText).toLowerCase();
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function extractMemoryMeta(content: string): { key?: string; version?: number } {
  const keyMatch = content.match(/\[memory_key=([^\]]+)\]/);
  const versionMatch = content.match(/\[version=(\d+)\]/);
  return {
    key: keyMatch?.[1],
    version: versionMatch ? Number.parseInt(versionMatch[1], 10) : undefined,
  };
}

function shouldPersistMemory(userText: string, assistantText: string): boolean {
  const user = compactWhitespace(userText);
  const assistant = compactWhitespace(assistantText);
  if (!user || !assistant) return false;
  if (user.length < 8) return false;
  if (assistant.length < 24) return false;
  if (TRANSIENT_PATTERNS.some((p) => p.test(user))) return false;
  if (ASSISTANT_NOISE_PATTERNS.some((p) => p.test(assistant))) return false;
  if (user.endsWith("?") && assistant.length > 280 && !RULE_HINT_PATTERNS.some((p) => p.test(user))) {
    return false;
  }
  if (isLikelyChinese(user) && !isLikelyChinese(assistant) && englishCharRatio(assistant) > 0.6) {
    return false;
  }
  return true;
}

function scoreMemoryRow(row: MatchRow): number {
  const plain = compactWhitespace(stripMemoryMeta(row.content));
  const similarity = row.similarity || 0;
  const importanceBoost = (row.importance || 1) * 0.015;
  const ruleBoost = RULE_HINT_PATTERNS.some((p) => p.test(plain)) ? 0.08 : 0;
  const chinesePenalty = isLikelyChinese(plain) ? 0 : 0.02;
  return similarity + importanceBoost + ruleBoost - chinesePenalty;
}

function rerankRows(rows: MatchRow[]): MatchRow[] {
  // 综合语义相似度 + 重要度 + 规则信号，抑制噪音召回
  return [...rows].sort((a, b) => {
    const sa = scoreMemoryRow(a);
    const sb = scoreMemoryRow(b);
    return sb - sa;
  });
}

function inferMemoryImportance(userText: string, assistantText: string): number {
  const combined = `${userText}\n${assistantText}`;
  if (RULE_HINT_PATTERNS.some((p) => p.test(combined))) return 4;
  if (combined.length > 320) return 2;
  return 1;
}

function isRuleMemoryContent(content: string): boolean {
  return RULE_HINT_PATTERNS.some((p) => p.test(stripMemoryMeta(content)));
}

async function compactMemoryVersions(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<void> {
  const maxVersionsPerKey =
    Number.parseInt(process.env.MEMORY_MAX_VERSIONS_PER_KEY || "4", 10) || 4;
  const scanLimit = Number.parseInt(process.env.MEMORY_VERSION_SCAN_LIMIT || "1200", 10) || 1200;
  if (maxVersionsPerKey < 1) return;

  const { data, error } = await supabase
    .from("memories")
    .select("id,content,updated_at")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .limit(scanLimit);

  if (error) {
    console.warn("memory compact: query failed", error.message);
    return;
  }

  const rows = (data || []) as Array<{ id: number; content: string; updated_at: string }>;
  const seen = new Map<string, number>();
  const deleteIds: number[] = [];

  for (const row of rows) {
    const meta = extractMemoryMeta(row.content);
    if (!meta.key) continue;
    const count = (seen.get(meta.key) || 0) + 1;
    seen.set(meta.key, count);
    if (count > maxVersionsPerKey) {
      deleteIds.push(row.id);
    }
  }

  if (deleteIds.length) {
    await supabase.from("memories").delete().in("id", deleteIds);
  }
}

async function decayMemoryImportance(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<void> {
  const decayDays = Number.parseInt(process.env.MEMORY_IMPORTANCE_DECAY_DAYS || "30", 10) || 30;
  const decayCutoff = new Date(Date.now() - decayDays * 24 * 60 * 60 * 1000).toISOString();
  const decayTo = Number.parseInt(process.env.MEMORY_IMPORTANCE_DECAY_TO || "1", 10) || 1;
  const batchLimit = Number.parseInt(process.env.MEMORY_IMPORTANCE_DECAY_LIMIT || "100", 10) || 100;

  const { data, error } = await supabase
    .from("memories")
    .select("id,content,importance,updated_at")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .gt("importance", decayTo)
    .lt("updated_at", decayCutoff)
    .order("updated_at", { ascending: true })
    .limit(batchLimit);

  if (error) {
    console.warn("memory decay: query failed", error.message);
    return;
  }

  const rows = (data || []) as Array<{
    id: number;
    content: string;
    importance: number;
    updated_at: string;
  }>;
  const decayIds = rows
    .filter((row) => !isRuleMemoryContent(row.content))
    .map((row) => row.id);

  if (decayIds.length) {
    await supabase.from("memories").update({ importance: decayTo }).in("id", decayIds);
  }
}

async function appendMemoryVersion(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  memoryKey: string,
  version: number,
  content: string,
  action: MemoryVersionAction,
): Promise<void> {
  const { error } = await supabase.from("memory_versions").insert({
    org_id: orgId,
    user_id: userId,
    memory_key: memoryKey,
    version,
    content,
    action,
  });
  if (error) {
    console.warn("memory versions: append failed", error.message);
  }
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
  conversationId?: string,
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

  const expandedCount = conversationId ? Math.max(matchCount * 6, 30) : matchCount;
  const { data, error } = await supabase.rpc("match_memories", {
    query_embedding: vectorToPgString(embedding),
    match_count: expandedCount,
    filter_user_id: filterUserId,
    filter_org_id: filterOrgId,
    min_similarity: Number.parseFloat(process.env.MEMORY_MIN_SIMILARITY || "0.55") || 0.55,
  });

  if (error) {
    console.warn("memory retrieve: rpc match_memories failed", error.message);
    return undefined;
  }

  const rows = rerankRows(
    ((data || []) as MatchRow[]).filter((row) => {
      if (!conversationId) return true;
      return getConversationTag(row.content) === conversationId;
    }),
  );
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
  conversationId?: string,
): Promise<void> {
  if (!shouldPersistMemory(userText, assistantText)) {
    return;
  }

  let key = stableMemoryKey(userText);
  const user = compactWhitespace(userText);
  const assistant = compactWhitespace(assistantText);

  const baseContent = `User: ${user}\nAssistant: ${assistant}`.slice(
    0,
    8000,
  );
  const conversationTag = conversationId ? `[conversation_id=${conversationId}]` : "";
  let content = `[memory_key=${key}][version=1]${conversationTag}\n${baseContent}`;
  let nextVersion = 1;

  let embedding: number[];
  try {
    embedding = await embedText(content);
  } catch (e) {
    console.warn("memory persist: embed failed", e);
    return;
  }

  // Step 2 (通用版): 语义相似驱动的记忆归并
  // 如果当前记忆与既有记忆高度相似，则复用既有 memory_key 并做版本递增更新。
  const mergeThreshold =
    Number.parseFloat(process.env.MEMORY_MERGE_SIMILARITY || "0.82") || 0.82;
  const { data: semanticRows, error: semanticError } = await supabase.rpc("match_memories", {
    query_embedding: vectorToPgString(embedding),
    match_count: 1,
    filter_user_id: userId,
    filter_org_id: orgId,
    min_similarity: mergeThreshold,
  });
  if (semanticError) {
    console.warn("memory merge: semantic lookup failed", semanticError.message);
  }

  const semanticHit = ((semanticRows || []) as Array<{
    id: number;
    content: string;
    similarity: number | null;
  }>).find((row) => {
    if (!conversationId) return true;
    return getConversationTag(row.content) === conversationId;
  });

  let updateExistingId: number | undefined;
  if (semanticHit) {
    const existingPlain = compactWhitespace(stripMemoryMeta(semanticHit.content));
    const currentPlain = compactWhitespace(baseContent);
    if (existingPlain === currentPlain) {
      return;
    }

    const meta = extractMemoryMeta(semanticHit.content);
    if (meta.key) key = meta.key;
    const previousVersion = meta.version || 1;
    nextVersion = previousVersion + 1;
    const sameConversationTag = conversationId ? `[conversation_id=${conversationId}]` : "";
    content = `[memory_key=${key}][version=${nextVersion}]${sameConversationTag}\n${baseContent}`;
    updateExistingId = semanticHit.id;
    embedding = await embedText(content);
  }

  const payload = {
    org_id: orgId,
    user_id: userId,
    content,
    embedding: vectorToPgString(embedding),
    importance: inferMemoryImportance(user, assistant),
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
    return;
  }

  await appendMemoryVersion(
    supabase,
    userId,
    orgId,
    key,
    nextVersion,
    baseContent,
    updateExistingId ? "update" : "insert",
  );
}

// Step 4: 记忆体检（轻量版）——定期清理过旧低价值记忆，抑制长期膨胀
export async function runMemoryHealthCheck(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<void> {
  await compactMemoryVersions(supabase, userId, orgId);
  await decayMemoryImportance(supabase, userId, orgId);

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
