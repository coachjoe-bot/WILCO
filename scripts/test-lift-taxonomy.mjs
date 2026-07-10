// Lift-taxonomy regression suite — the guard rail for resolveLift/normalizeExName.
// Run with: node scripts/test-lift-taxonomy.mjs
//
// Two tables tell the whole story:
//   MERGE — spellings of the SAME lift that must resolve to one id.
//   KEEP  — genuinely different lifts/variants/complexes that must stay distinct.
// When Will reports a new mis-grouping: add the pair to MERGE (or KEEP), watch it
// fail, fix grit.js (usually one alias/synonym line), watch it pass.

import { resolveLift, getBenchKey } from "../src/grit.js";

const MERGE = [
  // Will 2026-07-10: the three reported splits.
  ["Clean + Jerk", "Clean and Jerk"],
  ["clean & jerk", "Clean and Jerk"],
  ["C&J", "Clean and Jerk"],
  ["seated horizontal row (close grip)", "seated cable row close grip"],
  ["tricep push down", "Tricep Pushdown"],
  ["Tricep Pushdowns", "Tricep Pushdown"],
  ["triceps pushdown", "Tricep Pushdown"],
  ["rope pushdown", "tricep pushdown"],
  // Same class, found while fixing.
  ["lat pull down", "lat pulldown"],
  ["Lat Pull-Down", "lat pulldown"],
  ["bench press (close grip)", "close grip bench press"],
  ["close-grip bench press", "close grip bench press"],
  ["seated row", "seated cable row"],
  ["one arm dumbbell row", "single-arm dumbbell row"],
  // The 07-05 wave — must never regress.
  ["conventional deadlift", "deadlift"],
  ["weighted pull-ups", "pull-up"],
  ["weighted sit ups", "weighted situps"],
  ["paused back squat", "back squat"],
  ["deficit pull", "deficit deadlift"],
];

const KEEP = [
  // Real variants stay their own lift.
  ["deficit deadlift", "deadlift"],
  ["romanian deadlift", "deadlift"],
  ["sumo deadlift", "deadlift"],
  ["front squat", "back squat"],
  ["close grip bench press", "bench press"],
  ["incline bench press", "bench press"],
  ["power clean", "clean"],
  ["clean and jerk", "clean"],
  ["wide grip seated cable row", "close grip seated cable row"],
  ["tricep pushdown", "tricep extension"],
  ["lat pulldown", "pull-up"],
  // Real complexes keep their + and stay distinct from the classic lift.
  ["Muscle Snatch + Hang Snatch", "snatch"],
  ["clean + front squat + jerk", "clean and jerk"],
];

// benchKey sanity — ranking must key off the canonical lift.
const BENCH = [
  ["Clean + Jerk", "clean and jerk"],
  ["clean & jerk", "clean and jerk"],
  ["close grip bench press", null],        // own lift, never ranks vs full bench
  ["bench press (close grip)", null],
  ["Muscle Snatch + Hang Snatch", null],   // complexes never rank
  ["clean + front squat + jerk", null],
  ["weighted pull-ups", "weighted pull-up"],
];

let fail = 0;
const bad = (msg) => { fail++; console.error("  ✗ " + msg); };

console.log("MERGE (same lift → same id):");
for (const [a, b] of MERGE) {
  const ra = resolveLift(a), rb = resolveLift(b);
  if (ra.id !== rb.id) bad(`"${a}" (${ra.id}) ≠ "${b}" (${rb.id})`);
  else if (!ra.tracked) bad(`"${a}" merged but untracked`);
}
if (!fail) console.log("  ✓ all " + MERGE.length);

const f0 = fail;
console.log("KEEP (different lifts stay distinct):");
for (const [a, b] of KEEP) {
  const ra = resolveLift(a), rb = resolveLift(b);
  if (ra.id === rb.id) bad(`"${a}" wrongly merged with "${b}" (both → ${ra.id})`);
}
if (fail === f0) console.log("  ✓ all " + KEEP.length);

const f1 = fail;
console.log("BENCH (benchmark keys):");
for (const [name, want] of BENCH) {
  const got = resolveLift(name).benchKey;
  if (got !== want) bad(`"${name}" benchKey ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
if (fail === f1) console.log("  ✓ all " + BENCH.length);

if (fail) { console.error(`\n${fail} FAILURE(S)`); process.exit(1); }
console.log("\nAll taxonomy checks pass.");
