-- ─── Phase 1c: deny anonymous SELECT on the remaining PII read-tables ────────
-- Completes the read lockdown started in Phase 1b(b) (which closed workouts+prs).
-- These four tables also held athlete (incl. minor) PII readable by the public
-- (anon) bundle key:
--   proof_digests   — AI-generated training digests
--   manual_one_rms  — manually entered 1-rep maxes
--   athlete_goals   — stated training goals
--   athlete_context — monthly-recap context blobs
--
-- The app now reads all four through the authenticated, role-scoped gateway
-- (api/data.js, op:"read") using the service_role key, which BYPASSES RLS — so
-- dropping the anon SELECT policy closes the anon read hole without breaking the
-- app. RLS stays enabled (from the Phase 1 lock); with no SELECT policy, anon is
-- denied while service_role keeps working.
--
-- After this runs, NO app table is anonymously readable; the anon bundle key can
-- neither read nor write any PII. (Login/onboarding go through api/identity.js.)
--
-- RUN ONLY AFTER the Phase 1c code is deployed AND verified:
--   • athlete view loads goals / context / digest / manual 1RMs, AND
--   • coach dashboard still shows proof digests (proof_digests is the one table
--     here also read on the coach path — verify on the live app first).
-- The emergency UNDO block at the bottom re-opens anon reads if anything breaks.

DO $$
DECLARE
  read_tables text[] := ARRAY['proof_digests','manual_one_rms','athlete_goals','athlete_context'];
  t text;
BEGIN
  FOREACH t IN ARRAY read_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS anon_read ON public.%I', t);
  END LOOP;
END $$;


-- ─── EMERGENCY UNDO — run ONLY if the app breaks and you need anon reads back ──
-- DO $$
-- DECLARE
--   read_tables text[] := ARRAY['proof_digests','manual_one_rms','athlete_goals','athlete_context'];
--   t text;
-- BEGIN
--   FOREACH t IN ARRAY read_tables LOOP
--     EXECUTE format('CREATE POLICY anon_read ON public.%I FOR SELECT TO anon, authenticated USING (true)', t);
--   END LOOP;
-- END $$;
