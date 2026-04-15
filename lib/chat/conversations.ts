import type { UIMessage } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";

type ConversationRow = {
  id: string;
  title: string | null;
  summary: string | null;
  messages: UIMessage[] | null;
  updated_at: string;
  created_at: string;
};

function textFromMessage(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export function buildConversationTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const seed = firstUser ? textFromMessage(firstUser) : "";
  if (!seed) return "新对话";
  return seed.slice(0, 24);
}

export function buildLastPreview(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const txt = textFromMessage(messages[i]);
    if (txt) return txt.slice(0, 80);
  }
  return "";
}

export async function listConversations(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<{
  conversations: Array<{ id: string; title: string; updated_at: string; created_at: string }>;
  error?: string;
}> {
  const { data, error } = await supabase
    .from("chat_conversations")
    .select("id,title,updated_at,created_at")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .limit(200);

  if (error) {
    return { conversations: [], error: error.message };
  }

  return {
    conversations: (data || []).map(
      (row: { id: string; title: string | null; updated_at: string; created_at: string }) => ({
        id: row.id,
        title: row.title?.trim() || "新对话",
        updated_at: row.updated_at,
        created_at: row.created_at,
      }),
    ),
  };
}

export async function createConversation(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  id: string,
): Promise<{ id: string; title: string } | null> {
  const { error } = await supabase.from("chat_conversations").insert({
    id,
    user_id: userId,
    org_id: orgId,
    title: "新对话",
    summary: "",
    last_message_preview: "",
    messages: [],
  });

  if (error) {
    return null;
  }

  return { id, title: "新对话" };
}

export async function getConversationMessages(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  conversationId: string,
): Promise<UIMessage[]> {
  const { data, error } = await supabase
    .from("chat_conversations")
    .select("messages")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    console.warn("get conversation messages failed", error.message);
    return [];
  }

  const row = data as { messages?: UIMessage[] } | null;
  return row?.messages || [];
}

export async function getConversationSummary(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  conversationId: string,
): Promise<string | undefined> {
  const { data, error } = await supabase
    .from("chat_conversations")
    .select("summary")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    console.warn("get conversation summary failed", error.message);
    return undefined;
  }

  const row = data as { summary?: string | null } | null;
  return row?.summary?.trim() || undefined;
}

export async function saveConversationState(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  conversationId: string,
  messages: UIMessage[],
  summary?: string,
): Promise<void> {
  const title = buildConversationTitle(messages);
  const lastPreview = buildLastPreview(messages);

  const payload: Record<string, unknown> = {
    title,
    last_message_preview: lastPreview,
    messages,
  };
  if (typeof summary === "string") {
    payload.summary = summary;
  }

  const { error } = await supabase
    .from("chat_conversations")
    .update(payload)
    .eq("id", conversationId)
    .eq("user_id", userId)
    .eq("org_id", orgId);

  if (error) {
    console.warn("save conversation state failed", error.message);
  }
}

export type { ConversationRow };
