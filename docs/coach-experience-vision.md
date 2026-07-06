# Coach Experience — North-Star Vision

> Captured 2026-07-05 with Will. This is the canonical vision for the coach-side
> overhaul and **supersedes** `coach-experience-roadmap.md` as the direction (the
> roadmap's engineering-groundwork notes still hold — see §Build order).
> Source files: `src/coach.jsx` (dashboard), `api/_proof.js` +
> `api/trigger-proof-feed.js` (digest/adherence engine), `src/App.jsx` (athlete
> side, PR logic, program lock), `api/data.js`/`identity.js` (scoped reads/writes).

## The organizing idea

**WILCO is the coach's assistant and their hype-man — never their replacement.**
Two pillars:

- **Assistant** — reads every athlete's week, then *briefs, flags, and recommends*.
  Every suggestion is a recommendation the coach approves (Yes / Skip / Edit). It
  never assumes it knows better than the coach; it *recommends and cautions*.
- **Hero-maker** — turns the data into positive, **shareable** reports (image export)
  for parents, the AD, and the team. Makes the coach look great and makes WILCO
  obviously indispensable. The shareable "Wins" block is part of **every** weekly and
  monthly report.

## Cost model (why the AI briefing is cheap)

- The briefing's *detection* (pain, inactivity, adherence gaps, true PRs, volume
  spikes, session-feel, strong/weak benchmarks) is **deterministic — zero tokens**.
- Adherence parsing (`parseProgramIfNeeded`) calls Haiku **only when a program's text
  changes** (cached by source_hash). Near-zero ongoing.
- The only AI spend is the **prose synthesis** of the coach report, which **already
  runs once per coach per week** (`generateCoach`). We re-surface it, not add calls.
- Cost scales **per-coach, not per-athlete-week** — all athletes' pre-computed briefs
  go into ONE batched call. ~$0.03/report Sonnet, ~$0.01 Haiku. Weekly+monthly ≈
  ~$0.15/coach/mo Sonnet. **Decision: triage deterministic + daily; AI prose weekly/
  monthly on the existing cadence; run the coach report on Haiku unless we want
  Sonnet's voice.**

## Information architecture

Dashboard **opens on a new Overview tab** (graphs + briefing), not the roster.

| Tab | What it is |
|---|---|
| **Overview** ← default | Live briefing (triage) + team-health graphs w/ plain-English readouts + adherence + program strengths/weaknesses |
| **Athletes** | Triage-sorted roster + upgraded per-athlete detail (adherence, change-requests inbox) |
| **Reports** | Weekly + monthly coach reports, each with a shareable "Wins" section (image export) |
| **Settings / Coaches / Account** | Admin + notification controls |

---

## 1. Overview (graphs-first home)

Every card = number + trend arrow + **one plain-English sentence of what it means** +
a **healthy/attention color band**. Varied chart styles.

| Metric | Chart | "What it means" + healthy range |
|---|---|---|
| Sessions/day (7 & 28d) | line | Consistent training? Healthy = flat/rising; flag downtrend |
| **Program adherence** (team avg by week) | line + per-athlete day×athlete **heatmap** | Doing the *assigned* work? ≥80% green · 60–80 amber · <60 red |
| Active athletes % (WAU) | donut/gauge | Share of roster engaged. Healthy ≥ ~70% |
| Pain/injury flags over time | bar | Rising = trouble. Healthy = low & flat |
| True PRs & tier-ups over time | bar | Momentum — are they getting stronger? |
| Session-feel distribution | stacked bar | great/good/ok/rough; rising "rough" = overreaching/burnout |
| Team volume-load trend | line w/ band | Big spikes = injury risk (ACWR). Healthy = gradual |
| Roster by sport | donut | Composition (already exists) |

### Program strengths & weaknesses (new card + in reports)
Aggregate the **Grit tier distribution across the roster per benchmark lift**. Lifts
where the team skews high-tier = *program strength*; low-tier = *weakness*. Tells the
coach where the **program** is strong/weak, not just individuals. Shown on the
dashboard **and** written into the weekly/monthly feed.

