-- ─── COACH DASHBOARD OVERHAUL ─────────────────────────────────────────────────
-- All additive + backward-compatible: new tables, one nullable column, one boolean
-- with a backfill. Inert until the feat/coach-overhaul code reads/writes it, so it
-- is safe to apply to the shared prod DB ahead of merge. Every new table is RLS-on
-- with ZERO policies — reachable ONLY through the service-key gateway (api/data.js),
-- same lockdown as every other PII-adjacent table.

-- ── coach_context: rolling buffer of what the coach told WILCO ─────────────────
-- The coach-side analogue of athlete_context. Written from the Coach's Edition
-- check-in (season phase, block goal, fatigue read, per-athlete notes) so each
-- edition is generated against the coach's real situation.
CREATE TABLE IF NOT EXISTS coach_context (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id     UUID        NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  note         TEXT        NOT NULL,
  is_long_term BOOLEAN     DEFAULT FALSE,
  meta         JSONB       DEFAULT '{}'::jsonb,   -- {kind:'season'|'goal'|'response'|'notes'}
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS coach_context_coach_idx ON coach_context (coach_id, created_at DESC);
ALTER TABLE coach_context ENABLE ROW LEVEL SECURITY;

-- ── program_change_requests: the locked-program collaboration loop ────────────
-- When an athlete's program is LOCKED and the AI would have changed it, it instead
-- files a request here + tells the athlete what to raise. The coach's inbox shows
-- these with Apply / Skip / Edit. coach_id denormalized so the inbox scopes by it.
CREATE TABLE IF NOT EXISTS program_change_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  UUID        NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  coach_id    UUID        REFERENCES coaches(id) ON DELETE SET NULL,
  items       JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{lift, suggested_change, current, why}]
  reason      TEXT,                                       -- free-text athlete note
  source      TEXT        NOT NULL DEFAULT 'feedback',    -- plateau|pr|pain|feedback
  status      TEXT        NOT NULL DEFAULT 'pending',     -- pending|applied|skipped|edited
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT pcr_source_chk CHECK (source IN ('plateau','pr','pain','feedback')),
  CONSTRAINT pcr_status_chk CHECK (status IN ('pending','applied','skipped','edited'))
);
CREATE INDEX IF NOT EXISTS pcr_coach_pending_idx ON program_change_requests (coach_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS pcr_athlete_idx ON program_change_requests (athlete_id);
ALTER TABLE program_change_requests ENABLE ROW LEVEL SECURITY;

-- ── prs.is_baseline: tag first-ever logs so PR counts/notifications are honest ─
-- Root cause of PR-spam: the first-ever log of any exercise inserts a prs row; the
-- coach counted raw rows. A countable/notifiable PR = improvement over a prior best,
-- never a baseline. Backfill flags the OLDEST row per (athlete, exercise).
ALTER TABLE prs ADD COLUMN IF NOT EXISTS is_baseline BOOLEAN NOT NULL DEFAULT FALSE;
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY athlete_id, lower(exercise) ORDER BY created_at ASC, id ASC) AS rn
  FROM prs
)
UPDATE prs SET is_baseline = TRUE
FROM ranked
WHERE prs.id = ranked.id AND ranked.rn = 1 AND prs.is_baseline = FALSE;

-- ── coach push: coaches can't receive push today (push_subscriptions.athlete_id
-- is NOT NULL). A parallel table keeps the hot athlete table untouched. ─────────
CREATE TABLE IF NOT EXISTS coach_push_subscriptions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id       UUID        NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  endpoint       TEXT        UNIQUE NOT NULL,
  p256dh         TEXT        NOT NULL,
  auth           TEXT        NOT NULL,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  last_nudged_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS coach_push_subscriptions_coach_idx ON coach_push_subscriptions (coach_id);
ALTER TABLE coach_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- ── coaches.notification_prefs: the Coach Settings toggles ─────────────────────
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS notification_prefs JSONB
  NOT NULL DEFAULT '{"injury":true,"big_pr":true,"inactive":true,"digest":true}'::jsonb;
