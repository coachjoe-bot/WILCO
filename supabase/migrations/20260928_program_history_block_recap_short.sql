-- T64 Fix 3b (Will 09-28): a short, athlete-facing line alongside the full
-- AI-context block_recap (Will found the full recap too long to read on the
-- Past Blocks card). Additive, nullable. NOT applied to prod by this session —
-- closeBlock (src/programHistory.js) writes it in its own best-effort call
-- that is safe to fail until this migration lands (the render falls back to
-- the first two sentences of block_recap via recapShortFallback). See the S3
-- handoff's SHIP DARK FIRST list: the integrator applies this before the
-- client ships.
ALTER TABLE program_history ADD COLUMN IF NOT EXISTS block_recap_short text;
