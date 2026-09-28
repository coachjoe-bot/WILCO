-- T64 Fix 3 (Will 09-28): a non-destructive way to clear a Drafts-pane card.
-- Additive, nullable — dismissing a card stamps this column; the row, its
-- swaps, and its auto-revert clock all stay exactly as they were (only
-- Will's 09-01 Dismiss=Delete ruling on the REC SHEET's own Dismiss button is
-- unaffected by this — that path still hard-deletes, as decided). The boot
-- auto-revert scan (App.jsx) must NEVER filter on this column: a dismissed
-- timed rec still has to revert on schedule.
ALTER TABLE program_drafts ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
