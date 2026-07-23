// ─── COACH ALERT REGRESSION SUITE (notification policy v2.1) ─────────────────
// Covers the big-PR alert's decision logic (api/data.js pickImprovedPRs), which
// backs the coach Settings "Big PR" toggle. This is duty-of-care code: a coach
// who enabled the toggle should get the alert, and should NOT be pinged for
// baselines or non-improvements.
//
// The canonical-lift grouping is the part most worth pinning: keying by raw
// name (the A1 defect this release fixed on the client) silently DROPS alerts
// for any lift whose stored name differs from its canonical form — plurals and
// abbreviations, which are the norm in real logs.
//
//   node scripts/test-coach-alerts.mjs
//
import { pickImprovedPRs } from "../api/data.js";
import { resolveLift } from "../src/grit.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
};
const names = (rows) => rows.map((r) => r.exercise);
const improved = (existing, rows) => names(pickImprovedPRs(existing, rows, resolveLift));

console.log("pickImprovedPRs — canonical grouping:");
// The regression this suite exists for: stored "Squats", new row "Squat".
check("plural stored name still matches the new PR",
  improved([{ exercise: "Squats", weight: 300, reps: 1, estimated_1rm: 300 }],
           [{ exercise: "Back Squat", weight: 315, reps: 1, estimated_1rm: 315 }]),
  ["Back Squat"]);
check("abbreviation (RDL) matches its canonical lift",
  improved([{ exercise: "RDL", weight: 200, reps: 1, estimated_1rm: 200 }],
           [{ exercise: "Romanian Deadlift", weight: 225, reps: 1, estimated_1rm: 225 }]),
  ["Romanian Deadlift"]);
check("alias (conventional deadlift) collapses onto deadlift",
  improved([{ exercise: "Deadlift", weight: 400, reps: 1, estimated_1rm: 400 }],
           [{ exercise: "Conventional Deadlift", weight: 405, reps: 1, estimated_1rm: 405 }]),
  ["Conventional Deadlift"]);
check("different lifts do NOT cross-match",
  improved([{ exercise: "Bench Press", weight: 300, reps: 1, estimated_1rm: 300 }],
           [{ exercise: "Back Squat", weight: 200, reps: 1, estimated_1rm: 200 }]),
  []);

console.log("\npickImprovedPRs — improvement rule:");
check("a genuine improvement alerts",
  improved([{ exercise: "Bench Press", weight: 225, reps: 1, estimated_1rm: 225 }],
           [{ exercise: "Bench Press", weight: 235, reps: 1, estimated_1rm: 235 }]),
  ["Bench Press"]);
check("equal to the prior best does NOT alert",
  improved([{ exercise: "Bench Press", weight: 225, reps: 1, estimated_1rm: 225 }],
           [{ exercise: "Bench Press", weight: 225, reps: 1, estimated_1rm: 225 }]),
  []);
check("lower than the prior best does NOT alert",
  improved([{ exercise: "Bench Press", weight: 225, reps: 1, estimated_1rm: 225 }],
           [{ exercise: "Bench Press", weight: 205, reps: 1, estimated_1rm: 205 }]),
  []);
check("first-ever PR for a lift is a baseline, not news",
  improved([{ exercise: "Bench Press", weight: 225, reps: 1, estimated_1rm: 225 }],
           [{ exercise: "Overhead Press", weight: 135, reps: 1, estimated_1rm: 135 }]),
  []);
check("no history at all → nothing alerts",
  improved([], [{ exercise: "Bench Press", weight: 225, reps: 1, estimated_1rm: 225 }]),
  []);
check("best-of-many is the comparison baseline, not the newest row",
  improved([{ exercise: "Back Squat", weight: 315, reps: 1, estimated_1rm: 315 },
            { exercise: "Back Squat", weight: 275, reps: 1, estimated_1rm: 275 }],
           [{ exercise: "Back Squat", weight: 300, reps: 1, estimated_1rm: 300 }]),
  []);
check("multiple improvements all return",
  improved([{ exercise: "Back Squat", weight: 300, reps: 1, estimated_1rm: 300 },
            { exercise: "Bench Press", weight: 200, reps: 1, estimated_1rm: 200 }],
           [{ exercise: "Back Squat", weight: 315, reps: 1, estimated_1rm: 315 },
            { exercise: "Bench Press", weight: 210, reps: 1, estimated_1rm: 210 }]),
  ["Back Squat", "Bench Press"]);

console.log("\npickImprovedPRs — units + derived e1RM:");
check("kg history vs lbs PR compares in lbs (100kg ≈ 220lbs beats 215lbs)",
  improved([{ exercise: "Bench Press", weight: 215, reps: 1, unit: "lbs" }],
           [{ exercise: "Bench Press", weight: 100, reps: 1, unit: "kg" }]),
  ["Bench Press"]);
check("kg history is NOT read as lbs (100kg history blocks a 215lbs PR)",
  improved([{ exercise: "Bench Press", weight: 100, reps: 1, unit: "kg" }],
           [{ exercise: "Bench Press", weight: 215, reps: 1, unit: "lbs" }]),
  []);
check("missing estimated_1rm falls back to Epley over the set",
  improved([{ exercise: "Back Squat", weight: 225, reps: 5 }],   // ≈262
           [{ exercise: "Back Squat", weight: 245, reps: 5 }]),  // ≈286
  ["Back Squat"]);

console.log(`\n${fail === 0 ? "All" : ""} ${pass} coach-alert checks pass${fail ? `, ${fail} FAILED` : "."}`);
process.exit(fail === 0 ? 0 : 1);
