import {
  deleteConversation,
  renameConversation,
} from "@/lib/chat/conversations";
import { createServiceRoleClient, getMemoryOrgId } from "@/lib/supabase/service";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = createServiceRoleClient();
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();

  if (!supabase || !userId) {
    return Response.json({ error: "memory store unavailable" }, { status: 500 });
  }

  const ok = await deleteConversation(supabase, userId, orgId, id);
  if (!ok) {
    return Response.json({ error: "delete failed" }, { status: 500 });
  }
  return Response.json({ ok: true });
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const supabase = createServiceRoleClient();
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();

  if (!supabase || !userId) {
    return Response.json({ error: "memory store unavailable" }, { status: 500 });
  }

  const body = (await req.json()) as { title?: string };
  const title = body.title?.trim();
  if (!title) {
    return Response.json({ error: "title is required" }, { status: 400 });
  }

  const ok = await renameConversation(supabase, userId, orgId, id, title);
  if (!ok) {
    return Response.json({ error: "rename failed" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
