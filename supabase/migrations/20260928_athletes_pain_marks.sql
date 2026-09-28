-- T64 S2: the pain ledger's marks. Additive, nullable, invisible to the current
-- client. Shape: {areaKey: {cleared_at, dismissed_at, offered_at, asked_at,
-- noted_at, declined_change_count}} — written by the chat post-parse step, the
-- MY LOG "resolved" button (alongside the legacy resolved_pain array) and the
-- check-in (S4). api/data.js allowlists it with a shape guard (validPainMarks).
alter table public.athletes add column if not exists pain_marks jsonb;
comment on column public.athletes.pain_marks is 'T64 pain ledger marks: {areaKey: {cleared_at, dismissed_at, offered_at, asked_at, noted_at, declined_change_count}}';
