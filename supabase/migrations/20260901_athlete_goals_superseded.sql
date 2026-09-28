-- T62 memory engine (Will's 09-01 ruling): goals stop accumulating as equals.
-- A new goal write stamps the prior active rows superseded; readers filter on
-- this + a 14-day grace past target_date (src/goals.js activeGoals). History
-- stays queryable for Past Blocks and the coach brain — never deleted.
alter table athlete_goals
  add column if not exists superseded_at timestamptz;

comment on column athlete_goals.superseded_at is
  'Stamped when a newer goal replaced this one (T62). Null = still the athlete''s stated goal (subject to the read-side target_date grace window).';
