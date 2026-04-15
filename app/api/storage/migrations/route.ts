import {
  getConversationBinding,
  listConversationBindings,
} from "@/lib/storage/bindings";
import {
  migrateConversationBetweenBackends,
  migrateConversationsBatch,
} from "@/lib/storage/migration";
import { getControlPlaneStorageProvider } from "@/lib/storage/router";
import type { StorageBackend } from "@/lib/storage/types";
import { getMemoryOrgId } from "@/lib/supabase/service";

type MigrationRequest = {
  mode?: "single" | "batch";
  conversationId?: string;
  conversationIds?: string[];
  targetBackend?: StorageBackend;
  rollback?: boolean;
  dryRun?: boolean;
  onlyFailed?: boolean;
  continueOnError?: boolean;
  limit?: number;
  offset?: number;
};

function isBackend(value: string | undefined): value is StorageBackend {
  return value === "cloud" || value === "local";
}

export async function GET(req: Request) {
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();
  const url = new URL(req.url);
  const conversationId = (url.searchParams.get("conversationId") || "").trim();
  const mode = (url.searchParams.get("mode") || "").trim().toLowerCase();
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1),
    500,
  );
  const offset = Math.max(Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
  const onlyFailed = url.searchParams.get("onlyFailed") === "true";

  if (!userId) {
    return Response.json({ error: "userId missing" }, { status: 400 });
  }

  const controlPlane = getControlPlaneStorageProvider();
  const client = controlPlane.createServiceRoleClient();
  if (!client) {
    return Response.json({ error: "control plane unavailable" }, { status: 500 });
  }

  if (mode === "batch" || (!conversationId && (limit > 0 || offset >= 0))) {
    const items = await listConversationBindings(client, userId, orgId, {
      limit,
      offset,
      migrationStatus: onlyFailed ? "failed" : undefined,
    });
    return Response.json({
      mode: "batch",
      pagination: { limit, offset, count: items.length },
      filter: { onlyFailed },
      items,
    });
  }

  if (!conversationId) {
    return Response.json({ error: "conversationId is required for single mode" }, { status: 400 });
  }

  const binding = await getConversationBinding(client, userId, orgId, conversationId);
  return Response.json({ binding: binding || null });
}

export async function POST(req: Request) {
  const userId = process.env.MEMORY_USER_ID;
  const orgId = getMemoryOrgId();
  if (!userId) {
    return Response.json({ error: "memory user unavailable" }, { status: 500 });
  }

  const body = (await req.json()) as MigrationRequest;
  const conversationId = body.conversationId?.trim();
  const rollback = Boolean(body.rollback);
  const dryRun = Boolean(body.dryRun);
  const mode = body.mode || (body.conversationIds?.length ? "batch" : "single");

  const controlPlane = getControlPlaneStorageProvider();
  const client = controlPlane.createServiceRoleClient();
  if (!client) {
    return Response.json({ error: "control plane unavailable" }, { status: 500 });
  }

  if (mode === "batch") {
    const directIds = (body.conversationIds || []).map((x) => x.trim()).filter(Boolean);
    const limit = Math.min(Math.max(body.limit || 50, 1), 500);
    const offset = Math.max(body.offset || 0, 0);
    const migrationStatus = body.onlyFailed ? "failed" : undefined;
    const fromBindings = await listConversationBindings(client, userId, orgId, {
      limit,
      offset,
      migrationStatus,
    });
    const bindingIds = fromBindings.map((x) => x.conversation_id);
    const conversationIds = Array.from(new Set([...directIds, ...bindingIds]));

    if (!conversationIds.length) {
      return Response.json({
        ok: true,
        total: 0,
        succeeded: 0,
        failed: 0,
        results: [],
      });
    }

    const defaultBackend = isBackend(body.targetBackend) ? body.targetBackend : "local";
    const batchResult = await migrateConversationsBatch(client, {
      userId,
      orgId,
      conversationIds,
      targetBackend: defaultBackend,
      rollback,
      dryRun,
      continueOnError: body.continueOnError !== false,
    });

    if (!batchResult.ok) {
      return Response.json(batchResult, { status: 500 });
    }
    return Response.json(batchResult);
  }

  if (!conversationId) {
    return Response.json({ error: "conversationId is required" }, { status: 400 });
  }

  const current = await getConversationBinding(client, userId, orgId, conversationId);
  const currentBackend = current?.storage_backend || "cloud";
  const targetBackend = isBackend(body.targetBackend)
    ? body.targetBackend
    : currentBackend === "cloud"
      ? "local"
      : "cloud";

  const result = await migrateConversationBetweenBackends(client, {
    userId,
    orgId,
    conversationId,
    targetBackend,
    rollback,
    dryRun,
  });

  if (!result.ok) {
    return Response.json(result, { status: 500 });
  }
  return Response.json(result);
}
