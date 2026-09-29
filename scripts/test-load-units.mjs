// ─── LOAD-UNIT RESOLVER SUITE (T65) ──────────────────────────────────────────
// Locks the one resolver every logged set and declared max goes through before a
// row is saved (src/prAttempts.js resolveLoadUnits / stampLoadUnits). The bug: a kg
// athlete's "squat 5x3 at 140" was saved as a 140 LB squat because the parser's
// rulebook called an unlabelled load lbs. The rule it replaced exists for a real
// reason (T46: a unit written on one lift must never carry to the next), so both
// directions are pinned. The real parser GUESSES units, so most cases run under
// every guess (null, "lbs", "kg") and must give the same answer.
// Run: node scripts/test-load-units.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveLoadUnits, stampLoadUnits, stampAttemptUnits, loadChains, writtenUnit, liftRecentBestLbs, unitCheckMessage, unitCheckFact, replyAsksUnit, pendingUnitLoads, confirmPendingUnits, unitAnswer, CONFIRMED_SOURCES } from "../src/prAttempts.js";
import { normalizeExName, bestE1RMForExercise, implausibleJump, toLbs, sessionTonnage, sessionTopSet, prCheckLines } from "../src/grit.js";
import { logTurnExercises, performedLine } from "../src/turnFacts.js";
import { exerciseUnit, exerciseLoadUnit, isUnitPending } from "../src/units.js";
import { draftInUnit } from "../src/boot.js";
// T68 names, read off the namespace so a run against older code fails an assert instead of crashing the suite.
import * as PA from "../src/prAttempts.js";
import * as UN from "../src/units.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.error(`✗ ${name}`); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const R = (message, du, exercises, attempts = []) => {
  const v = resolveLoadUnits({ exercises, pr_attempts: attempts }, { displayUnit: du, message, normalizeName: normalizeExName });
  return { ex: v.exercises.map((x) => x.unit), pr: v.pr_attempts.map((x) => x.unit) };
};
// Run a case under every parser guess for the entries marked unit:"?".
const GUESSES = [null, "lbs", "kg"];
const any = (message, du, exercises, attempts, want, name) => {
  for (const g of GUESSES) {
    const fill = (x) => (x.unit === "?" ? { ...x, unit: g } : x);
    const got = R(message, du, exercises.map(fill), attempts.map(fill));
    eq(want.pr ? got : { ex: got.ex }, want.pr ? want : { ex: want.ex }, `${name} [parser guessed ${g}]`);
  }
};
const ex = (name, weight, unit = "?", extra = {}) => ({ name, weight, unit, ...extra });
const ladder = (name, weights, unit = "?", reps = 1) => ({ name, weight: Math.max(...weights), unit, reps, sets: weights.length, set_details: weights.map((w) => ({ weight: w, reps })) });

// 1 ── the order: written on the number, parser only when backed, then the athlete
console.log("the resolver order:");
any("squat 5x3 at 140", "kg", [ex("Back Squat", 140)], [], { ex: ["kg"] }, "kg athlete, nothing written -> kg");
any("squat 5x3 at 140", "lbs", [ex("Back Squat", 140)], [], { ex: ["lbs"] }, "lbs athlete, nothing written -> lbs (nothing changes from today)");
any("squat 5x3 at 140kg", "lbs", [ex("Back Squat", 140)], [], { ex: ["kg"] }, "written kg beats an lbs athlete");
any("squat 5x3 at 140 lbs", "kg", [ex("Back Squat", 140)], [], { ex: ["lbs"] }, "written lbs beats a kg athlete");
any("squat 5x3 at 300#", "kg", [ex("Back Squat", 300)], [], { ex: ["lbs"] }, "# is pounds");
any("squat 5x3 at 140 kilos", "lbs", [ex("Back Squat", 140)], [], { ex: ["kg"] }, "kilos is kg");

// 2 ── T46 both directions: a unit never carries to the next lift
console.log("no carry-over (T46), both directions:");
any("clean 100, then curls 40lb", "kg", [ex("Clean", 100), ex("Dumbbell Curl", 40)], [], { ex: ["kg", "lbs"] }, "kg athlete: clean 100 kg, curls 40 lb");
any("squat 180kg, then bench 135", "lbs", [ex("Back Squat", 180), ex("Bench Press", 135)], [], { ex: ["kg", "lbs"] }, "lbs athlete: squat 180 kg, bench 135 lb");
any("squat 5x3 at 180kg, then bench 3x8 at 135", "lbs", [ex("Back Squat", 180), ex("Bench Press", 135)], [], { ex: ["kg", "lbs"] }, "the rulebook's own example");
any("squat 180kg, then bench 180", "lbs", [ex("Back Squat", 180), ex("Bench Press", 180)], [], { ex: ["kg", "lbs"] }, "same number on two lifts: the unit stays on the first");
any("squat 100, then bench 100lb", "kg", [ex("Back Squat", 100), ex("Bench Press", 100)], [], { ex: ["kg", "lbs"] }, "same number, the unit on the second");
any("curls 40lb then clean 100", "kg", [ex("Dumbbell Curl", 40), ex("Clean", 100)], [], { ex: ["lbs", "kg"] }, "unit on the FIRST lift does not carry forward");
eq(R("clean 100, then curls 40lb", "kg", [ex("Clean", 100, "lbs"), ex("Dumbbell Curl", 40, "lbs")]).ex, ["kg", "lbs"], "parser said lbs for both: lbs is written on the curls only, so it does not back the clean");
eq(R("squat 180kg, then bench 135", "lbs", [ex("Back Squat", 180, "kg"), ex("Bench Press", 135, "kg")]).ex, ["kg", "lbs"], "parser carried kg to the bench: kg belongs to the squat, bench follows the athlete");

// 3 ── whole-session statements
console.log("whole-session unit:");
eq(R("all in kilos today: squat 100, bench 80", "lbs", [ex("Back Squat", 100, "kg"), ex("Bench Press", 80, "kg")]).ex, ["kg", "kg"], "lbs athlete, 'all in kilos', parser kg -> kg for both");
eq(R("whole session in lbs: squat 225, bench 185", "kg", [ex("Back Squat", 225, "lbs"), ex("Bench Press", 185, "lbs")]).ex, ["lbs", "lbs"], "kg athlete, 'session in lbs', parser lbs -> lbs");
eq(R("all in kilos today: squat 100", "lbs", [ex("Back Squat", 100, null)]).ex, ["lbs"], "a free-standing unit word backs the parser, it does not replace it (parser null -> athlete)");

// 4 ── ladders, "100/110/120", unit on the first or last number
console.log("ladders and multi-value loads:");
any("clean singles 100/110/120", "kg", [ladder("Clean", [100, 110, 120])], [], { ex: ["kg"] }, "kg athlete, unlabelled ladder -> kg");
any("clean singles 100/110/120", "lbs", [ladder("Clean", [100, 110, 120])], [], { ex: ["lbs"] }, "lbs athlete, unlabelled ladder -> lbs");
any("clean singles 100/110/120kg", "lbs", [ladder("Clean", [100, 110, 120])], [], { ex: ["kg"] }, "unit on the last number covers the ladder");
any("snatch singles @ 20kg/50/70/118", "lbs", [ladder("Snatch", [20, 50, 70, 118])], [], { ex: ["kg"] }, "unit on the first number covers the ladder");
any("back squat 3x4 120,140, 140 kg", "lbs", [ladder("Back Squat", [120, 140, 140], "?", 4)], [], { ex: ["kg"] }, "comma ladder with a trailing unit");
any("snatch pull 4x3 @ 100kg, 110kg, 110kg", "lbs", [ladder("Snatch Pull", [100, 110, 110], "?", 3)], [], { ex: ["kg"] }, "every number labelled");
any("C&J work up to 110, then 3x1 @ 110,120,125 warm up sets: 20,70,90,100", "kg",
  [{ name: "Clean & Jerk", weight: 125, unit: "?", set_details: [20, 70, 90, 100, 110, 120, 125].map((w) => ({ weight: w, reps: 1 })) }], [], { ex: ["kg"] }, "warm-ups written apart from the working sets");
any("DB press 40-45lb", "kg", [ex("Dumbbell Press", 45)], [], { ex: ["lbs"] }, "a range carries its unit");
any("5x3 @ 60/80/90/100/100kg", "lbs", [ladder("Push Press", [60, 80, 90, 100, 100], "?", 3)], [], { ex: ["kg"] }, "T64 tokenizer case");
eq(R("front squat 70kg/100lb/120", "lbs", [ladder("Front Squat", [70, 100, 120], "kg", 3)]).ex, ["kg"], "a chain with both units is not a written unit; the parser's kg is backed by the chain -> kg");

