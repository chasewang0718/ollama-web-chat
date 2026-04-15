import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createConversation,
  deleteConversation,
  getConversationMessages,
  getConversationSummary,
  listConversations,
  renameConversation,
  saveConversationState,
} from "@/lib/chat/conversations";
import {
  buildMemorySystemPrompt,
  persistConversationMemory,
  runMemoryHealthCheck,
} from "@/lib/memory/rag";
import { shouldRefreshSummary, summarizeConversationWithOllama } from "@/lib/memory/summary";
import type { ConversationRepository } from "@/lib/storage/repositories/conversation-repo";
import type { MemoryRepository } from "@/lib/storage/repositories/memory-repo";
import type { SummaryRepository } from "@/lib/storage/repositories/summary-repo";
import { createServiceRoleClient } from "@/lib/supabase/service";

function getSupabaseOrThrow(): SupabaseClient {
  const supabase = createServiceRoleClient();
  if (!supabase) {
    throw new Error("service role client unavailable");
  }
  return supabase;
}

const cloudConversationRepository: ConversationRepository = {
  async list(userId, orgId) {
    const supabase = getSupabaseOrThrow();
    return listConversations(supabase, userId, orgId);
  },
  async create(userId, orgId, id) {
    const supabase = getSupabaseOrThrow();
    return createConversation(supabase, userId, orgId, id);
  },
  async getMessages(userId, orgId, conversationId) {
    const supabase = getSupabaseOrThrow();
    return getConversationMessages(supabase, userId, orgId, conversationId);
  },
  async getSummary(userId, orgId, conversationId) {
    const supabase = getSupabaseOrThrow();
    return getConversationSummary(supabase, userId, orgId, conversationId);
  },
  async saveState(input) {
    const supabase = getSupabaseOrThrow();
    await saveConversationState(
      supabase,
      input.userId,
      input.orgId,
      input.conversationId,
      input.messages,
      input.summary,
    );
  },
  async rename(userId, orgId, conversationId, title) {
    const supabase = getSupabaseOrThrow();
    return renameConversation(supabase, userId, orgId, conversationId, title);
  },
  async delete(userId, orgId, conversationId) {
    const supabase = getSupabaseOrThrow();
    return deleteConversation(supabase, userId, orgId, conversationId);
  },
};

const cloudMemoryRepository: MemoryRepository = {
  async buildSystemPrompt(supabase, userId, orgId, userQuery, matchCount, conversationId) {
    return buildMemorySystemPrompt(
      supabase,
      userId,
      orgId,
      userQuery,
      matchCount,
      conversationId,
    );
  },
  async persistTurn(supabase, userId, orgId, userText, assistantText, conversationId) {
    await persistConversationMemory(
      supabase,
      userId,
      orgId,
      userText,
      assistantText,
      conversationId,
    );
  },
  async runHealthCheck(supabase, userId, orgId) {
    await runMemoryHealthCheck(supabase, userId, orgId);
  },
};

const cloudSummaryRepository: SummaryRepository = {
  shouldRefresh(userTurns, interval) {
    return shouldRefreshSummary(userTurns, interval);
  },
  async generate(conversationText, previousSummary, activeModel) {
    return summarizeConversationWithOllama(conversationText, previousSummary, activeModel);
  },
};

export function createCloudStorageProvider() {
  return {
    conversation: cloudConversationRepository,
    memory: cloudMemoryRepository,
    summary: cloudSummaryRepository,
    createConversationId: () => randomUUID(),
    createServiceRoleClient,
  };
}

export type CloudStorageProvider = ReturnType<typeof createCloudStorageProvider>;
