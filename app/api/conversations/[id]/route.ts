import {
  bindConversationBackend,
  getConversationBackend,
} from "@/lib/storage/bindings";
import {
  getStorageMode,
  getControlPlaneStorageProvider,
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

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const controlPlane = getControlPlaneStorageProvider();
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();

  if (!userId) {
    return Response.json({ error: "memory store unavailable" }, { status: 500 });
  }

  const bindingClient = controlPlane.createServiceRoleClient();
  const backend = bindingClient
    ? await getConversationBackend(bindingClient, userId, orgId, id)
    : undefined;
  const candidates = resolveBackendCandidates(backend);
  let ok = false;
  let touchedBackend: "cloud" | "local" | undefined;

  for (const selectedBackend of candidates) {
    const storage = getStorageProviderForBackend(selectedBackend);
    try {
      ok = await storage.conversation.delete(userId, orgId, id);
    } catch (error) {
      if (selectedBackend === "local" && isLocalBackendUnavailable(error)) {
        ok = false;
      } else {
        throw error;
      }
    }
    if (ok) {
      touchedBackend = selectedBackend;
      break;
    }
  }

  if (!ok) {
    return Response.json({ error: "delete failed" }, { status: 500 });
  }
  if (!backend && touchedBackend && bindingClient) {
    await bindConversationBackend(bindingClient, userId, orgId, id, touchedBackend);
  }
  return Response.json({ ok: true });
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const controlPlane = getControlPlaneStorageProvider();
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();

  if (!userId) {
    return Response.json({ error: "memory store unavailable" }, { status: 500 });
  }

  const body = (await req.json()) as { title?: string };
  const title = body.title?.trim();
  if (!title) {
    return Response.json({ error: "title is required" }, { status: 400 });
  }

  const bindingClient = controlPlane.createServiceRoleClient();
  const backend = bindingClient
    ? await getConversationBackend(bindingClient, userId, orgId, id)
    : undefined;
  const candidates = resolveBackendCandidates(backend);
  let ok = false;
  let touchedBackend: "cloud" | "local" | undefined;

  for (const selectedBackend of candidates) {
    const storage = getStorageProviderForBackend(selectedBackend);
    try {
      ok = await storage.conversation.rename(userId, orgId, id, title);
    } catch (error) {
      if (selectedBackend === "local" && isLocalBackendUnavailable(error)) {
        ok = false;
      } else {
        throw error;
      }
    }
    if (ok) {
      touchedBackend = selectedBackend;
      break;
    }
  }

  if (!ok) {
    return Response.json({ error: "rename failed" }, { status: 500 });
  }
  if (!backend && touchedBackend && bindingClient) {
    await bindConversationBackend(bindingClient, userId, orgId, id, touchedBackend);
  }
  return Response.json({ ok: true });
}
