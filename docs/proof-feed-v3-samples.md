# Proof Feed v3 — Sample Review

Branch: `feat/proof-feed-v3`. Generated 2026-07-04 against **real production data**,
with the prose written by the **real Claude Sonnet 5 call** the pipeline uses (see
"How these were generated" below). Read-only — no writes to `proof_digests`, no cycle
advance, no email, no push.

## What changed and why

The existing weekly digest gets four new structured inputs, fed into the SAME
generation call (no new card type, no cadence change, per Will's instruction):

1. **Grit rank movement** — a real port of the client's benchmark ladder (thresholds,
   tiers, bodyweight/age-fair scaling — see `src/grit.js`), not a simplified stand-in.
   The server computes the athlete's current Grit snapshot and diffs it against the
   snapshot as of their last feed entry (stateless recompute, no new table) to surface
   tier-ups, Strength Score deltas, and new bests on ranked/benchmarked lifts.
2. **Pain trend** — flag counts this week vs last week, classified worsening /
   improving / clearing / steady, feeding into how firm the injury plan reads.
3. **Week-over-week volume** — total working sets logged this week vs last, program-
   agnostic (works even for athletes with no structured program parsed).
4. **Next-week focus** — `focus_next_week` is now a required field (never null): the
   digest always ends on one concrete, numbered directive.

Entry cadence, card type, storage shape (`proof_digests`), and client rendering are
all unchanged.

## How these were generated (real pipeline output)

These three digests are the **actual output of the real generation pipeline**, not a
stand-in:

- `scripts/gen-proof-samples.mjs` runs the exact `api/_proof.js` builders
  (`briefFor`/`buildBrief`/`computeRankMovement`/`painTrend`/`parseProgramIfNeeded`/
  `generateWeekly`, all unmodified) against **real prod data** via the repo's service
  key (read-only).
- The Claude call inside `generateWeekly` is routed through **production
  `/api/claude`** (the real proxy, real `claude-sonnet-5`, the same server-side
  inference params the feed uses) using a short-lived throwaway athlete's login token
  as the caller. So the prose below is genuinely what Sonnet 5 produces from each
  athlete's real brief — same model, same system prompt, same numbers.
- Why the proxy detour: `ANTHROPIC_KEY` is a Production-only Sensitive var and can't
  be pulled locally, so the generation can't run off-prod. Routing through the live
  proxy is the faithful substitute. The throwaway caller and its `usage_costs` rows
  were deleted after the run.

**Sample generation cost: ≈ $0.03** — 6 real Claude calls (3 Sonnet-5 weekly digests
+ 3 Haiku program-parses), ~30k tokens total. Real spend the scheduled feature would
also incur; the sample rows were cleaned from `usage_costs`.

> **One dependency to know:** these numbers assume the Epley rep-cap fix
> (`MAX_E1RM_REPS = 15` in `src/grit.js`, also on branch `fix/grit-e1rm-rep-cap`) is
> in the merged `grit.js`. Without it, Joe T's Pull-up reads a bogus 953 lb e1RM and
> his rank shows LEGENDARY instead of the correct STRONG below. See the bug note at
> the end — the two branches' `grit.js` must be reconciled at merge.

---

## Sample 1: Will Higgins — rank movement + improving pain

Real signals: Strength Score 2125 → 2175 (+50); new bests pushed **Conventional
Deadlift** (368) and **Pull-Up** (220) into STRONG; overall rank holds DOMINANT; pain
trend **improving** (2 flags last week → 1 this week); volume down 5 sets (61 → 56),
one fewer session (4 → 3).

> Will — here's your week.

**THIS WEEK VS LAST**
> Will, 3 sessions this week vs 4 last week, and sets dropped 61 to 56. Front squat e1rm slipped 7lbs to 248, but bench held strong at 286 e1rm off 245x5, and your pulling numbers (conventional deadlift 368, deficit pull 255) are climbing hard.

**PRS & PROGRESS**
> Big week on paper — PRs across Muscle Snatch (185), Hang Clean (205), Hang Power Clean (205), Clean Pull (292 e1RM), Deficit Pull (255 e1RM), Bench (286 e1RM off 245x5), Back Squat (334 e1RM off 295x4), Conventional Deadlift (368 e1RM off 315x5), plus accessory bests on lateral raises, tricep pushdown, lat pulldown and curls. That's a stacked log.

