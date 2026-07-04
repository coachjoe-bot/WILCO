# NEXT SESSION — Proof Feed tab: visual upgrade

**Goal:** make the Proof Feed tab *look* like the premium weekly "drop" it now is
under the hood. The v3 backend (merged 2026-07-04) generates rich, structured signal
— Grit rank movement, PRs, pain trend, volume trend, a next-week focus — but the tab
still renders all of it as flat, near-identical stacked text cards. This is a
**presentation-layer only** job. Do NOT touch generation (`api/_proof.js`,
`api/trigger-proof-feed.js`) or the check-in dialogue logic — the content is approved
and live. Just make it beautiful.

## Hard process rule (non-negotiable)
This is user-visible UI → **branch → Vercel preview → Will reviews on his iPhone →
merge only after his OK.** Never straight to main. See
[[feedback-wilco-preview-before-ship]]. Local preview: the `wilco-app` launch config
(pin `--port 5174 --strictPort`; note `/api/*` is NOT served under vite dev, so the
feed data won't load locally — design against the real sample content below, and do
the real review on the branch's Vercel preview URL where the API works). It's a PWA
that lives on an installed iPhone home screen — design mobile-first, portrait.

## Where it renders (all in `src/App.jsx`)
- **The Proof tab itself: ~lines 4566–4625** (`{tab==="proof"&&(...)}`). Current build:
  - Empty state: centered 📋 + "Your first Proof Feed drops after your first full week."
  - A tap-to-open **check-in card** (navy2 bg, gold-tinted border, label + "Weekly
    check-in · Coach Joe", unread gold dot, PLATEAU/PAIN red pills, intro line,
    "TAP TO START CHECK-IN →").
  - Then the digest **sections[]** as a stack of near-identical cards (navy2 bg, tiny
    uppercase muted label, body text; red border only when `flag==="warn"`).
- **The check-in modal (`ProofChatModal`): ~lines 1358–1660** — renders the same
  sections as the opening "report", then the guided Q&A dialogue. Visual polish here
  is in scope too (it's the same experience once you tap in).
- **Brand palette `C`: line 1156** — `navy #060d1e / navy2 #0a1228 / navy3 #0d1836 /
  border #1e2a4a / gold #d4a017 / blue #3b82f6 / green #10b981 / red #ef4444 /
  text #e2e8f0 / muted #64748b / muted2 #94a3b8`. Fonts: **Bebas Neue** (display/
  headers, see `btn()` at 1170) + **DM Sans** (body). Shared helpers: `inp()`, `btn()`.

## The data you now have to visualize (`digest.content_json`)
```
{
  intro: "Will — here's your week.",
  sections: [ { label:"THIS WEEK VS LAST", body:"…", flag:null },
              { label:"GRIT RANK", body:"…" },
              { label:"VOLUME", body:"…", flag:"warn" }, … ],
  questions: [ … ],                       // drives the check-in
  flags: { has_plateau, has_pain, has_missed, volume_gap, rank_up },   // ← underused!
  charts: null,
}
```
The `flags` object (esp. `rank_up`) is barely used visually today — it's the hook for
real hierarchy. For rank visualization, `src/grit.js` exports the ladder:
`TIER_NAMES` (ROOKIE→LEGENDARY), `TIER_COLORS` (slate→purple), `TIER_POINTS`,
`TIER_DESC`. The GRIT RANK section body already names the tier + Strength Score
delta; a real tier badge / progress bar could render from these.

## Design direction (ideas, not a spec — bring taste)
Read the taste corpus first: `~/dev/wilco-carousel-style` + the WILCO TASTE.md /
founder-story-blueprint referenced in [[project-wilco-taste-corpus]]. The marketing
brand language is **cold electric-blue**; the app currently leans navy + gold. Worth
deciding whether the feed should pull toward the electric-blue brand or keep the gold
accent — flag it for Will, don't guess.

Concrete opportunities (the whole point — the signal is there, the hierarchy isn't):
1. **Rank-movement hero.** When `flags.rank_up` (or a Strength Score delta), lead with
   a real tier badge in `TIER_COLORS`, before→after, an animated Strength Score
   counter/bar. Right now a tier-up reads as one gray text card identical to the rest.
2. **PR highlights** as their own visually-distinct block (not buried in a text card).
3. **Section hierarchy** — the current cards are all the same weight. Injury/warn
   should feel urgent, the focus line should feel like the closing directive, routine
   sections should recede.
4. **Make the check-in CTA the focal point** — it's the interactive heart of the
   feature; today it's a quiet card.
5. Subtle motion on open (the "drop" should feel like an event). Respect
   `prefers-reduced-motion`.

## Constraints
- **No `env(safe-area-inset-bottom)` padding** on bottom bars — see
  [[feedback-wilco-no-bottom-safe-area]] (Will has flagged this twice).
- **Human copy** — any new microcopy stays in Coach Joe's voice, no em-dashes, no
  AI-slop symmetry ([[feedback-wilco-human-copy]]).
- Keep the legacy keyed-field fallback (the `sections` derivation handles old digests).
- Performance: the app is code-split and boot-speed-tuned — don't add heavy deps for
  animation; CSS/SVG is plenty.

## Real content to design against
`docs/proof-feed-v3-samples.md` has three REAL generated digests (Will = rank movement
+ improving pain; Jonathan = big rank jump + worsening pain; Joe T = steady week +
volume gap) plus the real post-digest dialogue. Use those as your fixtures — they're
exactly what the tab will render.

## Out of scope
Generation, notification policy, the check-in *logic*, Grit thresholds, anything
backend. Pure look-and-feel of the Proof tab + `ProofChatModal` presentation.
