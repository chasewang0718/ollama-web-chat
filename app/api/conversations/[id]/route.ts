import {
  getConversationBackend,
} from "@/lib/storage/bindings";
import {
  getControlPlaneStorageProvider,
  getStorageMode,
  getStorageProviderForBackend,
  resolveDefaultBackendForNewConversation,
} from "@/lib/storage/router";
import { getMemoryOrgId } from "@/lib/supabase/service";

type Params = { params: Promise<{ id: string }> };

function resolveBackendOrDefault(
  backend: "cloud" | "local" | undefined,
): "cloud" | "local" {
  if (backend) return backend;
  return resolveDefaultBackendForNewConversation(getStorageMode());
}

function isLocalBackendUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("local service role client unavailable");
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
  const selectedBackend = resolveBackendOrDefault(backend);
  const storage = getStorageProviderForBackend(selectedBackend);
  let ok = false;
  try {
    ok = await storage.conversation.delete(userId, orgId, id);
  } catch (error) {
    if (selectedBackend === "local" && isLocalBackendUnavailable(error)) {
      ok = await getStorageProviderForBackend("cloud").conversation.delete(userId, orgId, id);
    } else {
      throw error;
    }
  }
  if (!ok) {
    return Response.json({ error: "delete failed" }, { status: 500 });
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
  const selectedBackend = resolveBackendOrDefault(backend);
  const storage = getStorageProviderForBackend(selectedBackend);
  let ok = false;
  try {
    ok = await storage.conversation.rename(userId, orgId, id, title);
  } catch (error) {
    if (selectedBackend === "local" && isLocalBackendUnavailable(error)) {
      ok = await getStorageProviderForBackend("cloud").conversation.rename(userId, orgId, id, title);
    } else {
      throw error;
    }
  }
  if (!ok) {
    return Response.json({ error: "rename failed" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