**GRIT RANK**
> Conventional Deadlift pushed into STRONG territory at 368lbs, and Pull-Up joined it at 220lbs STRONG. Strength Score up 50 to 2175, still holding DOMINANT overall.

**INJURY WATCH + PLAN** ⚠
> Low back, left pec, and shoulder are all still flagged, but pain trend is improving — 1 flag this week vs 2 last. Don't get lax. Cap bench at 80% (196lbs) for the next two weeks, swap flat bench for floor press 4x6, and add band pull-aparts 3x20 before every upper session to keep the pec and shoulder quiet.

**GOAL PROGRESS**
> Bench 286 e1rm, target 315 by mid-August — you're 29lbs out with time to close it if the pec stays clean. Squat's sitting at 334 e1rm, still your priority to rebuild post-competition. Pull strength (368 deadlift) is already ahead of squat-target range 185-200kg (408-441lbs) — keep building squat to match.

**FOCUS NEXT WEEK**
> Hit 6 sessions this week — you dropped to 3, program calls for 6. Get back on schedule and keep bench capped at 196lbs while the pec settles.

---

## Sample 2: Jonathan Herrero — big rank jump + worsening pain

Real signals: 0 sessions last week → 3 this week (56 sets from a standing start);
Strength Score 350 → 450 (+100); new bests on **High Bar Squat** (298, into STRONG)
and **Bench Press** (325, into ELITE); pain trend **worsening** (0 flags → 1, pectoral,
right after the bench PR).

> Jonathan — here's your week.

**THIS WEEK VS LAST**
> Jonathan, huge week — Bench up to a 325 e1RM (from 303), Deadlift e1RM 446 off 405x3, Back Squat climbing 185→230. Went from 0 sessions last week to 3 this week and 56 total sets logged — you were dead in the water, now you're moving again.

**PRS & PROGRESS**
> Ten PRs this week: Bench 325 (new best), Deadlift 405x3 (446 e1RM), High Bar Squat 255x5 (298 e1RM), Back Squat 230x2, Good Morning 140x5, Cable Crunch three separate bests. That's a stacked log — real strength coming in.

**GRIT RANK**
> Strength Score jumped 350→450. Bench Press pushed into ELITE territory at 325, and High Bar Squat landed you in STRONG territory at 298. That's two ranked lifts moving up in one week.

**INJURY WATCH + PLAN** ⚠
> Pec flag showed up this week and it's trending worse, not better, right after a 325 bench PR — that's not a coincidence, that's a warning shot. Cap bench at 80% (260) for the next 2 weeks, swap your top set for floor press 4x6, add band pull-aparts 3x20 before every upper day.

**GOAL PROGRESS**
> 325 bench already hit — that was your 8-week target, and you got there early. Don't test it again until the pec settles.

**FOCUS NEXT WEEK**
> Bench: floor press 4x6 at 260 (80%), no heavy flat bench testing until the pec flag clears.

---

## Sample 3: Joe T — steady high-volume week, no pain, program-adherence gap

Real signals: the roster's most active athlete (100 workouts / 28 days); 6 sessions
this week vs 5 last, raw sets up 56 → 73 (+17); no pain flags; Strength Score flat at
770, holds STRONG (one new **Trap Bar Deadlift** best at 408 that didn't move the top
tier). The enrichment surfaces a **35%-under program-volume gap** — the real story of
an otherwise quiet week.

> Joe — here's your week.

**THIS WEEK VS LAST**
> Joe T, 6 sessions this week vs 5 last — good, and raw sets jumped 56 to 73 (+17). But bench e1RM slid 270 to 252ish territory (-18) and incline DB press dropped 7. Legs carried the week: leg press e1RM +60, leg extension +50.

**VOLUME** ⚠
> 35% under prescribed volume overall — Incline DB Press, Machine Chest Press, Overhead DB Press, Tricep Pushdowns, DB Shrugs, Bicep Curls, RDL, and Single-Leg RDL all logged 0 sets against their prescription. Could be auto-regulation, could be skipped accessories — either way it's the real story this week, not the PRs.

**PROGRAM VS ACTUAL (LOAD)**
> Where you did show up — squat, bench, deadlift, rows, calves — you hit prescribed sets/reps at full load. The gap is entirely in the accessory/pressing-variation work, not your main lifts.

