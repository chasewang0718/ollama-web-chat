-- Step 3 — 目的：在数据库里提供「按向量相似度取 Top-K」的能力。
-- 表含 org_id 时需同时按组织过滤。在 Supabase SQL Editor 中整段执行（维度须与 memories.embedding 一致，默认 768）。

-- 若曾创建过三参数旧版，先删掉避免重载冲突
drop function if exists public.match_memories(vector, int, uuid);

create or replace function public.match_memories(
  query_embedding vector(768),
  match_count int,
  filter_user_id uuid,
  filter_org_id text
)
returns table (
  id bigint,
  content text,
  similarity double precision
)
language sql
stable
as $$
  select
    m.id,
    m.content,
    (1 - (m.embedding <=> query_embedding))::double precision as similarity
  from public.memories m
  where m.user_id = filter_user_id
    and m.org_id is not distinct from filter_org_id
    and m.embedding is not null
  order by m.embedding <=> query_embedding
  limit greatest(1, least(match_count, 50));
$$;

grant execute on function public.match_memories(vector, int, uuid, text) to service_role;
grant execute on function public.match_memories(vector, int, uuid, text) to authenticated;
