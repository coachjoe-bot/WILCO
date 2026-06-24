-- ─── athlete_context UNIQUE(athlete_id) ──────────────────────────────────────
-- The monthly-recap feature upserts one context row per athlete via
--   POST /athlete_context?on_conflict=athlete_id  (resolution=merge-duplicates)
-- but athlete_context never had a unique key on athlete_id, so PostgREST cannot
-- resolve the conflict and the upsert has been failing silently — recap context
-- never persists. This adds the missing constraint.
--
-- Run AFTER collapsing any duplicate rows that accumulated while it was broken.
-- Safe to run more than once (dedupe + constraint guard are both idempotent).

BEGIN;

-- 1) Collapse duplicates: keep the most-recently-updated row per athlete, drop the rest.
--    NULLS LAST so any row missing a timestamp loses to a real one.
DELETE FROM athlete_context
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY athlete_id
             ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
           ) AS rn
    FROM athlete_context
  ) ranked
  WHERE ranked.rn > 1
);

-- 2) Add the unique constraint (skip if it already exists).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'athlete_context_athlete_id_key'
  ) THEN
    ALTER TABLE athlete_context
      ADD CONSTRAINT athlete_context_athlete_id_key UNIQUE (athlete_id);
  END IF;
END $$;

COMMIT;

-- ─── ROLLBACK (if ever needed) ───────────────────────────────────────────────
-- ALTER TABLE athlete_context DROP CONSTRAINT IF EXISTS athlete_context_athlete_id_key;
-- (Note: the de-duplicated rows cannot be restored, but they were redundant stale
--  recap snapshots — the kept row per athlete is the newest.)
