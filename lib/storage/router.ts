import { createCloudStorageProvider } from "@/lib/storage/providers/cloud";
import { createLocalStorageProvider } from "@/lib/storage/providers/local";
import type { StorageBackend, StorageMode } from "@/lib/storage/types";

function resolveStorageMode(): StorageMode {
  const raw = process.env.STORAGE_MODE?.trim().toLowerCase();
  if (raw === "local" || raw === "hybrid" || raw === "cloud") return raw;
  return "cloud";
}

export function resolveDefaultBackendForNewConversation(mode: StorageMode): StorageBackend {
  if (mode === "local") return "local";
  if (mode === "hybrid") {
    const raw = process.env.STORAGE_HYBRID_WRITE_BACKEND?.trim().toLowerCase();
    if (raw === "local" || raw === "cloud") return raw;
  }
  return "cloud";
}

/**
 * Resolves which backend to use when creating a conversation.
 * Optional `requested` comes from the client (e.g. user chose cloud vs local in hybrid mode).
 */
export function resolveBackendForNewConversation(
  mode: StorageMode,
  requested?: StorageBackend,
): { backend: StorageBackend } | { error: string } {
  if (requested === undefined) {
    return { backend: resolveDefaultBackendForNewConversation(mode) };
  }
  if (mode === "hybrid") {
    return { backend: requested };
  }
  if (mode === "cloud") {
    if (requested === "local") {
      return { error: "当前为仅云端模式，无法创建本地会话。" };
    }
    return { backend: "cloud" };
  }
  if (mode === "local") {
    if (requested === "cloud") {
      return { error: "当前为仅本地模式，无法创建云端会话。" };
    }
    return { backend: "local" };
  }
  return { backend: resolveDefaultBackendForNewConversation(mode) };
}

/**
 * Iteration 1: keep behavior unchanged.
 * Always route to cloud provider while introducing the router boundary.
 */
export function getStorageProvider() {
  return getStorageProviderForBackend(resolveDefaultBackendForNewConversation(resolveStorageMode()));
}

export function getStorageMode(): StorageMode {
  return resolveStorageMode();
}

export function getStorageProviderForBackend(backend: StorageBackend) {
  if (backend === "local") {
    return createLocalStorageProvider();
  }
  return createCloudStorageProvider();
}

export function getControlPlaneStorageProvider() {
  const mode = resolveStorageMode();
  if (mode === "local") {
    return createLocalStorageProvider();
  }
  return createCloudStorageProvider();
}
