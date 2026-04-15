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
import { createLocalServiceRoleClient } from "@/lib/localdb/service";
import {
  buildMemorySystemPrompt,
  persistConversationMemory,
  runMemoryHealthCheck,
} from "@/lib/memory/rag";
import { shouldRefreshSummary, summarizeConversationWithOllama } from "@/lib/memory/summary";
import type { ConversationRepository } from "@/lib/storage/repositories/conversation-repo";
import type { MemoryRepository } from "@/lib/storage/repositories/memory-repo";
import type { SummaryRepository } from "@/lib/storage/repositories/summary-repo";

function getLocalSupabaseOrThrow(): SupabaseClient {
  const supabase = createLocalServiceRoleClient();
  if (!supabase) {
    throw new Error("local service role client unavailable");
  }
  return supabase;
}

const localConversationRepository: ConversationRepository = {
  async list(userId, orgId) {
    const supabase = getLocalSupabaseOrThrow();
    return listConversations(supabase, userId, orgId);
  },
  async create(userId, orgId, id) {
    const supabase = getLocalSupabaseOrThrow();
    return createConversation(supabase, userId, orgId, id);
  },
  async getMessages(userId, orgId, conversationId) {
    const supabase = getLocalSupabaseOrThrow();
    return getConversationMessages(supabase, userId, orgId, conversationId);
  },
  async getSummary(userId, orgId, conversationId) {
    const supabase = getLocalSupabaseOrThrow();
    return getConversationSummary(supabase, userId, orgId, conversationId);
  },
  async saveState(input) {
    const supabase = getLocalSupabaseOrThrow();
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
    const supabase = getLocalSupabaseOrThrow();
    return renameConversation(supabase, userId, orgId, conversationId, title);
  },
  async delete(userId, orgId, conversationId) {
    const supabase = getLocalSupabaseOrThrow();
    return deleteConversation(supabase, userId, orgId, conversationId);
  },
};

const localMemoryRepository: MemoryRepository = {
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

const localSummaryRepository: SummaryRepository = {
  shouldRefresh(userTurns, interval) {
    return shouldRefreshSummary(userTurns, interval);
  },
  async generate(conversationText, previousSummary, activeModel) {
    return summarizeConversationWithOllama(conversationText, previousSummary, activeModel);
  },
};

export function createLocalStorageProvider() {
  return {
    conversation: localConversationRepository,
    memory: localMemoryRepository,
    summary: localSummaryRepository,
    createConversationId: () => randomUUID(),
    createServiceRoleClient: createLocalServiceRoleClient,
  };
}

export type LocalStorageProvider = ReturnType<typeof createLocalStorageProvider>;
