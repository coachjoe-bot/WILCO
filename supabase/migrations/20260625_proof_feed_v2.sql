-- ─── Proof Feed v2 — Phase 1: data model ─────────────────────────────────────
-- Companion to docs/proof-feed-v2-spec.md §4. Run by Will in the Supabase SQL
-- editor. Every statement is idempotent (IF NOT EXISTS / DROP-then-ADD), so this
-- file is safe to re-run.
--
-- What it adds:
--   1. athletes  — per-athlete scheduling, a daily-run cap guard, and ask-flags.
--   2. program_prescriptions — structured parse of each athlete's program_text
--      (one row per athlete; server-only, anon denied via RLS). Powers the
--      load + set/rep VOLUME adherence comparison (the spec's headline feature).
--   3. proof_digests — widen the digest_type CHECK to allow the coach digests.
--   4. a scale index so the "athletes due now" query stays fast at 10k+ athletes.
--
-- Nothing here is wired to the client: the new athlete columns are written through
-- the EXISTING athletes update path in api/data.js (already scoped to the caller's
-- own id), and program_prescriptions is written ONLY by the engine with the
-- service key (which bypasses RLS). The browser never touches it.

-- ── 1. athletes: scheduling + caps + ask-flags ───────────────────────────────
ALTER TABLE athletes
  ADD COLUMN IF NOT EXISTS proof_enabled        BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS proof_schedule_dow   INTEGER,          -- 0=Sun..6=Sat (local)
  ADD COLUMN IF NOT EXISTS proof_schedule_hour  INTEGER,          -- 0..23 local
  ADD COLUMN IF NOT EXISTS proof_timezone       TEXT DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS last_proof_run_date  DATE,             -- daily-cap guard (≤1 run/day/athlete)
  ADD COLUMN IF NOT EXISTS ask_weight           BOOLEAN DEFAULT TRUE;
-- height: we reuse the EXISTING height_finalized column (TRUE => stop asking).

-- ── 2. program_prescriptions: structured program parse (one row per athlete) ──
-- Re-parsed only when program_text changes (source_hash guard, see spec §6), so
-- the per-digest program-vs-actual comparison is a free code lookup, not an AI call.
CREATE TABLE IF NOT EXISTS program_prescriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    UUID NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  source_hash   TEXT NOT NULL,           -- hash(program_text); skip re-parse if unchanged
  parsed_json   JSONB NOT NULL,          -- blocks[].days[].exercises[] + ref_1rms (spec §6)
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
-- One prescription row per athlete — also lets the engine upsert on athlete_id.
CREATE UNIQUE INDEX IF NOT EXISTS program_prescriptions_athlete_idx
  ON program_prescriptions (athlete_id);

-- Server-only: enable RLS and add NO policy → anon/authenticated are denied, while
-- the service_role key (engine) bypasses RLS. Same lockdown posture as the other
-- PII tables (Phase 1b/1c). This is the default-deny that keeps proof data private.
ALTER TABLE program_prescriptions ENABLE ROW LEVEL SECURITY;

-- ── 3. proof_digests: widen the digest_type CHECK ────────────────────────────
-- Was (weekly|monthly|monthly_coach). Add weekly_coach for the Phase 5 weekly
-- coach report. DROP-then-ADD keeps this idempotent.
ALTER TABLE proof_digests DROP CONSTRAINT IF EXISTS proof_digests_digest_type_check;
ALTER TABLE proof_digests ADD CONSTRAINT proof_digests_digest_type_check
  CHECK (digest_type IN ('weekly','monthly','weekly_coach','monthly_coach'));

-- 3b. The team-aggregate coach reports (weekly_coach/monthly_coach) are about the
-- whole roster, not one athlete, so they store athlete_id = NULL. Relax the NOT
-- NULL (the FK + ON DELETE CASCADE stay; per-athlete digests still set it).
ALTER TABLE proof_digests ALTER COLUMN athlete_id DROP NOT NULL;

-- ── 4. Scale index: the "athletes due now" query ─────────────────────────────
-- Beyond the spec, for scalability: the engine/pg_cron selects athletes where
-- proof is enabled and next_proof_due_at <= now(). A partial index on that column
-- (enabled rows only) turns a full-table scan into an index range scan — matters
-- at thousands of athletes when the cron runs frequently.
CREATE INDEX IF NOT EXISTS athletes_proof_due_idx
  ON athletes (next_proof_due_at)
  WHERE proof_enabled;


-- ─── EMERGENCY UNDO — run ONLY to fully reverse this migration ────────────────
-- (Dropping the columns/table is destructive — it discards scheduling prefs and
-- any cached program parses. The digest_type CHECK is restored to its prior form.)
-- DROP INDEX IF EXISTS athletes_proof_due_idx;
-- DROP TABLE IF EXISTS program_prescriptions;
-- ALTER TABLE athletes
--   DROP COLUMN IF EXISTS proof_enabled,
--   DROP COLUMN IF EXISTS proof_schedule_dow,
--   DROP COLUMN IF EXISTS proof_schedule_hour,
--   DROP COLUMN IF EXISTS proof_timezone,
--   DROP COLUMN IF EXISTS last_proof_run_date,
--   DROP COLUMN IF EXISTS ask_weight;
-- ALTER TABLE proof_digests DROP CONSTRAINT IF EXISTS proof_digests_digest_type_check;
-- ALTER TABLE proof_digests ADD CONSTRAINT proof_digests_digest_type_check
--   CHECK (digest_type IN ('weekly','monthly','monthly_coach'));
-- DELETE FROM proof_digests WHERE athlete_id IS NULL;  -- remove coach reports first
-- ALTER TABLE proof_digests ALTER COLUMN athlete_id SET NOT NULL;
