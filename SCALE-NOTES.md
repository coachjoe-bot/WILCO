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
- **Vercel is at 12/12 functions (Hobby cap).** No room for new endpoints — before
  big features, consolidate into a router function or bump the plan. (Cost
  tracking deliberately added zero functions for this reason.)
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

## Future phases (planned, not built)
- **Phase 2 Engagement** — `usage_events` (app opens/sessions, feature views) for
  true DAU/sessions + activation funnel + feature-adoption breadth.
- **Coach dashboard reads** — route `usage_costs` through `api/data.js`'s scoped
  `read` op (add to `READ_OWN_COL`), scoped by `school_id`/`coach_id` snapshots.
