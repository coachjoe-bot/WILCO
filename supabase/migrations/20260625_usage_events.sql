-- ─── ENGAGEMENT / USAGE ANALYTICS (Phase 2) ──────────────────────────────────
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query → Run).
-- Idempotent — safe to re-run.
--
-- WHAT THIS IS: a structured log of ENGAGEMENT — app opens, sessions, key actions
-- (logged a workout, opened chat) and a curated set of screen views. The third leg
-- of the analytics stack: Phase 1 = COST (usage_costs), Phase 1.5 = RELIABILITY
-- (error_events), Phase 2 = ENGAGEMENT (this table). It answers DAU/WAU/MAU,
-- sessions, the activation funnel, and feature-adoption breadth.
--
-- WHAT THIS IS NOT: it is not a firehose of every tap. The client only emits a
-- curated ALLOWLIST of high-value events (validated server-side in api/_supa.js ->
-- EVENT_NAMES); anything off-list is dropped. Events are BATCHED on the client and
-- flushed N-at-a-time / on a timer / on page-hide, so this table costs ~one request
-- per flush, not one per event. See api/identity.js -> log-events.
--
-- WHY IT ALSO MATTERS TO THE OTHER LEDGERS: this is the missing DENOMINATOR. Phase
-- 1.5 could only ship error COUNTS because it had no "attempts per feature" to
-- divide by. usage_events carries the same coarse `area` vocabulary as error_events,
-- so v_error_rate_by_area_daily (below) finally expresses errors as a true RATE.
--
-- WHO READS IT (mirrors usage_costs / error_events):
--   1. A local Claude agent, via the SERVICE key, for internal product reports.
--   2. (Later, out of scope now) a coach dashboard, scoped by school_id/coach_id —
--      which is why every row snapshots tier/school_id/coach_id at write time so a
--      scoped read is a single indexed WHERE with no join, and the attribution
--      survives an athlete later changing schools.
--
-- PRIVACY: metadata only. No PINs, tokens, emails, or raw chat/workout content.
-- event_name/area are allowlisted (no free text); route has its query string
-- stripped; meta is sanitized + size-capped server-side; ALL attribution is derived
-- server-side (never from the client body), so per-athlete/per-school numbers can't
-- be forged. Pre-login events log as role='anon' with only a random session_id.
--
-- SCALE: this table will dwarf usage_costs and error_events. The design plans for it
-- up front: a 90-day raw-retention prune (bottom of file) plus a MATERIALIZED daily
-- rollup (mv_daily_active_athletes) so DAU/WAU/MAU/retention never scan raw at
-- volume. See SCALE-NOTES.md.

-- ── 1. usage_events — the engagement ledger ───────────────────────────────────
--    Shape parallels usage_costs / error_events: id/created_at, source, a coarse
--    label (`area`, same vocabulary as error_events), role/actor_id/athlete_id,
--    snapshotted school_id/coach_id/tier, app_version/user_agent, generic meta.
--    The two engagement-specific columns are `event_name` (the granular verb,
--    validated in app code against a Set — adding one is a code change, never a
--    migration) and `session_id` (the unit for sessions + funnels).
CREATE TABLE IF NOT EXISTS usage_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- server receive time; client
                                                     -- flushes frequently so this
                                                     -- tracks event time to ~30s.

  -- Where the event was observed. 'client' (browser) today; 'server' reserved.
  source        TEXT NOT NULL DEFAULT 'client',

  -- The granular verb: app_open | session_start | login | signup_start |
  -- signup_complete | workout_logged | chat_opened | chat_message_sent |
  -- screen_view | coach_dashboard_view. Allowlisted in api/_supa.js (EVENT_NAMES).
  event_name    TEXT NOT NULL,
  -- Coarse functional area — SAME vocabulary as error_events.area
  -- (auth|workout_log|coach_dashboard|billing|ai|sync|nav|other). This is the join
  -- key that turns error COUNTS into RATES (v_error_rate_by_area_daily).
  area          TEXT,

  -- Client-generated session id (random UUID). The unit for "sessions/day" and for
  -- ordering events within a visit (the activation funnel). A new id is minted on
  -- app open and after ~30min idle. Stitches anon→known: the `login` event carries
  -- the same session_id, so a pre-login prefix can be attributed without rewriting
  -- earlier anon rows.
  session_id    TEXT,
  -- Client screen or route. QUERY STRING STRIPPED before store (can carry ids).
  route         TEXT,

  -- Actor (server-derived; 'anon' when the event happened pre-login — app_open /
  -- session_start / signup_start are intentionally captured anonymously).
  role          TEXT NOT NULL DEFAULT 'anon',     -- 'athlete' | 'coach' | 'anon'
  actor_id      UUID,                             -- athletes.id or coaches.id
  -- Ownership column the future coach-dashboard read scopes on (null for coach/anon).
  athlete_id    UUID,

  -- Snapshots taken at write time (denormalized on purpose — see header). Null for
  -- anonymous (pre-login) events, which have no known account.
  school_id     UUID,
  coach_id      UUID,
  tier          TEXT,                             -- free | pro | elite | school

  -- Environment.
  app_version   TEXT,                             -- short client build id
  user_agent    TEXT,                             -- read from req headers, truncated

  -- Small, sanitized, size-capped structured extras (e.g. {"tab":"benchmarks"}).
  -- NOT free-form content — no chat/workout text ever.
  meta          JSONB
);

