-- Step 3 — 目的：在数据库里提供「按向量相似度取 Top-K」的能力。
-- PostgREST 不方便直接写 `<=>` 排序，用 RPC 封装后，应用里一行 supabase.rpc 即可。
-- 在 Supabase SQL Editor 中执行本文件（维度须与 memories.embedding 一致，默认 768）。

create or replace function public.match_memories(
  query_embedding vector(768),
  match_count int,
  filter_user_id uuid
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
    and m.embedding is not null
  order by m.embedding <=> query_embedding
  limit greatest(1, least(match_count, 50));
$$;

grant execute on function public.match_memories(vector, int, uuid) to service_role;
grant execute on function public.match_memories(vector, int, uuid) to authenticated;
