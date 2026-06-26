-- ─── Proof Feed v2 — Phase 6: pg_cron scheduling (per-id fanout) ─────────────
-- Run in the Supabase SQL Editor AFTER 20260625_proof_feed_v2.sql is applied and
-- the Phase 0-6 code is deployed. Idempotent — safe to re-run.
--
-- WHY fanout: the Vercel engine must never loop the whole roster in one request
-- (Hobby 10s timeout). This job selects only the athletes/coaches DUE right now and
-- fires ONE net.http_post per id to the engine, which generates exactly one digest
-- per invocation. Scales to thousands of athletes — each is an independent ~3s job.
--
-- ── ONE-TIME SETUP (paste your values, run once) ──────────────────────────────
-- The engine URL and cron secret are read from DB settings so they're not stored
-- in source. Set them once (replace the placeholders), then run this whole file:
--
--   ALTER DATABASE postgres SET app.proof_engine_url   = 'https://app.trainwilco.com/api/trigger-proof-feed';
--   ALTER DATABASE postgres SET app.proof_cron_secret  = '<the CRON_SECRET value from Vercel>';
--
-- (ALTER DATABASE takes effect on NEW connections — pg_cron opens fresh ones, so
-- no reconnect needed for the jobs. To test inline in this session, also run the
-- two SET commands without ALTER DATABASE.)

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Athlete dispatch: fire one request per due athlete ────────────────────────
-- Due = proof on, hasn't run today, AND either the athlete's local day/hour matches
-- their chosen slot, or (no slot set) their weekly re-arm time has passed.
CREATE OR REPLACE FUNCTION proof_feed_dispatch_athletes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url    text := current_setting('app.proof_engine_url', true);
  v_secret text := current_setting('app.proof_cron_secret', true);
  v_count  integer := 0;
  r        record;
BEGIN
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'proof_feed_dispatch_athletes: app.proof_engine_url / app.proof_cron_secret not set — skipping';
    RETURN 0;
  END IF;

  FOR r IN
    SELECT id,
           COALESCE(proof_timezone, 'America/New_York') AS tz,
           proof_schedule_dow, proof_schedule_hour, next_proof_due_at
    FROM athletes
    WHERE proof_enabled IS NOT FALSE
      AND last_proof_run_date IS DISTINCT FROM CURRENT_DATE
  LOOP
    -- Honor the chosen slot in the athlete's timezone; fall back to the weekly
    -- re-arm (next_proof_due_at) when no slot is configured yet.
    IF (
      r.proof_schedule_dow IS NOT NULL AND r.proof_schedule_hour IS NOT NULL
      AND EXTRACT(DOW  FROM now() AT TIME ZONE r.tz)::int = r.proof_schedule_dow
      AND EXTRACT(HOUR FROM now() AT TIME ZONE r.tz)::int = r.proof_schedule_hour
    ) OR (
      r.proof_schedule_dow IS NULL
      AND (r.next_proof_due_at IS NULL OR r.next_proof_due_at <= now())
    ) THEN
      PERFORM net.http_post(
        url := v_url,
        body := jsonb_build_object('athlete_id', r.id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret)
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ── Coach dispatch: fire one request per coach (weekly team report) ────────────
CREATE OR REPLACE FUNCTION proof_feed_dispatch_coaches()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url    text := current_setting('app.proof_engine_url', true);
  v_secret text := current_setting('app.proof_cron_secret', true);
  v_count  integer := 0;
  r        record;
BEGIN
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'proof_feed_dispatch_coaches: settings not set — skipping';
    RETURN 0;
  END IF;
  FOR r IN SELECT DISTINCT coach_id AS id FROM athletes WHERE coach_id IS NOT NULL LOOP
    PERFORM net.http_post(
      url := v_url,
      body := jsonb_build_object('coach_id', r.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ── Schedule the jobs (re-scheduling by name replaces any prior copy) ──────────
DO $$
BEGIN
  PERFORM cron.unschedule('proof-feed-athletes') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'proof-feed-athletes');
  PERFORM cron.unschedule('proof-feed-coaches')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'proof-feed-coaches');
END $$;

-- Every 15 min: catch each athlete's chosen hour (the daily-cap guard means only
-- the first fire in the hour actually generates; the rest return skipped).
SELECT cron.schedule('proof-feed-athletes', '*/15 * * * *', $$ SELECT public.proof_feed_dispatch_athletes(); $$);
-- Mondays 13:00 UTC: weekly team reports.
SELECT cron.schedule('proof-feed-coaches',  '0 13 * * 1',   $$ SELECT public.proof_feed_dispatch_coaches();  $$);

-- ── (optional) prove it works ─────────────────────────────────────────────────
--   SELECT public.proof_feed_dispatch_athletes();   -- returns # of athletes fired
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'proof-feed-%';
--
-- NOTE: the daily Vercel cron in vercel.json stays as a backstop sweep. Once this
-- fanout is verified you may remove the /api/trigger-proof-feed entry from
-- vercel.json's crons (optional — the engine's daily-cap makes double-runs safe).
