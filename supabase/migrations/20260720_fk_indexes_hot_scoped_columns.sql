-- ─── FK indexes on hot scoped columns (scalability review 2026-07-20, item C4) ──
-- The performance advisor flags these foreign keys as unindexed. They are invisible
-- at today's row counts (workouts ~800, athletes ~40) — a seq scan over 800 rows is
-- nothing — but every per-athlete / per-coach / per-school scoped query filters on
-- exactly these columns, so they become full seq scans once the tables reach the
-- 100k–500k rows a few hundred active athletes produce. Add them now, cheaply, well
-- ahead of the 5,000-user push (roadmap "Now" bucket).
--
-- Additive + idempotent: CREATE INDEX IF NOT EXISTS only. No table is rewritten and
-- nothing is dropped. Plain (non-CONCURRENT) CREATE INDEX is used deliberately: these
-- tables are tiny today so the build + brief ACCESS EXCLUSIVE lock is sub-second, and
-- CONCURRENTLY cannot run inside the transaction Supabase wraps a migration in. If any
-- of these tables is already large when this runs, build that one index out-of-band
-- with CREATE INDEX CONCURRENTLY instead.
--
-- Naming follows the existing convention (<table>_<col>_idx, e.g. usage_costs_athlete_idx).

-- workouts.athlete_id — THE hot path. Nearly every read is "this athlete's workouts,
-- newest first" (Progress screen, proof-feed briefs), so index (athlete_id, created_at)
-- rather than the bare FK: it serves the FK lookup AND the ORDER BY created_at in one.
CREATE INDEX IF NOT EXISTS workouts_athlete_created_idx ON workouts (athlete_id, created_at);

-- prs.athlete_id — per-athlete PR lookups (proof feed, e1RM math), equality only.
CREATE INDEX IF NOT EXISTS prs_athlete_idx ON prs (athlete_id);

-- athletes.coach_id / athletes.school_id — the roster scoping columns. Every coach
-- dashboard load, coach report, and school rollup filters on one of these.
CREATE INDEX IF NOT EXISTS athletes_coach_idx  ON athletes (coach_id);
CREATE INDEX IF NOT EXISTS athletes_school_idx ON athletes (school_id);

-- program_modifications.athlete_id / athlete_goals.athlete_id — per-athlete scoped
-- reads in the program + goals paths.
CREATE INDEX IF NOT EXISTS program_modifications_athlete_idx ON program_modifications (athlete_id);
CREATE INDEX IF NOT EXISTS athlete_goals_athlete_idx         ON athlete_goals (athlete_id);
