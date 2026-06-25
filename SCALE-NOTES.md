# Scale Notes — edits for thousands of users

Running list of things to address before WILCO scales to thousands of users.
These are **out of scope for the cost-tracking work** but noted as they surface.
None are urgent at current volume.

## Cost-tracking system (usage_costs)
- **Materialize the daily rollup.** `v_ai_cost_daily` recomputes over all raw rows
  on every read. When `usage_costs` gets large, convert it to a `MATERIALIZED
  VIEW` refreshed nightly (piggyback the existing daily cron `trigger-proof-feed`,
  or add pg_cron), and point the agent at the rollup for trends.
- **Retention / pruning.** Raw rows aren't needed forever. Once the daily rollup
  exists, prune raw rows older than ~90 days:
  `DELETE FROM usage_costs WHERE created_at < now() - interval '90 days';`
  Wire to a cron. (Storage is bounded; queries stay fast.)
- **Drop the per-call snapshot read.** `api/claude.js` does one extra `sbSelect`
  per AI call to snapshot tier/school/coach (currently overlapped with the
  Anthropic call, so ~free). At very high volume, eliminate it by having
  `authCaller` (in `api/_supa.js`) return those fields — but that's a shared
  security-owned file, so coordinate that change.

## App architecture (pre-existing, bigger lifts)
- **`src/App.jsx` is one ~5,800-line file that loads data client-side.** The coach
  dashboard pulling all workouts/athletes to the browser won't survive scale —
  needs server-side pagination/aggregation.
- **Client-side progress math.** `groupIntoSessions`, Epley e1RM loops, etc. run
  in the browser over all workouts. Move to SQL/server as data grows.
- **Vercel is at 12/12 functions** (14 files in `api/` − 2 `_`-prefixed helpers that
  Vercel doesn't count; confirmed 2026-06-25). This is the **Hobby** 12-function cap —
  verify the plan tier in the dashboard (Settings → Billing), since upgrading to Pro
  lifts it (~100). No room for new endpoints on Hobby — before big features,
  consolidate into a router function or bump the plan. (The analytics ledgers + the
  app-health reporting agent deliberately add zero functions for this reason.)
- **`rate_limits` grows unbounded.** Wire up the cleanup cron commented out in
  `20260624_security_rate_limits.sql`.
- **`count(*)` dashboards** get slow eventually — fine at thousands, but consider
  estimated counts / maintained counters at much larger scale.

## Reliability system (error_events — Phase 1.5, BUILT)
- **Materialize the rollups.** `v_errors_daily` / `v_errors_by_fingerprint` /
  `v_ai_reliability_daily` recompute over all raw rows on every read. At volume,
  convert to `MATERIALIZED VIEW`s refreshed nightly (piggyback `trigger-proof-feed`
  or pg_cron), and point the agent at the rollups for trends.
- **Retention / pruning.** Same 90-day policy as `usage_costs`:
  `DELETE FROM error_events WHERE created_at < now() - interval '90 days';` Wire to
  a cron. Error rows can spike in bursts, so this matters sooner than cost rows.
- **True per-feature error RATES need a denominator.** Counts ship now; rates wait
  on Phase 2 `usage_events` (attempts per feature). AI is the exception — it already
  has a denominator via `usage_costs` (`v_ai_reliability_daily`).
- **Ingestion rides `api/identity` (log-error), zero new functions** — Vercel stays
  at 12/12. The IP rate-limit (60/15min) writes a `rate_limits` row per error POST;
  that table's unbounded-growth cleanup (above) covers it.

## Engagement system (usage_events — Phase 2, BUILT)
- **Highest-volume ledger by far** (every session/key-action vs. one row per AI call
  or crash). Volume is contained at the source: a curated event ALLOWLIST (off-list
  events dropped server-side) + client-side BATCHING (events buffered, flushed
  N-at-a-time / on a timer / on page-hide → ~one request per flush, not per event).
- **Daily rollup is already materialized.** `mv_daily_active_athletes` (one row per
  athlete per active day) is the scale primitive behind `v_dau`/`v_wau`/`v_mau`/
  `v_stickiness_daily`, so active-user math never scans raw. **Nightly refresh is now
  WIRED (DONE 2026-06-25):** pg_cron job `engagement-rollups-nightly` at 00:15 UTC runs
  `refresh_engagement_rollups()` (migration `20260625_engagement_rollup_cron.sql`).
  Confirm it's registered: `SELECT jobname,schedule,active FROM cron.job WHERE
  jobname='engagement-rollups-nightly';`. The other engagement views
  (`v_sessions_daily`, `v_feature_adoption*`, `v_error_rate_by_area_daily`) still
  recompute over raw — materialize them too if they get slow.
- **Retention matters MOST here.** 90-day raw prune of `usage_events` is now **DONE** —
  folded into the same `refresh_engagement_rollups()` cron above (the matview retains
  aggregate history indefinitely, so pruning raw is safe). NOTE: the equivalent prunes
  for `usage_costs` and `error_events` are **still TODO** (see those sections).
- **Ingestion rides `api/identity` (log-events), zero new functions** — Vercel stays
  at 12/12. Per-IP rate-limit (120 batches/15min) writes a `rate_limits` row per
  POST; covered by that table's cleanup (above).
- **Denominator is now live.** `v_error_rate_by_area_daily` joins `error_events` to
  `usage_events` on `(area, day)` — true per-feature error RATES (closes the
  Phase-1.5 "rates wait on Phase 2" note above).

## Future phases (planned, not built) — PINNED
- **Coach dashboard reads** — route `usage_costs` / `error_events` / `usage_events`
  through `api/data.js`'s scoped `read` op (add to `READ_OWN_COL`), scoped by
  `school_id`/`coach_id` snapshots. (All three ledgers already snapshot
  `school_id`/`coach_id`/`tier` on every row precisely so this is a single indexed
  WHERE with no join — the analytics views are built to be reused here.)
- **Non-AI cost sources** — `usage_costs` was built to absorb other per-customer
  costs (e.g. Resend `source='email'`, with `quantity`/`meta`) with NO migration.
  Wire a write where those costs are incurred when worth tracking; the cost views
  already `WHERE source='claude'`, so non-AI sources slot in cleanly.
