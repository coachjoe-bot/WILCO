// ─── COACH ANALYTICS — server re-export ───────────────────────────────────────
// Thin re-export of src/coachAnalytics.js for server (Vercel function) callers —
// same pattern (and same in-sync contract) as api/_grit.js: a re-export, not a
// copy. If the bundler ever fails to trace the ../src import, inline the whole
// file — never hand-copy pieces.
//
// Underscore-prefixed: Vercel does not route this as its own function.
export * from "../src/coachAnalytics.js";
