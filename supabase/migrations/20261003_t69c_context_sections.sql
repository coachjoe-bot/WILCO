-- T69-C (Will 10-01/10-02): the Athlete Context tab has six sections, and every
-- stored note knows its section and when it was last checked, so the weekly
-- check-in can ask about old notes (src/memoryReview.js). Additive and nullable:
-- no row changes, no script touches Will's notes (his existing rows get a
-- section from code at read time and join the queue spread over 8 weeks).
--
--   athlete_memory.section       schedule | body | preferences | this_week (or null = legacy)
--   athlete_memory.confirmed_at  when the athlete last confirmed, edited or wrote the note
--   athlete_memory.ask_count     asked and answered without an answer; the second removes it
--   athlete_memory.area_key      the pain area a work-around note is tied to (pain stays in
--                                the ledger; only the athlete's own work-around is stored)
--   athlete_goals.confirmed_at / ask_count   the same two stamps for the goal
--   athletes.review_stamps       {training_days_per_week|equipment|injury_history: {confirmed_at, ask_count}}
--                                the three signup fields the check-in re-confirms
--
-- Gateway twins (api/data.js): ATHLETE_COL_ALLOW.athlete_memory (cols + value
-- guards, section enum), ATHLETE_COL_ALLOW.athletes (review_stamps, validReviewStamps).
-- The section list here, in that guard, and in src/memorySections.js NOTE_SECTIONS
-- must move together. athlete_goals has no column allowlist (row-scoped only).
-- APPLIED to prod via MCP ahead of the client that writes it.
ALTER TABLE public.athlete_memory
  ADD COLUMN IF NOT EXISTS section text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ask_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS area_key text;
ALTER TABLE public.athlete_memory ADD CONSTRAINT athlete_memory_section_check
  CHECK (section IS NULL OR section = ANY (ARRAY['schedule'::text, 'body'::text, 'preferences'::text, 'this_week'::text]));
ALTER TABLE public.athlete_memory ADD CONSTRAINT athlete_memory_ask_count_check
  CHECK (ask_count IS NULL OR (ask_count >= 0 AND ask_count <= 9));
ALTER TABLE public.athlete_goals
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ask_count integer DEFAULT 0;
ALTER TABLE public.athletes
  ADD COLUMN IF NOT EXISTS review_stamps jsonb;
