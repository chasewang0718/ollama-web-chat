import type { SupabaseClient } from "@supabase/supabase-js";

import {
  bindConversationBackend,
  getConversationBinding,
  setConversationMigrationStatus,
} from "@/lib/storage/bindings";
import { getStorageProviderForBackend } from "@/lib/storage/router";
import type { StorageBackend } from "@/lib/storage/types";

type MigrationOptions = {
  userId: string;
  orgId: string;
  conversationId: string;
  targetBackend: StorageBackend;
  rollback?: boolean;
  dryRun?: boolean;
};

type MigrationResult = {
  ok: boolean;
  sourceBackend: StorageBackend;
  targetBackend: StorageBackend;
  migrated: {
    conversations: number;
    memories: number;
    memoryVersions: number;
  };
  rollbackApplied?: boolean;
  error?: string;
};

type BatchMigrationOptions = {
  userId: string;
  orgId: string;
  conversationIds: string[];
  targetBackend: StorageBackend;
  rollback?: boolean;
  dryRun?: boolean;
  continueOnError?: boolean;
};

type BatchMigrationResult = {
  ok: boolean;
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{ conversationId: string; result: MigrationResult }>;
};

type ConversationRow = {
  id: string;
  org_id: string;
  user_id: string;
  title: string;
  summary: string;
  last_message_preview: string;
  messages: unknown;
  created_at: string;
  updated_at: string;
};

type MemoryRow = {
  org_id: string;
  user_id: string;
  content: string;
  embedding: string | number[] | null;
  importance: number | null;
  created_at?: string;
  updated_at?: string;
};

type MemoryVersionRow = {
  org_id: string;
  user_id: string;
  memory_key: string;
  version: number;
  content: string;
  action: "insert" | "update";
  created_at?: string;
};

function buildClientUnavailableMessage(
  sourceBackend: StorageBackend,
  targetBackend: StorageBackend,
): string {
  const missing: string[] = [];
  if (sourceBackend === "local" || targetBackend === "local") {
    if (!process.env.LOCAL_SUPABASE_URL) missing.push("LOCAL_SUPABASE_URL");
    if (!process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY) {
      missing.push("LOCAL_SUPABASE_SERVICE_ROLE_KEY");
    }
  }
  if (sourceBackend === "cloud" || targetBackend === "cloud") {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!missing.length) {
    return "source or target backend client unavailable";
  }
  return `backend client unavailable: missing env ${missing.join(", ")}`;
}

function extractMemoryKey(content: string): string | undefined {
  const m = content.match(/\[memory_key=([^\]]+)\]/);
  return m?.[1];
}

function includesConversationTag(content: string, conversationId: string): boolean {
  return content.includes(`[conversation_id=${conversationId}]`);
}

async function fetchConversation(
  source: SupabaseClient,
  userId: string,
  orgId: string,
  conversationId: string,
): Promise<ConversationRow | undefined> {
  const { data, error } = await source
    .from("chat_conversations")
    .select("id,org_id,user_id,title,summary,last_message_preview,messages,created_at,updated_at")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    throw new Error(`fetch conversation failed: ${error.message}`);
  }
  return (data as ConversationRow | null) || undefined;
}

async function copyConversation(
  source: SupabaseClient,
  target: SupabaseClient,
  userId: string,
  orgId: string,
  conversationId: string,
  dryRun = false,
): Promise<number> {
  const row = await fetchConversation(source, userId, orgId, conversationId);
  if (!row) return 0;
  if (dryRun) return 1;

  const payload = {
    id: row.id,
    org_id: row.org_id,
    user_id: row.user_id,
    title: row.title,
    summary: row.summary,
    last_message_preview: row.last_message_preview,
    messages: row.messages,
  };

  const { error } = await target.from("chat_conversations").upsert(payload, { onConflict: "id" });
  if (error) {
    throw new Error(`copy conversation failed: ${error.message}`);
  }
  return 1;
}

async function fetchConversationMemories(
  source: SupabaseClient,
  userId: string,
  orgId: string,
  conversationId: string,
): Promise<MemoryRow[]> {
  const { data, error } = await source
    .from("memories")
    .select("org_id,user_id,content,embedding,importance,created_at,updated_at")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .limit(4000);

  if (error) {
    throw new Error(`fetch memories failed: ${error.message}`);
  }

  return ((data || []) as MemoryRow[]).filter((row) =>
    includesConversationTag(row.content || "", conversationId),
  );
}

async function replaceConversationMemories(
  source: SupabaseClient,
  target: SupabaseClient,
  userId: string,
  orgId: string,
  conversationId: string,
  dryRun = false,
): Promise<{ count: number; memoryKeys: string[] }> {
  const sourceRows = await fetchConversationMemories(source, userId, orgId, conversationId);
  const keys = Array.from(
    new Set(
      sourceRows
        .map((x) => extractMemoryKey(x.content || ""))
        .filter((x): x is string => Boolean(x)),
    ),
  );

  if (dryRun) {
    return { count: sourceRows.length, memoryKeys: keys };
  }

  const existing = await fetchConversationMemories(target, userId, orgId, conversationId);
  if (existing.length) {
    const deleteContents = existing.map((x) => x.content);
    const { error: deleteError } = await target
      .from("memories")
      .delete()
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .in("content", deleteContents);
    if (deleteError) {
      throw new Error(`cleanup target memories failed: ${deleteError.message}`);
    }
  }

  if (!sourceRows.length) {
    return { count: 0, memoryKeys: keys };
  }

  const insertPayload = sourceRows.map((row) => ({
    org_id: row.org_id,
    user_id: row.user_id,
    content: row.content,
    embedding: row.embedding,
    importance: row.importance ?? 1,
  }));
  const { error: insertError } = await target.from("memories").insert(insertPayload);
  if (insertError) {
    throw new Error(`copy memories failed: ${insertError.message}`);
  }
  return { count: sourceRows.length, memoryKeys: keys };
}

