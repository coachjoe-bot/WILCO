# Program Builder — Build Handoff

**Status:** vision locked (concept v4). Doctrine extraction interview is a prerequisite for the
*quality* of the AI, but the UI + plumbing can be built in parallel. This doc is the handoff for the
build. It assumes familiarity with the shipped program-edit loop (see
`[[project-wilco-program-edit-loop]]` memory / `src/changeRequest.js`, `src/programDiff.js`, the
coach staged-edit in `src/coach.jsx`, and the athlete self-apply flow in `src/App.jsx`).

Read `docs/` concept artifact wording if unsure of intent. Do NOT start building until Will says go —
he wants the doctrine trained first per the roadmap (vision → train AI → build → integrate). This
doc exists so that when he does say go, the plan is ready.

---

## What this is

A `Program Builder`: interview-driven program creation living under the Program tab, for both
athletes (self, unlocked programs only) and coaches (per-athlete or team). It replaces "type a
sentence, get AI slop" with a short structured conversation that fills a **Blueprint** (a set of
power cells), then drafts a real program. It is a **PRO feature**.

Every design decision is in the concept artifact. This doc translates them into a build plan.

## Build in phases — each independently shippable, preview-before-ship per house rule

### Phase A — Program tab becomes three subtabs (no AI yet)
The athlete Program view (`src/App.jsx`, `showProgram` modal ~6500) and the coach program tab
(`src/coach.jsx` AthleteDetail `program` tab ~3585) are today single views. Split each into three
subtabs, styled like the Progress modal's tab pattern (`ProgressModal` ~7889, `tab` state):

- **My Program** — exactly today's program view (the current textarea + temp banner + change cards).
  No behavior change; just moves under a subtab.
- **Builder** — new (Phase C). Until then, a "coming soon / PRO" placeholder is fine.
- **Drafts** — new (Phase B).

Ship A alone first: it's pure layout, low risk, and unblocks everything else.

### Phase B — Drafts tab + program history snapshots
Two new tables (via Supabase MCP `apply_migration`, RLS-on/zero-policy like the other
coach-overhaul tables, reached only through the `api/data.js` gateway — add them to the writable +
read-scope allowlists):

- **`program_drafts`**: `id, owner_type ('athlete'|'coach'), owner_id, athlete_id (nullable — coach
  drafts target an athlete or are team-level null), title, status ('interview'|'draft'|'applied'),
  blueprint jsonb, transcript jsonb, draft_text text, provisional_goal text, scope
  ('full'|'short'|'quick'), created_at, updated_at`. Parked interviews and finished drafts both live
  here; `status='applied'` rows are the block history.
- **`program_history`** (or reuse `program_drafts` applied rows): a snapshot of `program_text` on
  every save-to-program, with `applied_at`, `completed_at` (nullable), `source`, and a Haiku-authored
  one-line `block_summary`. **Start capturing this the moment Phase B ships**, even before the
  Builder exists — history needs to pre-exist so the block hand-off question has real data at launch.
  Wire the snapshot into the existing `onProgramSave` (coach.jsx ~1160) and the athlete program-save
  paths (`confirmProgramReplace`, `saveSelfChange`, `program_append`/`program_create_request`
  branches in App.jsx).

Drafts tab UI: cards mirroring the concept — parked interview (Resume / Delete), draft ready (Save to
My Program / Open & edit / Delete), applied history (View / Rebuild from this). "Save to My Program"
runs the **existing** replace-confirm + `programDiff` gate. Reuse the `staged` card styling from
coach.jsx and the diff-review overlay verbatim.

### Phase C — the Builder itself (the AI)
Only start once doctrine files exist (Phase 2 of the roadmap). New client-side flow, one new AI
call pattern through `/api/claude` (no new endpoint — same proxy; add feature label
`"program_build"` and `"program_draft"` to `FEATURES` in `api/claude.js`).

**Blueprint = power cells.** Reuse the `.hcell` battery-tube CSS + `benchGo`-style charge-on-mount
already in App.jsx (~1591 / 8236) so the Builder's cells match the benchmark tab exactly. A master
cell sums the sub-cells; each cell is a Blueprint field (goal, schedule, equipment, red flags,
non-negotiables, recovery, prep, block hand-off — coach set adds team-destination, season map, team
read, roster spread, weekly reality, proof, house rules). Cells arrive **pre-charged** from known
data (athlete_context goal, logged frequency, injury flags, PRs, last block from program_history;
coach: team analytics board + coach_context). SMART goal converter gates the goal cell — it only
fills when goal is specific + measurable + timebound.

**Interviewer prompt** (Sonnet, cached doctrine prefix via `system_cached`):
- Cell-checklist is the spine; conversation is free. One question per turn, chips offered, each
  question carries a why-line in Joe's voice.
- A per-answer **extractor** (Haiku) that can fill ANY cell from ANY message (so an expert dumping a
  full spec fills many cells at once).
- Hard rule: **never draft below 100%.**
- Scope-aware: full program (full interview) / short block / quick build (few cells, no SMART gate,
  straight to draft). Athlete quick-builds stay in chat (Field Mode) — Builder quick-builds are
  coach-only.
- Adapts depth: plain-language for novices, goes into percentages/periodization/velocity when the
  user shows they want it.

