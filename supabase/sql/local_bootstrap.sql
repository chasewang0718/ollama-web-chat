create extension if not exists vector;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.chat_conversations (
  id text primary key,
  org_id text not null,
  user_id uuid not null,
  title text not null default 'New Chat',
  summary text not null default '',
  last_message_preview text not null default '',
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists chat_conversations_user_org_updated_idx
on public.chat_conversations(user_id, org_id, updated_at desc);

drop trigger if exists trg_chat_conversations_updated_at on public.chat_conversations;
create trigger trg_chat_conversations_updated_at
before update on public.chat_conversations
for each row execute function public.set_updated_at();

create table if not exists public.memories (
  id bigserial primary key,
  org_id text not null,
  user_id uuid not null,
  content text not null,
  embedding vector(768),
  importance int not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists memories_user_org_updated_idx
on public.memories(user_id, org_id, updated_at desc);

create index if not exists memories_embedding_hnsw_idx
on public.memories using hnsw (embedding vector_cosine_ops);

drop trigger if exists trg_memories_updated_at on public.memories;
create trigger trg_memories_updated_at
before update on public.memories
for each row execute function public.set_updated_at();

create table if not exists public.memory_summaries (
  id bigserial primary key,
  org_id text not null,
  user_id uuid not null,
  summary text not null,
  turn_count int not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, org_id)
);

drop trigger if exists trg_memory_summaries_updated_at on public.memory_summaries;
create trigger trg_memory_summaries_updated_at
before update on public.memory_summaries
for each row execute function public.set_updated_at();

create table if not exists public.memory_versions (
  id bigserial primary key,
  org_id text not null,
  user_id uuid not null,
  memory_key text not null,
  version int not null,
  content text not null,
  action text not null check (action in ('insert', 'update')),
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists memory_versions_unique_key
on public.memory_versions(user_id, org_id, memory_key, version);

create index if not exists memory_versions_lookup_idx
on public.memory_versions(user_id, org_id, memory_key, created_at desc);

create table if not exists public.conversation_storage_bindings (
  conversation_id text primary key,
  org_id text not null,
  user_id uuid not null,
  storage_backend text not null check (storage_backend in ('cloud', 'local')),
  migration_status text not null default 'none'
    check (migration_status in ('none', 'pending', 'running', 'failed', 'done')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists conversation_storage_bindings_lookup_idx
on public.conversation_storage_bindings(user_id, org_id, created_at desc);

drop trigger if exists trg_conversation_storage_bindings_updated_at on public.conversation_storage_bindings;
create trigger trg_conversation_storage_bindings_updated_at
before update on public.conversation_storage_bindings
for each row execute function public.set_updated_at();

create or replace function public.match_memories(
  query_embedding vector(768),
  match_count int,
  filter_user_id uuid,
  filter_org_id text,
  min_similarity double precision default 0.55
)
returns table (
  id bigint,
  content text,
  similarity double precision,
  importance int
)
language sql
stable
as $$
  select
    m.id,
    m.content,
    (1 - (m.embedding <=> query_embedding))::double precision as similarity,
    m.importance
  from public.memories m
  where m.user_id = filter_user_id
    and m.org_id is not distinct from filter_org_id
    and m.embedding is not null
    and (1 - (m.embedding <=> query_embedding)) >= min_similarity
  order by m.embedding <=> query_embedding
  limit greatest(1, least(match_count, 50));
$$;

-- Local-only compatibility: when migrating cloud records, the user UUID may not
-- exist in local auth.users. Drop auth FK constraints to avoid migration failures.
alter table if exists public.chat_conversations
  drop constraint if exists chat_conversations_user_id_fkey;
alter table if exists public.memories
  drop constraint if exists memories_user_id_fkey;
alter table if exists public.memory_summaries
  drop constraint if exists memory_summaries_user_id_fkey;
alter table if exists public.memory_versions
  drop constraint if exists memory_versions_user_id_fkey;
alter table if exists public.conversation_storage_bindings
  drop constraint if exists conversation_storage_bindings_user_id_fkey;
