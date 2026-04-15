-- Control-plane routing table: binds each conversation to a storage backend.
-- Run in Supabase SQL Editor.

create table if not exists public.conversation_storage_bindings (
  conversation_id text primary key,
  org_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
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

alter table public.conversation_storage_bindings enable row level security;

drop policy if exists "conversation_storage_bindings_select_own" on public.conversation_storage_bindings;
create policy "conversation_storage_bindings_select_own"
on public.conversation_storage_bindings
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "conversation_storage_bindings_insert_own" on public.conversation_storage_bindings;
create policy "conversation_storage_bindings_insert_own"
on public.conversation_storage_bindings
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "conversation_storage_bindings_update_own" on public.conversation_storage_bindings;
create policy "conversation_storage_bindings_update_own"
on public.conversation_storage_bindings
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
