-- One-time cleanup for historical English/noise memories.
-- Run carefully in Supabase SQL Editor after reviewing result counts.

-- 1) Preview candidates (read-only)
select
  id,
  left(content, 160) as preview,
  importance,
  created_at,
  updated_at
from public.memories
where org_id = 'local-dev'
  and (
    content ilike '%is there anything else%'
    or content ilike '%would you like to brainstorm%'
    or content ilike '%let me know how I can be of assistance%'
    or content ilike '%what can i help you with%'
  )
order by updated_at desc;

-- 2) Delete only the obvious assistant-noise records.
-- Uncomment after checking the preview above.
-- delete from public.memories
-- where org_id = 'local-dev'
--   and (
--     content ilike '%is there anything else%'
--     or content ilike '%would you like to brainstorm%'
--     or content ilike '%let me know how I can be of assistance%'
--     or content ilike '%what can i help you with%'
--   );

-- 3) Optional: remove legacy records before language policy fix (time-based).
-- Replace timestamp if needed, then uncomment.
-- delete from public.memories
-- where org_id = 'local-dev'
--   and updated_at < '2026-04-15T08:40:00Z'::timestamptz
--   and content ~* 'Assistant:\s*[A-Za-z]';
