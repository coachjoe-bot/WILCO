-- ─── RELIABILITY / ERROR TRACKING (Phase 1.5) ────────────────────────────────
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query → Run).
-- Idempotent — safe to re-run.
--
-- WHAT THIS IS: a structured log of "technical difficulties" — client JS crashes,
-- failed/ unreachable API calls, failed Supabase reads/writes, and unexpected
-- server exceptions. The reliability follow-on to Phase 1 (usage_costs, which logs
-- COST). This table logs FAILURES, so the local reporting agent (and a future coach
-- dashboard) can answer "how often is the app breaking, where, and for whom."
--
-- WHAT THIS IS NOT: it does NOT log AI/Claude HTTP errors — those are already in
-- usage_costs.status (Phase 1). Logging them here too would double-count. The one
-- AI-adjacent thing we DO log is "the client couldn't reach our server at all"
-- (a network failure that never produces a usage_costs row).
--
-- WHO READS IT (mirrors usage_costs):
--   1. A local Claude agent, via the SERVICE key, for internal reliability reports.
--   2. (Later, out of scope now) a coach dashboard, scoped by school_id/coach_id —
--      which is why every row snapshots tier/school_id/coach_id at write time so a
--      scoped read is a single indexed WHERE with no join, and the attribution
--      survives an athlete later changing schools.
--
-- PRIVACY: metadata only. No PINs, tokens, emails, raw chat/workout content, or
-- request bodies. The `message` is sanitized + truncated server-side before insert;
-- query strings are stripped from routes; user_agent is read server-side. See
-- api/_supa.js -> logError() / sanitizeMessage().

