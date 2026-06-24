-- ─── Phase 1: deny anonymous writes (close the write hole) ───────────────────
-- After this runs, the public (anon) key can NO LONGER insert/update/delete.
-- The app writes through api/data.js using the service_role key, which BYPASSES
-- RLS, so the app keeps working. Tables the browser still READS directly keep
-- anonymous SELECT; everything else is fully closed to anon.
--
-- Run AFTER confirming the deployed app's writes work (logging a workout, etc.).
-- Wrap in a transaction is NOT useful here (you must test against the committed
-- state) — instead, the emergency UNDO block at the bottom re-opens writes if
-- anything breaks while you debug.

DO $$
DECLARE
  -- Browser reads these directly -> keep anon SELECT, deny anon writes.
  read_tables   text[] := ARRAY['workouts','prs','proof_digests','manual_one_rms','athlete_goals','athlete_context'];
  -- Only the server touches these -> deny anon entirely (reads already go server-side).
  server_tables text[] := ARRAY['athletes','coaches','schools','legal_acceptances','deletion_requests','push_subscriptions','program_modifications'];
  t text;
  p record;
BEGIN
  -- 1. Clean slate: drop every existing policy on the target tables.
  FOR p IN SELECT policyname, tablename FROM pg_policies
           WHERE schemaname='public' AND tablename = ANY(read_tables || server_tables)
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename);
  END LOOP;

  -- 2. Enable RLS everywhere (default-deny until a policy says otherwise).
  FOREACH t IN ARRAY (read_tables || server_tables) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;

  -- 3. Read tables: anon + logged-in may SELECT only. No write policy => writes denied.
  FOREACH t IN ARRAY read_tables LOOP
    EXECUTE format('CREATE POLICY anon_read ON public.%I FOR SELECT TO anon, authenticated USING (true)', t);
  END LOOP;

  -- 4. Server-only tables: no anon policies at all => anon fully denied.
  --    (service_role bypasses RLS, so api/* keeps working.)
END $$;


-- ─── EMERGENCY UNDO — run ONLY if the app breaks and you need writes back ─────
-- Re-opens anon writes (reverts to the pre-lock "hole open" state) so the app
-- works while we debug. Then we re-apply the lock once fixed.
--
-- DO $$
-- DECLARE t text; all_tables text[] := ARRAY[
--   'workouts','prs','proof_digests','manual_one_rms','athlete_goals','athlete_context',
--   'athletes','coaches','schools','legal_acceptances','deletion_requests','push_subscriptions','program_modifications'];
-- BEGIN
--   FOREACH t IN ARRAY all_tables LOOP
--     EXECUTE format('CREATE POLICY emergency_open ON public.%I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
--   END LOOP;
-- END $$;
