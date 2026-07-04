# WILCO App — Aesthetic Overhaul

Running log of the app's visual direction. The app currently leans **navy + gold**
(palette `C` at `src/App.jsx`: navy `#060d1e` / gold `#d4a017`). The marketing brand
language is **cold electric-blue** (see `~/dev/wilco-carousel-style`,
`project-wilco-taste-corpus`). These do not yet match — that reconciliation is a
deliberate, separate project, not tied to any single feature.

## Open decision: app palette → brand electric-blue (DEFERRED)

**Decision: keep the existing navy + gold accent for now. Migrate the whole app to the
electric-blue brand palette on a later, dedicated pass — NOT feature-by-feature.**

Why deferred:
- The color system (`C`) is referenced everywhere in `src/App.jsx`. A palette swap is
  an app-wide job that should be done in one coherent sweep so the app stays internally
  consistent — doing it piecemeal inside individual features leaves a half-and-half app.
- Each new feature (e.g. the Proof Feed envelope, 2026-07) is therefore built in the
  **current gold** so it's consistent with everything shipping around it. When the
  brand-color pass happens, it re-skins the whole app at once, including these features.

When we do it:
- Pick the electric-blue brand hues from `~/dev/wilco-carousel-style` and map them onto
  the `C` tokens (and any hard-coded gold/orange in feature code).
- Decide the fate of the gold accent (drop entirely vs keep as a warm secondary).
- Re-check tier colors (`TIER_COLORS` in `src/grit.js`) against the new palette so the
  Grit ladder still reads.
- Verify contrast/legibility on the installed iPhone PWA in daylight.

## Feature work built in current (gold) palette — will inherit the brand pass

- **Proof Feed — envelope redesign** (2026-07): the Proof tab becomes a sealed letter
  (postmarked drop date, wax seal, "OPEN THE LETTER") that opens into the full digest
  with a rank hero, PR medal chips, red injury card, gold focus directive, and the
  guided check-in. Built in gold/orange per this deferral. Presentation only — no
  generation, notification, or check-in-logic changes.