-- ── 1. error_events — the reliability ledger ──────────────────────────────────
--    Shape deliberately parallels usage_costs: id/created_at, source, a feature-
--    like `area` label, role/actor_id/athlete_id, snapshotted school_id/coach_id/
--    tier, and a generic meta JSONB. Label columns are plain TEXT (validated in app
--    code against a Set, like usage_costs.feature/status) so adding a new severity
--    or area is a code change, never a migration.
CREATE TABLE IF NOT EXISTS error_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Where the failure was observed. 'client' (browser) | 'server' (api/*).
  source        TEXT NOT NULL DEFAULT 'client',
  -- How bad. 'info' | 'warn' | 'error' | 'fatal' (validated in app code).
  severity      TEXT NOT NULL DEFAULT 'error',

  -- Coarse functional area (auth | workout_log | coach_dashboard | billing | ai |
  -- sync | nav | other). The primary GROUP BY for "where is the app breaking."
  area          TEXT,
  -- Client screen or api path. QUERY STRING STRIPPED before store (it can carry
  -- tokens/ids). e.g. '/log', 'api/data'.
  route         TEXT,
  -- Optional finer locus: a component or function name.
  component     TEXT,
  -- Error class / kind: 'TypeError' | 'NetworkError' | 'supabase_write_failed' |
  -- 'http_502' | 'unhandledrejection' | ...
  error_type    TEXT,
  -- Sanitized + truncated human message (~500 chars). NEVER raw user content.
  message       TEXT,
  -- HTTP status when the failure was an HTTP call; null otherwise.
  status_code   INTEGER,

  -- Actor (server-derived; 'anon' when the error happened pre-login or auth was
  -- itself broken — those are often the MOST important errors, so they are kept).
  role          TEXT NOT NULL DEFAULT 'anon',     -- 'athlete' | 'coach' | 'anon'
  actor_id      UUID,                             -- athletes.id or coaches.id
  -- Ownership column the future coach-dashboard read scopes on (null for
  -- coach/anon). Mirrors the READ_OWN_COL pattern in api/data.js.
  athlete_id    UUID,

  -- Snapshots taken at write time (denormalized on purpose — see header). Null for
  -- anonymous (pre-login) errors, which have no known account.
  school_id     UUID,
  coach_id      UUID,
  tier          TEXT,                             -- free | pro | elite | school

  -- Environment.
  app_version   TEXT,                             -- short client build id
  user_agent    TEXT,                             -- read from req headers, truncated

  -- Stable grouping key: hash(area|error_type|message-prefix), computed server-side
  -- so the agent/dashboard can collapse "the same error happening 10,000 times"
  -- into one row with a count. Cheap to GROUP BY; see v_errors_by_fingerprint.
  fingerprint   TEXT,

  -- Small, sanitized, size-capped structured extras (NOT free-form content).
  meta          JSONB
);

-- ── 2. Indexes — sized for the rollup queries the agent + dashboard run ────────
--    Deliberately minimal: enough for fast GROUP BYs / dashboard scoping, few
--    enough not to tax the write path (errors can spike in bursts).
CREATE INDEX IF NOT EXISTS error_events_created_idx     ON error_events (created_at);
CREATE INDEX IF NOT EXISTS error_events_severity_idx    ON error_events (severity, created_at);
CREATE INDEX IF NOT EXISTS error_events_area_idx        ON error_events (area, created_at);
CREATE INDEX IF NOT EXISTS error_events_school_idx      ON error_events (school_id, created_at);
CREATE INDEX IF NOT EXISTS error_events_athlete_idx     ON error_events (athlete_id, created_at);
CREATE INDEX IF NOT EXISTS error_events_fingerprint_idx ON error_events (fingerprint, created_at);

-- ── 3. RLS — server-only, exactly like usage_costs / rate_limits ──────────────
--    No policies => the anon key can do nothing (it cannot read OR write this
--    table). The service_role key (api/* and the local agent) bypasses RLS, so
--    server writes and agent reads work. The anonymous client error path does NOT
--    use the anon key — it POSTs to api/identity (log-error), which validates and
--    writes with the service key. So the Phase-1 anon-write lockdown stays intact.
ALTER TABLE error_events ENABLE ROW LEVEL SECURITY;

-- ── 4. Views — the read contract (read these, not raw error_events) ───────────

-- Base view: every row + a UTC `day` column. All rollups build on this so the
-- date-bucketing lives in one place. (Kept thin — no joins — so it stays cheap.)
CREATE OR REPLACE VIEW v_errors AS
SELECT
  e.*,
  (e.created_at AT TIME ZONE 'UTC')::date AS day
FROM error_events e;

-- By area: where is the app breaking. Severity split + reach (distinct athletes).
CREATE OR REPLACE VIEW v_errors_by_area AS
SELECT
  COALESCE(area, 'unknown')                       AS area,
  COUNT(*)                                         AS events,
  COUNT(*) FILTER (WHERE severity = 'fatal')       AS fatal,
  COUNT(*) FILTER (WHERE severity = 'error')       AS error,
  COUNT(*) FILTER (WHERE severity = 'warn')        AS warn,
  COUNT(*) FILTER (WHERE severity = 'info')        AS info,
  COUNT(DISTINCT athlete_id)                       AS athletes_affected,
  MIN(created_at)                                  AS first_seen,
  MAX(created_at)                                  AS last_seen
FROM error_events
GROUP BY COALESCE(area, 'unknown');

-- By day × severity: the reliability trend line ("are we getting better/worse").
CREATE OR REPLACE VIEW v_errors_daily AS
SELECT
  (created_at AT TIME ZONE 'UTC')::date           AS day,
  severity,
  COUNT(*)                                         AS events,
  COUNT(DISTINCT athlete_id)                       AS athletes_affected
FROM error_events
GROUP BY (created_at AT TIME ZONE 'UTC')::date, severity
ORDER BY day DESC, severity;

-- By fingerprint: the top distinct issues, collapsed across all occurrences. This
-- is the "triage" view — what to fix first, ranked by how many users it hits.
CREATE OR REPLACE VIEW v_errors_by_fingerprint AS
SELECT
  fingerprint,
  MIN(area)                                        AS area,
  MIN(error_type)                                  AS error_type,
  MIN(message)                                     AS sample_message,
  COUNT(*)                                         AS events,
  COUNT(DISTINCT athlete_id)                       AS athletes_affected,
  MAX(severity)                                    AS worst_severity,
  MIN(created_at)                                  AS first_seen,
  MAX(created_at)                                  AS last_seen
FROM error_events
WHERE fingerprint IS NOT NULL
GROUP BY fingerprint;

-- By school: dashboard-scoped reliability (errors per school / per school-athlete).
CREATE OR REPLACE VIEW v_errors_by_school AS
SELECT
  school_id,
  COUNT(*)                                         AS events,
  COUNT(*) FILTER (WHERE severity IN ('error','fatal')) AS hard_errors,
  COUNT(DISTINCT athlete_id)                       AS athletes_affected,
  MAX(created_at)                                  AS last_seen
FROM error_events
WHERE school_id IS NOT NULL
GROUP BY school_id;

-- AI reliability rate: the ONE place error_events meets usage_costs. We have a
-- real denominator for AI features (every AI call is a usage_costs row), so we can
-- express AI client-unreachable failures as a rate. General per-feature error
-- RATES need a usage/attempt denominator that doesn't exist yet — that arrives
-- with Phase 2 (usage_events). Until then the other views above are COUNTS/trends,
-- which is honest. See docs/analytics-schema.md.
CREATE OR REPLACE VIEW v_ai_reliability_daily AS
WITH ai_calls AS (
  SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS calls
  FROM usage_costs WHERE source = 'claude'
  GROUP BY (created_at AT TIME ZONE 'UTC')::date
),
ai_errs AS (
  SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS client_unreachable
  FROM error_events WHERE area = 'ai'
  GROUP BY (created_at AT TIME ZONE 'UTC')::date
)
SELECT
  COALESCE(c.day, e.day)                           AS day,
  COALESCE(c.calls, 0)                             AS ai_calls,
  COALESCE(e.client_unreachable, 0)                AS client_unreachable,
  ROUND(COALESCE(e.client_unreachable,0)::numeric
        / NULLIF(COALESCE(c.calls,0) + COALESCE(e.client_unreachable,0), 0), 4)
                                                    AS unreachable_rate
FROM ai_calls c
FULL OUTER JOIN ai_errs e ON e.day = c.day
ORDER BY day DESC;

-- ─── RETENTION (manual for now) ───────────────────────────────────────────────
-- Raw rows aren't needed forever. Prune raw error rows older than ~90 days to
-- bound storage (same policy as usage_costs):
--   DELETE FROM error_events WHERE created_at < now() - interval '90 days';
-- Wire to a cron later — see SCALE-NOTES.md. At higher volume, also consider a
-- nightly MATERIALIZED rollup of v_errors_daily / v_errors_by_fingerprint.