### Progress deltas (new — dashboard + reports + Wins)
Team-level movement, e.g. *"Squat e1RM up an avg +4.2% this month."* Computed by
comparing current e1RM vs N weeks ago per lift, averaged across the roster. Feeds the
shareable **Wins** report (§6).

---

## 2. The Briefing — full scope

Lives at the **top of the Overview** as a ranked triage card ("3 athletes need you
today") and feeds the weekly/monthly written report. Limited to what WILCO can compute.

**TELLS (ranked by urgency):**
- **Injury/pain** — new unresolved pain; escalations (same area 2+ sessions);
  returning-from-injury
- **Overreaching risk** — volume spikes vs the athlete's 4-wk avg; clusters of
  "rough"/"exhausted" feels
- **Disengagement** — no session in N days; adherence *droppers* (fell vs last week);
  stalled mid-program
- **Adherence gaps** — below healthy % this week (which days/lifts skipped)
- **Wins** — *true* PRs (post-fix, baselines excluded); Grit tier-ups; "X lbs from a
  tier-up" near-misses; consistency streaks; goals hit
- **Program status** — block ended / stale; no program assigned; temp program that
  should revert; certification earned
- **Program-change requests** — locked-athlete items queued for the coach (§4)
- **Roster admin** — new athletes joined; never-logged athletes
- **Team strengths/weaknesses** — headline of the strong/weak benchmark card

**SUGGESTS (each = Yes / Skip / Edit, coach decides):**
- **Deload / back off** a specific athlete (pain or overreaching) — concrete change
- **Program alterations** for specific athletes (plateau-driven + locked-flow requests)
  — applies to `program_text`, respecting %-baselines like PR-propagation does
- **Set a focus lift** for an athlete/team (motivational; NOT a rank change — tiers are
  auto/numbers-driven and the benchmark set is a curated allowlist)
- **Assign or refresh** a program when a block ends
- **Revert** a stale temp program
- **Flag a win to share** — one tap into the shareable Wins report
- **Follow up** with a quiet athlete — a *flag*, not an auto-message (messaging tabled)

Empty state: "Everything looks healthy — nothing needs you today." Voice = recommend &
caution, never override.

---

## 3. Adherence math (mostly already built)

`compareProgramVsActual()` (`api/_proof.js:252`) already parses free-text `program_text`
into a structured week-by-week prescription (Haiku, hash-cached) and computes
prescribed-vs-actual per lift: sets×reps **volume** (`volumeGapPct`), prescribed %×1RM
**load** vs actual, and **exercise matching** (`liftsMatch`). So all four inputs Will
named (volume, weight, exercise choice, workouts logged) already flow.

Team-facing **adherence = weighted blend** of:
1. Sessions logged vs prescribed days (showed up)
2. Volume completed vs prescribed (`volumeGapPct`)
3. Exercise match (did the right lifts)
4. Load within X% of prescribed (%-based programs only)

Day-by-day = map prescribed days → logged sessions (complete/partial/missed). Week =
aggregate. **Caveats:** needs an assigned program (else "no program", not red);
load-adherence needs %/weights in the program (volume + exercise adherence work on any).

---

## 4. Locked-program collaboration flow

Turns the lock from a wall into a two-way loop.

- **Athlete side (locked):** when the AI *would* have suggested a change, it doesn't
  apply (already true — `App.jsx:4025/4040`), and instead tells the athlete
  *specifically what to raise*: "Talk to Coach about: squat e1RM climbing, % loads may
  be light; knee felt off on lunges, may want a swap." Logged as
  `program_change_requests` (athlete_id, items, reason, source: plateau/PR/pain/feedback,
  status).
- **Coach side:** Briefing + athlete detail show "Program change requests (N)" — each
  with the suggested alteration + *why*. Coach hits **Apply / Skip / Edit**, mirroring
  today's PR-propagation and athlete-side AI-suggestion UX. Applies to `program_text`
  with the same %-baseline safety.

---

## 5. Notifications + the PR fix

**Coach Settings → push toggles** (ride `notification_policy_v2`):
- 🩹 Athlete injury/pain reported (real-time or batched daily)
- 🏆 Big PR
- 😴 Athlete inactive N days
- 📊 Weekly digest ready (+ monthly)
- (NOT program-block-ended — Will cut this)

**PR fix (prereq for "Big PR"):** root cause — first-ever log of any exercise inserts a
`prs` baseline row (`App.jsx:3797`), and coach "New PRs" counts raw rows, so new
athletes inflate. A notifiable/countable PR = **improvement over prior best** (never a
baseline), on a **ranked lift**, above a small **magnitude threshold** (e.g. ≥5 lb
e1RM, tunable). The improvement path already exists (`newPRs` only pushes on
`exE1RM > prE1RM`); we gate counts/notifications on it and/or tag baseline rows
(`is_baseline`).

---

## 6. Reports — weekly + monthly + shareable Wins

- **Turn on both cadences:** athlete weekly (wk 1–3) + monthly (wk 4) already run;
  the **coach report is hardcoded to `weekly_coach`** (`trigger-proof-feed.js:293`) —
  `monthly_coach` is coded but never fired. Turn on the monthly coach report on the
  4-week cycle.
- **Shareable "Wins" section in every report** (the hero-maker):
  - Team progress deltas ("Squat e1RM +4.2% team avg this month")
  - Program strengths/weaknesses summary
  - **Personal shout-outs** for specific athlete PRs — so when shared, people
    congratulate that athlete → motivation loop
  - **Image export** ("Share as image") — clean, brand-styled, one tap. Easy to text
    to parents / post for the team / send the AD.

---

## 7. Athletes tab upgrades
- Roster **sorted by "needs attention"** (pain > inactive > adherence-drop), not flat A–Z
- Per-athlete detail gains an **Adherence** view (day/week heatmap) + the
  **change-requests** inbox
- Keep: bulk assign, program lock, photo-to-program

## Messaging (tabled)
Deferred for legal. Everywhere the vision wants to reach an athlete (nudges,
celebrations) it's a **coach-side flag or app-side nudge**, never a coach-authored DM,
so nothing here depends on messaging. Slots in cleanly later.

---

## Build order
1. **Overview graphs + readouts + adherence + strengths/weaknesses** (mostly surfacing
   existing engine output) — the visible "huge update", graphs-first home
2. **PR fix** — small, unblocks Big-PR notifications + clean win counts
3. **Briefing triage card** on the Overview (assistant pillar)
4. **Notifications settings** (injury / big PR / inactive / digest)
5. **Monthly coach report ON + shareable Wins w/ image export** (hero pillar)
6. **Locked-program collaboration flow** (deepest, most coaching-specific)

Steps 1–2, 5's monthly toggle are verifiable by diffing against current output on a
preview deploy (coach dashboard can't run under `vite dev` — no `/api`).

---

## Parking lot — revisit before build (Will, 2026-07-05)

Ideas raised after the interactive mockup that we want in but haven't scoped. Revisit
and fold into the numbered plan above before building the relevant piece.

1. **Deepen the coach reports to match the athlete report.** The athlete digest
   (`generateWeekly`/monthly in `api/_proof.js`) is rich — multiple sections + a bank
   of reflective **questions** at the end. The coach report (`generateCoach`, ~700
   tokens) is comparatively thin. Bring the weekly/monthly **coach** reports up to that
   depth: structured sections (roster health, standouts, concerns, program
   read-through, what to watch) and **end with coach-facing questions** ("Is Marcus'
   knee something to pull him for?", "Do you want to rebuild the pressing block?"). This
   is the report equivalent of the assistant pillar — prompts the coach to reflect and
   act, never dictates. Cost note: deeper = more output tokens per coach/week; still
   one call per coach (see Cost model). Run on Haiku unless we want Sonnet's voice.
2. **AI-assisted program creation tab.** A dedicated surface where the coach describes
   intent (sport, goal, block length, days/week, equipment, athlete or team) and the AI
   drafts a full structured program the coach can edit, lock, and bulk-assign. Should
   reuse the existing program parse/prescription pipeline (`parseProgramIfNeeded` →
   `program_prescriptions`) so anything created is immediately adherence-trackable and
   %-propagatable. Assistant framing: it drafts, the coach owns/approves. Ties into
   bulk assign + program lock (§4) and the locked change-request loop.
3. **(Placeholder)** Will noted there are likely more ideas he's forgetting — add here
   as they surface before locking the build plan.
