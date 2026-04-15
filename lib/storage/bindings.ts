import type { SupabaseClient } from "@supabase/supabase-js";

import type { MigrationStatus, StorageBackend } from "@/lib/storage/types";

export type BindingRow = {
  conversation_id: string;
  storage_backend: StorageBackend;
  migration_status: MigrationStatus;
  updated_at: string;
};

export async function getConversationBackend(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  conversationId: string,
): Promise<StorageBackend | undefined> {
  const { data, error } = await supabase
    .from("conversation_storage_bindings")
    .select("conversation_id,storage_backend,updated_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    console.warn("conversation backend lookup failed", error.message);
    return undefined;
  }

  const row = data as BindingRow | null;
  return row?.storage_backend;
}

export async function getConversationBinding(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  conversationId: string,
): Promise<BindingRow | undefined> {
  const { data, error } = await supabase
    .from("conversation_storage_bindings")
    .select("conversation_id,storage_backend,migration_status,updated_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    console.warn("conversation binding lookup failed", error.message);
    return undefined;
  }

  return (data as BindingRow | null) || undefined;
}

export async function bindConversationBackend(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  conversationId: string,
  backend: StorageBackend,
): Promise<boolean> {
  const { error } = await supabase.from("conversation_storage_bindings").upsert(
    {
      conversation_id: conversationId,
      user_id: userId,
      org_id: orgId,
      storage_backend: backend,
      migration_status: "none",
    },
    { onConflict: "conversation_id" },
  );

  if (error) {
    console.warn("conversation backend bind failed", error.message);
    return false;
  }
  return true;
}

export async function setConversationMigrationStatus(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  conversationId: string,
  migrationStatus: MigrationStatus,
): Promise<boolean> {
  const { error } = await supabase
    .from("conversation_storage_bindings")
    .update({ migration_status: migrationStatus })
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .eq("org_id", orgId);

  if (error) {
    console.warn("conversation migration status update failed", error.message);
    return false;
  }
  return true;
}

export async function listConversationBindings(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  options?: {
    limit?: number;
    offset?: number;
    migrationStatus?: MigrationStatus;
  },
): Promise<BindingRow[]> {
  const limit = Math.min(Math.max(options?.limit || 50, 1), 500);
  const offset = Math.max(options?.offset || 0, 0);
  let query = supabase
    .from("conversation_storage_bindings")
    .select("conversation_id,storage_backend,migration_status,updated_at")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (options?.migrationStatus) {
    query = query.eq("migration_status", options.migrationStatus);
  }

  const { data, error } = await query;
  if (error) {
    console.warn("list conversation bindings failed", error.message);
    return [];
  }
  return (data || []) as BindingRow[];
}
