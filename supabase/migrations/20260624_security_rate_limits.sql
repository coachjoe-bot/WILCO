-- ─── Security Phase 0: rate-limit store ──────────────────────────────────────
-- Backs login rate limiting (api/_supa.js -> rateLimit). Stateless serverless
-- functions can't hold counters in memory, so attempts are recorded here.
-- Only the SERVICE key (server) touches this table; RLS denies the anon key.

CREATE TABLE IF NOT EXISTS rate_limits (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key        TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limits_key_time_idx ON rate_limits (key, created_at);

-- Enable RLS with NO policies => the anon key can do nothing here.
-- The service_role key bypasses RLS, so the server still reads/writes freely.
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Optional housekeeping: drop attempt rows older than a day.
-- (Safe to run manually anytime, or wire to a cron later.)
-- DELETE FROM rate_limits WHERE created_at < now() - interval '1 day';
