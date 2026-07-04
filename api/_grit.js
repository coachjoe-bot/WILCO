// ─── GRIT — server re-export ──────────────────────────────────────────────────
// Thin re-export of src/grit.js for server (Vercel function) callers — primarily
// the Proof Feed engine's rank-movement enrichment. KEEP THIS FILE IN SYNC WITH
// src/grit.js: it is a re-export, not a copy — there is no duplicated math here,
// so "in sync" just means this file still imports the same names. If Vercel's
// Node bundler ever fails to trace the ../src/grit.js import (it hasn't so far —
// verified by `vercel dev` / preview deploys building this route successfully),
// the fix is to inline grit.js's contents here directly, NOT to hand-copy pieces —
// still update src/grit.js first and copy the whole file.
//
// Underscore-prefixed: Vercel does not route this as its own function.
export * from "../src/grit.js";
