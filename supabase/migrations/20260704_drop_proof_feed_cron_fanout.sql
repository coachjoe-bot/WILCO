-- ─── Proof Feed v3 — drop the pg_cron per-athlete dispatch fanout ─────────────
-- DO NOT RUN THIS UNTIL MERGE TIME (see the runbook in docs/proof-feed-v3-samples.md
-- / the PR description). It is committed to the branch now so the SQL is reviewed
-- alongside the code, but it must run AFTER feat/proof-feed-v3 is merged to main
-- and deployed to production — running it before that would remove the ONLY
-- working dispatch path (the pg_cron fanout) before the new single-invocation
-- Vercel cron sweep (vercel.json's "/api/trigger-proof-feed" entry, unchanged
-- schedule "0 14 * * *") has a chance to prove itself in prod.
--
-- WHY this existed: 20260625_proof_feed_v2_cron.sql added a pg_cron job that fired
-- one net.http_post per due athlete (and one per coach) because the Vercel engine
-- used to run under the Hobby plan's implicit 10s function timeout — a single
-- invocation could never loop the whole roster. Vercel Pro (2026-07-04) allows up
-- to 300s, so api/trigger-proof-feed.js's scheduler-sweep branch now loops every
-- due athlete SEQUENTIALLY in one invocation (see that file's header), making the
-- per-id fanout redundant. Running BOTH at once is not unsafe (the daily-cap on
-- last_proof_run_date makes a double-fire a no-op skip, not a duplicate digest)
-- but it's pointless complexity + an extra CRON_SECRET copy sitting in two SQL
-- functions (the original reason this whole migration got flagged in the security
-- audit — see project-wilco-crunch-events / SCALE-NOTES history).
--
-- ── MERGE-TIME RUNBOOK (run in order) ──────────────────────────────────────────
--   1. Merge feat/proof-feed-v3 to main; confirm the Vercel production deploy is
--      READY and its cron entries (vercel.json) are picked up (Vercel re-reads
--      crons on deploy — check the Vercel dashboard's Cron Jobs tab).
--   2. Apply 20260704_notification_policy_v2.sql (adds athlete_nudge_state,
--      program_change_events, push_subscriptions.last_feed_push_at) if not
--      already applied.
--   3. Let the "0 14 * * *" Vercel cron fire at least once in production; check
--      the function's logs (Vercel → Functions → trigger-proof-feed → Logs) for
--      the "[proof-feed] sweep complete: N ok, 0 failed" line.
--   4. ONLY THEN run this file (below) to drop the pg_cron fanout.
--   5. Verify: `SELECT jobname FROM cron.job WHERE jobname LIKE 'proof-feed-%';`
--      returns zero rows.
--
-- Idempotent — safe to re-run (DROP ... IF EXISTS, unschedule guarded by existence check).

DO $$
BEGIN
  PERFORM cron.unschedule('proof-feed-athletes') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'proof-feed-athletes');
  PERFORM cron.unschedule('proof-feed-coaches')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'proof-feed-coaches');
END $$;

DROP FUNCTION IF EXISTS public.proof_feed_dispatch_athletes();
DROP FUNCTION IF EXISTS public.proof_feed_dispatch_coaches();

-- The app.proof_engine_url / app.proof_cron_secret DB settings (set via
-- ALTER DATABASE in 20260625_proof_feed_v2_cron.sql) are harmless leftovers once
-- the functions that read them are gone — left in place rather than unset, since
-- ALTER DATABASE ... RESET requires superuser in some Supabase plans and there's
-- no security value in removing a now-unread setting.
