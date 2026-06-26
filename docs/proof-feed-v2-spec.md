# Proof Feed v2 — Build Spec

Self-contained spec for rebuilding WILCO's **Proof Feed**. A fresh Claude Code
session should be able to implement from this doc alone. Read it top to bottom,
then start at **Phase 0**.

Companion docs: `docs/analytics-schema.md` (cost/usage/engagement ledgers).
Status as of writing: **designed, approved by Will, not yet implemented.**

---

## 0. Why we're doing this

### What the Proof Feed is
An automated, AI-generated training digest in **Coach Joe's voice**, delivered to
athletes (and, separately, to coaches) on a recurring schedule. It reads the
athlete's logged training and produces a review: week-over-week comparison,
consistency, program-vs-actual, PRs, plateaus, recurring injuries, goal progress,
a focus for next week — then runs a short guided check-in.

### The root-cause bug it "never deployed once" was hiding
The Vercel app build was **always green**. The failure was runtime: the Proof
Feed engine lived in a **Supabase edge function** (`supabase/functions/proof-feed-daily`)
that is deployed by a separate manual `supabase functions deploy` step. That
function read its DB credential from `Deno.env.get("SERVICE_KEY")`, a secret that
was **never set**, so every internal REST call returned a 401 error object and the
function died on the first `.map()` (`"bootstrapRaw.map is not a function"`). Net:
the feature never generated a single digest, which read like "never deployed."

**v2 removes this entire failure mode** by deleting the edge function and moving
the engine to Vercel, which deploys automatically on `git push`.

---

## 1. Locked decisions (do not re-litigate)

