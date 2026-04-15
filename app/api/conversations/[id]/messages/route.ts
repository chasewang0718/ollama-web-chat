import { bindConversationBackend, getConversationBackend } from "@/lib/storage/bindings";
import {
  getControlPlaneStorageProvider,
  getStorageMode,
  getStorageProviderForBackend,
  resolveDefaultBackendForNewConversation,
} from "@/lib/storage/router";
import { getMemoryOrgId } from "@/lib/supabase/service";

type Params = { params: Promise<{ id: string }> };

function isLocalBackendUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("local service role client unavailable");
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const controlPlane = getControlPlaneStorageProvider();
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();

  if (!userId) {
    return Response.json({ messages: [] });
  }

  const bindingClient = controlPlane.createServiceRoleClient();
  const backend = bindingClient
    ? await getConversationBackend(bindingClient, userId, orgId, id)
    : undefined;
  if (backend) {
    const storage = getStorageProviderForBackend(backend);
    const messages = await storage.conversation
      .getMessages(userId, orgId, id)
      .catch(async (error: unknown) => {
        if (backend === "local" && isLocalBackendUnavailable(error)) {
          return getStorageProviderForBackend("cloud").conversation.getMessages(userId, orgId, id);
        }
        throw error;
      });
    return Response.json({ messages });
  }

  // Legacy compatibility: conversations created before binding rollout.
  // In hybrid mode, probe both backends and backfill binding once a hit is found.
  if (getStorageMode() === "hybrid") {
    const cloudStorage = getStorageProviderForBackend("cloud");
    const cloudMessages = await cloudStorage.conversation.getMessages(userId, orgId, id);
    if (cloudMessages.length > 0) {
      if (bindingClient) {
        await bindConversationBackend(bindingClient, userId, orgId, id, "cloud");
      }
      return Response.json({ messages: cloudMessages });
    }

    const localStorage = getStorageProviderForBackend("local");
    const localMessages = await localStorage.conversation
      .getMessages(userId, orgId, id)
      .catch(() => [] as Awaited<ReturnType<typeof localStorage.conversation.getMessages>>);
    if (localMessages.length > 0) {
      if (bindingClient) {
        await bindConversationBackend(bindingClient, userId, orgId, id, "local");
      }
      return Response.json({ messages: localMessages });
    }
  }

  const selectedBackend = resolveDefaultBackendForNewConversation(getStorageMode());
  const storage = getStorageProviderForBackend(selectedBackend);
  const messages = await storage.conversation
    .getMessages(userId, orgId, id)
    .catch(async (error: unknown) => {
      if (selectedBackend === "local" && isLocalBackendUnavailable(error)) {
        return getStorageProviderForBackend("cloud").conversation.getMessages(userId, orgId, id);
      }
      throw error;
    });
  return Response.json({ messages });
}
