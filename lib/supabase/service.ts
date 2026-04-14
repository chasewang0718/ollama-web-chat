import { createClient } from "@supabase/supabase-js";

/**
 * Step 1 — 目的：在服务端用 Service Role 访问数据库。
 * 浏览器里的 anon key 受 RLS 限制，无法在「未登录」场景下写入 memories。
 * Service Role 仅放在服务器环境变量中，绝不暴露给前端。
 */
export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function isMemoryStorageConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.MEMORY_USER_ID,
  );
}
