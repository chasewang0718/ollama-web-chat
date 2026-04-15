import type { SupabaseClient } from "@supabase/supabase-js";

export interface MemoryRepository {
  buildSystemPrompt(
    supabase: SupabaseClient,
    userId: string,
    orgId: string,
    userQuery: string,
    matchCount: number,
    conversationId?: string,
  ): Promise<string | undefined>;
  persistTurn(
    supabase: SupabaseClient,
    userId: string,
    orgId: string,
    userText: string,
    assistantText: string,
    conversationId?: string,
  ): Promise<void>;
  runHealthCheck(supabase: SupabaseClient, userId: string, orgId: string): Promise<void>;
}