// 5 ── mixed-unit messages (the founder's real habit: bars in kg, DBs and machines in lbs)
console.log("mixed-unit messages:");
any("Snatch 5x2 @ 60/70/80kg\nDB curls 3x10 @ 30lbs\nBack ext 3x12 @ 45", "kg",
  [ladder("Snatch", [60, 70, 80], "?", 2), ex("Dumbbell Curl", 30), ex("Back Extension", 45)], [], { ex: ["kg", "lbs", "kg"] }, "kg athlete: kg bar, lbs DBs, unlabelled plate follows the athlete");
any("Incline DB 4x6 @ 75lbs\nArnold press 3x8 @ 20 kg\nCable row 3x10 @ 100/120/120", "lbs",
  [ex("Incline Dumbbell Bench Press", 75), ex("Arnold Press", 20), ladder("Cable Row", [100, 120, 120], "?", 10)], [], { ex: ["lbs", "kg", "lbs"] }, "lbs athlete, one kg lift in the middle");
eq(R("Cable row 2x8 @ 140/160 (progression from 130/150lbs)", "kg", [ladder("Cable Row", [140, 160], "lbs", 8)]).ex, ["lbs"], "a lbs number nobody else owns backs the parser's lbs (founder 08-31)");

// 6 ── bodyweight work and BW+ loads are left exactly as parsed
console.log("bodyweight:");
eq(R("Pull-ups 3x10, push-ups 3x20", "kg", [{ name: "Pull-Up", unit: "bodyweight" }, { name: "Push-Up", unit: "bodyweight" }]).ex, ["bodyweight", "bodyweight"], "bodyweight stays bodyweight");
eq(R("Pull-ups 3x8 BW/+25lbs/+25lbs", "kg", [{ name: "Pull-Up", unit: "bodyweight", set_details: [{ weight: 0, reps: 8 }, { weight: 25, reps: 8 }, { weight: 25, reps: 8 }] }]).ex, ["bodyweight"], "BW/+25lbs stays bodyweight");
eq(R("dips 3x8 BW+25", "kg", [{ name: "Dip", unit: "bodyweight", added_weight: 25 }]).ex, ["bodyweight"], "BW+25 stays bodyweight (added load keeps the lbs convention)");
eq(R("Weighted Sit-Up 3x12 @ BW/8kg/12kg", "lbs", [{ name: "Weighted Sit-Up", weight: 12, unit: "?", set_details: [{ weight: 0, reps: 12 }, { weight: 8, reps: 12 }, { weight: 12, reps: 12 }] }].map((x) => ({ ...x, unit: null }))).ex, ["kg"], "BW/8kg/12kg (founder 09-03) -> kg");
eq(R("pull-ups 3x8 BW+25, then squat 5x5 @ 100", "kg", [{ name: "Pull-Up", unit: "bodyweight", added_weight: 25 }, ex("Back Squat", 100, "lbs")]).ex, ["bodyweight", "kg"], "BW work next to a barbell lift");

// 7 ── percentages, RPE-only lines, times: not loads
console.log("percentages, RPE, times:");
eq(loadChains("Back Squat 3x5 @ 75%").map((c) => c.tokens.map((t) => t.value)), [[3, 5]], "a percentage is not a load");
eq(loadChains("Bench 3x8 @ RPE 8").map((c) => c.tokens.map((t) => t.value)), [[3, 8]], "an RPE is not a load");
eq(loadChains("Plank 3x45s, row 2:30").map((c) => c.tokens.map((t) => t.value)), [[30]], "times are not loads");
any("Back Squat 3x5 @ 75%", "kg", [{ name: "Back Squat", weight: null, unit: "?", percent_1rm: 75 }], [], { ex: ["kg"] }, "percent-only line, no weight -> the athlete's unit");
any("Bench 3x8 @ RPE 8", "lbs", [{ name: "Bench Press", weight: null, unit: "?", rpe: 8 }], [], { ex: ["lbs"] }, "RPE-only line -> the athlete's unit");
any("Squat 5x5 @ 80%, bench 3x8 @ 80kg", "lbs", [{ name: "Back Squat", weight: null, unit: "?", percent_1rm: 80 }, ex("Bench Press", 80)], [], { ex: ["lbs", "kg"] }, "80% and 80kg in one message: the percent never claims the kg");
any("Squat 3x5 @ 100 RPE 8, curls 3x10 @ 8", "kg", [ex("Back Squat", 100), ex("Dumbbell Curl", 8)], [], { ex: ["kg", "kg"] }, "RPE 8 is not the curl's 8");

// 8 ── supersets
console.log("supersets:");
any("Superset: bench 3x8 185 / bent row 3x8 155", "lbs", [ex("Bench Press", 185, "?", { superset_group: "A" }), ex("Bent Over Row", 155, "?", { superset_group: "A" })], [], { ex: ["lbs", "lbs"] }, "lbs superset");
any("SS A1 bench 3x8 @ 80kg / A2 row 3x8 @ 60", "lbs", [ex("Bench Press", 80, "?", { superset_group: "A" }), ex("Barbell Row", 60, "?", { superset_group: "A" })], [], { ex: ["kg", "lbs"] }, "kg on A1 does not carry to A2 (lbs athlete)");
any("SS A1 bench 3x8 @ 80 / A2 row 3x8 @ 60lb", "kg", [ex("Bench Press", 80, "?", { superset_group: "A" }), ex("Barbell Row", 60, "?", { superset_group: "A" })], [], { ex: ["kg", "lbs"] }, "lbs on A2 does not reach back to A1 (kg athlete)");

// 9 ── declared maxes and their sets: one resolver
console.log("declared maxes share the resolver:");
any("Back Squat singles @ 70/110/130/150/170 then I missed 180kg", "lbs",
  [ladder("Back Squat", [70, 110, 130, 150, 170])],
  [{ exercise: "Back Squat", weight: 170, unit: "?", reps: 1, achieved: true }, { exercise: "Back Squat", weight: 180, unit: "?", reps: 1, achieved: false }],
  { ex: ["kg"], pr: ["kg", "kg"] }, "kg written on the missed attempt covers the same lift's ladder and single");
any("hit 275 then missed 285", "kg", [ex("Back Squat", 275)], [{ exercise: "Back Squat", weight: 275, unit: "?", reps: 1, achieved: true }, { exercise: "Back Squat", weight: 285, unit: "?", reps: 1, achieved: false }],
  { ex: ["kg"], pr: ["kg", "kg"] }, "kg athlete, nothing written: set and attempts agree");
any("Hit a 102kg snatch today, new PR", "lbs", [], [{ exercise: "Snatch", weight: 102, unit: "?", reps: 1, achieved: true }], { ex: [], pr: ["kg"] }, "the 09-28 incident message, lbs athlete");
eq(stampAttemptUnits, stampLoadUnits, "stampAttemptUnits is the same function (one resolver)");

// 10 ── stamping: self-describing rows, idempotent, input untouched
console.log("stampLoadUnits:");
{
  const parsed = { exercises: [ex("Back Squat", 140, null)], pr_attempts: [], general_notes: "x" };
  const out = stampLoadUnits(parsed, { displayUnit: "kg", message: "squat 5x3 at 140", normalizeName: normalizeExName });
  eq(out.exercises[0].unit, "kg", "unit stamped on the row");
  eq(parsed.exercises[0].unit, null, "input not mutated");
  eq(out.general_notes, "x", "other fields pass through");
  eq(stampLoadUnits(out, { displayUnit: "kg", message: "squat 5x3 at 140", normalizeName: normalizeExName }), out, "idempotent: same object on a second stamp");
  eq(stampLoadUnits(out, { displayUnit: "lbs" }).exercises[0].unit, "kg", "no message: a stamped unit stands even under another display unit");
  const bw = { exercises: [{ name: "Pull-Up", unit: "bodyweight" }] };
  eq(stampLoadUnits(bw, { displayUnit: "kg", message: "pull-ups 3x10" }), bw, "nothing to change -> same object");
  eq(stampLoadUnits(null, { displayUnit: "kg" }), null, "null parse passes through");
  eq(stampLoadUnits({ exercises: [ex("Back Squat", 140, null)] }).exercises[0].unit, "lbs", "no options at all -> app default");
}

