# WILCO Aesthetic Overhaul — status (2026-07-06)

Athlete-side electric-blue "night gym" overhaul. Isolated worktree `~/dev/WILCO-aesthetic`,
branch `feat/athlete-aesthetic` (based off `main` `6ae602e`). Preview: launch.json `wilco-aesthetic`
(port 5175). SEPARATE from `~/dev/WILCO` (coach session) — coach.jsx untouched, stays navy/gold.

To SEE inner screens: `npm run dev` in the worktree proxies `/api` to prod (vite.config.js, uncommitted).
Log in as **Will Higgins / PIN 7707**.

## 2026-07-06 correction — ported the artifact's REAL CSS (was shipping approximations)

Will flagged the app didn't match the artifact (power cells / grid / animations). Root cause: earlier
passes rebuilt from notes, not the artifact. Fixed by extracting the artifact's actual inline CSS and
porting it 1:1 into `GSA` + retuning `CA` to the artifact `:root`. Landed:
- **`.cyber` blue grid ground** on program/log/progress (amber grid on temp/away) — the missing texture.
- **Battery-tube power cells** (`.htube`/`.hfill`) filled to position in the tier colour, glow by tier —
  replaced the 8-segment rainbow bar. Charges up on tab open.
- **Radar-sweep** AWAITING SIGNAL empty state (was a hex node).
- **`.ld-charge`** loader on chat load; charge/scan/hex classes ported.
- Palette → artifact values: ground #04060c, **blue #3a7bff + cyan #37e6ff duotone**; gradient+glow
  buttons + chat avatar; cyan titles/tabs/section-labels/line-chart strokes.
- PR NEW MAX stamp → artifact `.stamp` (cyan). Streak → thin bars. Proof → cyan scanline + radial ground.
- **Removed the Kling entrance video** (Will: tacky).
Branch tip 8e09dea. Not added: Proof `paperUp` auto-scroll (real front page opens the full edition on
tap; a loop would look broken).

## Earlier (superseded parts corrected above)

Everything shown on the athlete overhaul artifact is now built on the branch:

- Full electric-blue **CA palette** on every athlete screen; **PRO badge** repointed to accent
  (was gold; TIERS config stays gold for coach/pricing).
- **Login** 9:16 storefront hero (`public/login-bg.jpg`).
- **Entrance walk-through** — `public/enter.mp4` (171 KB, 540×960 9:16, watermark cropped out) plays
  once per session on first sign-in, then skips; tap-to-enter, clip-end, error, or a 6.5s safety net
  all drop into chat; reduced-motion skips it. Built from the Kling walk-through clip (Profession_5595).
- **Chat** — solid-blue Coach avatar, 9:16 gym-interior backdrop (`public/chat-bg.jpg`), scrolling
  recommendations ticker (glowing blue dividers), and NEW **charge-chain streak** on the header
  (this week's trained days lit + glowing, today marked, staggered light-up).
- **Program** all-white monospace console; **Field/Away** amber temp-program skin.
- **Workout Log** Exercise/Sets/Feel grid.
- **Benchmarks** — power cells that **charge up** on open (aCharge), tier-scaling glow, and NEW
  **rank-up flash** (⬆ RANK UP chip + boosted glow when a lift climbs a tier vs the last-seen baseline;
  debounced 600ms + persisted per athlete so async 1RM loads don't false-trigger).
- **Strength / Running / PRs** all use the LineChart with draw-in; **PRs tab** gained the per-lift
  "EST. 1RM OVER TIME" chart (Will's ask — running already had charts).
- **Proof** newspaper masthead + split-flap headline + LED-white ink + "Focus Next Week".
- **Strength Score** reactor glow.
- NEW **"NEW MAX" stamp** — pressed straight on in chat when a logged lift beats the old best
  (fires with the PR congrats haptic, auto-clears ~2.6s).
- NEW **cool loader** — charge-bar sweep on the chat's main loading state.
- NEW **AWAITING SIGNAL** empty states across the Progress tabs (hex node pulse + mono kicker).

Production `npm run build` passes clean (481 KB / 147 KB gzip). No console errors.

## NEXT — ship
Will's plan: review the preview → **push `feat/athlete-aesthetic` → `main`** and deploy, then apply the
overhaul to the coach side. CAUTION on merge: `main` moved since the base (`6ae602e` → has `c3d3c40`
quick-log fix, maybe a coach `proofcore` refactor); `src/App.jsx` needs careful reconciliation. Do NOT
commit `vite.config.js` (dev-only proxy). Confirm with Will before the prod deploy.

## Notes / open items for Will's eye
- **Entrance clip framing**: `enter.mp4` is a center 9:16 crop of the existing 16:9 Kling walk-through —
  sharp and fills the screen, watermark removed. If Will wants a different framing or a native-9:16
  re-render, swap `public/enter.mp4` (same filename, no code change). The "approach" splash clip
  (Profession_5578) is NOT wired — only the walk-through is, on sign-in.
- Viewing: Will kept seeing the OLD app because he opened the installed PWA/prod, not the branch preview.
