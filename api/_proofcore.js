// ─── PROOF CORE — server re-export ────────────────────────────────────────────
// Thin re-export of src/proofcore.js for server (Vercel function) callers — the
// Proof Feed engine (api/_proof.js, api/trigger-proof-feed.js). KEEP IN SYNC by
// import, not by copy: there is no duplicated math here. Same pattern as
// api/_grit.js → src/grit.js. If Vercel's Node bundler ever fails to trace the
// ../src/proofcore.js import (it hasn't for grit.js — verified by preview deploys),
// the fix is to inline src/proofcore.js's contents here directly, NOT to hand-copy
// pieces — still update src/proofcore.js first and copy the whole file.
//
// Underscore-prefixed: Vercel does not route this as its own function.
export * from "../src/proofcore.js";
