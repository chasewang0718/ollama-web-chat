import type { UIMessage } from "ai";

import type {
  ConversationCreateResult,
  ConversationListItem,
  SaveConversationStateInput,
} from "@/lib/storage/types";

export interface ConversationRepository {
  list(userId: string, orgId: string): Promise<{ conversations: ConversationListItem[]; error?: string }>;
  create(userId: string, orgId: string, id: string): Promise<ConversationCreateResult | null>;
  getMessages(userId: string, orgId: string, conversationId: string): Promise<UIMessage[]>;
  getSummary(userId: string, orgId: string, conversationId: string): Promise<string | undefined>;
  saveState(input: SaveConversationStateInput): Promise<void>;
  rename(userId: string, orgId: string, conversationId: string, title: string): Promise<boolean>;
  delete(userId: string, orgId: string, conversationId: string): Promise<boolean>;
}
