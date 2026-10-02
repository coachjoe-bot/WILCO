-- T70 Stats: one summary row per athlete, computed by the server from the raw
-- workouts rows (src/stats.js computeAthleteStats, run via api/_stats.js) after
-- every workouts write, and rebuilt nightly. The Stats tab, the share card, the
-- monthly Proof numbers block, the 1Y/ALL graph ranges and the coach team-totals
-- card read this ONE row instead of the athlete's whole history. It is derived
-- data: delete it and the next write or rebuild puts it back.
create table if not exists athlete_stats (
  athlete_id   uuid primary key references athletes(id) on delete cascade,
  version      int not null default 1,
  source_rows  int not null default 0,
  stats        jsonb not null default '{}'::jsonb,
  computed_at  timestamptz not null default now()
);

-- Gateway-only access, same posture as the other athlete tables: the app reads
-- it through api/data.js (READ_OWN_COL scope) and only the server writes it.
alter table athlete_stats enable row level security;
revoke all on athlete_stats from anon, authenticated;

-- Live truth for the nightly rebuild: how many workout rows each athlete has and
-- the newest one, so only athletes whose history moved get recomputed.
create or replace view v_athlete_workout_counts as
  select athlete_id, count(*)::int as workout_rows, max(created_at) as newest_at
  from workouts group by athlete_id;
revoke all on v_athlete_workout_counts from anon, authenticated;
