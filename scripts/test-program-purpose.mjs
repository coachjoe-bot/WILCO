// ─── PROGRAM PURPOSE SUITE (T64 S2) ──────────────────────────────────────────
// What a program protects, read from its own words. Cases mirror the shapes in
// the 10 most recent real programs on prod (read-only survey 09-28, paraphrased).
// Run: node scripts/test-program-purpose.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { programPurpose, purposeLine } from "../src/programPurpose.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const same = (a, b, n) => ok(JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const fx = JSON.parse(fs.readFileSync(join(here, "../tests/replay/founder-pain-fixture.json"), "utf8"));
const b2 = programPurpose(fx.program_text);
ok(b2.protects.includes("knee"), "founder Block 2 protects the knees (Week 1 deload note)");
ok(b2.goal && b2.goal.startsWith("Add to the total"), "INTENT block is the goal");
ok(!b2.protects.includes("pec"), "Block 2 does not claim to protect the pec");

same(programPurpose("GOAL OF THE BLOCK Give the pec three quiet weeks while squats get hammered.\nMonday Bench 3x5").protects, ["pec"], "'give the pec three quiet weeks'");
same(programPurpose("RULES No RPE. If the pec talks, the set is over.").protects, ["pec"], "'if the pec talks'");
same(programPurpose("ANKLE RECOVERY BLOCK Weeks 1-3\nDB Bench 3x10 (switch grip or reduce load until wrist settles)\nBulgarian Split Squat (rear foot elevated, bodyweight only, protecting the ankle) 2x8").protects, ["ankle", "wrist"], "recovery header + 'until wrist settles'; rear foot is jargon");
same(programPurpose("3. Leg Press - 3x12 (until quad pain resolves, then reassess)").protects, ["quad"], "'until quad pain resolves'");
same(programPurpose("Chest Supported Row: 3x10 (shoulder-friendly pulling volume)").protects, ["shoulder"], "'shoulder-friendly'");
same(programPurpose("If the bicep tendon flares up on curls, back off the weight").protects, ["elbow"], "'back off' is not the back");
same(programPurpose("Warm-up: arm circles, cat-cow, glute bridges x12\nCool-down: quad/hip flexor stretch, calf stretch").protects, [], "warm-up and cool-down cues protect nothing");
same(programPurpose("Day 1 Upper\n* Bench 5x5\n* Lat pulldown 3x8\nDay 2 Legs\n* Back squat 5x5").protects, [], "a plain program protects nothing");
same(programPurpose("").protects, [], "empty program");
ok(programPurpose(fx.program_text) === programPurpose(fx.program_text), "cached by text hash");
ok(purposeLine(b2).includes("Already protects: "), "purpose line names the protected areas");
ok(!/[—]/.test(purposeLine(b2).replace(b2.goal || "", "")), "purpose line adds no em dash of its own");

console.log(`\n${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
