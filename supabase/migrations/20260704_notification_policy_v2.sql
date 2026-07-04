-- ─── NOTIFICATION POLICY v2 ───────────────────────────────────────────────────
-- Run in Supabase SQL Editor (or via MCP apply_migration) AFTER the v3 code deploys.
-- Part of the feat/proof-feed-v3 branch — applied at MERGE time, not before
-- (prod DB is shared with previews; this file is inert until run).
--
-- Will's policy (2026-07-04): the ONLY pushes WILCO ever sends are:
--   1. Proof Feed went live for you (existing scope, capped 1/athlete/day)
--   2. Inactivity — exactly TWO touches per quiet streak: 14 days, then 30 days,
--      then silence until they log again (which re-arms both)
--   3. Coach updated your programming — debounced: rapid edits in ~15 min collapse
--      into ONE push
--   4. "Send a test" (user-initiated, unchanged)
--
-- WHY a dedicated table instead of overloading push_subscriptions.last_nudged_at:
-- an athlete can have multiple devices (multiple push_subscriptions rows), and the
-- old 3-day cooldown only ever needed "was ANY row nudged recently" — ambiguous by
-- design (fine for a repeating nudge). The new policy needs to answer a stricter
-- question PER ATHLETE (not per device): "have we already sent the 14-day touch
-- for THIS quiet streak" and "...the 30-day touch". A per-athlete state row with an
-- explicit stage makes that unambiguous and is naturally where "streak reset on a
-- new workout" lives (one UPSERT, not an update-every-device fan-out).

-- ── Inactivity nudge state (one row per athlete) ──────────────────────────────
CREATE TABLE IF NOT EXISTS athlete_nudge_state (
  athlete_id       UUID        PRIMARY KEY REFERENCES athletes(id) ON DELETE CASCADE,
  last_workout_at  TIMESTAMPTZ,              -- streak anchor: most recent workout we've seen
  stage_14_sent_at TIMESTAMPTZ,              -- set once the 14-day touch fires for this streak
  stage_30_sent_at TIMESTAMPTZ,              -- set once the 30-day touch fires for this streak
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- RLS on, zero policies — same lockdown as every other PII-adjacent table
-- (push_subscriptions, error_events, etc). Only the service-key cron path touches it.
ALTER TABLE athlete_nudge_state ENABLE ROW LEVEL SECURITY;

-- ── Coach programming-change debounce queue ───────────────────────────────────
-- Written by api/data.js at the exact point a COACH (not the athlete, not Joe's
-- automated in-chat program updates) PATCHes an athlete's program_text. A 15-min
-- Vercel cron (api/notify-program-changes.js) reads unnotified rows, and for each
-- athlete whose NEWEST unnotified row is >= 15 min old, sends ONE push and marks
-- every pending row for that athlete `notified` — so a burst of quick coach edits
-- collapses into a single notification.
CREATE TABLE IF NOT EXISTS program_change_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id  UUID        NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified    BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS program_change_events_pending_idx
  ON program_change_events (athlete_id, changed_at)
  WHERE notified = FALSE;

ALTER TABLE program_change_events ENABLE ROW LEVEL SECURITY;

-- ── Feed-push cap (one per athlete per day) ───────────────────────────────────
-- Simplest robust mechanism: a single timestamp column on push_subscriptions'
-- companion per-athlete state. We put it on athlete_nudge_state (not
-- push_subscriptions, which is per-DEVICE) so "already pushed today for this feed
-- entry" is one row's one column, independent of how many devices the athlete has.
ALTER TABLE athlete_nudge_state ADD COLUMN IF NOT EXISTS last_feed_push_at TIMESTAMPTZ;
