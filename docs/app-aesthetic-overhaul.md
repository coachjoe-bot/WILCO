# WILCO App — Aesthetic Overhaul

Living log of the app's visual direction: moving from **navy + gold** to the cinematic
**electric-blue "night gym"** brand world (near-black ground, blue `#3a7bff` + cyan
`#37e6ff` duotone, HUD grid, condensed display type).

## Status — ATHLETE SIDE: SHIPPED ✅ (2026-07-06)

The full athlete-side overhaul is **live on `main`** (merged `18b0337`, Vercel prod
deploy READY → app.trainwilco.com). Built in an isolated worktree on
`feat/athlete-aesthetic`, reconciled with the parallel coach-overhaul merge, and
verified screen-by-screen against the design artifact with real data.

**The athlete palette lives in the `CA` object** (`src/App.jsx`), the motion + component
CSS in `GSA` (both athlete-only; `C`/`GS` stay navy-gold for `src/coach.jsx`, which is
untouched). Source of truth for the look = the athlete artifact
`https://claude.ai/code/artifact/40b4a378-4f88-4a3f-...` (full extracted CSS saved for
reference during the build).

What shipped, matched 1:1 to the artifact:
- **`.cyber` blue grid ground** on every interior screen (program / log / progress /
  quick-log); amber grid in Field/Away mode.
- **Benchmark power cells** — a tier-colored battery tube filled to *within-tier*
  progress (resets + recharges on rank-up), glow scaled by rank; charges up on open.
- **Radar-sweep** "AWAITING SIGNAL" empty states.
- **Loader trio** — charge "Syncing feed" (chat load), scan "Reviewing form" (video),
  hex "Joe is thinking" (chat reply + quick-log).
- **The Proof** — living-newspaper infinite scroll (full edition scrolls behind a fixed
  masthead + fixed CTA), cyan scanline, split-flap headline.
- **Chat** — translucent glass bubbles/header/input over the 9:16 gym backdrop, blue
  gradient avatar + user bubbles, cyan title, scrolling suggestion ticker, week streak
  bars (only real logged workouts count).
- **NEW MAX** cyan stamp on PRs; cyan line charts; gradient+glow primary buttons
  everywhere (login, send, quick-log, toggles); **Field/Away mode** amber `.away-*`
  treatment of the temporary-program state.
- Login = 9:16 night storefront still. (The Kling entrance video was tried and pulled —
  looked tacky.)

Minor deferred polish (not blocking, unmentioned by Will): settings group labels not yet
mono `.setgrp`; chat glass uses runtime backdrop-blur (a deliberate deviation from the
old no-blur perf rule for artifact fidelity — watch on-device).

## NEXT — COACH DASHBOARD (pick up here)

Bring the same night-gym language to the **coach side** (`src/coach.jsx`, currently still
navy + gold). This is the next session's work. Groundwork:
- The coach functional overhaul (graphs-first Overview, The Coach's Edition, grouped
  Progress tab, notifications) already shipped on `main` — so the coach side is now
  stable to re-skin.
- Re-skin approach mirrors the athlete build: keep `coach.jsx` importing `C`/`GS` OR give
  it its own palette object, apply the same `.cyber` grid + Blue-Steel/Command registers,
  power-cell/HUD language, and cyan/blue duotone. Decide gold's fate on the coach side
  (the plan pitched B "Blue Steel" everywhere + a dash of C "Command" on the dashboard).
- **The Coach's Edition** should get the same "The Proof" newspaper treatment as the
  athlete edition so athlete + coach editions read as one franchise.
- Coach hero image still TBD.

See `project-wilco-aesthetic-build` and `project-wilco-app-redesign` in memory for the
locked direction, the 3-register system (A gym-world / B Blue-Steel / C Command), and the
per-screen decisions.
