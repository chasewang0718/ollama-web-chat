import { getConversationMessages } from "@/lib/chat/conversations";
import { createServiceRoleClient, getMemoryOrgId } from "@/lib/supabase/service";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = createServiceRoleClient();
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();

  if (!supabase || !userId) {
    return Response.json({ messages: [] });
  }

  const messages = await getConversationMessages(supabase, userId, orgId, id);
  return Response.json({ messages });
}
