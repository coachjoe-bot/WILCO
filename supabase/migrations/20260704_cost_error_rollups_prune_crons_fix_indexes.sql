-- Follow-up to 20260704_cost_error_rollups_prune_crons.sql.
-- The first cut used COALESCE(...) expression unique indexes on the two matviews
-- with nullable group keys. REFRESH MATERIALIZED VIEW CONCURRENTLY rejects
-- expression / partial indexes (Postgres 55000: "cannot refresh ... concurrently"),
-- so this swaps them for plain column-only unique indexes. Still unique because
-- GROUP BY yields one row per (day,feature) / (day,severity), incl. one NULL-key
-- row per day. (The main migration file has since been corrected too; this file
-- mirrors the exact sequence applied to production.)
DROP INDEX IF EXISTS mv_ai_cost_daily_pk;
CREATE UNIQUE INDEX mv_ai_cost_daily_pk ON mv_ai_cost_daily (day, feature);

DROP INDEX IF EXISTS mv_errors_daily_pk;
CREATE UNIQUE INDEX mv_errors_daily_pk ON mv_errors_daily (day, severity);