-- ── 2. Indexes — sized for the rollup queries the agent + dashboard run ────────
--    Deliberately minimal: enough for fast GROUP BYs / dashboard scoping, few
--    enough not to tax the write path (this is the highest-volume ledger).
CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events (created_at);
CREATE INDEX IF NOT EXISTS usage_events_event_idx   ON usage_events (event_name, created_at);
CREATE INDEX IF NOT EXISTS usage_events_area_idx    ON usage_events (area, created_at);
CREATE INDEX IF NOT EXISTS usage_events_athlete_idx ON usage_events (athlete_id, created_at);
CREATE INDEX IF NOT EXISTS usage_events_school_idx  ON usage_events (school_id, created_at);
CREATE INDEX IF NOT EXISTS usage_events_session_idx ON usage_events (session_id);

-- ── 3. RLS — server-only, exactly like usage_costs / error_events ─────────────
--    No policies => the anon key can do nothing (it cannot read OR write this
--    table). The service_role key (api/* and the local agent) bypasses RLS, so
--    server writes and agent reads work. The anonymous client engagement path does
--    NOT use the anon key — it POSTs metadata to api/identity (log-events), which
--    validates and writes with the service key. So the Phase-1 anon-write lockdown
--    stays intact.
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

-- ── 4. Base view — every row + a UTC `day` column ─────────────────────────────
--    All raw-grain rollups build on this so date-bucketing lives in one place.
CREATE OR REPLACE VIEW v_usage AS
SELECT
  e.*,
  (e.created_at AT TIME ZONE 'UTC')::date AS day
FROM usage_events e;

-- ── 5. SCALE PRIMITIVE: daily-active-athletes rollup (MATERIALIZED) ────────────
-- One row per athlete per active day — the standard building block for active-user
-- math. DAU = count per day; WAU/MAU = distinct over a trailing window; retention /
-- cohorts = self-join. This is TINY next to raw usage_events, so the active-user
-- views below never scan the firehose. Refresh nightly (piggyback the existing
-- daily cron trigger-proof-feed, or pg_cron):
--   REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_active_athletes;
-- (CONCURRENTLY needs the UNIQUE index below.) DROP ... CASCADE keeps this file
-- re-runnable: it drops the dependent views too, which are recreated just after.
DROP MATERIALIZED VIEW IF EXISTS mv_daily_active_athletes CASCADE;
CREATE MATERIALIZED VIEW mv_daily_active_athletes AS
SELECT
  (created_at AT TIME ZONE 'UTC')::date    AS day,
  athlete_id,
  -- Snapshots: pick any value seen that day (they're stable per athlete per day).
  MAX(tier)                                AS tier,
  MAX(school_id::text)::uuid               AS school_id,
  MAX(coach_id::text)::uuid                AS coach_id,
  COUNT(DISTINCT session_id)               AS sessions,
  COUNT(*)                                 AS events
FROM usage_events
WHERE athlete_id IS NOT NULL
GROUP BY (created_at AT TIME ZONE 'UTC')::date, athlete_id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_daily_active_athletes_pk
  ON mv_daily_active_athletes (day, athlete_id);
CREATE INDEX IF NOT EXISTS mv_daily_active_athletes_day_idx
  ON mv_daily_active_athletes (day);
CREATE INDEX IF NOT EXISTS mv_daily_active_athletes_school_idx
  ON mv_daily_active_athletes (school_id, day);

-- ── 6. Active-user views (read these) ─────────────────────────────────────────

-- DAU: distinct active athletes + sessions + events per day. Built on the matview.
CREATE OR REPLACE VIEW v_dau AS
SELECT
  day,
  COUNT(*)              AS dau,        -- one matview row per athlete per day
  SUM(sessions)         AS sessions,
  SUM(events)           AS events
FROM mv_daily_active_athletes
GROUP BY day
ORDER BY day DESC;

-- WAU / MAU: distinct athletes over a trailing window ending today (UTC). Single
-- row each. Cheap — scans only the small matview.
CREATE OR REPLACE VIEW v_wau AS
SELECT COUNT(DISTINCT athlete_id) AS wau
FROM mv_daily_active_athletes
WHERE day > (now() AT TIME ZONE 'UTC')::date - INTERVAL '7 days';

CREATE OR REPLACE VIEW v_mau AS
SELECT COUNT(DISTINCT athlete_id) AS mau
FROM mv_daily_active_athletes
WHERE day > (now() AT TIME ZONE 'UTC')::date - INTERVAL '30 days';

-- Stickiness (DAU/MAU) per day — the standard engagement-quality ratio.
CREATE OR REPLACE VIEW v_stickiness_daily AS
SELECT
  d.day,
  d.dau,
  (SELECT COUNT(DISTINCT m.athlete_id)
     FROM mv_daily_active_athletes m
    WHERE m.day > d.day - INTERVAL '30 days' AND m.day <= d.day) AS mau_trailing_30,
  ROUND(d.dau::numeric / NULLIF(
    (SELECT COUNT(DISTINCT m.athlete_id)
       FROM mv_daily_active_athletes m
      WHERE m.day > d.day - INTERVAL '30 days' AND m.day <= d.day), 0), 4) AS stickiness
FROM v_dau d
ORDER BY d.day DESC;

-- ── 7. Engagement views (raw-grain) ───────────────────────────────────────────
-- NOTE (scale): these recompute over raw on every read. At volume, materialize the
-- daily ones nightly alongside mv_daily_active_athletes. See SCALE-NOTES.md.

-- Sessions per day: count + average events per session (engagement depth).
CREATE OR REPLACE VIEW v_sessions_daily AS
SELECT
  (created_at AT TIME ZONE 'UTC')::date    AS day,
  COUNT(DISTINCT session_id)               AS sessions,
  COUNT(*)                                 AS events,
  ROUND(COUNT(*)::numeric
        / NULLIF(COUNT(DISTINCT session_id), 0), 2) AS events_per_session
FROM usage_events
WHERE session_id IS NOT NULL
GROUP BY (created_at AT TIME ZONE 'UTC')::date
ORDER BY day DESC;

-- Feature adoption: reach + volume per event. "How many distinct athletes ever
-- touched each feature, and when." Breadth-of-adoption answer.
CREATE OR REPLACE VIEW v_feature_adoption AS
SELECT
  event_name,
  MIN(area)                                AS area,
  COUNT(*)                                 AS events,
  COUNT(DISTINCT athlete_id)               AS athletes,
  COUNT(DISTINCT session_id)               AS sessions,
  MIN(created_at)                          AS first_seen,
  MAX(created_at)                          AS last_seen
FROM usage_events
GROUP BY event_name;

-- Feature adoption per day × event — the adoption trend line.
CREATE OR REPLACE VIEW v_feature_adoption_daily AS
SELECT
  (created_at AT TIME ZONE 'UTC')::date    AS day,
  event_name,
  COUNT(*)                                 AS events,
  COUNT(DISTINCT athlete_id)               AS athletes
FROM usage_events
GROUP BY (created_at AT TIME ZONE 'UTC')::date, event_name
ORDER BY day DESC, event_name;

-- Activation funnel: how many athletes get from account → first workout. signup_start
-- is pre-login (anon, session-only) so it's reported as a SESSION count; the
-- account-grained steps are distinct athletes. Honest about the grain change.
CREATE OR REPLACE VIEW v_activation_funnel AS
SELECT
  (SELECT COUNT(DISTINCT session_id) FROM usage_events WHERE event_name = 'signup_start')
                                                       AS signup_started_sessions,
  (SELECT COUNT(DISTINCT athlete_id) FROM usage_events WHERE event_name = 'signup_complete')
                                                       AS accounts_created,
  (SELECT COUNT(DISTINCT athlete_id) FROM usage_events WHERE event_name = 'workout_logged')
                                                       AS logged_first_workout,
  (SELECT COUNT(DISTINCT athlete_id) FROM usage_events WHERE event_name = 'chat_message_sent')
                                                       AS used_chat;

-- Per-school engagement (dashboard scope): active athletes + sessions per school.
CREATE OR REPLACE VIEW v_engagement_by_school AS
SELECT
  school_id,
  COUNT(DISTINCT athlete_id)               AS athletes_active,
  COUNT(DISTINCT session_id)               AS sessions,
  COUNT(*)                                 AS events,
  MAX(created_at)                          AS last_active
FROM usage_events
WHERE school_id IS NOT NULL
GROUP BY school_id;

-- ── 8. THE DENOMINATOR PAYOFF: true per-feature error RATES ───────────────────
-- The one place usage_events meets error_events. Phase 1.5 could only ship error
-- COUNTS; now we have attempts-per-area, so we can divide. attempts come from
-- usage_events, errors from error_events, joined on (area, day). This is what
-- SCALE-NOTES and the Phase-1.5 migration promised "arrives with Phase 2."
CREATE OR REPLACE VIEW v_error_rate_by_area_daily AS
WITH attempts AS (
  SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COALESCE(area,'other') AS area,
         COUNT(*) AS attempts
  FROM usage_events
  GROUP BY (created_at AT TIME ZONE 'UTC')::date, COALESCE(area,'other')
),
errs AS (
  SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COALESCE(area,'other') AS area,
         COUNT(*) AS errors,
         COUNT(*) FILTER (WHERE severity IN ('error','fatal')) AS hard_errors
  FROM error_events
  GROUP BY (created_at AT TIME ZONE 'UTC')::date, COALESCE(area,'other')
)
SELECT
  COALESCE(a.day,  e.day)                  AS day,
  COALESCE(a.area, e.area)                 AS area,
  COALESCE(a.attempts, 0)                  AS attempts,
  COALESCE(e.errors, 0)                    AS errors,
  COALESCE(e.hard_errors, 0)               AS hard_errors,
  ROUND(COALESCE(e.errors,0)::numeric
        / NULLIF(COALESCE(a.attempts,0), 0), 4) AS error_rate
FROM attempts a
FULL OUTER JOIN errs e ON e.day = a.day AND e.area = a.area
ORDER BY day DESC, area;

-- ─── RETENTION (manual for now) ───────────────────────────────────────────────
-- This is the highest-volume ledger, so retention matters MOST here. The matview
-- (mv_daily_active_athletes) is the durable record for active-user / cohort math,
-- so raw rows can be pruned aggressively. Keep raw ~90 days (funnels + recent
-- session detail), then prune:
--   DELETE FROM usage_events WHERE created_at < now() - interval '90 days';
-- Wire to a cron alongside the nightly matview refresh — see SCALE-NOTES.md. The
-- matview retains aggregate history indefinitely even after raw rows are pruned.
