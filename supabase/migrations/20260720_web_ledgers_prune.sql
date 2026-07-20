-- ─── web_events / web_errors 90-day prune (scalability review 2026-07-20, item C3) ─
-- web_events is the largest table in the DB (22 MB / ~30k rows, ~73% of total) and
-- the fastest-growing, and it is the ONLY high-volume ledger with no retention policy.
-- Its growth tracks MARKETING traffic, not athlete count — a viral week or an ad push
-- inflates it independent of signups — so left unbounded it becomes the disk-growth
-- leader well before user data does. The nightly rollup crons already prune
-- usage_events / usage_costs / error_events at 90 days; this brings web_events and
-- web_errors under the same policy.
--
-- WHY created_at (not occurred_at): web_events carries both a client-stamped
-- occurred_at (spoofable / clock-skewed) and a server batch-insert created_at.
-- Retention keys on the server-authoritative created_at, matching every other ledger.
--
-- HISTORY NOTE: the weekly web-health report only looks back ~10 days, so a 90-day
-- window loses nothing it needs. Long-range web history is out of scope here; if it is
-- ever wanted, range-partition web_events by created_at and drop old partitions
-- (pg_partman is available on this project) rather than lengthening this prune.
--
-- Additive + idempotent: cron.schedule upserts by jobname; the function is CREATE OR
-- REPLACE. Deletes nothing until rows age past 90 days. Mirrors the SECURITY DEFINER /
-- search_path pattern of refresh_cost_error_rollups (20260704_cost_error_rollups...).

CREATE OR REPLACE FUNCTION public.prune_web_ledgers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM web_events WHERE created_at < now() - interval '90 days';
  DELETE FROM web_errors WHERE created_at < now() - interval '90 days';
END;
$function$;

-- Nightly at 00:35 UTC — staggered 5 min after rate-limits-cleanup (00:30), so the
-- three cleanup jobs (00:15 engagement, 00:20 cost/error, 00:30 rate-limits) don't
-- pile onto the same instant.
SELECT cron.schedule('web-ledgers-prune-nightly', '35 0 * * *',
  $$SELECT public.prune_web_ledgers()$$);
