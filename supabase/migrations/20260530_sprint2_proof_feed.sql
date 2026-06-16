-- ─── SPRINT 2: PROOF FEED ────────────────────────────────────────────────────
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query → Run)

-- 1. Add proof-cycle columns to athletes
ALTER TABLE athletes
  ADD COLUMN IF NOT EXISTS proof_cycle_count   INTEGER   DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_proof_sent_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_proof_due_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS height_finalized    BOOLEAN   DEFAULT FALSE;

-- 2. proof_digests — one record per athlete at a time (previous deleted on new insert)
CREATE TABLE IF NOT EXISTS proof_digests (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     UUID        NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  coach_id       UUID        REFERENCES coaches(id) ON DELETE SET NULL,
  digest_type    TEXT        NOT NULL CHECK (digest_type IN ('weekly','monthly','monthly_coach')),
  label          TEXT        NOT NULL,   -- e.g. "WEEKLY DIGEST — May 30, 2026"
  content_json   JSONB       NOT NULL,   -- full generated content sections
  is_read        BOOLEAN     DEFAULT FALSE,
  has_plateau    BOOLEAN     DEFAULT FALSE,
  has_pain       BOOLEAN     DEFAULT FALSE,
  has_missed     BOOLEAN     DEFAULT FALSE,
  generated_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS proof_digests_athlete_idx ON proof_digests (athlete_id);
CREATE INDEX IF NOT EXISTS proof_digests_coach_idx   ON proof_digests (coach_id);

-- 3. athlete_context — one record per athlete (overwritten each monthly recap)
--    is_long_term=true entries are NEVER auto-overwritten
CREATE TABLE IF NOT EXISTS athlete_context (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   UUID        NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  content      TEXT        NOT NULL,
  is_long_term BOOLEAN     DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS athlete_context_athlete_idx ON athlete_context (athlete_id);

-- 4. push_subscriptions — Web Push API (VAPID) subscriptions per athlete
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id        UUID        NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  subscription_json JSONB       NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_athlete_idx ON push_subscriptions (athlete_id);

-- 5. RLS: allow authenticated service role (edge functions use service key so no row-level needed for them)
--    For client-side reads, athletes should only see their own data.
--    These policies are additive — skip if RLS is not enabled on your project.
-- ALTER TABLE proof_digests    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE athlete_context  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
