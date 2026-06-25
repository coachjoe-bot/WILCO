-- ─── Phase 1b(b): deny anonymous SELECT on workouts + prs ───────────────────
-- These tables hold athletes' (incl. minors') training PII. Until now the public
-- (anon) bundle key could read EVERY row. The app now reads them through the
-- authenticated, role-scoped gateway (api/data.js, op:"read") using the
-- service_role key, which BYPASSES RLS — so dropping the anon SELECT policy keeps
-- the app working while closing the anon read hole.
--
-- Scope: ONLY workouts + prs. The other four still-anon-readable tables
-- (proof_digests, manual_one_rms, athlete_goals, athlete_context) keep their
-- anon_read policy for now — their reads have NOT been moved server-side yet.
--
-- RUN ONLY AFTER the gateway read path is deployed AND verified:
--   • athlete view (own workouts/prs load), AND
--   • coach dashboard + recalc PRs (master + a regular coach) — the coach path
--     could not be tested locally, so confirm it on the deployed app first.
-- The emergency UNDO block at the bottom re-opens anon reads if anything breaks.

DO $$
BEGIN
  -- Drop the anon SELECT policy added in Phase 1 for these two tables only.
  -- RLS stays enabled; with no SELECT policy, anon is denied. service_role bypasses.
  DROP POLICY IF EXISTS anon_read ON public.workouts;
  DROP POLICY IF EXISTS anon_read ON public.prs;
END $$;


-- ─── EMERGENCY UNDO — run ONLY if the app breaks and you need anon reads back ──
-- Re-creates the anon SELECT policy (reverts to the pre-lock readable state) so
-- the app works while we debug. Re-apply the lock above once fixed.
--
-- DO $$
-- BEGIN
--   CREATE POLICY anon_read ON public.workouts FOR SELECT TO anon, authenticated USING (true);
--   CREATE POLICY anon_read ON public.prs      FOR SELECT TO anon, authenticated USING (true);
-- END $$;
