# Coach Dashboard v2 — Spec

> Drafted 2026-07-08 against origin/main @ 3002b85. Approved direction from Will:
> responsive (iPhone-viewable, laptop-expansive), the six Overview fixes, and
> **Briefing v2** — a proof-feed-style *conversation* at the top of the Overview.
> Implements the Briefing scope in `coach-experience-vision.md` §2.
>
> **Ship rule: branch → preview → Will's eyes. Nothing to main without his review.**
> Build in the dedicated coach worktree `~/dev/WILCO-coach` (NOT the main tree —
> parallel sessions switch its branch; see collision history). Rebase that worktree
> onto origin/main first (its `feat/coach-overhaul` is already merged), then branch
> `feat/coach-dashboard-v2`. Never `git add -A` in a shared tree.
> After this ships, `~/dev/WILCO-demo` needs an exact-copy resync (it mirrors prod).

---

## Part A — Responsive layout

Coaches ≈ laptop; athletes ≈ iPhone. Today the coach dashboard has **no max-width**
and only one breakpoint (`useIsMobile(640)` in App.jsx:1374). Two problems observed:
at ~658px the Athletes tab overflows horizontally (~93px) because the `300px 1fr`
grid's detail pane can't shrink; and on a wide laptop the single-column Overview
wastes the screen.

1. **Content shell**: wrap all coach tab content in `maxWidth: 1440, margin: "0 auto"`.
2. **Second breakpoint**: add `isNarrow = width < 900` alongside `isMobile` (reuse the
   `useIsMobile` hook with bp=900; it already takes a param).
3. **Overview grid (laptop ≥900px)**: two-column CSS grid for the chart cards
   (`gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))"`); Briefing card and
   Team Volume span full width (`gridColumn: "1 / -1"`). On a 1440 shell this yields
   a proper 2-up dashboard instead of a phone column stretched wide.
4. **Overview (iPhone <640)**: single column stack (current behavior); heatmap day
   cells shrink (fixed 7 columns, `minmax(0,1fr)`) and athlete names truncate with
   ellipsis; tab bar horizontally scrollable (`overflowX: auto`, no wrap).
5. **Athletes tab**: switch the list/detail split on `isNarrow` (900), not 640.
   - ≥900: keep `300px 1fr`, but add `minWidth: 0` to the detail pane (grid children
     default to `min-width:auto` — this is the actual overflow bug) and let inner
     wide content (session chips, program text) scroll within its own container.
   - <900: single pane. Roster list; selecting an athlete replaces the list with the
     detail view + a `← Roster` back button (state already exists — `selected`).
6. **Every card**: no fixed pixel widths; charts already render to container width.
7. Verify at 390 (iPhone 14), 768 (iPad), 1440 via preview_resize before review.

## Part B — Approved Overview fixes (all deterministic, no data changes)

1. **Heatmap truncation label** — heatmap shows worst-6 sorted worst-first but says
   nothing. Add caption `Showing 6 of 12 · worst adherence first` + a `Show all`
   toggle that renders the full roster (scrolls inside the card past ~12 rows).
2. **Fixed Mon–Sun week** — replace the rolling-7-day axis (`T F S S M T W`).
   Add ONE shared helper in coach.jsx:
   ```js
   // weekBounds(d) -> { start: Monday 00:00 local, end: Sunday 23:59, days: [7 Dates] }
   ```
   **Flush across every "this week" call site** (rule: every rule has a twin):
   heatmap columns, adherence team avg, Active This Week donut, Sessions/day window,
   Wins "this week", Pain Flags This Week, Active by Sport, and the briefing triage's
   "no session this week" test. Header the axis `M T W T F S S` with the date
   under each letter (e.g. `M 7`), so duplicate letters stop being ambiguous.
3. **Sessions/day: exclude today** — the always-incomplete current day renders as a
   cliff. Plot Monday→yesterday only; render today as a hollow/dashed final point
   with no line segment to it (visible but visibly partial). Slope/readout
   ("holding or climbing") computed **excluding today**.
4. **Grit tier legend** — under the Strengths & Weaknesses card add a one-line
   legend: the 8 tier names Rookie→Legendary as small color-graded chips, with the
   team-avg marker explained (`bar = roster average tier for that lift`). Tier
   names on the rows (GRITTY, SHARP) stay, now decodable.
