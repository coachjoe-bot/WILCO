// ─── TURN FACTS SUITE (T64 S2, bug 5) ────────────────────────────────────────
// Locks the performed-set lines Joe quotes: what was DONE, from set_details,
// with the plan's different prescription named as the plan.
// Run: node scripts/test-turn-facts.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performedLine, performedLines, performedBlock, planSchemeFor } from "../src/turnFacts.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const eq = (a, b, n) => ok(a === b, `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// replay: Sep 2 "clean double"
{
  const rp = JSON.parse(fs.readFileSync(join(here, "../tests/replay/bug5-clean-double.json"), "utf8"));
  const lines = performedLines(rp.parsed_exercises, { displayUnit: rp.starting_state.display_unit, planText: rp.starting_state.plan_text });
  eq(lines[0], "Behind the Neck Snatch Grip Push Press: 5 sets of 3, 60/80/90/100/100 kg, top set 100 kg x 3 (plan was 5x2)", "Sep 2 push press line");
  eq(lines[1], "Push Press: 5 sets of 3, 60/70/80/90/90 kg, top set 90 kg x 3 (plan was 5x2)", "push press is its own lift, not the BTN variant");
  ok(!/double/i.test(lines.join(" ")), "no 'double' anywhere in the facts");
  ok(lines[2].startsWith("DB Lateral Raise: 3 sets of 8 at 18"), `lbs lift shown in the athlete's kg (got ${lines[2]})`);
  const blk = performedBlock(rp.parsed_exercises, { displayUnit: "kg", planText: rp.starting_state.plan_text });
  ok(blk.includes("FINAL") && blk.includes("never swap in the program's prescription"), "block states finality");
}
// straight sets read naturally
eq(performedLine({ name: "Back Squat", sets: 3, reps: 5, weight: 140, unit: "kg" }, { displayUnit: "kg" }), "Back Squat: 3 sets of 5 at 140 kg", "straight sets");
// missed rep on the last set: shown per set
eq(performedLine({ name: "Front Squat", unit: "kg", set_details: [{ weight: 102, reps: 3 }, { weight: 102, reps: 3 }, { weight: 102, reps: 3 }, { weight: 102, reps: 2 }] }, { displayUnit: "kg" }),
  "Front Squat: 4 sets: 102 x 3, 102 x 3, 102 x 3, 102 x 2 kg, top set 102 kg x 3", "missed rep on the last set shows per set");
// warm-ups excluded from the count, named
eq(performedLine({ name: "Clean & Jerk", unit: "kg", set_details: [{ weight: 70, reps: 1, warmup: true }, { weight: 90, reps: 1, warmup: true }, { weight: 110, reps: 1 }, { weight: 120, reps: 1 }] }, { displayUnit: "kg" }),
  "Clean & Jerk: 2 sets of 1, 110/120 kg, top set 120 kg x 1, after 2 warm-up sets", "warm-ups named, not counted");
// bodyweight
eq(performedLine({ name: "Pull-Up", sets: 3, reps: 10, unit: "bodyweight" }), "Pull-Up: 3 sets of 10, bodyweight", "bodyweight reps");
eq(performedLine({ name: "Pull-Up", unit: "bodyweight", set_details: [{ reps: 8 }, { reps: 8, weight: 25 }, { reps: 8, weight: 25 }] }), "Pull-Up: 3 sets: bodyweight x 8, +25 lbs x 8, +25 lbs x 8", "weighted bodyweight per set");
eq(performedLine({ name: "Weighted Pull-Up", sets: 3, reps: 5, unit: "bodyweight", added_weight: 45 }), "Weighted Pull-Up: 3 sets of 5, bodyweight plus 45 lbs", "added weight");
eq(performedLine({ name: "Weighted Sit-Up", unit: "bodyweight" }), null, "bodyweight with no reps is skipped");
// timed
eq(performedLine({ name: "Plank", sets: 2, time_per_set_seconds: 60, unit: "bodyweight" }), "Plank: 2 sets of 60 s held", "timed work");
// plan 5x2 vs logged 5x3 in a multi-line program; ambiguous plan says nothing
eq(planSchemeFor("Front Squat", "WEEK 2\nTUE\n* Front squat 4×3 @ 97.5 kg\nWEEK 3\n* Front squat 5×3 @ 104 kg"), null, "two schemes for one lift: ambiguous, no plan note");
eq(planSchemeFor("Front Squat", "Monday Front squat 4x3 at 250 Snatch pull 4x3 at 240"), "4x3", "day label in front of the lift is stripped");
eq(planSchemeFor("Push Press", "* Behind the Neck Snatch Grip Push Press 5x2 @ 60 kg"), null, "a longer lift name is not this lift");
eq(performedLine({ name: "Back Squat", sets: 3, reps: 5, weight: 140, unit: "kg" }, { displayUnit: "kg", planText: "Back squat 3x5 @ 140" }), "Back Squat: 3 sets of 5 at 140 kg", "plan matches: no plan note");
// complex rep scheme
eq(performedLine({ name: "Muscle Snatch + Hang Snatch", sets: 4, reps: 1, rep_scheme: "1+1", unit: "lbs", set_details: [{ weight: 135, reps: 1 }, { weight: 165, reps: 1 }, { weight: 185, reps: 1 }, { weight: 185, reps: 1 }] }, { displayUnit: "lbs" }),
  "Muscle Snatch + Hang Snatch: 4 sets of 1+1, 135/165/185/185 lbs, top set 185 lbs x 1", "complex keeps its rep scheme");
// per-hand dumbbells
eq(performedLine({ name: "Incline Dumbbell Bench Press", sets: 3, reps: 8, weight: 60, unit: "lbs", load_basis: "each" }, { displayUnit: "lbs" }), "Incline Dumbbell Bench Press: 3 sets of 8 at 60 lbs each", "per-hand load");

console.log(`\n${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
