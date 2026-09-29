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
import { resolveLoadUnits, stampLoadUnits, stampAttemptUnits, loadChains, writtenUnit } from "../src/prAttempts.js";
import { normalizeExName, bestE1RMForExercise, implausibleJump, toLbs } from "../src/grit.js";
import { exerciseUnit, exerciseLoadUnit } from "../src/units.js";
import { draftInUnit } from "../src/boot.js";

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

// 14 ── replay: the founder's real rows (read-only copies)
console.log("replay exercise-unit-kg-0904:");
{
  const rp = JSON.parse(readFileSync(join(here, "../tests/replay/exercise-unit-kg-0904.json"), "utf8"));
  for (const r of rp.rows) {
    const got = R(r.raw_message, r.display_unit, r.parsed.exercises, r.parsed.pr_attempts || []);
    eq(got.ex, r.expect.exercises, `${r.name}: exercises`);
    eq(got.pr, r.expect.pr_attempts, `${r.name}: declared maxes`);
    // Same answer whatever the parser guessed on the unlabelled loads.
    for (const g of GUESSES) {
      const guessed = r.parsed.exercises.map((x) => (x.unit === "bodyweight" ? x : { ...x, unit: g }));
      eq(R(r.raw_message, r.display_unit, guessed, r.parsed.pr_attempts || []).ex, r.expect.exercises, `${r.name}: exercises when the parser guessed ${g}`);
    }
    if (r.expect_if_lbs_athlete) {
      const lb = R(r.raw_message, "lbs", r.parsed.exercises.map((x) => ({ ...x, unit: null })), r.parsed.pr_attempts || []);
      eq(lb.ex, r.expect_if_lbs_athlete.exercises, `${r.name}: same message from an lbs athlete, exercises`);
      eq(lb.pr, r.expect_if_lbs_athlete.pr_attempts, `${r.name}: same message from an lbs athlete, maxes`);
    }
    if (r.expect_implausible_jump != null) {
      const stamped = stampLoadUnits(r.parsed, { displayUnit: r.display_unit, message: r.raw_message, normalizeName: normalizeExName });
      const exRow = stamped.exercises.find((x) => normalizeExName(x.name) === normalizeExName(r.parsed.exercises.find((y) => y.unit === "lbs" && y.weight)?.name));
      const knownLbs = r.known_best.e1rm_lbs ?? toLbs(r.known_best.weight, r.known_best.unit);
      eq(implausibleJump(knownLbs, bestE1RMForExercise(exRow)), r.expect_implausible_jump, `${r.name}: implausible-jump guard (${Math.round(bestE1RMForExercise(exRow))} lbs vs ${Math.round(knownLbs)} lbs)`);
    }
  }
}

// 15 ── writtenUnit (the stored-row reader shares the chain reading)
console.log("writtenUnit:");
eq(writtenUnit("clean singles 100/110/120kg", 100), "kg", "chain unit covers its first number");
eq(writtenUnit("clean 100, then curls 40lb", 100), null, "another expression's unit is not this number's");

console.log(`\n${fail === 0 ? "✓" : "✗"} load-units: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
