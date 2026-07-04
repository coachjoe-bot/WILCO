-- ─── Backfill: record the schema of program_modifications ────────────────────
-- This table has existed in the live database since before 2026-06-21 (created
-- ad-hoc via the Supabase dashboard) but was never captured as a migration file,
-- which made it look dead in the repo. It is alive and working:
--   * App.jsx writes a pr_propagation audit row whenever a new PR auto-rewrites
--     an athlete's program_text (routed through api/data.js with the service key).
--   * 20260624_phase1_lock_writes.sql already enabled RLS with no anon policies,
--     so the anon key can neither read nor write it (verified live 2026-07-04).
--   * Both deletion cascades (api/process-deletions.js and the edge function)
--     purge it by athlete_id.
-- Running this against prod is a no-op; it exists so a fresh environment gets
-- the same table and so the repo reflects reality. Schema below matches the
-- live table exactly (via the PostgREST OpenAPI definitions, 2026-07-04).

CREATE TABLE IF NOT EXISTS public.program_modifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id uuid REFERENCES public.athletes(id),
  modification_type text,
  description text,
  old_value text,
  new_value text,
  created_at timestamp DEFAULT now()
);

-- Server-only table: RLS on, no anon policies => anon fully denied.
-- (Idempotent — already applied to prod by 20260624_phase1_lock_writes.sql.)
ALTER TABLE public.program_modifications ENABLE ROW LEVEL SECURITY;