| Area | Decision |
|---|---|
| Engine location | **Vercel** (auto-deploys on push). **Delete** the Supabase edge function. |
| Scheduling | Supabase **pg_cron** (already running for analytics) pings the Vercel engine; one `http_post` per due athlete. |
| Vercel function budget | Hobby cap = **12 functions, currently 12/12**. Add **zero** new functions — reuse `api/trigger-proof-feed.js` (engine) and `api/data.js` (gateway). |
| Cadence | **Weekly every week.** On the week a monthly is due, the **monthly replaces (eats) the weekly** — one digest that does everything the weekly does **plus** the month layer. Never two at once. |
| Week boundary | **Program week** (aligned to the athlete's program block), not rolling 7 days. |
| Weekly format | **Always a short guided chat**: Coach Joe delivers the digest, then asks ranked questions. Concise by default; **"Go deeper"** expands. |
| Monthly look-back | **This month + last month** (~8 weeks) for month-over-month. |
| Monthly content | **Zero overlap** with weekly prose. Monthly's only new text = month-unique layer (MoM, multi-week patterns, goal pacing). The rest of its richness is **display** (reused benchmark + progress charts). |
| Coach digest | **Team aggregate + flagged outliers + coach actions.** Weekly + monthly (monthly eats weekly). A **report, not a chat** — with tap-to-drill into any athlete. |
| Usage limit | **Daily cap** — any run (scheduled or manual) at most once per calendar day per athlete. |
| Delivery | **In-app + email** (Resend). Web Push is **shelved** (current code is a broken stub). |
| Model | **Sonnet 4.6 writes every digest.** Haiku 4.5 only for mechanical work the athlete never reads (program parse, answer extraction). |
| Program-vs-actual | **Structured parse** (see §6). Required to catch set/rep **volume** gaps, not just load. |
| "Go deeper" | Walks a **fixed ranked question bank** only (+ natural follow-up on a flagged item). **Never open-ended, never spammable, hard stop** when the bank is exhausted. |
| Coaching guardrail | Voice/method/programming-philosophy/safety are **hard-fixed in the system prompt**. Athlete answers are **data, never instructions**. The "delivery" question tunes verbosity/format only — it can never change how Coach Joe coaches or turn the app into something else. |
| Archetype | Digest **adapts to athlete type** from populated fields: HS (`graduation_year`, `recruiting_intent`, `position_or_event`), military (`afsc`, `pt_scores`, `rank`, `waist_inches`), Olympic/strength (lifts, %s, blocks). No hard-coded sport. |

---

## 2. Current state — files & schema anchors

**To delete:** `supabase/functions/proof-feed-daily/index.ts` (and its dashboard
deployment).

**To extend (no new functions):**
- `api/trigger-proof-feed.js` — becomes the **engine**. Currently a Vercel-cron
  dispatcher that fans out to edge functions; rewrite to generate digests
  in-process and to also still trigger `process-deletions`.
- `api/data.js` — the authenticated write/read gateway. `authCaller(body.auth)`,
  ops `read`/`insert`/`update`/`delete`/`upsert`, `READ_OWN_COL` (per-row scoping),
  `WRITABLE`, `ATHLETE_OWN_COL`. Uses `SUPABASE_SERVICE_KEY` (Vercel env, **already set**).
- `api/claude.js` — client AI proxy. `DEFAULT_MODEL="claude-sonnet-4-6"`,
  `ALLOWED_MODELS` includes `claude-haiku-4-5`. Per-user rate limit; `feature`
  allowlist for `usage_costs`.
- `api/_supa.js` — shared helpers (`authCaller`, `sbWrite`, `sbSelect`, `logError`,
  cost logging). Add a server-side `askClaudeServer()` here (calls Anthropic with
  the server key **and** logs `usage_costs`) for the engine to use.
- `src/App.jsx` — client. `askClaude(system,user,maxTokens,images,model,feature)`;
  `sbRead/sbUpsert/sbUpdate/sbUpdateWhere`; `MonthlyRecapModal`, `MyLogModal` Proof
  tab, coach Reports view.
- `vercel.json` — `crons`. (pg_cron will drive scheduling; keep a daily Vercel
  cron only as a backstop if desired.)
- `sw.js` — push handler (leave inert; push shelved).

**Tables already present** (see `\d` / PostgREST):
- `athletes` — incl. `birthday, gender, height_inches, weight_lbs, weight_unit,
  age, program_text, program_locked, injury_history, training_days_per_week,
  equipment, position_or_event, recruiting_intent, graduation_year, rank, afsc,
  pt_scores, waist_inches, total_sessions_logged, coach_id, school_id` and the v1
  proof columns `proof_cycle_count, last_proof_sent_at, next_proof_due_at,
  height_finalized`.
- `workouts` — `raw_message, parsed_data (JSONB: exercises[], run_data,
  pain_flags[], session_feel, new_session), bot_reply, created_at`. **Full history
  is retained forever** (nothing prunes it) — month/year look-backs cost no extra
  storage.
- `prs` — `exercise, weight, reps, estimated_1rm, unit, date`. Read real PRs here.
- `manual_one_rms` — athlete-entered maxes.
- `athlete_goals` — `goal_text, goal_type, target_metric, target_value, target_date`.
- `proof_digests` — `digest_type CHECK (weekly|monthly|monthly_coach)`,
  `content_json JSONB, is_read, has_plateau/has_pain/has_missed, label`.
- `athlete_context` — one row per athlete, `content TEXT, is_long_term BOOL`,
  `UNIQUE(athlete_id)`.
- `coaches` — `role, school_id, coach_number, email`. `schools` — org grouping.
- `proof_digests`/`athlete_context`/`workouts`/`prs`/`manual_one_rms`/`athlete_goals`
  are **anon-read-denied** (security Phase 1b/1c); client reads go through
  `api/data.js` with per-row ownership scoping.

---

## 3. Architecture (v2)

```
pg_cron (every ~15 min)                 client "Run now" button
   │ selects due athletes/coaches          │ POST /api/trigger-proof-feed
   │ one http_post per due id              │ { auth: CURRENT_AUTH, run_now:true }
   ▼                                        ▼
            api/trigger-proof-feed.js  (THE ENGINE, Vercel)
   ── auth: cron-secret header  OR  authCaller (run-now, own id only)
   ── daily-cap check (skip if already ran today)
   ── compute brief in CODE  →  askClaudeServer(Sonnet)  →  write proof_digests
   ── update next_proof_due_at + last_proof_sent_at
   ── send email (Resend)              [push shelved]
   ── also: trigger process-deletions (unchanged behavior)
            │
            ▼
   Supabase Postgres  (proof_digests, athlete_context, athlete_goals, athletes…)
            ▲
   client reads digest via sbRead → api/data.js op:read (scoped)
```

**Vercel Hobby 10 s timeout:** generation is **per-athlete, one invocation each**
(pg_cron fans out one `http_post` per due id; run-now is a single athlete). A
single Sonnet digest is ~2–4 s — comfortably under 10 s. **Never** loop all
athletes in one request.

**Server AI calls:** the engine runs server-to-server, so it calls Anthropic
directly via `askClaudeServer()` (not the same-origin client proxy `api/claude.js`),
but **must still log to `usage_costs`** with feature labels (§7).

---

## 4. Data model changes (migration)

New file: `supabase/migrations/<date>_proof_feed_v2.sql`. (Migrations are applied
by Will in the Supabase SQL editor — keep each idempotent with `IF NOT EXISTS`.)

```sql
-- athlete scheduling + caps + ask-flags
ALTER TABLE athletes
  ADD COLUMN IF NOT EXISTS proof_enabled        BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS proof_schedule_dow   INTEGER,          -- 0=Sun..6=Sat
  ADD COLUMN IF NOT EXISTS proof_schedule_hour  INTEGER,          -- 0..23 local
  ADD COLUMN IF NOT EXISTS proof_timezone       TEXT DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS last_proof_run_date  DATE,             -- daily-cap guard
  ADD COLUMN IF NOT EXISTS ask_weight           BOOLEAN DEFAULT TRUE;
  -- height: reuse existing height_finalized (TRUE => stop asking about height)

-- structured program parse (one row per athlete; re-parsed only on change)
CREATE TABLE IF NOT EXISTS program_prescriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id    UUID NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  source_hash   TEXT NOT NULL,           -- hash(program_text); skip re-parse if unchanged
  parsed_json   JSONB NOT NULL,          -- see §6 shape
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS program_prescriptions_athlete_idx
  ON program_prescriptions (athlete_id);

-- coach digests: widen the type check
ALTER TABLE proof_digests DROP CONSTRAINT IF EXISTS proof_digests_digest_type_check;
ALTER TABLE proof_digests ADD CONSTRAINT proof_digests_digest_type_check
  CHECK (digest_type IN ('weekly','monthly','weekly_coach','monthly_coach'));

-- RLS: new table is server-only (deny anon), like the other PII tables
ALTER TABLE program_prescriptions ENABLE ROW LEVEL SECURITY;
-- (no anon policy = anon denied; service key bypasses RLS)
```

**Gateway wiring (`api/data.js`):** add `program_prescriptions` to `WRITABLE` and
`READ_OWN_COL`/`ATHLETE_OWN_COL` keyed on `athlete_id` **only if** the client needs
to read/write it. Default: server-only (engine writes with service key); client
does not touch it. The new athlete columns are written through the existing
`athletes` update path (already scoped to the caller's own id).

**`athlete_context` stays one bounded row per athlete** (≤ ~1500 chars / ~400
tokens). On each run the engine folds new soft info in and **trims** transient
detail; `is_long_term=TRUE` rows (injuries, hard constraints, AI preferences) are
preserved. Constant size regardless of tenure → scalable to many thousands.

---

## 5. The brief — compute in CODE, not the model

This is the scalability/cost backbone. The model **never sees raw workout JSON**.
Code builds a compact brief; Sonnet turns it into Coach Joe's voice.

Compute (JS, deterministic) per athlete for the window:
- **Sessions** grouped from `workouts` (3 h gap rule; respect `new_session`).
- **Per-lift est. 1RM history** (Epley) → week-over-week deltas, block bests.
- **Consistency** — sessions done vs program days; streaks.
- **Program-vs-actual** (load **and** set/rep **volume**) from `program_prescriptions`
  (§6). Volume adherence is a **first-class output** (see §8).
- **PRs** — read `prs` (don't recompute); note new ones in the window.
- **Plateaus** — lift est. 1RM flat across ≥3 sessions (±tolerance).
- **Recurring injuries** — aggregate `parsed_data.pain_flags` across the window;
  flag anything appearing ≥2×, and cross-block patterns.
- **Goal progress** — compare current bests vs `athlete_goals.target_*`.
- **Bodyweight multiples / benchmarks** — reuse the existing benchmark logic.

Hand Sonnet a tight structured brief (~a few KB). Output target per digest:
~4–7K input / ~1.2–1.6K output tokens.

---

## 6. Structured program parse (§ cost note: cheaper at runtime)

Parse `athletes.program_text` into structured prescriptions **once per program
change**, store in `program_prescriptions`. Each weekly digest then does a **free
code lookup** to compute program-vs-actual — no per-digest AI cost.

- Trigger: on program save/change. Compute `hash(program_text)`; if it equals the
  stored `source_hash`, **skip** (no AI call). Otherwise call **Haiku 4.5** to
  produce `parsed_json`.
- `parsed_json` shape (target):
  ```json
  {
    "blocks": [
      { "name":"Block I — Accumulation", "weeks":4, "start":"2026-06-02",
        "days": [
          { "day":"Monday", "label":"Push A",
            "exercises":[
              {"name":"Bench Press","sets":5,"reps":5,
               "pct_by_week":[85,86,87,88],"ref_1rm_lift":"Bench Press"}
            ]}
        ]}
    ],
    "ref_1rms": {"Bench Press":340,"Back Squat":410,"Deadlift":380,"...":0}
  }
  ```
- Comparison (code): match logged exercise → prescribed (fuzzy name match), resolve
  `prescribed_load = ref_1rm * pct_by_week[currentWeek]`, compare **load** and
  **sets×reps**. Emit per-lift and per-day adherence + a rolled-up **volume gap %**.

**Why structured, not fuzzy:** fuzzy load-matching cannot reliably catch *set/rep*
shortfalls. The validated test case (Will's WILLARD program) ran ~20–30% under
prescribed working-set volume on pulls/legs for weeks — only a structured set/rep
comparison surfaces that. Build cost is one Haiku call per program change
(amortized); runtime cost is zero extra tokens.

---

## 7. Models, cost, scale

- **Digests (weekly, monthly, coach): Sonnet 4.6.** Non-negotiable — these are the
  voice.
- **Program parse + answer extraction: Haiku 4.5** (athlete never reads it).
- `usage_costs` feature labels to add to `api/claude.js` allowlist **and** use in
  `askClaudeServer()`: `proof_weekly`, `proof_monthly`, `proof_coach`,
  `program_parse`, `proof_answer_extract`.
- Rates (`ai_pricing`): Sonnet 4.6 $3/$15 per Mtok; Haiku 4.5 $1/$5.

**Cost at 1,000 fully-active athletes (Sonnet):** ~$0.04–0.06/digest →
~$150/mo weeklies + ~$60/mo monthlies + ~$10/mo coach ≈ **~$200/mo at full
engagement** (realistically lower). Daily cap bounds run-now abuse.

**Scale guardrails:** (1) math in code, compact brief; (2) `athlete_context`
bounded + AI-compacted each run; (3) per-athlete invocation. At 1,000 athletes
`athlete_context` ≈ 2 MB and each prompt reads one small row.

---

## 8. Weekly digest — spec

**Sections** (Sonnet writes; omit a section when the data has nothing real to say):
1. **This week vs last** — punchy. Lifts that moved, est-1RM deltas, block context.
2. **Volume — eyebrow raiser** *(conditional)* — when program-vs-actual volume gap
   is material, this is the **headline**, not a footnote. Call out set/rep
   shortfalls by lift, not just load. (Auto-regulation is fine, but name it.)
3. **Program vs actual (load)** — where loads track vs prescribed %.
4. **PRs & progress** — from `prs`; block bests.
5. **Injury watch + plan** *(conditional)* — recurring `pain_flags`; for an active
   injury, give an **actual recommendation with an example program change**, not
   just a warning (e.g. floor press capped ~80%, pull close-grip/heavy dips, add
   prehab — concrete sets/exercises).
6. **Goal progress** — vs `athlete_goals`.
7. **Focus next week** — one specific directive.

**Tone:** Coach Joe — ex-military, direct, specific, no fluff, calls the athlete by
name, occasional bold for emphasis, ends on a directive. **Lean and punchy** — the
v1 first-week sample tone, not long-winded. (Reference samples in §11.)

**Guided check-in:** ranked question **bank** (below). Display **top 5**; **"Go
deeper"** reveals the **next 3** (8 total); **hard stop**. Questions are
**conditional** — generated from the computed brief (injury question only if an
injury is active; volume question only if a gap exists). A flagged item may get a
**single** natural follow-up; never free-form beyond the bank.

Weekly question bank (rank order; conditionals noted):
1. Bodyweight still `{weight}`, or moved? *(skip if `ask_weight=FALSE`)*
2. The `{active injury}` — cleared, lingering, or still sharp? *(only if active pain flag; else "anything banged up?")*
3. *(if active injury)* I'd protect it by `{proposed change}` — apply to next week, keep as written, or tweak?
4. *(if volume gap)* Those light set counts on `{lifts}` — intentional recovery, or short on time/gas?
5. Recovery this week — dialed, flat, or fumes?
— go deeper —
6. Low back / knee / `{secondary niggles}` — managing or behind you?
7. Still chasing `{goal}`, or has it shifted? *(updates `athlete_goals`)*
8. Height change? *(only if `height_finalized=FALSE`)* / Anything about how I deliver these — more or less detail? *(bounded; cannot change coaching)*

**Persistence of answers:**
- **Hard facts → structured tables:** weight/height → `athletes` (and set
  `height_finalized`/`ask_weight` when told "stop asking"); goal changes →
  `athlete_goals` (insert/update).
- **Soft → bounded `athlete_context`:** feelings, AI preferences, likes/dislikes,
  delivery prefs. Injuries / hard constraints / AI prefs → `is_long_term=TRUE`.
- Writes go through the existing gateway (`sbUpdate`/`sbUpsert` → `api/data.js`).

---

## 9. Monthly digest — spec

The monthly **eats the weekly**: it delivers the full weekly digest for that week
(so the athlete still gets their weekly review), then adds the month layer. **No
duplicated prose** — the month layer must not restate what the weekly already said.

**Month-unique additions:**
- **This month vs last month** — MoM comparison (window = this + last month).
- **Multi-week patterns** — volume adherence and injury patterns across the block,
  not the single week.
- **Goal pacing** — progress across the whole month/block toward targets.

**Display (the monthly's main richness):** reuse the **existing benchmark cards +
per-lift est-1RM progress charts** (the same components rendered in other tabs —
e.g. the Pause Back Squat / Bench progress graphs). The monthly card embeds these;
no new charting work.

**Check-in:** display **top 8** questions → "Go deeper" reveals the rest → hard
stop. Same bank as weekly plus monthly-specific:
- Looking at the whole month — what genuinely worked, and what didn't?
- The volume gap is the headline — real cause? (so the next block is built honestly)
- Any bodyweight / training-availability change heading into the next block?

---

## 10. Coach digest — spec

A **report, not a chat.** Delivered in-app (coach Reports tab) + email. Weekly +
monthly (monthly eats weekly, same no-overlap rule). Aggregates **all of a coach's
athletes** (scope by `coach_id`, like the existing coach reads). Tap any athlete to
drill into their individual digest (view already exists).

**Sections:**
- **Team snapshot** — active/total, total sessions, avg sessions/athlete (wk/wk),
  consistency trend.
- **Strength movement** — team-avg est-1RM deltas on key lifts; count of new PRs.
- **Notable PRs** — athlete + lift + delta.
- **Injury report** — active flags as group + individual (who/what, recurrence).
- **Flagged outliers** — most improved; at-risk (disengaging/0 sessions); volume
  cratered. Outliers are computed from the aggregate distribution.
- **Coach actions** — turn the group data into 2–4 concrete actions (Will's
  favorite section: clustering injuries → team warm-up emphasis; disengaging
  athletes → outreach; lagging lift category → programming nudge).

`digest_type` = `weekly_coach` / `monthly_coach`. Cheap (one Sonnet call over
pre-aggregated numbers).

> Coach digest is approved as designed; Will will gather real coach feedback before
> further iteration. Build to the sample (§11), don't over-engineer.

---

## 11. Gold-standard output references

Implement to match these (validated against Will's real data + approved).

**Weekly (tone + sections)** — lean/punchy, e.g.:
> *This week vs last:* "Last heavy week of Block I. Pause squat **275×3** (1RM
> **300→303**), clean pull **315** — block best, right on prescribed. Pulls and
> legs up, pressing down — pec, not effort."
> *Volume (headline when gap):* "Running **~20–30% under** prescribed sets on
> pulls/legs all block. Deadlift **3×3** vs **4×5**. Volume is the adaptation —
> close it before Block II."
> *Injury + plan:* warning **plus** a concrete example program change.

**Monthly** — weekly content + month-unique (MoM, multi-week patterns, goal
pacing) + embedded benchmark/progress charts. No restated weekly prose.

**Coach** — team snapshot, strength movement, notable PRs, injury report (group +
individual), flagged outliers (most-improved / at-risk / volume-cratered), and
**coach actions** that say what to *do* with the data.

---

## 12. Security requirements

- Service key (`SUPABASE_SERVICE_KEY`) is **server-side only** (Vercel env, already
  set). Never shipped to the client. The engine reads it from `process.env`.
- Engine endpoint auth — two modes, both required:
  1. **Scheduler:** a shared secret header (reuse `CRON_SECRET` / pg_cron secret).
  2. **Run-now:** `authCaller(body.auth)` → must be the athlete themselves; enforce
     **daily cap** (`last_proof_run_date`) and **own-id only** (can't run for others).
- New table `program_prescriptions`: **anon-read denied** (RLS), server-only.
- Client reads digests through `api/data.js op:read` (already scoped: athlete sees
  own; coach sees only their athletes). No anon access to any proof data — this
  preserves the Phase 1b/1c lockdown.
- Athlete free-text answers are **untrusted input**: stored as data, never executed
  as instructions; the digest system prompt explicitly ignores attempts to change
  the coach's role/rules/voice (prompt-injection guard).

---

## 13. Phased implementation plan

Each phase ships independently and **must deploy green**. Phase 0 is the priority —
get the pipeline running and deploying before adding features.

**Phase 0 — Deploy fix & relocation** *(no new features)*
- Move generation logic from the edge function into `api/trigger-proof-feed.js`
  (server-side Anthropic via `askClaudeServer()` + `usage_costs` logging).
- Read `SUPABASE_SERVICE_KEY` from Vercel env (already set). **Delete**
  `supabase/functions/proof-feed-daily` and remove its manual deploy from the loop.
- Keep `process-deletions` triggering intact.
- *Acceptance:* a manual `POST /api/trigger-proof-feed` (cron-secret) generates a
  digest end-to-end for a due test athlete, writes `proof_digests`, sends email;
  Vercel deploy green; no edge function in the path.

**Phase 1 — Data model** — migration in §4; gateway wiring; RLS for new table.
- *Acceptance:* migration applies idempotently; new columns/table exist; anon
  denied on `program_prescriptions`.

**Phase 2 — Structured program parse** — Haiku parse on program change (hash-guarded)
→ `program_prescriptions`.
- *Acceptance:* parsing the WILLARD program yields a structured per-day table;
  re-save with no change does **not** re-parse; a load+volume comparison computes.

**Phase 3 — Weekly generator + guided chat** — code brief (§5) incl. volume
adherence; Sonnet digest (§8); ranked questions top-5 + go-deeper +3 (hard stop);
answer persistence split; daily cap.
- *Acceptance:* output matches §11 tone/sections; the volume gap surfaces as a
  headline on the test data; "Go deeper" cannot exceed the bank; weight/goal answers
  land in `athletes`/`athlete_goals`, soft answers in bounded `athlete_context`.

**Phase 4 — Monthly** — superset window; no-overlap prose; embed reused
benchmark/progress charts; top-8 + go-deeper.
- *Acceptance:* monthly shows the charts, MoM comparison, and **no duplicated
  weekly text**; it replaces (not duplicates) that week's weekly.

**Phase 5 — Coach digest** — aggregate + outliers + actions; `weekly_coach`/
`monthly_coach`; report UI + drill-down.
- *Acceptance:* matches §11 coach sample from a real roster aggregate; outliers and
  actions computed from the distribution.

**Phase 6 — Scheduling UI + run-now + pg_cron** — Proof-tab settings (day/time/tz,
enable); run-now button with daily-cap feedback; pg_cron job fanning one
`http_post` per due id.
- *Acceptance:* athlete sets a slot → `next_proof_due_at` honors it; run-now respects
  the daily cap; pg_cron drives scheduled runs with no Vercel timeout.

---

## 14. Open items / future
- **Web Push** — deferred; rebuild properly (real VAPID encryption) later, or use a
  Deno/Node web-push lib. `sw.js` handler already exists.
- **Coach digest iteration** — Will gathers real coach feedback before changes.
- **Look-back depth** — monthly is this+last month now; revisit if a quarter view is
  wanted (cost scales with window).
- **Archetype templates** — HS / military / Olympic adapt from populated fields;
  expand as new athlete types appear.
