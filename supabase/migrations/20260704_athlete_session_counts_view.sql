-- ─── Server-side session aggregation (SCALE-NOTES) ───────────────────────────
-- SQL port of the client's groupIntoSessions() (src/App.jsx): a session is a run of
-- one athlete's REAL workout entries within a 3-hour gap; parsed_data.new_session
-- forces a split. "Real" mirrors isRealSession(): exercises[] non-empty OR truthy
-- run_data. Lets the coach dashboard show per-athlete session totals without pulling
-- every raw workout to the browser.
--
-- VERIFIED 2026-07-04: exported all 696 prod workouts and re-ran the actual
-- groupIntoSessions() algorithm in Node — the view matched row-for-row (117 sessions
-- across all 16 athletes-with-workouts, zero mismatches).
--
-- SECURITY: a view bypasses the base table's RLS by default, which would re-open the
-- anon read hole closed on `workouts`. security_invoker=on makes it honor the caller's
-- RLS (service_role gateway bypasses + scopes; anon is denied). Grants are explicit.
-- Applied to prod as two migrations (…_view, …_view_security); combined here.

CREATE OR REPLACE VIEW v_athlete_session_counts AS
WITH real AS (
  SELECT
    athlete_id,
    created_at,
    (parsed_data->'new_session' = 'true'::jsonb) AS forced_new  -- strict === true
  FROM workouts
  WHERE
    (jsonb_typeof(parsed_data->'exercises') = 'array' AND jsonb_array_length(parsed_data->'exercises') > 0)
    OR (
      parsed_data->'run_data' IS NOT NULL
      AND jsonb_typeof(parsed_data->'run_data') <> 'null'
      AND parsed_data->'run_data' NOT IN ('false'::jsonb, '0'::jsonb, '""'::jsonb)
    )
),
marked AS (
  SELECT
    athlete_id, created_at, forced_new,
    LAG(created_at) OVER (PARTITION BY athlete_id ORDER BY created_at) AS prev_at,
    ROW_NUMBER() OVER (PARTITION BY athlete_id ORDER BY created_at) AS rn
  FROM real
)
SELECT
  athlete_id,
  COUNT(*) FILTER (
    WHERE rn = 1 OR forced_new OR (created_at - prev_at) > interval '3 hours'
  )::int AS session_count,
  MAX(created_at) AS last_workout_at
FROM marked
GROUP BY athlete_id;

ALTER VIEW v_athlete_session_counts SET (security_invoker = on);
REVOKE ALL ON v_athlete_session_counts FROM anon, authenticated;
GRANT SELECT ON v_athlete_session_counts TO service_role;