**PRS & PROGRESS**
> 16 PRs logged, headlined by Trap Bar Deadlift 340x6 (408 e1RM), Squat 295x6 (354 e1RM), and Leg Press 660x12 (924 e1RM). Real strength being built in the lower body and pull.

**GRIT RANK**
> Trap Bar Deadlift pushed to a new best at 408lbs, holding your STRONG tier — Strength Score steady at 770. No tier change, but that deadlift number is legit progress.

**GOAL PROGRESS**
> 800m butterfly goal — nothing in this week's log ties to swim conditioning. If that's still the target, we need aerobic capacity work programmed, not just barbell volume.

**FOCUS NEXT WEEK**
> Hit Overhead DB Press 4x8 and RDL 3x8 as prescribed — zero excuses, these get logged before you touch anything else in that session.

---

## Notification copy (notification policy v2) — for approval

All four notification types + test. Every payload sets `icon: /icon-192.png`,
`badge: /icon-192.png`, and a per-type `tag` (so one type never silently replaces
another in the tray). Titles: **"Coach Joe"** for the three Joe-voice types (feed,
both inactivity nudges, test) — **"Program Update"** for the coach-authored one, so
an athlete can tell at a glance who's talking.

### 1. Feed-live push (title: "Coach Joe")
Fires when an entry is written (never in dry-run), capped 1/athlete/day. Body picks
the strongest real signal in that entry — never invented copy:
- If the entry has Grit rank movement: **"New rank movement in your Proof Feed. Go see it."**
- Else if new PRs: **"New PRs are in your Proof Feed. Go check it out."**
- Else if a normal entry: **"Your weekly is ready — next week's focus is in there."** (monthly: *"Your monthly recap is ready — next week's focus is in there."*)
- Fallback (rare — no headline signal at all): **"Your weekly Proof Feed is ready."** / **"Your monthly recap is ready."**

### 2. Inactivity — 14-day touch (title: "Coach Joe")
Fires once per quiet streak, at 14 days since the athlete's last logged workout:
- "Haven't seen a log from you in a couple weeks. No pressure, just checking in — let's get back to it."
- "It's been 14 days since your last session. Whenever you're ready, I'm here."
- "Two weeks since we've trained together. Let's get one in today."

### 3. Inactivity — 30-day touch (title: "Coach Joe")
Fires once per quiet streak, at 30 days — then WILCO goes silent until the athlete
logs again (which resets the streak and re-arms both touches):
- "It's been a month since your last log. Whenever life settles, come back — I'll pick up right where we left off."
- "30 days quiet. No judgment — just know the door's open whenever you want back in."
- "It's been a while. If you're ready to start again, I'm ready to coach."

### 4. Coach programming-update (title: "Program Update")
Fires when a coach edits an athlete's program, debounced 15 minutes (a burst of
quick edits collapses into ONE push):
- "Coach updated your program. Take a look before your next session."

(Single fixed line by design — this one is a factual notice, not a rotated
encouragement bank; nothing to vary without inventing detail the coach didn't confirm.)

### 5. Test push (title: "Coach Joe", user-initiated, unchanged from v1)
- "Notifications are on. I'll keep you posted."

---

## Discovered data-quality bug — now being fixed (`fix/grit-e1rm-rep-cap`)

Originally surfaced here: Joe T's benchmark snapshot showed **Pull-ups at a 953 lbs
est-1RM** (tier LEGENDARY, inflating his Strength Score). Root cause, traced to the
actual workout row: on 2026-05-25 he logged **"Pull-ups, 100 reps, unit: bodyweight"**
as part of a scaled Murph WOD — a high-rep conditioning set, not a strength benchmark.
`bestE1RMForExercise` ran Epley (`bodyweight * (1 + reps/30)`) on any bodyweight lift
regardless of rep count; at 100 reps that's `220 * (1 + 100/30) ≈ 953` — nonsense as
a 1RM.

**Status:** a rep cap (`MAX_E1RM_REPS = 15`, plus dropping above-cap sets from
benchmark eligibility) is in `src/grit.js` and on branch `fix/grit-e1rm-rep-cap`. The
Sample 3 numbers above were generated WITH that cap applied, which is why Joe T
correctly reads STRONG / Strength Score 770 rather than LEGENDARY. **Merge note:** the
proof-feed-v3 tree and `fix/grit-e1rm-rep-cap` both touch `src/grit.js` — reconcile
them at merge so the cap lands exactly once and the feed's rank matches the
Benchmarks tab.
