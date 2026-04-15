import type { UIMessage } from "ai";

export type StorageMode = "cloud" | "local" | "hybrid";
export type StorageBackend = "cloud" | "local";
export type MigrationStatus = "none" | "pending" | "running" | "failed" | "done";

export type ConversationListItem = {
  id: string;
  title: string;
  updated_at: string;
  created_at: string;
};

export type ConversationCreateResult = {
  id: string;
  title: string;
};

export type SaveConversationStateInput = {
  userId: string;
  orgId: string;
  conversationId: string;
  messages: UIMessage[];
  summary?: string;
};
