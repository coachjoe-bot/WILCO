-- ─── COST TRACKING (Phase 1) ─────────────────────────────────────────────────
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query → Run).
-- Idempotent — safe to re-run.
--
-- WHAT THIS IS: a per-customer COST ledger. The app records the cost of serving
-- each user — Phase 1 populates only AI/Claude calls (source='claude'); the same
-- table later absorbs other per-customer costs (Resend emails, etc.) with no
-- migration. Revenue lives in Stripe (+ the marketing scheduled task), NOT here —
-- the future local agent joins this cost data to Stripe revenue to compute margin.
--
-- WHO READS IT:
--   1. A local Claude agent, via the SERVICE key, for internal business reports.
--   2. (Later, out of scope now) a coach dashboard, scoped by school_id/coach_id —
--      which is why every row snapshots tier/school_id/coach_id at write time so a
--      scoped read is a single indexed WHERE with no join, and historical
--      attribution survives an athlete changing schools.
--
-- PRIVACY: token COUNTS and metadata only. No prompt/response content ever.

-- ── 1. ai_pricing — model → $/MTok reference, joined by the cost views ─────────
--    Kept as data (not baked into the views) so re-pricing is an UPDATE, never a
--    schema change, and the agent can re-price historical rows if rates change.
CREATE TABLE IF NOT EXISTS ai_pricing (
  model                TEXT PRIMARY KEY,
  input_per_mtok       NUMERIC NOT NULL,
  output_per_mtok      NUMERIC NOT NULL,
  cache_read_per_mtok  NUMERIC NOT NULL DEFAULT 0,
  cache_write_per_mtok NUMERIC NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed / refresh current rates (USD per million tokens, as of 2026-06-25).
-- cache_write is the 5-minute-TTL rate (1.25× input). The app sends no
-- cache_control today, so cache_* columns read 0 until prompt caching is added.
INSERT INTO ai_pricing (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) VALUES
  ('claude-sonnet-4-6',          3.00, 15.00, 0.30, 3.75),
  ('claude-haiku-4-5',           1.00,  5.00, 0.10, 1.25),
  ('claude-haiku-4-5-20251001',  1.00,  5.00, 0.10, 1.25),
  ('claude-sonnet-4-5',          3.00, 15.00, 0.30, 3.75),
  ('claude-sonnet-4-5-20250929', 3.00, 15.00, 0.30, 3.75)
ON CONFLICT (model) DO UPDATE SET
  input_per_mtok       = EXCLUDED.input_per_mtok,
  output_per_mtok      = EXCLUDED.output_per_mtok,
  cache_read_per_mtok  = EXCLUDED.cache_read_per_mtok,
  cache_write_per_mtok = EXCLUDED.cache_write_per_mtok,
  updated_at           = now();

-- ── 2. usage_costs — the ledger ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_costs (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Cost source. 'claude' today; 'email' and others slot in later unchanged.
  source             TEXT NOT NULL DEFAULT 'claude',
  -- The app feature that incurred the cost (workout_parse, joebot_chat, ...).
  feature            TEXT,

  -- Actor (server-verified by authCaller — never client-supplied).
  role               TEXT NOT NULL,                 -- 'athlete' | 'coach'
  actor_id           UUID,                          -- athletes.id or coaches.id
  -- Ownership column the future coach-dashboard read scopes on (null for
  -- coach-initiated calls). Mirrors the READ_OWN_COL pattern in api/data.js.
  athlete_id         UUID,

  -- Snapshots taken at write time (denormalized on purpose — see header).
  school_id          UUID,
  coach_id           UUID,
  tier               TEXT,                          -- free | pro | elite | school (athletes only)

  -- AI specifics (null for non-AI sources). Tokens are raw truth; $ is computed
  -- in the views from ai_pricing.
  model              TEXT,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  latency_ms         INTEGER,
  status             TEXT,                          -- 'ok' | 'error_<httpstatus>'

  -- Generic extension for non-AI cost sources (e.g. emails): quantity + detail.
  quantity           NUMERIC,
  meta               JSONB
);

-- ── 3. Indexes — sized for the rollup queries the agent + dashboard run ────────
--    Deliberately minimal: enough for fast GROUP BYs, few enough to not tax writes.
CREATE INDEX IF NOT EXISTS usage_costs_created_idx ON usage_costs (created_at);
CREATE INDEX IF NOT EXISTS usage_costs_athlete_idx ON usage_costs (athlete_id, created_at);
CREATE INDEX IF NOT EXISTS usage_costs_school_idx  ON usage_costs (school_id, created_at);
CREATE INDEX IF NOT EXISTS usage_costs_coach_idx   ON usage_costs (coach_id, created_at);
CREATE INDEX IF NOT EXISTS usage_costs_feature_idx ON usage_costs (feature, created_at);
CREATE INDEX IF NOT EXISTS usage_costs_source_idx  ON usage_costs (source, created_at);

-- ── 4. RLS — server-only, exactly like rate_limits ────────────────────────────
--    No policies => the anon key can do nothing. The service_role key (api/* and
--    the local agent) bypasses RLS, so server reads/writes work. The future
--    coach dashboard will read through a service-key server endpoint, not anon.
ALTER TABLE usage_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_pricing  ENABLE ROW LEVEL SECURITY;

-- ── 5. Cost views ─────────────────────────────────────────────────────────────
-- Base view: every row + its computed $ cost. All rollups build on this so the
-- pricing math lives in exactly one place.
CREATE OR REPLACE VIEW v_ai_costs AS
SELECT
  u.*,
  ROUND(
      COALESCE(u.input_tokens,0)       / 1e6 * COALESCE(p.input_per_mtok,0)
    + COALESCE(u.output_tokens,0)      / 1e6 * COALESCE(p.output_per_mtok,0)
    + COALESCE(u.cache_read_tokens,0)  / 1e6 * COALESCE(p.cache_read_per_mtok,0)
    + COALESCE(u.cache_write_tokens,0) / 1e6 * COALESCE(p.cache_write_per_mtok,0)
  , 6) AS est_cost_usd
FROM usage_costs u
LEFT JOIN ai_pricing p ON p.model = u.model
WHERE u.source = 'claude';

-- Per athlete: lifetime cost + call count + tokens. AI cost per user.
CREATE OR REPLACE VIEW v_ai_cost_by_user AS
SELECT
  athlete_id,
  tier,
  school_id,
  coach_id,
  COUNT(*)                                  AS calls,
  SUM(est_cost_usd)                         AS cost_usd,
  SUM(COALESCE(input_tokens,0))             AS input_tokens,
  SUM(COALESCE(output_tokens,0))            AS output_tokens,
  COUNT(*) FILTER (WHERE status <> 'ok')    AS errors,
  MIN(created_at)                           AS first_call_at,
  MAX(created_at)                           AS last_call_at
FROM v_ai_costs
WHERE athlete_id IS NOT NULL
GROUP BY athlete_id, tier, school_id, coach_id;

-- Per feature: which features drive cost. AI cost per feature.
CREATE OR REPLACE VIEW v_ai_cost_by_feature AS
SELECT
  feature,
  COUNT(*)                               AS calls,
  SUM(est_cost_usd)                      AS cost_usd,
  ROUND(AVG(est_cost_usd), 6)            AS avg_cost_per_call,
  ROUND(AVG(latency_ms))                 AS avg_latency_ms,
  COUNT(*) FILTER (WHERE status <> 'ok') AS errors
FROM v_ai_costs
GROUP BY feature;

-- Per tier: AI cost per account type (cost side of "most profitable tier").
CREATE OR REPLACE VIEW v_ai_cost_by_tier AS
SELECT
  COALESCE(tier, 'unknown')                AS tier,
  COUNT(*)                                 AS calls,
  COUNT(DISTINCT athlete_id)               AS users,
  SUM(est_cost_usd)                        AS cost_usd,
  ROUND(SUM(est_cost_usd)
        / NULLIF(COUNT(DISTINCT athlete_id),0), 6) AS cost_per_user
FROM v_ai_costs
GROUP BY COALESCE(tier, 'unknown');

-- Per school: AI cost per school (and per school-athlete).
CREATE OR REPLACE VIEW v_ai_cost_by_school AS
SELECT
  school_id,
  COUNT(*)                                 AS calls,
  COUNT(DISTINCT athlete_id)               AS athletes,
  SUM(est_cost_usd)                        AS cost_usd,
  ROUND(SUM(est_cost_usd)
        / NULLIF(COUNT(DISTINCT athlete_id),0), 6) AS cost_per_athlete
FROM v_ai_costs
WHERE school_id IS NOT NULL
GROUP BY school_id;

-- Per model: token + cost split across models (track the 4.6/Haiku cost mix).
CREATE OR REPLACE VIEW v_ai_cost_by_model AS
SELECT
  model,
  COUNT(*)                       AS calls,
  SUM(COALESCE(input_tokens,0))  AS input_tokens,
  SUM(COALESCE(output_tokens,0)) AS output_tokens,
  SUM(est_cost_usd)              AS cost_usd
FROM v_ai_costs
GROUP BY model;

-- Daily trend, split by feature. The agent reads this for "cost over time".
-- NOTE (scale): this recomputes on every read. When usage_costs grows large,
-- convert to a MATERIALIZED VIEW refreshed nightly (e.g. piggyback the existing
-- daily cron) or a rollup table. See SCALE-NOTES.md.
CREATE OR REPLACE VIEW v_ai_cost_daily AS
SELECT
  (created_at AT TIME ZONE 'UTC')::date AS day,
  feature,
  COUNT(*)                              AS calls,
  SUM(est_cost_usd)                     AS cost_usd,
  SUM(COALESCE(input_tokens,0)
    + COALESCE(output_tokens,0))        AS total_tokens
FROM v_ai_costs
GROUP BY (created_at AT TIME ZONE 'UTC')::date, feature
ORDER BY day DESC, feature;

-- ─── RETENTION (manual for now) ───────────────────────────────────────────────
-- Raw rows aren't needed forever. Once a daily rollup table exists, prune raw
-- rows older than ~90 days to bound storage:
--   DELETE FROM usage_costs WHERE created_at < now() - interval '90 days';
-- (Wire to a cron later — see SCALE-NOTES.md.)
