-- L2 summary table for long sessions (writing workflow).
-- Run in Supabase SQL Editor.

create table if not exists public.memory_summaries (
  id bigserial primary key,
  org_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
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

alter table public.memory_summaries enable row level security;

drop policy if exists "summary_select_own" on public.memory_summaries;
create policy "summary_select_own"
on public.memory_summaries
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "summary_insert_own" on public.memory_summaries;
create policy "summary_insert_own"
on public.memory_summaries
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "summary_update_own" on public.memory_summaries;
create policy "summary_update_own"
on public.memory_summaries
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
