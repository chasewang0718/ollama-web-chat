import { bindConversationBackend, listConversationBindings } from "@/lib/storage/bindings";
import {
  getControlPlaneStorageProvider,
  getStorageMode,
  getStorageProvider,
  getStorageProviderForBackend,
  resolveDefaultBackendForNewConversation,
} from "@/lib/storage/router";
import { getMemoryOrgId } from "@/lib/supabase/service";

export async function GET() {
  const mode = getStorageMode();
  const storage = getStorageProvider();
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();

  if (!userId) {
    return Response.json({ conversations: [] });
  }

  if (mode === "hybrid") {
    const cloud = await getStorageProviderForBackend("cloud").conversation
      .list(userId, orgId)
      .catch((error: unknown) => {
        console.warn("hybrid list cloud failed", error);
        return { conversations: [] };
      });
    const local = await getStorageProviderForBackend("local").conversation
      .list(userId, orgId)
      .catch((error: unknown) => {
        console.warn("hybrid list local failed", error);
        return { conversations: [] };
      });
    const merged = new Map<
      string,
      {
        id: string;
        title: string;
        updated_at: string;
        created_at: string;
        storage_backend: "cloud" | "local";
      }
    >();

    for (const item of cloud.conversations) {
      const prev = merged.get(item.id);
      if (!prev || new Date(item.updated_at).getTime() > new Date(prev.updated_at).getTime()) {
        merged.set(item.id, { ...item, storage_backend: "cloud" });
      }
    }
    for (const item of local.conversations) {
      const prev = merged.get(item.id);
      if (!prev || new Date(item.updated_at).getTime() > new Date(prev.updated_at).getTime()) {
        merged.set(item.id, { ...item, storage_backend: "local" });
      }
    }

    const bindingClient = getControlPlaneStorageProvider().createServiceRoleClient();
    if (bindingClient) {
      const bindings = await listConversationBindings(bindingClient, userId, orgId, { limit: 1000, offset: 0 });
      const bindingById = new Map(bindings.map((item) => [item.conversation_id, item.storage_backend]));
      for (const [id, item] of merged.entries()) {
        const bound = bindingById.get(id);
        if (bound) {
          merged.set(id, { ...item, storage_backend: bound });
        }
      }
    }

    const conversations = [...merged.values()].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    return Response.json({ conversations });
  }

  const result = await storage.conversation.list(userId, orgId);
  if (result.error) {
    console.warn("list conversations failed", result.error);
    return Response.json(
      { conversations: [], error: "chat_conversations table unavailable" },
      { status: 500 },
    );
  }

  const defaultBackend = mode === "local" ? "local" : "cloud";
  return Response.json({
    conversations: result.conversations.map((item) => ({ ...item, storage_backend: defaultBackend })),
  });
}

export async function POST() {
  const mode = getStorageMode();
  const defaultBackend = resolveDefaultBackendForNewConversation(mode);
  const storage = getStorageProviderForBackend(defaultBackend);
  const controlPlane = getControlPlaneStorageProvider();
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();

  if (!userId) {
    return Response.json({ error: "memory store unavailable" }, { status: 500 });
  }

  const conversation = await storage.conversation.create(
    userId,
    orgId,
    storage.createConversationId(),
  );
  if (!conversation) {
    return Response.json({ error: "chat_conversations table unavailable" }, { status: 500 });
  }

  const bindingClient = controlPlane.createServiceRoleClient();
  if (bindingClient) {
    await bindConversationBackend(bindingClient, userId, orgId, conversation.id, defaultBackend);
  }

  return Response.json({ conversation: { ...conversation, storage_backend: defaultBackend } });
}
