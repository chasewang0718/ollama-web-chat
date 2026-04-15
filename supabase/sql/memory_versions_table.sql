-- Version history for long-term memories (dedup/conflict merge trace).
-- Run in Supabase SQL Editor.

create table if not exists public.memory_versions (
  id bigserial primary key,
  org_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
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

alter table public.memory_versions enable row level security;

drop policy if exists "memory_versions_select_own" on public.memory_versions;
create policy "memory_versions_select_own"
on public.memory_versions
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "memory_versions_insert_own" on public.memory_versions;
create policy "memory_versions_insert_own"
on public.memory_versions
for insert
to authenticated
with check (auth.uid() = user_id);
