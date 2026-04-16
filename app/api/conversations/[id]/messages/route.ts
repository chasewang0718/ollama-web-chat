import { bindConversationBackend, getConversationBackend } from "@/lib/storage/bindings";
import { ensureBackendReady } from "@/lib/storage/connection";
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

function resolveBackendCandidates(bound?: "cloud" | "local"): Array<"cloud" | "local"> {
  if (bound) return [bound, bound === "cloud" ? "local" : "cloud"];
  if (getStorageMode() === "hybrid") return ["cloud", "local"];
  const fallback = resolveDefaultBackendForNewConversation(getStorageMode());
  return fallback === "cloud" ? ["cloud", "local"] : ["local", "cloud"];
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
  const candidates = resolveBackendCandidates(backend);
  let firstError: unknown = undefined;

  for (const selectedBackend of candidates) {
    const ready = await ensureBackendReady(selectedBackend);
    if (!ready.ok) {
      continue;
    }
    const storage = getStorageProviderForBackend(selectedBackend);
    try {
      const messages = await storage.conversation.getMessages(userId, orgId, id);
      if (!backend && bindingClient && messages.length > 0) {
        await bindConversationBackend(bindingClient, userId, orgId, id, selectedBackend);
      }
      if (messages.length > 0) {
        return Response.json({ messages });
      }
      // Keep probing when no messages are found, because legacy conversations may be on the other backend.
    } catch (error) {
      if (selectedBackend === "local" && isLocalBackendUnavailable(error)) {
        continue;
      }
      if (!firstError) firstError = error;
    }
  }

  if (firstError) {
    throw firstError;
  }
  return Response.json({ messages: [] });
}