5. **Wins export on Overview** — `exportWins()` already exists in coach.jsx (canvas
   PNG). Add a `Share as image ↗` button directly on the Overview Wins card (same
   export the Coach's Edition uses). Replace the italic "lands in the weekly +
   monthly Coach's Edition" note with the button.

---

## Part C — Briefing v2: "The Morning Brief" (conversation)

### Concept

The static triage card becomes a **daily conversation with WILCO in Coach Joe's
voice** — same shape as the athlete Proof Feed (envelope → guided walkthrough →
Q&A), but for the coach: it walks the highs, lows, and trends; makes suggestions
with **Apply / Edit / Skip**; asks the coach questions; and records every decision.

### Cost model (unchanged from vision doc — this is the load-bearing constraint)

- **Daily brief generation: ZERO tokens.** The prose is deterministic — templated
  COACH_VOICE-style strings filled from the triage data already computed client-side
  in `CoachOverview`. Several phrasing variants per beat, picked by
  `seed = dateKey % variants.length` so it doesn't read identical every morning.
- **AI fires only when the coach engages**, exactly like `CoachCheckin`
  (coach.jsx:1788): Haiku 4.5 reacts to free-text replies (≤160 tokens) and does one
  JSON extraction at the end (≤500 tokens). A coach who taps through chips costs $0.
- No new Vercel functions, no cron changes, no schema changes.

### The conversation script (deterministic "beats")

New pure function in coach.jsx (or a small `src/coachBrief.js` so it's testable):

```js
buildMorningBrief({ athletes, workouts, prs, prescriptions, changeRequests,
                    clearedThisWeek }) -> Beat[]
// Beat = { id, kind, prose, athleteId?, actions?: Action[], question?: Question }
```

Beat order (only beats with data render; every TELL from vision §2 maps in):

1. **Opening** — the week at a glance, highs first:
   *"Morning, Coach. Six true PRs this week and 11 of 12 have trained. Two things
   I'd get in front of today."*
2. **Concern beats** — one per flagged athlete, ranked injury > overreaching >
   quiet > adherence-drop > program-status. Each carries a concrete suggestion and
   actions:
   - *Pain/escalation* (shoulder ×2): *"Ava's shoulder has flagged two sessions
     running. I'd pull overhead work and slot landmine presses until it settles."*
     → **[Draft the change] [I'll handle it] [Watching it]**
     `Draft the change` deep-links to her Program tab with the suggestion text
     prefilled in the editor (v2.0 = prefill only; AI-applied edit is Phase 2,
     see Deferred). If she has a pending `program_change_request`, surface THAT
     with the existing **Apply / Edit / Skip** resolution instead.
   - *Quiet* (8d): *"Diego's gone quiet — eight days, and he was training weekly
     before that. Season over, or worth a conversation?"*
     → **[I'll talk to him] [Season's done] [Not a concern]** — all record
     decisions; **no athlete messaging** (tabled for legal; the app's own 14/30-day
     nudges keep running server-side regardless).
   - *Adherence slipping* (50%): *"Owen hit half his prescribed days. Skips are
     landing on his lower days specifically."* (day/lift detail comes free from
     `compareProgramVsActual`) → **[I'll handle it] [Trim his week] (prefill) [Not a concern]**
   - *Program status*: temp program overdue to revert, block ended, never-logged
     new athlete → matching one-tap actions (revert = existing program save path).
3. **Trend beat** — one plain-English trend, priority: volume spike (ACWR risk) >
   adherence WoW drop > session-feel souring > PR momentum:
   *"Team volume's drifted up 9% over four weeks — inside the safe band."*
4. **Question beat(s)** — max 1–2/day, keyed off flags (deterministic bank, mirroring
   `buildCoachQuestionBank`): *"Anything going on with Diego outside the gym I should
   factor in?"* Chips + free text. Free text → Haiku reaction → `coach_context`.
5. **Closing / Wins** — *"Worth sharing: Marcus put 12 lbs on his trap-bar e1RM."*
   → **[Share as image]** (`exportWins()`) **[Done]**.

Empty day: single beat — *"Everything looks healthy — nothing needs you today."*
(vision-doc empty state), plus wins if any.

### UI

- **Collapsed (default on Overview):** headline card — *"3 need you today · 6 PRs ·
  volume healthy"* + **Open brief**. Replaces the current static list.
- **Open:** on iPhone, a full-screen modal exactly like the athlete `ProofChatModal`
  (beats appear as chat cards, advance on action/answer, `.proof-drop` animation);
  on laptop (≥900), an inline expanded panel in the briefing card, two-column:
  conversation left, a live mini-summary of decisions made right.
- Progress: `2 of 5` dots; brief can be abandoned and reopened — beats already
  actioned stay collapsed with their outcome chip (*"Watching it ✓"*).
- Palette: coach `C` (gold/navy) — coach side is deliberately untouched by the
  athlete aesthetic overhaul.

### Persistence & the follow-through loop (the point of the feature)

Every action writes a **`coach_context`** row — no new tables:

```js
{ coach_id, note: "Diego quiet 8d → coach: season's done",
  meta: { kind: "decision", source: "morning_brief", athlete_id, flag: "quiet",
          action: "season_done", week: "2026-W28" } }
```

- **Suppression:** `buildMorningBrief` receives this week's `morning_brief` decisions
  and drops beats already resolved (per athlete+flag+week). Cross-device by
  construction, since it's in the DB. "Clear" without an outcome no longer exists —
  every dismissal IS an outcome.
- **The free win:** `generateCoach()` (api/_proof.js:314) already injects
  `coach_context` into the weekly Coach's Edition prompt ("WHAT THE COACH TOLD YOU").
  Briefing decisions therefore shape the weekly report with **zero extra wiring** —
  e.g. the report stops flagging Diego and instead says *"you called Diego's season
  done — roster him down."* Q&A answers flow the same way (same extraction pattern
  as CoachCheckin: `{season, block_goal, team_response, athlete_notes, decisions[]}`).

### API changes (tiny)

- `api/claude.js`: add `"coach_brief"` to the feature-label allowlist (one line) so
  brief reactions/extractions are separable from `coach_checkin` in `usage_costs`.
  Calls go through the existing authed `askClaude()` path, Haiku 4.5, same token
  caps as CoachCheckin (160 react / 500 extract).
- `api/data.js`: no changes — `coach_context` insert/read ops already exist for
  CoachCheckin.
- **No migrations. No new functions. No cron changes.**

### Explicitly deferred (Phase 2+, not in this build)

- **AI-applied program edits from the brief** ("Draft the change" actually rewriting
  `program_text` via a working-weight-aware AI edit, like check-in propagation).
  v2.0 prefills the editor instead — coach stays the author. Revisit once the brief
  has real usage.
- Daily "brief ready" push — the existing weekly-digest push stays; a daily push is
  noise until asked for.
- Any coach→athlete messaging (tabled for legal).
- Streaming the Haiku reactions (supported by api/claude.js; add later if replies
  feel slow — they're 160 tokens, likely fine).

---

## Build order & blast radius

| Step | Scope | Files |
|---|---|---|
| 1 | Part B fixes 2+3 (`weekBounds` + flush + today-exclusion) — foundation others sit on | coach.jsx (`CoachOverview` data memo, ~140 lines of math) |
| 2 | Part B fixes 1, 4, 5 (heatmap label, legend, wins button) | coach.jsx (`CoachOverview` render) |
| 3 | Part A responsive shell + Athletes-tab `minWidth:0` / 900px stack | coach.jsx (`CoachDashboard` layout, tabs, `AthleteDetail`), App.jsx (reuse `useIsMobile(900)`) |
| 4 | `buildMorningBrief()` + beats data (pure function, unit-testable) | new `src/coachBrief.js` |
| 5 | Brief UI (collapsed card, modal/panel, actions, Q&A loop) | coach.jsx (new `MorningBrief` component; patterns from `ProofChatModal` + `CoachCheckin`) |
| 6 | `coach_context` decision writes + suppression + feature label | coach.jsx, api/claude.js (1 line) |

- Preview: `wilco-app` launch config (port 5174) on the branch; verify 390/768/1440.
- Note `/api/*` isn't served under vite dev — Q&A reactions need the preview pointed
  at a Vercel preview deployment or tested with the brief's zero-AI path (chips),
  which covers 90% of the UX.
- After Will approves + merge: resync `~/dev/WILCO-demo` (exact-copy rule) and add a
  demo fixture beat script so the sales demo shows the brief.

---

## Part D — Adherence v2 (added mid-build, 2026-07-08)

Will: adherence should blend **exercise choice (most important), then volume
(sets×reps), then working weights**, shown as a red→green gradient.

Implemented in proofcore (shared client+server via api/_proofcore.js):
- `compareProgramVsActual` now emits `components` (matched prescribed sets,
  matched volume capped at prescription, actual/prescribed load ratios).
- New `adherenceBreakdown(adherence, elapsedFrac)` → `{score, E, V, W}`:
  **E** = prescribed-set-weighted share of lifts actually performed;
  **V** = sets×reps completed on matched lifts (capped — overshoot ≠ credit);
  **W** = load band: full credit ≥95% of prescribed (heavier fine), zero ≤60%.
  Blend **50/30/20**; no-load programs renormalize E/V to 62.5/37.5.
- `elapsedFrac` pro-rates weekly targets for the fixed Mon–Sun window mid-week
  (server's rolling 7-day window passes 1 → unchanged cadence there).
- Attendance is implicit: a skipped day's lifts go unmatched and drag E.
- UI: team avg + new per-athlete ADH column on the heatmap in a continuous
  red→green gradient (hue 0→120), tooltip shows the E/V/W split.
- Triage: quiet is now days-since-last-session (≥5d, ≤21d) so Monday doesn't
  flag weekend trainers; adherence flags wait until Thursday (pro-rated scores
  are too noisy earlier); adherence `what` names the weakest component.
