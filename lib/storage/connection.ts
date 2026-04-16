import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { StorageBackend } from "@/lib/storage/types";

const execAsync = promisify(exec);
const START_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 4_000;

type EnsureBackendReadyResult =
  | { ok: true }
  | { ok: false; error: string };

let localBootPromise: Promise<void> | null = null;

function toBaseUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/$/, "");
}

async function probeSupabase(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/rest/v1/`, {
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function ensureLocalSupabaseStarted(cwd: string) {
  if (localBootPromise) {
    await localBootPromise;
    return;
  }
  localBootPromise = (async () => {
    const projectRoot = resolveSupabaseProjectRoot(cwd);
    const commands =
      process.platform === "win32"
        ? [
            `${process.env.ComSpec || "cmd.exe"} /d /s /c "npx supabase start"`,
            `${process.env.ComSpec || "cmd.exe"} /d /s /c "npm exec supabase start"`,
          ]
        : ["npx supabase start", "npm exec supabase start"];
    const failures: string[] = [];

    for (const command of commands) {
      try {
        await execAsync(command, { cwd: projectRoot, timeout: START_TIMEOUT_MS });
        return;
      } catch (error) {
        failures.push(formatCommandFailure(command, error));
      }
    }
    throw new Error(`all startup commands failed:\n${failures.join("\n")}`);
  })();

  try {
    await localBootPromise;
  } finally {
    localBootPromise = null;
  }
}

function formatCommandFailure(command: string, error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const maybe = error as { message?: string; stderr?: string; stdout?: string };
    const details = [maybe.message, maybe.stderr, maybe.stdout].filter((x) => x && x.trim()).join(" | ");
    return `${command} => ${details || "unknown error"}`;
  }
  return `${command} => ${String(error)}`;
}

function resolveSupabaseProjectRoot(cwd: string): string {
  const candidates = [
    cwd,
    process.cwd(),
    path.resolve(cwd, ".."),
    path.resolve(cwd, "../.."),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "supabase"))) {
      return candidate;
    }
  }
  return cwd;
}

export async function ensureBackendReady(backend: StorageBackend): Promise<EnsureBackendReadyResult> {
  if (backend === "cloud") {
    const url = toBaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return { ok: false, error: "云端数据库配置缺失（NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）。" };
    }
    const ok = await probeSupabase(url, key);
    return ok ? { ok: true } : { ok: false, error: "云端数据库连接失败，请检查网络或 Supabase 项目状态。" };
  }

  const localUrl = toBaseUrl(process.env.LOCAL_SUPABASE_URL);
  const localKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
  if (!localUrl || !localKey) {
    return { ok: false, error: "本地数据库配置缺失（LOCAL_SUPABASE_URL / LOCAL_SUPABASE_SERVICE_ROLE_KEY）。" };
  }

  if (await probeSupabase(localUrl, localKey)) {
    return { ok: true };
  }

  try {
    await ensureLocalSupabaseStarted(process.cwd());
  } catch (error) {
    return {
      ok: false,
      error: `自动启动本地 Supabase 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (await probeSupabase(localUrl, localKey)) {
    return { ok: true };
  }
  return { ok: false, error: "本地数据库启动后仍不可连接，请检查 Docker Desktop 和端口 54321。" };
}
