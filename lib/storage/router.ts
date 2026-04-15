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
