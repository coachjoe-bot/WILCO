# Coach Experience — Overhaul Roadmap

> Captured 2026-07-04. Will flagged that the **coach experience needs a huge update**.
> This is the running backlog for that overhaul. UX/visual decisions are Will's taste
> call — items below are proposals + the engineering groundwork that's already landed.
> Source: `src/coach.jsx` (lazy-loaded dashboard chunk), `api/identity.js`
> (`coach-dashboard`, `coach-athlete-fields`), `api/data.js` (scoped reads/writes).

## Where the coach dashboard is today

The dashboard (`CoachDashboard` in `src/coach.jsx`, ~1800 lines) loads everything up
front in `loadAll()`:
- `idApi("coach-dashboard")` → athletes + coaches + school(s), role-scoped server-side.
- `sbReadPaged("workouts")` + `sbReadPaged("prs")` → **all** scoped workouts/prs into
  browser memory (now paginated to a 50k ceiling; see SCALE-NOTES).
- proof digests (per-athlete + team reports).

Everything then renders client-side off those in-memory arrays: roster list (session
count via `groupIntoSessions`, pain flags), per-athlete detail, `GroupStats`, proof
reports, bulk program assignment, coach/school management.

### Pain points / gaps observed
- **Loads the whole roster's raw history to the browser.** Fine now; won't scale. The
  data layer for the fix is already built (below).
- **All-at-once load** — no lazy per-athlete detail; the roster + every athlete's
  workouts arrive before anything renders.
- **Session counts / stats computed client-side** (`groupIntoSessions`, Epley e1RM
  loops) — belongs in SQL as the roster grows.
- Coaches have **no cost / reliability / engagement visibility** into their roster
  (the analytics ledgers snapshot `coach_id` precisely so this is a single scoped read).

## Engineering groundwork already landed (ready to consume)

- ✅ **Server-side session counts** — `v_athlete_session_counts` (SQL port of
  `groupIntoSessions`, **verified row-for-row** against prod, secured, exposed via the
  scoped read op). Consume it: `sbRead("v_athlete_session_counts", "?select=*")` returns
  `{athlete_id, session_count, last_workout_at}` scoped to the coach's roster. Swap the
  in-browser `groupIntoSessions(workouts.filter(...)).length` at `coach.jsx` roster list
  for `sessionCounts[a.id]`. **This is the first step to stop loading raw workouts.**
- ✅ **Paginated reads** (`sbReadPaged`) — no more silent 5000-row truncation.
- ✅ **Longer function budgets** (Vercel Pro `maxDuration`) — coach-dashboard bulk
  reads + any future aggregate endpoints have room.

## Proposed overhaul (pick + shape with Will)

### A. Data layer — stop shipping raw workouts to the browser
1. Roster list renders from **aggregates only**: `v_athlete_session_counts`
   (session_count, last_workout_at) + a small per-athlete "unresolved pain?" flag view
   (mirror the pain-flag logic the roster currently computes from raw `parsed_data`).
2. **Lazy-load** a single athlete's raw workouts/prs only when their detail is opened
   (bounded, like the athlete side's `limit=100`).
3. Move `GroupStats` (team rollups: most-improved, volume-cratered) to SQL or a scoped
   aggregate endpoint. Each is additive; none needs a new Vercel function (ride
   `api/data.js` read op or add SQL views like the session-count one).
4. Retire the full `sbReadPaged("workouts")`/`("prs")` pull once 1–3 cover the UI.

### B. Coach analytics dashboard (deferred feature, now unblocked by Pro's fn headroom)
Per-roster views reading the scoped ledgers (all snapshot `coach_id`):
- **Engagement**: active athletes (DAU/WAU), sessions logged this week, activation
  funnel, who's gone quiet (`usage_events`, `v_dau/wau/mau`).
- **Reliability**: error rate on the athletes' app experience (`error_events`).
- **AI cost** per roster (`usage_costs`) — useful if school tiers ever get cost-based.
Design/what-to-surface is Will's call. Endpoint is a scoped read (add the ledger views
to `READ_OWN_COL`, already coach_id-scoped) — zero new functions.

### C. UX / information architecture (Will's taste)
Candidate directions to react to, not prescriptions:
- **Roster triage view**: sort/filter by "needs attention" (inactive N days, unresolved
  pain, missed program) instead of a flat list.
- **Per-athlete timeline**: sessions, PRs, proof digests, pain history in one scroll.
- **At-a-glance team health** header (active %, sessions this week, flags) from aggregates.
- **Faster first paint**: render the roster from the lightweight aggregate immediately;
  hydrate detail on demand (ties to A).
- Mobile-first pass (coaches check phones between sessions).

## Suggested sequencing
1. Wire `v_athlete_session_counts` into the roster list (small, safe, immediate).
2. Add the pain-flag + last-active aggregate views; move roster fully onto aggregates.
3. Lazy per-athlete detail; retire the full raw pull.
4. `GroupStats` → SQL.
5. Coach analytics dashboard (B).
6. UX/IA overhaul (C) — the "huge update", shaped with Will.

Steps 1–4 are pure functionality (verifiable by comparing to the current client output,
like the session-count view was). Do them on a preview deploy and diff against prod
before merging, since the coach dashboard can't be exercised under `vite dev` (no `/api`).
