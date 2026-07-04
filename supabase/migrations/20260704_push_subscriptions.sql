-- ─── WEB PUSH v1: push_subscriptions rebuild ─────────────────────────────────
-- Run in Supabase SQL Editor (or via MCP apply_migration).
--
-- HISTORY: 20260530_sprint2_proof_feed.sql created push_subscriptions with a
-- single JSONB `subscription_json` blob and ONE subscription per athlete
-- (unique athlete_id). That shape never went live: the client registration
-- gated on a VITE_VAPID_PUBLIC_KEY that was never set, so the table stayed
-- empty forever (verified 0 rows at rebuild time — the DROP below is safe).
-- Web Push v1 (api/push.js) needs:
--   • one row PER BROWSER ENDPOINT (an athlete can have phone + laptop),
--     keyed by the endpoint URL (unique) so upsert-by-endpoint just works;
--   • the p256dh/auth keys as columns (what the `web-push` library consumes);
--   • last_nudged_at for the daily inactivity-nudge cron's 3-day cooldown.
--
-- SECURITY: same lockdown pattern as every other PII table (see
-- 20260624_phase1_lock_writes.sql / 20260625_error_events.sql): RLS ENABLED with
-- NO policies → the public anon key can neither read nor write ANY row. All
-- access goes through the authenticated gateways (api/push.js / api/data.js)
-- with the SERVICE key, which bypasses RLS after verifying the caller.

DROP TABLE IF EXISTS push_subscriptions;

CREATE TABLE push_subscriptions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id     UUID        NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  endpoint       TEXT        UNIQUE NOT NULL,
  p256dh         TEXT        NOT NULL,
  auth           TEXT        NOT NULL,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  last_nudged_at TIMESTAMPTZ
);

-- The nudge cron and the per-athlete subscribe/test/unsubscribe paths all
-- filter by athlete (NOT unique — an athlete may have several devices).
CREATE INDEX push_subscriptions_athlete_idx ON push_subscriptions (athlete_id);

-- RLS on, zero policies: anon fully denied; service_role bypasses.
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
