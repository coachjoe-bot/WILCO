-- ─── Cost + error rollups, 90-day prunes, rate-limit cleanup (SCALE-NOTES) ──────
-- Phase 2 of the 2026-07-03 app-health work order. All additive / non-destructive:
-- no base table is dropped or rewritten, and no raw row newer than 90 days is ever
-- deleted. Mirrors the engagement pattern in 20260625_engagement_rollup_cron.sql
-- (matview-behind-view + REFRESH ... CONCURRENTLY + retention prune, nightly cron).
--
-- WHY: v_ai_cost_daily / v_errors_daily / v_errors_by_fingerprint /
-- v_ai_reliability_daily recomputed over ALL raw rows on every read. Each is now
-- backed by a MATERIALIZED VIEW refreshed nightly; the ORIGINAL VIEW NAME is kept
-- (now selecting from the matview) so every reader — including the app-health
-- reporting agent — keeps working with identical columns and ordering.
--
-- NOTE ON HISTORY: a matview is rebuilt from raw on each REFRESH, so after the raw
-- 90-day prune each rollup holds a rolling ~90-day window (same as the engagement
-- matview). That's ample for the weekly report + trend queries; infinite aggregate
-- history would require incremental upserts into a real table (out of scope).

-- ── 2a. Materialize v_ai_cost_daily ──────────────────────────────────────────
DROP VIEW IF EXISTS v_ai_cost_daily;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_ai_cost_daily AS
  SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
    feature,
    count(*) AS calls,
    sum(est_cost_usd) AS cost_usd,
    sum(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS total_tokens
   FROM v_ai_costs
  GROUP BY ((created_at AT TIME ZONE 'UTC')::date), feature;
-- Unique index required for REFRESH ... CONCURRENTLY. MUST be column-only (no
-- expression / no partial). Still unique because GROUP BY collapses each
-- (day, feature) — incl. a single NULL-feature row per day — to one row.
CREATE UNIQUE INDEX IF NOT EXISTS mv_ai_cost_daily_pk
  ON mv_ai_cost_daily (day, feature);
CREATE VIEW v_ai_cost_daily AS
  SELECT * FROM mv_ai_cost_daily ORDER BY day DESC, feature;

-- ── 2a. Materialize v_errors_daily ───────────────────────────────────────────
DROP VIEW IF EXISTS v_errors_daily;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_errors_daily AS
  SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
    severity,
    count(*) AS events,
    count(DISTINCT athlete_id) AS athletes_affected
   FROM error_events
  GROUP BY ((created_at AT TIME ZONE 'UTC')::date), severity;
CREATE UNIQUE INDEX IF NOT EXISTS mv_errors_daily_pk
  ON mv_errors_daily (day, severity);
CREATE VIEW v_errors_daily AS
  SELECT * FROM mv_errors_daily ORDER BY day DESC, severity;

-- ── 2a. Materialize v_errors_by_fingerprint ──────────────────────────────────
DROP VIEW IF EXISTS v_errors_by_fingerprint;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_errors_by_fingerprint AS
  SELECT fingerprint,
    min(area) AS area,
    min(error_type) AS error_type,
    min(message) AS sample_message,
    count(*) AS events,
    count(DISTINCT athlete_id) AS athletes_affected,
    max(severity) AS worst_severity,
    min(created_at) AS first_seen,
    max(created_at) AS last_seen
   FROM error_events
  WHERE fingerprint IS NOT NULL
  GROUP BY fingerprint;
CREATE UNIQUE INDEX IF NOT EXISTS mv_errors_by_fingerprint_pk
  ON mv_errors_by_fingerprint (fingerprint);
CREATE VIEW v_errors_by_fingerprint AS
  SELECT * FROM mv_errors_by_fingerprint;

-- ── 2a. Materialize v_ai_reliability_daily ───────────────────────────────────
DROP VIEW IF EXISTS v_ai_reliability_daily;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_ai_reliability_daily AS
  WITH ai_calls AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS calls
      FROM usage_costs WHERE source = 'claude'
      GROUP BY ((created_at AT TIME ZONE 'UTC')::date)
  ), ai_errs AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS client_unreachable
      FROM error_events WHERE area = 'ai'
      GROUP BY ((created_at AT TIME ZONE 'UTC')::date)
  )
  SELECT COALESCE(c.day, e.day) AS day,
    COALESCE(c.calls, 0::bigint) AS ai_calls,
    COALESCE(e.client_unreachable, 0::bigint) AS client_unreachable,
    round(COALESCE(e.client_unreachable, 0::bigint)::numeric
          / NULLIF(COALESCE(c.calls, 0::bigint) + COALESCE(e.client_unreachable, 0::bigint), 0)::numeric, 4)
      AS unreachable_rate
   FROM ai_calls c
   FULL JOIN ai_errs e ON e.day = c.day;
CREATE UNIQUE INDEX IF NOT EXISTS mv_ai_reliability_daily_pk
  ON mv_ai_reliability_daily (day);
CREATE VIEW v_ai_reliability_daily AS
  SELECT * FROM mv_ai_reliability_daily ORDER BY day DESC;

-- ── 2a + 2b. Nightly refresh (CONCURRENTLY) then 90-day raw prune ────────────
CREATE OR REPLACE FUNCTION public.refresh_cost_error_rollups()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ai_cost_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_errors_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_errors_by_fingerprint;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ai_reliability_daily;
  -- 2b. Retention: prune raw only AFTER the rollups above capture it. Same 90-day
  -- policy already live for usage_events. Deletes nothing until rows age past 90d.
  DELETE FROM usage_costs  WHERE created_at < now() - interval '90 days';
  DELETE FROM error_events WHERE created_at < now() - interval '90 days';
END;
$function$;

-- Nightly at 00:20 UTC — staggered 5 min after engagement-rollups-nightly (00:15).
SELECT cron.schedule('cost-error-rollups-nightly', '20 0 * * *',
  $$SELECT public.refresh_cost_error_rollups()$$);

-- ── 2c. rate_limits cleanup (was commented out in 20260624_security_rate_limits) ─
-- Login/error/event throttling writes one row per attempt; only the last ~15 min
-- matters. Drop rows older than a day nightly so the table stays bounded.
SELECT cron.schedule('rate-limits-cleanup', '30 0 * * *',
  $$DELETE FROM rate_limits WHERE created_at < now() - interval '1 day'$$);
