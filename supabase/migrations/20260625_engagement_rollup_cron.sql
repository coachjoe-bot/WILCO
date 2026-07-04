-- ─── Engagement rollup + retention cron (Phase 2 engagement) ─────────────────
-- BACKFILL / SOURCE-OF-TRUTH ONLY. This function + cron job were applied directly
-- to production on 2026-06-25 (deploy db89eea) but the migration file was never
-- committed, leaving repo/prod drift. Recorded here so the repo is the source of
-- truth. It is ALREADY LIVE in prod (cron.job `engagement-rollups-nightly`,
-- schedule '15 0 * * *', active) — re-running is safe and idempotent
-- (CREATE OR REPLACE + cron.schedule upserts by jobname), but not required.
--
-- Pattern reused by 20260704_cost_error_rollups_prune_crons.sql:
--   refresh the MATERIALIZED VIEW(s) CONCURRENTLY, THEN prune raw >90d.

CREATE OR REPLACE FUNCTION public.refresh_engagement_rollups()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_active_athletes;
  DELETE FROM usage_events WHERE created_at < now() - interval '90 days';
END;
$function$;

-- cron.schedule upserts by jobname, so this both creates and keeps the job current.
SELECT cron.schedule('engagement-rollups-nightly', '15 0 * * *',
  $$SELECT public.refresh_engagement_rollups()$$);
