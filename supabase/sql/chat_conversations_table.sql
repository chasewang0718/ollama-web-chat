-- Conversation storage for Gemini-like sidebar history and session isolation.
-- Run in Supabase SQL Editor.

create table if not exists public.chat_conversations (
  id text primary key,
  org_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '新对话',
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

alter table public.chat_conversations enable row level security;

drop policy if exists "chat_conversations_select_own" on public.chat_conversations;
create policy "chat_conversations_select_own"
on public.chat_conversations
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "chat_conversations_insert_own" on public.chat_conversations;
create policy "chat_conversations_insert_own"
on public.chat_conversations
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "chat_conversations_update_own" on public.chat_conversations;
create policy "chat_conversations_update_own"
on public.chat_conversations
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
