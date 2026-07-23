// Chat-routing regression suite — the guard rail for src/chatRouting.js.
// Run with: node scripts/test-chat-routing.mjs
//
// These are the decisions send() makes about a raw athlete message before
// anything is written. What's at stake, in order of severity:
//   • propagate1RM / hasExplicitWorkingBasis / isFullProgramEcho decide whether an
//     athlete's PROGRAM gets rewritten. A wrong answer here silently replaces
//     weights they chose, or writes a truncated program over a complete one.
//   • looksLikeWorkoutLog decides which past rows are eligible to be REWRITTEN by
//     a log correction. A false positive lets a correction target a chat message.
//   • needsAdvancedParser / looksLikeLifting only cost money (an extra parse) or
//     lose a workout to an empty parse.
// So the program-writing cases get the most coverage, and every ambiguous case is
// asserted to resolve toward "don't touch it".

import {
  needsAdvancedParser, looksLikeLifting, parseGotNothing, asksToRemember,
  looksLikeWorkoutLog, hasExplicitWorkingBasis, propagate1RM, isFullProgramEcho,
} from "../src/chatRouting.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("  ✗ " + msg); } };
const eq = (got, want, msg) => ok(Object.is(got, want), `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── model escalation ─────────────────────────────────────────────────────────
console.log("needsAdvancedParser:");
for (const m of [
  "superset bench and rows 3x10",
  "super set of curls",
  "drop set on the last one",
  "dropset to failure",
  "rest-pause bench 225",
  "rest pause set",
  "cluster set squats",
  "myo reps on lateral raises",
  "myo-rep match set",
  "3 rounds AMRAP",
  "took the last set to failure",
  "warm-up sets then 3x5",
  "warmup 135, worked up to 315",
  "ramped up to a heavy single",
  "ramping up on squats",
  "giant set of shoulders",
  "triset arms",
]) ok(needsAdvancedParser(m), `advanced: ${m}`);
for (const m of [
  "bench 5x5 at 225",
  "squat 315 for 3",
  "ran 5 miles easy",
  "my knee hurts",
]) ok(!needsAdvancedParser(m), `plain: ${m}`);
eq(needsAdvancedParser(null), false, "null message is not advanced");

console.log("looksLikeLifting:");
ok(looksLikeLifting("bench 5x5"), "set x rep");
ok(looksLikeLifting("squat @ 315"), "@ weight");
ok(looksLikeLifting("225 lbs for a triple"), "bare lbs");
ok(looksLikeLifting("100kg snatch"), "bare kg");
ok(!looksLikeLifting("felt tired today"), "prose is not lifting");
ok(!looksLikeLifting("what should I do tomorrow?"), "a question is not lifting");
eq(looksLikeLifting(undefined), false, "undefined is not lifting");

console.log("parseGotNothing:");
ok(parseGotNothing(null), "null parse is nothing");
ok(parseGotNothing({ exercises: [] }), "empty exercises is nothing");
ok(parseGotNothing({ exercises: [], run_data: null, practice_data: null, pr_attempts: [] }), "all-empty is nothing");
ok(!parseGotNothing({ exercises: [{ name: "Squat" }] }), "an exercise is something");
ok(!parseGotNothing({ exercises: [], run_data: { distance_miles: 3 } }), "a run is something");
ok(!parseGotNothing({ exercises: [], practice_data: { practice_type: "game" } }), "a practice is something");
ok(!parseGotNothing({ exercises: [], pr_attempts: [{ exercise: "Squat" }] }), "a PR attempt is something");

// ── "remember this" ──────────────────────────────────────────────────────────
// A saved note is injected into EVERY future prompt, so this gate has to be a
// real request, not a passing mention.
console.log("asksToRemember:");
for (const m of [
  "remember I train at 6am",
  "note that my knee is bad",
  "make a note — I'm allergic to nothing",
  "keep in mind I only have dumbbells",
  "don't forget my meet is in March",
  "dont forget the meet",
  "from now on use kg",
  "for future reference I lift raw",
  "going forward I'm training 5 days",
  "just so you know I'm travelling",
  "for the record I hit 405",
  "update my weight to 190",
  "update my profile",
]) ok(asksToRemember(m), `remembers: ${m}`);
for (const m of [
  "I benched 225 today",
  "do you remembering things?",
  "my knee is sore",
  "what's my program",
]) ok(!asksToRemember(m), `not a memory request: ${m}`);

// ── is this row a workout log? ───────────────────────────────────────────────
console.log("looksLikeWorkoutLog:");
ok(looksLikeWorkoutLog("Bench 5x5 225"), "set x rep log");
ok(looksLikeWorkoutLog("Squat @ 315 for a triple"), "@ weight log");
ok(looksLikeWorkoutLog("did 185 lbs on rows"), "bare lbs log");
ok(looksLikeWorkoutLog("Upper A\nBench 5x5 225\nRow 3x8"), "multi-line log");
// The failure that matters: a QUESTION mentioning numbers must never be eligible
// for a log correction to overwrite.
ok(!looksLikeWorkoutLog("what should I do after 5x5 at 225?"), "a question is not a log");
ok(!looksLikeWorkoutLog("Can I swap bench for 3x10 dumbbells"), "a request is not a log");
ok(!looksLikeWorkoutLog("How heavy should I go, 225?"), "how-question is not a log");
ok(!looksLikeWorkoutLog("Should I do 5x5 or 3x8"), "should-question is not a log");
ok(!looksLikeWorkoutLog("[Form review: squat.mp4]"), "a form review is not a log");
ok(!looksLikeWorkoutLog("felt good today"), "prose with no numbers is not a log");
ok(!looksLikeWorkoutLog(""), "empty is not a log");
ok(!looksLikeWorkoutLog(null), "null is not a log");
ok(!looksLikeWorkoutLog(42), "a non-string is not a log");
// The question test looks at the FIRST line only, so a log whose later lines ask
// something still counts as a log.
ok(looksLikeWorkoutLog("Bench 5x5 225\nwas that too light?"), "first line decides");

// ── program-write guards ─────────────────────────────────────────────────────
console.log("hasExplicitWorkingBasis:");
for (const p of [
  "Squat 5x5 @ 85% of training max",
  "Based on a TM of 405",
  "working weight 225",
  "work weight: 185",
  "Loads based on your working max",
  "numbers based off last cycle",
  "sets at 80% of working max",
]) ok(hasExplicitWorkingBasis(p), `explicit basis: ${p}`);
for (const p of [
  "Squat 5x5 @ 315",
  "Bench 3x8 @ 225\nRow 4x10 @ 155",
  "",
]) ok(!hasExplicitWorkingBasis(p), `no explicit basis: ${JSON.stringify(p)}`);
eq(hasExplicitWorkingBasis(null), false, "null program has no basis");

console.log("propagate1RM:");
{
  const prog = "DAY 1\nBack Squat 5x5 @ 315lbs\nBench Press 3x8 @ 225lbs";
  const r = propagate1RM(prog, "Back Squat", 400, 420);
  ok(r.changed, "a real rescale reports changed");
  ok(r.text.includes("330lbs"), "315 @ 400 → 330 @ 420 (rounded to 5)");
  ok(r.text.includes("Bench Press 3x8 @ 225lbs"), "a lift that didn't PR is untouched");
}
{
  // No-ops. Each of these returning `changed:true` would rewrite a program for nothing.
  const prog = "Back Squat 5x5 @ 315lbs";
  eq(propagate1RM(prog, "Back Squat", 400, 400).changed, false, "same 1RM changes nothing");
  eq(propagate1RM(prog, "Back Squat", 0, 420).changed, false, "zero old 1RM changes nothing");
  eq(propagate1RM(prog, "Back Squat", 400, 0).changed, false, "zero new 1RM changes nothing");
  eq(propagate1RM("", "Back Squat", 400, 420).changed, false, "empty program changes nothing");
  eq(propagate1RM(null, "Back Squat", 400, 420).text, null, "null program passes through");
  eq(propagate1RM(prog, "Deadlift", 400, 420).changed, false, "a lift not in the program changes nothing");
}
{
  // The two bounds ARE the safety story — see the comment on propagate1RM.
  const bar = propagate1RM("Back Squat warmup 45lbs then 5x5 @ 315lbs", "Back Squat", 400, 420);
  ok(bar.text.includes("45lbs"), "bar weight (<45) is never rescaled");
  const goal = propagate1RM("Back Squat goal 700lbs, work 5x5 @ 315lbs", "Back Squat", 400, 420);
  ok(goal.text.includes("700lbs"), "an outlier goal number (>1.5x) is never rescaled");
}
{
  // A lift name with regex metacharacters must not blow up or match wildly.
  const r = propagate1RM("Squat (high bar) 5x5 @ 315lbs\nBench 3x5 @ 225lbs", "Squat (high bar)", 400, 420);
  ok(r.changed && r.text.includes("330lbs"), "regex metacharacters in the lift name are escaped");
  ok(r.text.includes("Bench 3x5 @ 225lbs"), "the escaped name doesn't leak onto other lines");
}
{
  // Rounding lands on 5s, always.
  const r = propagate1RM("Back Squat 5x5 @ 300lbs", "Back Squat", 400, 415);
  const m = /(\d+)lbs/.exec(r.text);
  eq(Number(m[1]) % 5, 0, "rescaled weights round to the nearest 5");
}
{
  // A downward correction (a PR was a mistype and got fixed) must also propagate.
  const r = propagate1RM("Back Squat 5x5 @ 315lbs", "Back Squat", 400, 380);
  ok(r.changed && !r.text.includes("315lbs"), "a downward 1RM correction propagates too");
}

console.log("isFullProgramEcho:");
{
  const original = "DAY 1 — LOWER\n".padEnd(400, "x");
  ok(isFullProgramEcho(original, original), "an identical echo is accepted");
  ok(isFullProgramEcho(original + "\nDAY 4 — EXTRA", original), "a longer rewrite is accepted");
  ok(isFullProgramEcho(original.slice(0, 380), original), "a 95% rewrite is accepted");
  // The failure this exists to stop: a token-capped response is a PREFIX, and
  // writing it over program_text destroys everything after the cut.
  ok(!isFullProgramEcho(original.slice(0, 200), original), "a truncated (50%) echo is REJECTED");
  ok(!isFullProgramEcho("Sorry, I can't do that.", original), "a short refusal is rejected");
  ok(!isFullProgramEcho("", original), "an empty response is rejected");
  ok(!isFullProgramEcho(null, original), "null is rejected");
  ok(!isFullProgramEcho("x".repeat(59), ""), "under 60 chars is rejected even with no original");
  ok(isFullProgramEcho("x".repeat(60), ""), "60+ chars is accepted when there's nothing to lose");
}

if (fail) { console.error(`\n${fail} FAILURE(S) (${pass} passed)`); process.exit(1); }
console.log(`\nAll ${pass} chat-routing checks pass.`);