// 11 ── the LOG SHEET path: a sent draft, as the parser sees it
console.log("log sheet drafts:");
{
  const lbsDraft = "Day 2 – Lower\nBack Squat 5x3 @ 315\nRDL 3x8 @ 225\nDB Walking Lunge 3x10 @ 50lb/hand\nPlank 3x45s";
  const kgDraft = draftInUnit(lbsDraft, "kg");
  ok(/Back Squat 5x3 @ 142\.5 kg/.test(kgDraft) && /RDL 3x8 @ 102\.5 kg/.test(kgDraft) && /22\.5 kg\/hand/.test(kgDraft), `kg athlete's sheet carries kg on every load (${JSON.stringify(kgDraft)})`);
  eq(draftInUnit(lbsDraft, "lbs"), lbsDraft, "lbs athlete's sheet is the program text, loads unlabelled");
  const kgEx = () => [ex("Back Squat", 142.5), ex("Romanian Deadlift", 102.5), ex("Dumbbell Walking Lunge", 22.5, "?", { load_basis: "each" }), { name: "Plank", unit: "bodyweight" }];
  const lbsEx = () => [ex("Back Squat", 315), ex("Romanian Deadlift", 225), ex("Dumbbell Walking Lunge", 50, "?", { load_basis: "each" }), { name: "Plank", unit: "bodyweight" }];
  any(kgDraft, "kg", kgEx(), [], { ex: ["kg", "kg", "kg", "bodyweight"] }, "kg athlete sends the sheet unchanged");
  any(lbsDraft, "lbs", lbsEx(), [], { ex: ["lbs", "lbs", "lbs", "bodyweight"] }, "lbs athlete sends the sheet unchanged");
  const kgEdited = kgDraft.replace("@ 142.5 kg", "@ 140");
  any(kgEdited, "kg", [ex("Back Squat", 140), ...kgEx().slice(1)], [], { ex: ["kg", "kg", "kg", "bodyweight"] }, "kg athlete deletes the unit on one line -> still kg");
  const kgEditedLb = kgDraft.replace("@ 22.5 kg/hand", "@ 50lb/hand");
  any(kgEditedLb, "kg", [...kgEx().slice(0, 2), ex("Dumbbell Walking Lunge", 50, "?", { load_basis: "each" }), kgEx()[3]], [], { ex: ["kg", "kg", "lbs", "bodyweight"] }, "kg athlete types lb on one line -> that line lbs, the rest kg");
  const lbsWithKgLine = "Day 3 – Oly\nSnatch 5x2 @ 60/70/80kg\nBack Squat 5x3 @ 315";
  eq(draftInUnit(lbsWithKgLine, "lbs"), lbsWithKgLine, "a kg-written program line stays kg on an lbs athlete's sheet (no reverse conversion)");
  any(lbsWithKgLine, "lbs", [ladder("Snatch", [60, 70, 80], "?", 2), ex("Back Squat", 315)], [], { ex: ["kg", "lbs"] }, "lbs athlete's sheet with one kg line");
  const lbsLabelled = "Day 2 – Lower\nBack Squat 5x3 @ 315 lbs\nRDL 3x8 @ 225 lbs";
  any(lbsLabelled, "lbs", [ex("Back Squat", 315), ex("Romanian Deadlift", 225)], [], { ex: ["lbs", "lbs"] }, "lbs athlete, labelled sheet");
  const kgSheetKgAthlete = draftInUnit("Day 1\nFront Squat 4x3 @ 102/102/102/125kg\nClean Pull 4x3 @ 100kg/125/125/125\nBack Extensions 3x12 @ 45lbs", "kg");
  any(kgSheetKgAthlete, "kg", [ladder("Front Squat", [102, 102, 102, 125], "?", 3), ladder("Clean Pull", [100, 125, 125, 125], "?", 3), ex("Back Extension", 20)], [], { ex: ["kg", "kg", "kg"] }, `founder-shaped sheet after the T64 converter (${JSON.stringify(kgSheetKgAthlete)})`);
}

// 12 ── PR detection and the implausible-jump guard compare in ONE unit
console.log("one unit for PR math:");
{
  const stamped = stampLoadUnits({ exercises: [ladder("Back Squat", [140, 140, 140], null, 3)] }, { displayUnit: "kg", message: "squat 3x3 at 140", normalizeName: normalizeExName });
  const e1 = bestE1RMForExercise(stamped.exercises[0]);
  ok(Math.abs(e1 - Math.round(140 * 2.20462 * 1.1)) <= 1, `140 kg x3 e1RM in lbs (${e1})`);
  ok(!implausibleJump(toLbs(150, "kg"), e1), "140 kg x3 against a 150 kg best: no false alarm");
  const oldRule = bestE1RMForExercise({ ...stamped.exercises[0], unit: "lbs" });
  ok(oldRule < toLbs(150, "kg") * 0.5, "the old lbs default would have filed it at under half the athlete's max");
}