async function replaceMemoryVersions(
  source: SupabaseClient,
  target: SupabaseClient,
  userId: string,
  orgId: string,
  memoryKeys: string[],
  dryRun = false,
): Promise<number> {
  if (!memoryKeys.length) return 0;

  const { data, error } = await source
    .from("memory_versions")
    .select("org_id,user_id,memory_key,version,content,action,created_at")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .in("memory_key", memoryKeys)
    .order("created_at", { ascending: true })
    .limit(10000);
  if (error) {
    throw new Error(`fetch memory_versions failed: ${error.message}`);
  }

  const rows = (data || []) as MemoryVersionRow[];
  if (dryRun) return rows.length;

  const { error: deleteError } = await target
    .from("memory_versions")
    .delete()
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .in("memory_key", memoryKeys);
  if (deleteError) {
    throw new Error(`cleanup target memory_versions failed: ${deleteError.message}`);
  }

  if (!rows.length) return 0;
  const { error: insertError } = await target.from("memory_versions").insert(rows);
  if (insertError) {
    throw new Error(`copy memory_versions failed: ${insertError.message}`);
  }
  return rows.length;
}

export async function migrateConversationBetweenBackends(
  controlPlane: SupabaseClient,
  options: MigrationOptions,
): Promise<MigrationResult> {
  const { userId, orgId, conversationId, targetBackend, dryRun = false } = options;
  const currentBinding = await getConversationBinding(controlPlane, userId, orgId, conversationId);
  const sourceBackend: StorageBackend = currentBinding?.storage_backend || "cloud";

  if (sourceBackend === targetBackend && !options.rollback) {
    return {
      ok: true,
      sourceBackend,
      targetBackend,
      migrated: { conversations: 0, memories: 0, memoryVersions: 0 },
    };
  }

  const rollbackAllowed = process.env.STORAGE_MIGRATION_ALLOW_ROLLBACK === "true";
  if (options.rollback && !rollbackAllowed) {
    return {
      ok: false,
      sourceBackend,
      targetBackend,
      migrated: { conversations: 0, memories: 0, memoryVersions: 0 },
      error: "rollback is disabled by STORAGE_MIGRATION_ALLOW_ROLLBACK",
    };
  }

  const effectiveSource = sourceBackend;
  const effectiveTarget = options.rollback
    ? sourceBackend === "cloud"
      ? "local"
      : "cloud"
    : targetBackend;

  const sourceClient = getStorageProviderForBackend(effectiveSource).createServiceRoleClient();
  const targetClient = getStorageProviderForBackend(effectiveTarget).createServiceRoleClient();
  if (!sourceClient || !targetClient) {
    return {
      ok: false,
      sourceBackend,
      targetBackend: effectiveTarget,
      migrated: { conversations: 0, memories: 0, memoryVersions: 0 },
      error: buildClientUnavailableMessage(effectiveSource, effectiveTarget),
    };
  }

  if (!dryRun) {
    await setConversationMigrationStatus(controlPlane, userId, orgId, conversationId, "pending");
    await setConversationMigrationStatus(controlPlane, userId, orgId, conversationId, "running");
  }

  try {
    const conversations = await copyConversation(
      sourceClient,
      targetClient,
      userId,
      orgId,
      conversationId,
      dryRun,
    );
    const memResult = await replaceConversationMemories(
      sourceClient,
      targetClient,
      userId,
      orgId,
      conversationId,
      dryRun,
    );
    const memoryVersions = await replaceMemoryVersions(
      sourceClient,
      targetClient,
      userId,
      orgId,
      memResult.memoryKeys,
      dryRun,
    );

    if (!dryRun) {
      await bindConversationBackend(controlPlane, userId, orgId, conversationId, effectiveTarget);
    }
    if (!dryRun) {
      await setConversationMigrationStatus(controlPlane, userId, orgId, conversationId, "done");
    }

    return {
      ok: true,
      sourceBackend: effectiveSource,
      targetBackend: effectiveTarget,
      migrated: {
        conversations,
        memories: memResult.count,
        memoryVersions,
      },
      rollbackApplied: options.rollback || undefined,
    };
  } catch (error) {
    if (!dryRun) {
      await setConversationMigrationStatus(controlPlane, userId, orgId, conversationId, "failed");
    }
    return {
      ok: false,
      sourceBackend: effectiveSource,
      targetBackend: effectiveTarget,
      migrated: { conversations: 0, memories: 0, memoryVersions: 0 },
      error: error instanceof Error ? error.message : String(error),
      rollbackApplied: options.rollback || undefined,
    };
  }
}

export async function migrateConversationsBatch(
  controlPlane: SupabaseClient,
  options: BatchMigrationOptions,
): Promise<BatchMigrationResult> {
  const results: Array<{ conversationId: string; result: MigrationResult }> = [];
  let succeeded = 0;
  let failed = 0;
  const continueOnError = options.continueOnError !== false;

  for (const conversationId of options.conversationIds) {
    const result = await migrateConversationBetweenBackends(controlPlane, {
      userId: options.userId,
      orgId: options.orgId,
      conversationId,
      targetBackend: options.targetBackend,
      rollback: options.rollback,
      dryRun: options.dryRun,
    });
    results.push({ conversationId, result });
    if (result.ok) {
      succeeded += 1;
    } else {
      failed += 1;
      if (!continueOnError) break;
    }
  }

  return {
    ok: failed === 0,
    total: options.conversationIds.length,
    succeeded,
    failed,
    results,
  };
}