**Warm-up / cool-down:** the interview includes a `prep` cell ("one standard routine vs. day-
specific vs. paste your own vs. skip"). Every drafted day card is written WITH a warm-up and
cool-down block. **Logging is two booleans only** — add `warmup_done` / `cooldown_done` to the
workout row + Quick Log sheet as tap-to-log toggles (NOT itemized). Surface the rate in Proof Feed
and coach adherence ("warmed up 9 of 11 sessions"). Do not put warm-up/cool-down detail into the
parser or log schema — full specificity lives in the program text, near-zero friction in the log.

**Save & exit anywhere:** mid-interview (blueprint + transcript persist to `program_drafts`
status='interview') and post-draft (status='draft'). Reuse the Quick Log park/resume pattern
(`src/quicklog.js`) for the persistence + staleness idiom.

**Draft editing:** exactly the Quick Log contract — hand-editable textarea OR "Tell Joe what to
change" scoped NL edit via the shipped surgical-merge (`programDiff` + the `program_apply_change`
call). "Save to My Program" → replace-confirm + diff gate → writes program_text → snapshots history.

### Phase D — integration
- **Chat redirect:** when the athlete asks Joe to build a real (non-temporary) program in chat,
  don't generate it inline — post the redirect bubble ("That's a Builder job…") with an "Open the
  Builder" action. Detect via the existing message classifier (`parseWorkout` intents
  `is_program_update` / `program_create_request` when there's no locked program and it's not a temp
  adaptation). Temporary/travel programs (`is_temp_program_update`) stay in chat unchanged.
- **Coach change-request deep-link:** the coach "Draft the change" / "Edit" hand-off (today lands in
  the AthleteDetail staged panel) can optionally open the Builder in edit mode for that athlete's
  program — decide during build whether small edits stay in the shipped staged panel and only full
  rebuilds route to the Builder (recommended: keep the shipped fast path, Builder is for real
  programs).
- **Coach summary card:** when an unlocked athlete saves a Builder program, notify the coach with a
  summary card (Looks good / Open in Builder / Lock program) — new card type in the coach inbox,
  distinct from change requests. Reuse `program_change_events` notification plumbing.

## Goal-memory precedence (load-bearing rule — get this right)
- The **live goal** = the running program's goal + latest weekly check-in. Daily chat, Proof Feed,
  all AI calls use this.
- A goal set **inside a draft** is stored on the draft as `provisional_goal`, marked provisional,
  and does **not** touch athlete_context / the live goal. The old goal is never deleted.
- It **promotes** to the live goal only when the draft is saved to My Program, OR the athlete says so
  explicitly out loud (same bar as the existing explicit-remember gate in the context system).
- History is kept regardless — every significant goal is remembered, so "you set out to dunk in
  July, switched to mass in September" is answerable, and the block hand-off gets richer each cycle.

## Doctrine loading (cost control — non-negotiable)
- Doctrine files (`doctrine-core.md` + topic files) load via the proxy's **cached system prefix**
  (`system_cached`) so they're paid once per session then ~10% on cached calls.
- Doctrine rides **only** on Builder / drafting / merge calls. Daily chat does NOT carry it; when
  chat detects a real programming conversation it attaches core-only or redirects.
- The classifier picks the ONE relevant topic file (in-season / team / youth / conditioning /
  return) so a session carries core + one topic, never the whole library.

## Eval harness (before shipping the AI)
Mirror `scripts/test-lift-taxonomy.mjs` / `scripts/test-program-diff.mjs`: `scripts/test-program-
build.mjs` with fixture blueprints (novice 3-day, in-season team, post-volume intensification,
hamstring red flag, 45-min sessions, no-barbell, winter-break conditioning). Generate drafts, assert
the rules: day count matches schedule, no barbell work in a no-barbell blueprint, red-flag guardrails
present in the text, in-season volume under the ceiling, warm-up + cool-down present on every day,
format matches house style. Add to `npm test`. Re-run on every doctrine edit.

## Reuse map (don't rebuild these)
| Need | Reuse |
|---|---|
| Surgical merge + diff review | `programDiff.js` + `program_apply_change` call (shipped) |
| Draft/interview persistence | Quick Log park/resume (`quicklog.js`) |
| Power-cell visuals | `.hcell` CSS + `benchGo` charge (App.jsx ~1591/8236) |
| Team analytics for coach cells | `coachAnalytics.js` / the Overview board |
| Doctrine loading | proxy `system_cached` prompt caching |
| Topic routing + chat redirect | existing `parseWorkout` classifier |
| Coach notification | `program_change_events` → `notify-program-changes.js` |
| Staged card / diff overlay UI | coach.jsx AthleteDetail staged panel |

## Ship discipline (per memory rules)
- Build in a worktree, branch → `npx vite build` → preview → **Will reviews (user-visible)** → merge
  to main → rsync-resync demo → `vercel --prod` → verify BOTH flows on the demo (Marcus/1234,
  Coach Reed/4477) with live AI.
- Demo caveats: only `/api/claude` is live — any new AI call must route through it; new `/api/*`
  routes get a `demoMock.js` passthrough or `{ok:true}` breaks them. New `source`/enum values must be
  in the `api/data.js` gateway allowlist. Lock a fixture athlete's program to demo coach-routing;
  seed a `program_drafts` fixture and a couple of `program_history` rows so the Drafts tab and block
  hand-off aren't empty in the demo.
- Flush every behavior change to all sibling call sites; no bottom safe-area padding on bars.

## Suggested phase order for the first build session
1. Phase A (subtabs) — ship solo, low risk.
2. Phase B (Drafts + history snapshots) — start capturing history immediately.
3. Wait for doctrine (roadmap step 2) before Phase C.
4. Phase C (Builder AI) then Phase D (integration).