// 13 ── readers: one helper, legacy rows unchanged
console.log("exercise readers:");
eq(exerciseUnit({ unit: "kg" }), "kg", "kg");
eq(exerciseUnit({ unit: "lbs" }), "lbs", "lbs");
eq(exerciseUnit({ unit: "bodyweight" }), "bodyweight", "bodyweight");
eq(exerciseUnit({}), "lbs", "legacy row with no unit reads lbs (pre-T65 contract)");
eq(exerciseUnit({ unit: null }), "lbs", "unit:null reads lbs");
eq(exerciseLoadUnit({ unit: "bodyweight" }), "lbs", "bodyweight added load is lbs");
eq(exerciseLoadUnit({ unit: "kg" }), "kg", "load unit kg");
{
  const srcDirs = [join(here, "../src"), join(here, "../api")];
  const hard = /\b(ex|e)\.unit\s*(\|\|\s*"lbs"|===?\s*"kg"\s*\?\s*"kg")/;
  for (const d of srcDirs) for (const f of readdirSync(d).filter((x) => /\.(js|jsx)$/.test(x))) {
    const lines = readFileSync(join(d, f), "utf8").split("\n");
    const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => hard.test(l));
    ok(hits.length === 0, `no hand-copied exercise unit default in ${f}${hits.length ? ` (line ${hits.map((h) => h[0]).join(", ")})` : ""}`);
  }
  const app = readFileSync(join(here, "../src/App.jsx"), "utf8");
  ok(/stampLoadUnits\(parsed, \{[^}]*history: workoutHistory/.test(app), "finalizeWorkout hands the resolver the athlete's history");
  ok(/stampLoadUnits\(p, \{[^}]*history: workoutHistory/.test(app), "send() hands the resolver the athlete's history");
  const finSrc = app.slice(app.indexOf("const finalizeWorkout = async"), app.indexOf("const finalizeWorkout = async") + 40000);
  ok(/if\(ex\.unit_suspect\)\{ unitChecks\.push\(.*?\); continue; \}/.test(finSrc) && /if\(attempt\.unit_suspect\)/.test(finSrc) && /unitCheckMessage\(unitChecks\)/.test(finSrc), "a unit-suspect load skips every derived write and is asked about by unit");
  ok(/"weight":number\|null,"unit":"lbs"\|"kg"\|"bodyweight"\|null/.test(app), "parse schema lets an exercise carry unit:null");
  ok(!/it is "lbs" \(this app's default\)/.test(app), "the lbs-default rule is gone from the rulebook");
  ok(/parsed = stampLoadUnits\(parsed, \{displayUnit: updatedAthlete\?\.weight_unit, message: msg/.test(app), "finalizeWorkout stamps every load before saving");
  ok(/\.then\(p=>stampLoadUnits\(p, \{displayUnit: athlete\.weight_unit, message: msg/.test(app), "send() stamps the parse at the source");
  // The one insert of a parsed log sits after the stamp inside finalizeWorkout.
  const fin = app.indexOf("const finalizeWorkout = async");
  const stampAt = app.indexOf("parsed = stampLoadUnits(parsed", fin);
  const insertAt = app.indexOf('sbInsert("workouts",{athlete_id:updatedAthlete.id,raw_message:msg', fin);
  ok(fin > 0 && stampAt > fin && insertAt > stampAt, "the workouts insert runs after the stamp");
}

// 14 ── replay: the founder's real rows (read-only copies) with their own history
console.log("replay exercise-unit-kg-0904:");
{
  const rp = JSON.parse(readFileSync(join(here, "../tests/replay/exercise-unit-kg-0904.json"), "utf8"));
  for (const r of rp.rows) {
    const opts = (du) => ({ displayUnit: du, message: r.raw_message, normalizeName: normalizeExName, history: r.history || [], now: Date.parse(r.created_at) });
    const run = (exs, du) => resolveLoadUnits({ exercises: exs, pr_attempts: r.parsed.pr_attempts || [] }, opts(du));
    const v = run(r.parsed.exercises, r.display_unit);
    eq(v.exercises.map((x) => x.unit), r.expect.exercises, `${r.name}: exercises`);
    eq(v.pr_attempts.map((x) => x.unit), r.expect.pr_attempts, `${r.name}: declared maxes`);
    if (r.expect.unit_source) eq(v.exercises.map((x) => x.unitSource), r.expect.unit_source, `${r.name}: which step decided`);
    if (r.expect.suspect) eq(v.exercises.map((x) => x.suspect), r.expect.suspect, `${r.name}: suspect flags`);
    // Same answer whatever the parser guessed on the unlabelled loads.
    for (const g of GUESSES) {
      const guessed = r.parsed.exercises.map((x) => (x.unit === "bodyweight" ? x : { ...x, unit: g }));
      eq(run(guessed, r.display_unit).exercises.map((x) => x.unit), r.expect.exercises, `${r.name}: exercises when the parser guessed ${g}`);
    }
    if (r.expect_if_lbs_athlete) {
      const lb = run(r.parsed.exercises.map((x) => ({ ...x, unit: null })), "lbs");
      eq(lb.exercises.map((x) => x.unit), r.expect_if_lbs_athlete.exercises, `${r.name}: same message from an lbs athlete, exercises`);
      eq(lb.pr_attempts.map((x) => x.unit), r.expect_if_lbs_athlete.pr_attempts, `${r.name}: same message from an lbs athlete, maxes`);
    }
    if (r.expect_after_answer) {
      const stamped = stampLoadUnits(r.parsed, opts(r.display_unit));
      const c = confirmPendingUnits(stamped, r.expect_after_answer.answer);
      eq(c.parsed_data.exercises.map((x) => x.unit), r.expect_after_answer.exercises, `${r.name}: after the athlete answers ${r.expect_after_answer.answer}`);
      ok(c.parsed_data.exercises.every((x) => !x.unit_suspect), `${r.name}: nothing pending after the answer`);
    }
    if (r.expect_implausible_jump != null) {
      const stamped = stampLoadUnits(r.parsed, opts(r.display_unit));
      const target = r.parsed.exercises.find((y) => y.unit === "lbs" && y.weight);
      const exRow = stamped.exercises.find((x) => normalizeExName(x.name) === normalizeExName(target?.name));
      const knownLbs = r.known_best.e1rm_lbs ?? toLbs(r.known_best.weight, r.known_best.unit);
      eq(implausibleJump(knownLbs, bestE1RMForExercise(exRow)), r.expect_implausible_jump, `${r.name}: implausible-jump guard (${Math.round(bestE1RMForExercise(exRow))} lbs vs ${Math.round(knownLbs)} lbs)`);
      eq(!!exRow.unit_suspect, false, `${r.name}: no unit_suspect stamped`);
    }
  }
}

// 16 ── step 4: the unit this athlete has used for THIS lift (orchestrator 09-29)
console.log("lift history (step 4) and the plausibility guard:");
{
  const NOW = Date.parse("2026-09-29T12:00:00Z");
  const day = (n) => new Date(NOW - n * 86400000).toISOString();
  const row = (n, raw, exercises) => ({ created_at: day(n), raw_message: raw, parsed_data: { exercises } });
  const V = (message, du, exercises, history, attempts = []) =>
    resolveLoadUnits({ exercises, pr_attempts: attempts }, { displayUnit: du, message, normalizeName: normalizeExName, history, now: NOW });
  const benchLbs = [row(5, "Bench 5x3 @ 205lbs", [ex("Bench Press", 205, "lbs")]), row(12, "bench 3x5 at 195", [ex("Bench Press", 195, "lbs")])];

  // a kg athlete's lbs lift
  let v = V("bench 3x5 at 205", "kg", [ex("Bench Press", 205, null)], benchLbs);
  eq([v.exercises[0].unit, v.exercises[0].unitSource, v.exercises[0].suspect], ["lbs", "history", false], "kg athlete, bench history written in lbs -> lbs, no suspect");
  // first-ever lift: no history -> the athlete's setting
  v = V("zercher squat 3x5 at 100", "kg", [ex("Zercher Squat", 100, null)], benchLbs);
  eq([v.exercises[0].unit, v.exercises[0].unitSource], ["kg", "display"], "first-ever lift -> athlete's setting");
  v = V("zercher squat 3x5 at 100", "lbs", [ex("Zercher Squat", 100, null)], []);
  eq([v.exercises[0].unit, v.exercises[0].unitSource], ["lbs", "display"], "no history at all -> athlete's setting");
  // lift identity through resolveLift: an alias of the same lift counts
  v = V("bench press 3x5 at 205", "kg", [ex("Bench", 205, null)], benchLbs);
  eq(v.exercises[0].unit, "lbs", "'Bench' and 'Bench Press' are the same lift");
  // history older than 180 days is ignored
  v = V("bench 3x5 at 100", "kg", [ex("Bench Press", 100, null)], [row(200, "Bench 3x5 @ 225lbs", [ex("Bench Press", 225, "lbs")])]);
  eq([v.exercises[0].unit, v.exercises[0].unitSource], ["kg", "display"], "history older than 180 days is ignored");
  v = V("bench 3x5 at 205", "kg", [ex("Bench Press", 205, null)], [row(179, "Bench 3x5 @ 205lbs", [ex("Bench Press", 205, "lbs")])]);
  eq(v.exercises[0].unit, "lbs", "179 days old still counts");
  // conflicting history: written evidence wins over newer unwritten rows
  const conflict = [
    row(2, "clean 3x2 at 100", [ex("Clean", 100, "lbs")]),
    row(4, "clean 3x2 at 100", [ex("Clean", 100, "lbs")]),
    row(9, "Clean 3x2 @ 100kg", [ex("Clean", 100, "kg")]),
    row(20, "clean 3x2 @ 220 lbs", [ex("Clean", 220, "lbs")]),
  ];
  v = V("clean 3x2 at 100", "lbs", [ex("Clean", 100, null)], conflict);
  eq([v.exercises[0].unit, v.exercises[0].unitSource], ["kg", "history"], "the most recent WRITTEN row (kg, 9 days) beats newer unwritten lbs rows");
  // no written evidence: majority of the last 5 stored units
  const unwritten = [
    row(1, "clean 100", [ex("Clean", 100, "kg")]), row(3, "clean 100", [ex("Clean", 100, "lbs")]), row(5, "clean 100", [ex("Clean", 100, "kg")]),
    row(7, "clean 100", [ex("Clean", 100, "kg")]), row(9, "clean 100", [ex("Clean", 100, "lbs")]), row(11, "clean 220", [ex("Clean", 220, "lbs")]),
    row(13, "clean 220", [ex("Clean", 220, "lbs")]), row(15, "clean 220", [ex("Clean", 220, "lbs")]),
  ];
  v = V("clean 3x2 at 100", "lbs", [ex("Clean", 100, null)], unwritten);
  eq([v.exercises[0].unit, v.exercises[0].unitSource], ["kg", "history"], "no written unit: majority of the last 5 (3 kg, 2 lbs) wins, older rows don't count");
  // the guard: history is kg, today's number only makes sense in lbs
  const benchKg = [row(6, "Bench 3x5 @ 100kg", [ex("Bench Press", 100, "kg", { sets: 3, reps: 5 })]), row(13, "bench 3x5 @ 97.5kg", [ex("Bench Press", 97.5, "kg", { sets: 3, reps: 5 })])];
  v = V("bench 3x5 at 225", "lbs", [ex("Bench Press", 225, null, { sets: 3, reps: 5 })], benchKg);
  eq([v.exercises[0].unit, v.exercises[0].unitSource, v.exercises[0].suspect], ["kg", "history", true], "kg history, 225 only makes sense in lbs -> kept kg, marked suspect (asks, never flips)");
  const st = stampLoadUnits({ exercises: [ex("Bench Press", 225, null, { sets: 3, reps: 5 })] }, { displayUnit: "lbs", message: "bench 3x5 at 225", normalizeName: normalizeExName, history: benchKg, now: NOW });
  eq([st.exercises[0].unit, st.exercises[0].unit_source, st.exercises[0].unit_suspect], ["kg", "history", true], "stamp stores unit, unit_source and unit_suspect");
  eq(stampLoadUnits(st, { displayUnit: "lbs", message: "bench 3x5 at 225", history: benchKg, now: NOW }), st, "a stamped (suspect) load is final: same object");
  ok(Math.abs(liftRecentBestLbs(benchKg, "Bench Press", NOW) - Math.round(toLbs(100, "kg") * (1 + 5 / 30))) <= 1, `the hold-up ask quotes the lift's history best (${liftRecentBestLbs(benchKg, "Bench Press", NOW)} lbs)`);
  eq(liftRecentBestLbs(benchKg, "Zercher Squat", NOW), 0, "no history -> 0");
  // the guard on step 5 too: no history for the unit call... but a display-unit reading that jumps
  const onlyOld = [row(3, "front squat 3x3 @ 100", [ex("Front Squat", 100, "kg", { sets: 3, reps: 3 })])];
  v = V("front squat 3x3 at 100", "kg", [ex("Front Squat", 100, null, { sets: 3, reps: 3 })], onlyOld);
  eq([v.exercises[0].unit, v.exercises[0].suspect], ["kg", false], "a normal day in the history's unit is not suspect");
  // both units implausible (a typo): not the unit guard's call (the finalize jump check still asks)
  v = V("bench 3x5 at 900", "lbs", [ex("Bench Press", 900, null, { sets: 3, reps: 5 })], benchLbs);
  eq([v.exercises[0].unit, v.exercises[0].suspect], ["lbs", false], "a typo implausible in both units is left to the existing jump check");
  // the guard, the other direction: a unit switch-over. The last WRITTEN C&J was
  // lbs (before the athlete moved to kg); today's unlabelled 130 read as lbs is a
  // collapse below the best, and 130 kg fits it. Asked, never silently flipped.
  const cjSwitch = [row(10, "Clean & Jerk 3x1 @ 70/90/100/110/120", [ladder("Clean & Jerk", [70, 90, 100, 110, 120], "kg")]),
    row(40, "Clean and jerk singles at 135/185/225/255/275/290lbs", [ladder("Clean & Jerk", [135, 185, 225, 255, 275, 290], "lbs")])];
  v = V("Clean and Jerk singles @ 70/90/100/110/120/130", "kg", [ladder("Clean & Jerk", [70, 90, 100, 110, 120, 130], null)], cjSwitch);
  eq([v.exercises[0].unit, v.exercises[0].unitSource, v.exercises[0].suspect], ["lbs", "history", true], "switch-over: history says lbs (last written), 130 lbs collapses below a 290 lb best, 130 kg fits -> suspect, asks");
  // an ordinary light day is never suspect (the other unit would be a 2x jump)
  v = V("bench 3x5 at 135", "kg", [ex("Bench Press", 135, null, { sets: 3, reps: 5 })], benchLbs);
  eq([v.exercises[0].unit, v.exercises[0].suspect], ["lbs", false], "a light day in the lift's unit is not suspect");
  v = V("bench 3x8 at 60", "kg", [ex("Bench Press", 60, null, { sets: 3, reps: 8 })], benchKg);
  eq([v.exercises[0].unit, v.exercises[0].suspect], ["kg", false], "a deload in kg is not suspect");
  // the ask copy
  eq(unitCheckMessage([{ exercise: "Clean & Jerk", weight: 130, unit: "lbs" }]),
    "Quick check before I bank that.\nClean & Jerk at 130 lbs doesn't line up with your recent Clean & Jerk numbers. 130 kg would.\n\nWhich was it, kg or lbs? I'll file it the way you say.", "unit ask, one lift");
  ok(/those[\s\S]*Which were they/.test(unitCheckMessage([{ exercise: "A", weight: 1, unit: "kg" }, { exercise: "B", weight: 2, unit: "lbs" }])), "unit ask, two lifts");
  eq(unitCheckMessage([]), "", "no checks, no message");
  ok(!/[\u2014!]/.test(unitCheckMessage([{ exercise: "Bench Press", weight: 225, unit: "kg" }])), "house style: no em dash, no exclamation");

  // steps 1-3 always outrank history, and history never overrides a written unit
  v = V("bench 3x5 at 100kg", "kg", [ex("Bench Press", 100, null)], benchLbs);
  eq([v.exercises[0].unit, v.exercises[0].unitSource], ["kg", "written"], "written kg beats lbs history");
  v = V("all in kilos today: bench 100", "lbs", [ex("Bench Press", 100, "kg")], benchLbs);
  eq([v.exercises[0].unit, v.exercises[0].unitSource], ["kg", "parser"], "a backed parser unit beats history");
  // T46 cases unchanged with history present
  v = V("squat 180kg, then bench 135", "lbs", [ex("Back Squat", 180, "kg"), ex("Bench Press", 135, "kg")], benchLbs);
  eq(v.exercises.map((x) => x.unit), ["kg", "lbs"], "T46 lbs athlete with bench history in lbs");
  v = V("clean 100, then curls 40lb", "kg", [ex("Clean", 100, "lbs"), ex("Dumbbell Curl", 40, "lbs")], []);
  eq(v.exercises.map((x) => x.unit), ["kg", "lbs"], "T46 kg athlete, no history");
  // declared maxes read history too, after their own set
  v = V("hit a 225 bench single", "kg", [], benchLbs, [{ exercise: "Bench Press", weight: 225, unit: null, reps: 1, achieved: true }]);
  eq([v.pr_attempts[0].unit, v.pr_attempts[0].unitSource], ["lbs", "history"], "declared max with lbs bench history -> lbs");
  // history rows: bodyweight / unitless / weightless rows give no evidence
  v = V("dips 3x8 at 20", "kg", [ex("Dip", 20, null)], [row(3, "dips 3x8", [{ name: "Dip", unit: "bodyweight", sets: 3, reps: 8 }])]);
  eq([v.exercises[0].unit, v.exercises[0].unitSource], ["kg", "display"], "a bodyweight history row is no unit evidence");
  // a JSON-string parsed_data row (as some reads return it) still counts
  v = V("bench 3x5 at 205", "kg", [ex("Bench Press", 205, null)], [{ created_at: day(4), raw_message: "Bench 3x5 @ 205lbs", parsed_data: JSON.stringify({ exercises: [ex("Bench Press", 205, "lbs")] }) }]);
  eq(v.exercises[0].unit, "lbs", "string parsed_data history row");
  // a backdated row (parsed_data.log_date) is placed by its log date
  v = V("bench 3x5 at 205", "kg", [ex("Bench Press", 205, null)], [{ created_at: day(1), raw_message: "Bench 3x5 @ 205lbs", parsed_data: { log_date: "2026-01-01", exercises: [ex("Bench Press", 205, "lbs")] } }]);
  eq(v.exercises[0].unitSource, "display", "log_date older than 180 days -> ignored");
}

// 17 ── step 4 by RECENCY (orchestrator 09-29, change 1)
console.log("step 4 recency ranking:");
{
  const NOW = Date.parse("2026-09-29T12:00:00Z");
  const day = (n) => new Date(NOW - n * 86400000).toISOString();
  const row = (n, raw, exercises) => ({ created_at: day(n), raw_message: raw, parsed_data: { exercises } });
  const V = (message, du, exercises, history) => resolveLoadUnits({ exercises }, { displayUnit: du, message, normalizeName: normalizeExName, history, now: NOW }).exercises[0];
  const cj = (w, unit, extra = {}) => ({ ...ladder("Clean & Jerk", [70, 90, w], unit), ...extra });
  // the founder's 09-04 shape: last 3 = kg, kg, lbs (none written) -> most recent -> kg, no flag
  const founder0904 = [row(7, "Clean and Jerk to heavy single 70/90/100/110/120", [cj(120, "kg")]), row(13, "C&J 3x1 @ 110,120,125", [cj(125, "kg")]),
    row(20, "Clean and jerk singles at 135/185/225/255/275/290", [ladder("Clean & Jerk", [135, 185, 225, 255, 275, 290], "lbs")])];
  let v = V("Clean and Jerk singles @ 70/90/100/110/120/130", "kg", [ladder("Clean & Jerk", [70, 90, 100, 110, 120, 130], null)], founder0904);
  eq([v.unit, v.unitSource, v.suspect], ["kg", "history", false], "founder 09-04: recent kg logs beat an older lbs log -> kg, no flag");
  // an old WRITTEN lbs row no longer outranks recent logs that agree
  const writtenOld = [row(3, "cj 120", [cj(120, "kg")]), row(10, "cj 125", [cj(125, "kg")]), row(15, "cj 118", [cj(118, "kg")]), row(60, "Clean & jerk 290lbs", [ladder("Clean & Jerk", [290], "lbs")])];
  v = V("C&J 130", "kg", [ladder("Clean & Jerk", [130], null)], writtenOld);
  eq([v.unit, v.suspect], ["kg", false], "last 3 agree (kg) -> kg, a months-old written lbs row does not count");
  // disagree -> the most recent WRITTEN or CONFIRMED of the last 3
  const disagree = [row(2, "cj 120", [cj(120, "lbs")]), row(5, "C&J 120kg", [cj(120, "kg")]), row(9, "cj 250", [cj(250, "lbs")])];
  eq(V("cj 118", "lbs", [ladder("Clean & Jerk", [118], null)], disagree).unit, "kg", "last 3 disagree -> the most recent written (kg) wins over a newer unwritten lbs");
  const confirmed = [row(2, "cj 120", [cj(120, "lbs")]), row(5, "cj 120", [cj(120, "kg", { unit_source: "athlete_confirmed" })]), row(9, "cj 250 lbs", [cj(250, "lbs")])];
  eq(V("cj 118", "lbs", [ladder("Clean & Jerk", [118], null)], confirmed).unit, "kg", "an athlete-confirmed log counts as evidence (beats an older written lbs)");
  const none = [row(2, "cj 120", [cj(120, "kg")]), row(5, "cj 250", [cj(250, "lbs")]), row(9, "cj 118", [cj(118, "kg")])];
  eq(V("cj 118", "lbs", [ladder("Clean & Jerk", [118], null)], none).unit, "kg", "disagree, nothing written or confirmed -> the most recent log");
  // an unconfirmed (suspect) log is no evidence
  const withSuspect = [row(1, "cj 130", [cj(130, "lbs", { unit_suspect: true, unit_source: "history" })]), row(5, "cj 120", [cj(120, "kg")]), row(9, "cj 118", [cj(118, "kg")])];
  eq(V("cj 125", "lbs", [ladder("Clean & Jerk", [125], null)], withSuspect).unit, "kg", "a unit_suspect log is ignored as evidence");
  ok(CONFIRMED_SOURCES.has("athlete_confirmed") && CONFIRMED_SOURCES.has("edit") && CONFIRMED_SOURCES.has("correction") && !CONFIRMED_SOURCES.has("history"), "confirmed sources: answer, edit, correction");
  // first C&J after a switch: all of the lift's history is lbs -> lbs, flagged (asks once)
  const allLbs = [row(7, "cj 290", [ladder("Clean & Jerk", [135, 225, 290], "lbs")]), row(14, "cj 275", [ladder("Clean & Jerk", [135, 225, 275], "lbs")]), row(21, "cj 285", [ladder("Clean & Jerk", [135, 225, 285], "lbs")])];
  v = V("C&J 3x1 @ 110,120,125", "kg", [ladder("Clean & Jerk", [110, 120, 125], null)], allLbs);
  eq([v.unit, v.suspect], ["lbs", true], "first C&J after switching to kg: history is all lbs, 125 lbs collapses, 125 kg fits -> asks");
  // self-correction: after the athlete confirms kg once, and three logs later
  const afterAnswer = [row(1, "C&J 3x1 @ 110,120,125", [ladder("Clean & Jerk", [110, 120, 125], "kg", 1)].map((x) => ({ ...x, unit_source: "athlete_confirmed" }))), ...allLbs];
  eq(V("cj 118", "kg", [ladder("Clean & Jerk", [118], null)], afterAnswer).unit, "kg", "the log right after the answer -> kg (confirmed beats the older lbs pair)");
  const threeLater = [row(0.5, "cj 120", [cj(120, "kg", { unit_source: "history" })]), row(0.7, "cj 118", [cj(118, "kg", { unit_source: "history" })]), ...afterAnswer];
  eq(V("cj 121", "kg", [ladder("Clean & Jerk", [121], null)], threeLater).unit, "kg", "three logs later the new unit still wins (last 3 agree)");
  // the silent case the orchestrator named: a switch where the number fits both units
  const accLbs = [row(7, "curls 3x10 @ 30", [ex("Dumbbell Curl", 30, "lbs")]), row(14, "curls 3x10 @ 30", [ex("Dumbbell Curl", 30, "lbs")]), row(21, "curls 3x10 @ 30", [ex("Dumbbell Curl", 30, "lbs")])];
  eq(V("curls 3x10 @ 30", "kg", [ex("Dumbbell Curl", 30, null)], accLbs).suspect, false, "a number that fits both units is not asked about (known limit)");
  const accSwitched = [row(1, "curls 3x10 @ 14kg", [ex("Dumbbell Curl", 14, "kg")]), ...accLbs];
  eq(V("curls 3x10 @ 14", "kg", [ex("Dumbbell Curl", 14, null)], accSwitched).unit, "kg", "...and it self-corrects as soon as the athlete writes the unit once");
  const accLater = [row(0.3, "curls 14", [ex("Dumbbell Curl", 14, "kg")]), row(0.6, "curls 14", [ex("Dumbbell Curl", 14, "kg")]), ...accSwitched];
  eq(V("curls 3x10 @ 14", "kg", [ex("Dumbbell Curl", 14, null)], accLater).unit, "kg", "...and three logs later the new unit wins on recency alone");
}

// 18 ── a flagged load derives NOTHING until confirmed (change 3)
console.log("nothing derived from a pending load:");
{
  const pend = { name: "Clean & Jerk", sets: 3, reps: 1, weight: 125, unit: "lbs", unit_source: "history", unit_suspect: true, set_details: [{ weight: 110, reps: 1 }, { weight: 120, reps: 1 }, { weight: 125, reps: 1 }] };
  ok(isUnitPending(pend) && !isUnitPending({ ...pend, unit_suspect: undefined }), "isUnitPending");
  eq(bestE1RMForExercise(pend), 0, "no e1RM (benchmarks, progress, prs, goals, Joe's known maxes all read this)");
  eq(sessionTonnage([pend]), 0, "no tonnage");
  eq(sessionTopSet([pend]), null, "no top set on the proof card");
  eq(prCheckLines([pend], {}, "kg").length, 0, "no PR CHECK line");
  eq(logTurnExercises({ exercises: [pend, ex("Back Squat", 140, "kg")] }, "kg").map((x) => x.name), ["Back Squat"], "log-turn facts leave it out");
  eq(logTurnExercises({ exercises: [], pr_attempts: [{ exercise: "Snatch", weight: 102, reps: 1, achieved: true, unit: "lbs", unit_suspect: true }] }, "kg"), [], "a pending declared max is not a turn fact either");
  const srcFiles = ["src/grit.js", "src/proofcore.js", "src/painLedger.js", "src/builder.jsx"];
  for (const f of srcFiles) ok(/isUnitPending\(/.test(readFileSync(join(here, "..", f), "utf8")), `${f} skips pending loads`);
  // confirming
  const rowPd = { exercises: [pend, ex("Back Squat", 140, "kg", { unit_source: "written" })], pr_attempts: [{ exercise: "Clean & Jerk", weight: 125, reps: 1, achieved: true, unit: "lbs", unit_source: "set", unit_suspect: true }], general_notes: "x" };
  const c = confirmPendingUnits(rowPd, "kg");
  eq(c.parsed_data.exercises.map((x) => [x.unit, x.unit_source, !!x.unit_suspect]), [["kg", "athlete_confirmed", false], ["kg", "written", false]], "answer settles the pending set, leaves the rest");
  eq(c.parsed_data.pr_attempts[0].unit, "kg", "and its declared max");
  eq(c.parsed_data.general_notes, "x", "other fields kept");
  eq([c.bank.exercises.length, c.bank.pr_attempts.length, c.bank.exercises[0].name], [1, 1, "Clean & Jerk"], "bank = only the confirmed loads (derived writes run once, for them)");
  eq(bestE1RMForExercise(c.bank.exercises[0]) > 0, true, "after confirmation the load derives normally");
  eq(confirmPendingUnits(c.parsed_data, "kg").bank.exercises.length, 0, "answering twice banks nothing twice");
  eq(confirmPendingUnits(rowPd, "stone").bank.exercises.length, 0, "a junk answer settles nothing");
  eq(stampLoadUnits(c.parsed_data, { displayUnit: "lbs", message: "C&J 125" }), c.parsed_data, "a confirmed row is final under the resolver");
  // typed answers
  eq(["kg", "KG", "it was kg", "kilos.", "lbs", "it was lbs", "pounds", "in kg", "they were lbs"].map(unitAnswer), ["kg", "kg", "kg", "kg", "lbs", "lbs", "lbs", "kg", "lbs"], "typed answers");
  eq(["kg squat 100", "what?", "", "the kg one was wrong"].map(unitAnswer), [null, null, null, null], "anything else is not an answer");
}

// 19 ── one voice on a flagged turn (change 2)
console.log("one voice per turn:");
{
  const parsed = stampLoadUnits({ exercises: [ladder("Clean & Jerk", [110, 120, 125], null)] }, { displayUnit: "kg", message: "C&J 3x1 @ 110,120,125", normalizeName: normalizeExName,
    history: [["cj 290", 7], ["cj 275", 14], ["cj 285", 21]].map(([raw, d]) => ({ created_at: new Date(Date.parse("2026-09-29T12:00:00Z") - d * 864e5).toISOString(), raw_message: raw, parsed_data: { exercises: [ladder("Clean & Jerk", [135, 225, Number(raw.split(" ")[1])], "lbs")] } })),
    now: Date.parse("2026-09-29T12:00:00Z") });
  eq(parsed.exercises[0].unit_suspect, true, "fixture is flagged");
  const loads = pendingUnitLoads(parsed);
  eq(loads, [{ exercise: "Clean & Jerk", weight: 125, unit: "lbs" }], "pendingUnitLoads");
  const fact = unitCheckFact(parsed);
  ok(/UNIT CHECK/.test(fact) && /Clean & Jerk/.test(fact) && /do not question that number/.test(fact) && /do not celebrate/.test(fact) && /do not restate its weight in either unit/.test(fact), "Joe gets the computed fact");
  ok(!/\b125\b/.test(fact), "the fact itself never states the number");
  ok(/Nothing else is in this log/.test(fact) && /names no other lift as done/.test(fact), "T67: a flagged-only log says there is nothing else (Joe invented the plan's lifts 5 of 5)");
  const mixed = unitCheckFact({ exercises: [{ ...parsed.exercises[0] }, ex("Back Squat", 140, "kg", { unit_source: "written" })] });
  ok(/The rest of this log \(Back Squat\)/.test(mixed) && !/Nothing else/.test(mixed), "T67: the settled lifts are named");
  eq(unitCheckFact({ exercises: [ex("Back Squat", 140, "kg", { unit_source: "written" })] }), "", "no pending load, no fact");
  // the app's line is suppressed when Joe already asked
  eq(replyAsksUnit("Solid session. Was that 125 in kg or lbs?", loads), true, "Joe asked about the unit");
  eq(replyAsksUnit("Nice work. Is 125 right?", loads), true, "Joe questioned the number");
  eq(replyAsksUnit("Nice work on the clean and jerk today.", loads), false, "no question");
  eq(replyAsksUnit("Good day. How did the squat feel?", loads), false, "a question about something else is not a unit ask");
  // the whole turn: exactly one message asks about the unit
  const turn = (joe) => { const app = replyAsksUnit(joe, loads) ? "" : unitCheckMessage(loads); return [joe, app].filter(Boolean).filter((m) => replyAsksUnit(m, loads) || /kg or lbs\?/.test(m)).length; };
  eq(turn("Solid work today. Squat moved well."), 1, "Joe silent on it -> the app asks, one ask");
  eq(turn("Solid work. Was the C&J in kg or lbs?"), 1, "Joe asked -> the app does not, one ask");
  const app = readFileSync(join(here, "../src/App.jsx"), "utf8");
  ok(/unitCheckContext\?`\\n\\n\$\{unitCheckContext\}`:""/.test(app), "the fact rides in Joe's dynamic context");
  ok(/replyAsksUnit\(reply, unitChecks\) \? "" : unitCheckMessage\(unitChecks\)/.test(app), "finalizeWorkout suppresses its ask when Joe already asked");
  ok(/if\(ex\.unit_suspect\)\{ unitChecks\.push/.test(app) && /await finalizeWorkout\(bank, row\.raw_message\|\|"", row\.bot_reply\|\|"", athlete, false, false, \{derivedOnly:true/.test(app), "pending loads skip the derived writes; the answer runs them once in derivedOnly mode (T68: through the one bank function)");
}

// 20 ── T68 bug 1: the unit of an ADDED load on a bodyweight lift ("BW+20")
// The exercise's own unit is "bodyweight", so the load carried no unit and every
// reader assumed lbs: a kg athlete's "Weighted pull-ups 3x5 BW+20" was read as 20
// LBS everywhere. The same resolver order decides it now, and the answer is stored
// beside the number as added_unit / added_unit_source. Old rows have no field and
// keep today's meaning (lbs).
console.log("added load on a bodyweight lift (T68):");
{
  const NOW = Date.now();
  const AS = (message, du, exercises, history = []) => stampLoadUnits({ exercises, pr_attempts: [] }, { displayUnit: du, message, normalizeName: normalizeExName, history, now: NOW }).exercises;
  const wpu = (extra = {}) => ({ name: "Weighted Pull-Up", sets: 3, reps: 5, unit: "bodyweight", weight: null, added_weight: 20, ...extra });
  const pair = (x) => [x.unit, x.added_unit, x.added_unit_source];
  eq(pair(AS("Weighted pull-ups 3x5 BW+20", "kg", [wpu()])[0]), ["bodyweight", "kg", "display"], "kg athlete, nothing written: the 20 is kg (was read as lbs)");
  eq(pair(AS("Weighted pull-ups 3x5 BW+20", "lbs", [wpu()])[0]), ["bodyweight", "lbs", "display"], "lbs athlete: lbs, as before");
  eq(pair(AS("Weighted pull-ups 3x5 BW+20lbs", "kg", [wpu()])[0]), ["bodyweight", "lbs", "written"], "written lbs beats a kg athlete");
  eq(pair(AS("Weighted pull-ups 3x5 BW+20kg", "lbs", [wpu()])[0]), ["bodyweight", "kg", "written"], "written kg beats an lbs athlete");
  eq(pair(AS("weighted pull-ups 3x5 +20 kilos", "lbs", [wpu()])[0]), ["bodyweight", "kg", "written"], "kilos is kg");
  eq(AS("Weighted pull-ups 3x5 BW+20", "kg", [wpu()])[0].added_weight, 20, "the number is stored as typed, never converted");
  ok(!AS("Weighted pull-ups 3x5 BW+20", "kg", [wpu()])[0].unit_suspect, "an added load is never flagged");
  // assisted, and per-set weights on a bodyweight row
  eq(pair(AS("assisted dips 3x8 -40", "kg", [{ name: "Dip", sets: 3, reps: 8, unit: "bodyweight", assist_weight: 40 }])[0]), ["bodyweight", "kg", "display"], "assist load: kg athlete -> kg");
  eq(pair(AS("assisted dips 3x8 -40lb", "kg", [{ name: "Dip", sets: 3, reps: 8, unit: "bodyweight", assist_weight: 40 }])[0]), ["bodyweight", "lbs", "written"], "assist load written in lbs");
  const ramp = { name: "Pull-Up", unit: "bodyweight", set_details: [{ weight: 0, reps: 8 }, { weight: 25, reps: 8 }, { weight: 25, reps: 8 }] };
  eq(pair(AS("Pull-ups 3x8 BW/+25kg/+25kg", "lbs", [ramp])[0]), ["bodyweight", "kg", "written"], "per-set weights: the chain's unit covers them");
  eq(pair(AS("Pull-ups 3x8 BW/25/25", "kg", [ramp])[0]), ["bodyweight", "kg", "display"], "per-set weights, nothing written: the athlete's unit");
  // a unit never carries to the next lift; the same lift elsewhere in the message does
  eq(AS("weighted pull-ups 3x5 +20kg, then dips 3x8 +45", "lbs", [wpu(), { name: "Dip", sets: 3, reps: 8, unit: "bodyweight", added_weight: 45 }]).map((x) => x.added_unit), ["kg", "lbs"], "kg stays on the pull-ups; the dips follow the athlete");
  eq(AS("weighted pull-ups 3x5 +20kg, then 1x8 weighted pull-ups +10", "lbs", [wpu(), wpu({ sets: 1, reps: 8, added_weight: 10 })]).map((x) => [x.added_unit, x.added_unit_source]), [["kg", "written"], ["kg", "same-lift"]], "the same lift elsewhere in the message");
  // step 4: this lift's recent added loads
  const hrow = (daysAgo, added_unit, src, raw = "Weighted pull-ups 3x5 +20") => ({ id: `h${daysAgo}`, created_at: new Date(NOW - daysAgo * 86400000).toISOString(), raw_message: raw,
    parsed_data: { exercises: [wpu(added_unit ? { added_unit, added_unit_source: src } : {})] } });
  eq(pair(AS("Weighted pull-ups 3x5 +25", "kg", [wpu({ added_weight: 25 })], [hrow(3, "lbs", "written"), hrow(8, "lbs", "written"), hrow(15, "lbs", "history")])[0]), ["bodyweight", "lbs", "history"], "a kg athlete who loads pull-ups in lbs: the lift's history wins over the setting");
  eq(pair(AS("Weighted pull-ups 3x5 +25", "lbs", [wpu({ added_weight: 25 })], [hrow(3, "kg", "written"), hrow(8, "kg", "display"), hrow(15, "lbs", "display")])[0]), ["bodyweight", "kg", "history"], "unit switch: the most recent written log settles it");
  eq(pair(AS("Weighted pull-ups 3x5 +25", "kg", [wpu({ added_weight: 25 })], [hrow(3), hrow(8), hrow(15)])[0]), ["bodyweight", "kg", "display"], "old rows carry no added_unit: they are not evidence, the setting decides");
  // stamped is final, idempotent, and only the weighted rows change
  const once = stampLoadUnits({ exercises: [wpu()], pr_attempts: [] }, { displayUnit: "kg", message: "Weighted pull-ups 3x5 BW+20", normalizeName: normalizeExName });
  eq(stampLoadUnits(once, { displayUnit: "lbs", message: "Weighted pull-ups 3x5 BW+20", normalizeName: normalizeExName }), once, "a stamped added load is final (even under another display unit)");
  const plain = { exercises: [{ name: "Pull-Up", unit: "bodyweight", sets: 3, reps: 10 }], pr_attempts: [] };
  eq(stampLoadUnits(plain, { displayUnit: "kg", message: "pull-ups 3x10" }), plain, "no added load: same object, no field");
  eq(R("Weighted pull-ups 3x5 BW+20", "kg", [wpu()]).ex, ["bodyweight"], "unit stays bodyweight");
  const v = resolveLoadUnits({ exercises: [wpu()], pr_attempts: [] }, { displayUnit: "kg", message: "Weighted pull-ups 3x5 BW+20", normalizeName: normalizeExName });
  eq([v.exercises[0].addedUnit, v.exercises[0].addedSource], ["kg", "display"], "the resolver's verdict names the added unit and its step");
  // flush guard: every file that reads an added/assist load resolves its unit through units.js
  for (const d of [join(here, "../src"), join(here, "../api")]) for (const f of readdirSync(d).filter((x) => /\.(js|jsx)$/.test(x))) {
    const src = readFileSync(join(d, f), "utf8");
    if (!/\b(added_weight|assist_weight)\b/.test(src)) continue;
    ok(/addedLoad(Unit|In)/.test(src), `${f} reads added_weight/assist_weight and resolves the unit through addedLoadUnit/addedLoadIn`);
  }
  // the readers' one helper
  ok(typeof UN.addedLoadUnit === "function", "units.addedLoadUnit exists");
  if (typeof UN.addedLoadUnit === "function") {
    eq(UN.addedLoadUnit({ unit: "bodyweight", added_weight: 20, added_unit: "kg" }), "kg", "reads the stamp");
    eq(UN.addedLoadUnit({ unit: "bodyweight", added_weight: 20 }), "lbs", "legacy row: lbs, exactly as before");
    eq(UN.addedLoadUnit({ unit: "bodyweight", added_weight: 20, added_unit: "stone" }), "lbs", "junk stamp: lbs");
    eq(Math.round(UN.addedLoadIn({ added_unit: "kg" }, 20, "lbs") * 10) / 10, 44.1, "20 kg is 44.1 lbs");
    eq(UN.addedLoadIn({ added_unit: "kg" }, 20, "kg"), 20, "same unit: identity");
    eq(UN.addedLoadIn({}, 45, "lbs"), 45, "legacy lbs row read in lbs: identity");
  }
  // e1RM: a kg athlete's +20 is 44 lbs of load, not 20
  const kgRow = { name: "Weighted Pull-Up", unit: "bodyweight", sets: 1, reps: 5, added_weight: 20, added_unit: "kg" };
  const lbRow = { ...kgRow, added_unit: undefined };
  ok(bestE1RMForExercise(kgRow, 180) > bestE1RMForExercise(lbRow, 180), "e1RM: 20 kg adds more than 20 lbs");
  eq(Math.round(bestE1RMForExercise(kgRow, 180)), Math.round((180 + 20 * UN.LBS_PER_KG) * (1 + 5 / 30)), "e1RM: (180 lb bodyweight + 20 kg) x5 through Epley");
  ok(bestE1RMForExercise({ ...kgRow, added_weight: undefined, assist_weight: 20 }, 180) < bestE1RMForExercise({ ...lbRow, added_weight: undefined, assist_weight: 20 }, 180), "e1RM: 20 kg of assistance takes off more than 20 lbs");
}

// 21 ── T68 bug 2: which loads did a hand edit settle?
console.log("loads settled by an edit (T68):");
{
  ok(typeof PA.settledLoads === "function", "prAttempts.settledLoads exists");
  if (typeof PA.settledLoads === "function") {
    const bench = { name: "Bench Press", sets: 3, reps: 5, weight: 225, unit: "kg", unit_source: "history", unit_suspect: true };
    const squat = { name: "Back Squat", sets: 5, reps: 3, weight: 140, unit: "kg", unit_source: "written" };
    const before = { exercises: [bench, squat], pr_attempts: [{ exercise: "Bench Press", weight: 225, reps: 1, achieved: true, unit: "kg", unit_source: "history", unit_suspect: true }] };
    const edited = (u) => ({ ...bench, unit: u, unit_source: "edit", unit_suspect: undefined });
    const noFlag = (x) => { const { unit_suspect, ...r } = x; return r; };
    // the athlete picks the other unit in the edit sheet: the flag is gone, the load is settled
    let b = PA.settledLoads(before, { exercises: [noFlag(edited("lbs")), squat], pr_attempts: before.pr_attempts });
    eq(b.exercises.map((x) => [x.name, x.unit, x.unit_source]), [["Bench Press", "lbs", "edit"]], "the edited flagged lift is settled, with its new unit");
    eq(b.pr_attempts, [], "a declared max still asking is not settled");
    // a change to a different lift, or to reps only, settles nothing
    eq(PA.settledLoads(before, { exercises: [bench, { ...squat, weight: 145 }], pr_attempts: before.pr_attempts }), { exercises: [], pr_attempts: [] }, "editing an unflagged lift settles nothing");
    eq(PA.settledLoads(before, { exercises: [{ ...bench, reps: 4 }, squat], pr_attempts: before.pr_attempts }), { exercises: [], pr_attempts: [] }, "flag still set: still unsettled, nothing to bank");
    // a row that was never flagged
    const clean = { exercises: [squat], pr_attempts: [] };
    eq(PA.settledLoads(clean, { exercises: [{ ...squat, unit: "lbs", unit_source: "edit" }], pr_attempts: [] }), { exercises: [], pr_attempts: [] }, "an unflagged row edited: nothing to bank (behaves as before)");
    // deleting the flagged lift banks nothing
    eq(PA.settledLoads(before, { exercises: [squat], pr_attempts: before.pr_attempts }), { exercises: [], pr_attempts: [] }, "a removed lift banks nothing");
    // the chip path and the edit path agree on what a settled load looks like
    const chip = confirmPendingUnits(before, "lbs");
    eq(PA.settledLoads(before, chip.parsed_data).exercises.map((x) => x.name), chip.bank.exercises.map((x) => x.name), "same loads as the chip answer's bank (exercises)");
    eq(PA.settledLoads(before, chip.parsed_data).pr_attempts.map((x) => x.exercise), chip.bank.pr_attempts.map((x) => x.exercise), "same loads as the chip answer's bank (declared maxes)");
  }
  const app = readFileSync(join(here, "../src/App.jsx"), "utf8");
  ok(/const bankSettledUnits = async/.test(app), "App.jsx has ONE bank function");
  ok((app.match(/await bankSettledUnits\(/g) || []).length === 2, "the chip answer and the chat correction call it");
  ok(/onUnitsSettled=\{bankSettledUnits\}/.test(app) && /onUnitsSettled&&await onUnitsSettled\(settledLoads\(pd, newParsedData\)/.test(app), "the My Log edit sheet reports its settled loads to the same function");
  ok((app.match(/finalizeWorkout\([^)]*derivedOnly:true/g) || []).length === 1, "derivedOnly finalize has ONE caller");
}

// 22 ── T68 replay: the kg athlete's "BW+20" and its readers
console.log("replay t68-bw-added-unit:");
{
  const rp = JSON.parse(readFileSync(join(here, "../tests/replay/t68-bw-added-unit.json"), "utf8"));
  for (const c of rp.cases) {
    // the parser's guess makes no difference: the answer is decided in code
    const row = c.stored ? c.parsed.exercises[0] : stampLoadUnits(c.parsed, { displayUnit: c.display_unit, message: c.raw_message, normalizeName: normalizeExName, history: c.history || [], now: c.now ? Date.parse(c.now) : Date.now() }).exercises[0];
    const { unit_source: _u, ...stored } = row;
    for (const [k, v] of Object.entries(c.expect_stored)) eq(row[k] ?? null, v, `${c.name}: stored ${k}`);
    eq(Object.keys(stored).filter((k) => !(k in c.parsed.exercises[0]) && !["added_unit", "added_unit_source"].includes(k)), [], `${c.name}: nothing else added to the row`);
    const rd = c.expect_readers;
    if (rd.performed_line_kg) eq(performedLine(row, { displayUnit: "kg" }), rd.performed_line_kg, `${c.name}: Joe's performed line (kg reader)`);
    if (rd.performed_line_lbs) eq(performedLine(row, { displayUnit: "lbs" }), rd.performed_line_lbs, `${c.name}: Joe's performed line (lbs reader)`);
    eq(Math.round(bestE1RMForExercise(row, rp.athlete_bodyweight_lbs)), rd.e1rm_lbs, `${c.name}: e1RM in lbs`);
  }
}

// 15 ── writtenUnit (the stored-row reader shares the chain reading)
console.log("writtenUnit:");
eq(writtenUnit("clean singles 100/110/120kg", 100), "kg", "chain unit covers its first number");
eq(writtenUnit("clean 100, then curls 40lb", 100), null, "another expression's unit is not this number's");

console.log(`\n${fail === 0 ? "✓" : "✗"} load-units: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
