import { randomUUID } from "node:crypto";

import { createConversation, listConversations } from "@/lib/chat/conversations";
import { createServiceRoleClient, getMemoryOrgId } from "@/lib/supabase/service";

export async function GET() {
  const supabase = createServiceRoleClient();
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();

  if (!supabase || !userId) {
    return Response.json({ conversations: [] });
  }

  const result = await listConversations(supabase, userId, orgId);
  if (result.error) {
    console.warn("list conversations failed", result.error);
    return Response.json(
      { conversations: [], error: "chat_conversations table unavailable" },
      { status: 500 },
    );
  }

  return Response.json({ conversations: result.conversations });
}

export async function POST() {
  const supabase = createServiceRoleClient();
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();

  if (!supabase || !userId) {
    return Response.json({ error: "memory store unavailable" }, { status: 500 });
  }

  const conversation = await createConversation(supabase, userId, orgId, randomUUID());
  if (!conversation) {
    return Response.json({ error: "chat_conversations table unavailable" }, { status: 500 });
  }
  return Response.json({ conversation });
}
