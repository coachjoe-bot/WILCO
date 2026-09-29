// ─── DECLARED-MAX UNIT SUITE ──────────────────────────────────────────────────
// Locks the 09-28 fix: a declared max (parsed_data.pr_attempts) with no unit on it
// is in the ATHLETE'S display unit, never a hard "lbs". Covers the pure resolver
// (units.js attemptUnit), the pre-save stamp, the stored-row reader and the
// actual-1RM write decision
// (src/prAttempts.js), replays the real incident (tests/replay/
// kg-declared-max-0928.json), and greps the source so the old ternary can't return.
// Run: node scripts/test-pr-attempts.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { attemptUnit, setDisplayUnit, toLbs, LBS_PER_KG } from "../src/units.js";
import { stampAttemptUnits, storedAttemptUnit, writtenUnit, mentionsUnit, isDeclaredMax, declaredMaxWrite } from "../src/prAttempts.js";
import { normalizeExName } from "../src/grit.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.error(`✗ ${name}`); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// 1 ── the resolver
console.log("attemptUnit:");
eq(attemptUnit({ weight: 102 }, "kg"), "kg", "no unit + kg athlete -> kg");
eq(attemptUnit({ weight: 225 }, "lbs"), "lbs", "no unit + lbs athlete -> lbs");
eq(attemptUnit({ weight: 102, unit: null }, "kg"), "kg", "unit:null + kg athlete -> kg");
eq(attemptUnit({ weight: 102, unit: "kg" }, "lbs"), "kg", "written kg beats an lbs display unit");
eq(attemptUnit({ weight: 225, unit: "lbs" }, "kg"), "lbs", "written lbs beats a kg display unit");
eq(attemptUnit({ weight: 225, unit: "bodyweight" }, "kg"), "kg", "a junk unit falls back to the display unit");
eq(attemptUnit({ weight: 225, unit: "KG" }, "lbs"), "lbs", "only the exact schema values count as written");
eq(attemptUnit({ weight: 225 }, undefined), "lbs", "no athlete unit on file, module default -> lbs");
eq(attemptUnit({ weight: 225 }, null), "lbs", "null display unit -> lbs");
eq(attemptUnit({ weight: 225 }, "stone"), "lbs", "unknown display unit -> lbs");
eq(attemptUnit(null, "kg"), "kg", "null attempt does not throw");
setDisplayUnit("kg");
eq(attemptUnit({ weight: 102 }), "kg", "omitted display unit reads the app-wide setting");
eq(attemptUnit({ weight: 102 }, "lbs"), "lbs", "an explicit display unit beats the app-wide setting");
setDisplayUnit("lbs");

// 2 ── the pre-save stamp
console.log("stampAttemptUnits:");
{
  const parsed = { exercises: [], pr_attempts: [{ exercise: "Snatch", weight: 102, reps: 1, achieved: true }] };
  const out = stampAttemptUnits(parsed, { displayUnit: "kg" });
  eq(out.pr_attempts[0].unit, "kg", "unitless attempt stamped with the athlete's unit");
  eq(parsed.pr_attempts[0].unit, undefined, "input is not mutated");
  eq(out.exercises, parsed.exercises, "everything else passes through untouched");
  eq(stampAttemptUnits(out, { displayUnit: "lbs" }), out, "idempotent: a stamped parse is returned as-is, even under another unit");
  eq(stampAttemptUnits(out, { displayUnit: "lbs" }).pr_attempts[0].unit, "kg", "a stamped unit survives a display-unit flip");

  const mixed = stampAttemptUnits({ pr_attempts: [
    { exercise: "Snatch", weight: 102, unit: "kg", reps: 1, achieved: true },
    { exercise: "Bench Press", weight: 225, unit: null, reps: 1, achieved: false },
  ] }, { displayUnit: "lbs" });
  eq(mixed.pr_attempts[0].unit, "kg", "written unit kept");
  eq(mixed.pr_attempts[1].unit, "lbs", "missed attempts get stamped too");
  eq(mixed.pr_attempts[1].achieved, false, "stamp never touches achieved");

  const none = { exercises: [{ name: "Squat" }], pr_attempts: [] };
  eq(stampAttemptUnits(none, { displayUnit: "kg" }), none, "no attempts -> same object");
  eq(stampAttemptUnits(null, { displayUnit: "kg" }), null, "null parse passes through");
  const noField = { exercises: [] };
  eq(stampAttemptUnits(noField, { displayUnit: "kg" }), noField, "missing pr_attempts passes through");
  eq(stampAttemptUnits({ pr_attempts: [{ exercise: "Snatch", weight: 102, reps: 1, achieved: true }] }).pr_attempts[0].unit, "lbs", "no options at all -> app default, no throw");

  // The unit written on the number, read from the athlete's own words.
  const a102 = { exercise: "Snatch", weight: 102, reps: 1, achieved: true };
  const st = (message, displayUnit, exercises = []) => stampAttemptUnits({ exercises, pr_attempts: [a102] }, { displayUnit, message, normalizeName: normalizeExName }).pr_attempts[0].unit;
  eq(st("Hit a 102kg snatch today, new PR", "lbs"), "kg", "LBS athlete who wrote 102kg, parser dropped the unit -> kg from the message");
  eq(st("Hit a 102 lb snatch today", "kg"), "lbs", "KG athlete who wrote 102 lb -> lbs from the message");
  eq(st("Hit a 102 snatch today", "kg"), "kg", "nothing written -> kg athlete's unit");
  // Twin set in the same message: kg is evidence, lbs is only the parser default.
  eq(st("Snatch singles 80/90/102, whole session in kilos", "lbs", [{ name: "Snatch", weight: 102, unit: "kg" }]), "kg", "kg twin set beats an lbs display unit");
  eq(st("Snatch singles 80/90/102", "kg", [{ name: "Snatch", weight: 102, unit: "lbs" }]), "kg", "an lbs twin (parser default) does NOT outvote a kg athlete's setting");
  eq(st("Snatch singles 80/90/102", "kg", [{ name: "Back Squat", weight: 140, unit: "lbs" }]), "kg", "another lift's set is not a twin");

  // The real parser GUESSES a unit when none is written (live pass 09-28). A unit
  // the athlete's message never names is a guess, and the athlete's setting wins.
  const guess = (unit, message, displayUnit) => stampAttemptUnits(
    { exercises: [], pr_attempts: [{ exercise: "Back Squat", weight: 140, unit, reps: 1, achieved: true }] },
    { displayUnit, message, normalizeName: normalizeExName }).pr_attempts[0].unit;
  eq(guess("lbs", "Hit a 140 back squat single today, new PR", "kg"), "kg", "parser guessed lbs, nothing written, KG athlete -> kg (the bug, one layer down)");
  eq(guess("kg", "Hit a 140 back squat single today, new PR", "lbs"), "lbs", "parser guessed kg, nothing written, LBS athlete -> lbs");
  eq(guess("lbs", "New back squat max today, hit 140 for a single", "lbs"), "lbs", "parser said lbs, nothing written, LBS athlete -> lbs (unchanged for 53 of 54 athletes)");
  eq(guess("kg", "Squat singles 100/120/140, all in kilos today", "lbs"), "kg", "parser said kg and the message names kilos -> kg");
  eq(guess("kg", "Squats @ 60kg/100/120/140", "lbs"), "kg", "a kg ladder: the unit sits on another number, parser's kg is backed");
  eq(guess("lbs", "Hit a 140kg back squat", "lbs"), "kg", "the unit written on the number beats the parser's unit");
  eq(guess("lbs", "", "kg"), "lbs", "no message to check against -> the parser's unit stands");
  const same = { exercises: [], pr_attempts: [{ exercise: "Back Squat", weight: 140, unit: "kg", reps: 1, achieved: true }] };
  eq(stampAttemptUnits(same, { displayUnit: "kg", message: "Hit a 140 back squat single" }), same, "nothing to change -> same object");
  const once = stampAttemptUnits({ exercises: [], pr_attempts: [{ exercise: "Back Squat", weight: 140, unit: "lbs", reps: 1, achieved: true }] }, { displayUnit: "kg", message: "140 squat single" });
  eq(stampAttemptUnits(once, { displayUnit: "kg", message: "140 squat single" }), once, "stamping twice with the same inputs changes nothing");
}

console.log("mentionsUnit:");
ok(mentionsUnit("hit 102kg", "kg"), "102kg");
ok(mentionsUnit("all in kilos today", "kg"), "kilos as a word");
ok(mentionsUnit("hit 225 lbs", "lbs"), "225 lbs");
ok(mentionsUnit("225lb bench", "lbs"), "225lb");
ok(!mentionsUnit("felt like a pound cake", "kg"), "lbs word is not kg");
ok(!mentionsUnit("hit 102 snatch", "kg"), "no unit");
ok(!mentionsUnit("hit 102 snatch", "lbs"), "no unit (lbs)");
ok(!mentionsUnit("skg workout", "kg"), "needs a boundary or a digit in front");
ok(!mentionsUnit("bulbs", "lbs"), "'bulbs' is not lbs");
ok(!mentionsUnit(null, "kg"), "null message");
ok(!mentionsUnit("102kg", "stone"), "unknown unit");

// 2b ── the unit written on a number
console.log("writtenUnit:");
eq(writtenUnit("Hit a 102kg snatch", 102), "kg", "102kg");
eq(writtenUnit("Hit a 102 kg snatch", 102), "kg", "102 kg");
eq(writtenUnit("hit 102 kilos", 102), "kg", "102 kilos");
eq(writtenUnit("Snatch 1RM is 250lbs", 250), "lbs", "250lbs");
eq(writtenUnit("bench 225 pounds", 225), "lbs", "225 pounds");
eq(writtenUnit("hit 102.5kg", 102.5), "kg", "decimal weight");
eq(writtenUnit("hit 1102kg", 102), null, "never matches inside a longer number");
eq(writtenUnit("hit 2.102kg", 102), null, "never matches a decimal tail");
eq(writtenUnit("20kg/50/70/118", 118), null, "a unit on ANOTHER number is not this number's unit");
eq(writtenUnit("snatch 102 today", 102), null, "no unit written");
eq(writtenUnit("102 kgb", 102), null, "needs a word boundary");
eq(writtenUnit("", 102), null, "empty message");
eq(writtenUnit(null, 102), null, "null message");
eq(writtenUnit("102kg", null), null, "null weight");

// 2c ── reading attempts back out of saved rows (pre-fix rows carry no unit)
console.log("storedAttemptUnit:");
{
  const row = (exercises, raw_message = "") => ({ raw_message, parsed_data: { exercises } });
  eq(storedAttemptUnit({ exercise: "Snatch", weight: 102, unit: "kg" }, row([{ name: "Snatch", unit: "lbs" }]), "lbs"), "kg", "a stamped unit answers for itself");
  eq(storedAttemptUnit({ exercise: "Snatch", weight: 225 }, row([{ name: "Snatch", unit: "lbs" }]), "kg"), "lbs", "unstamped + lbs twin + kg display TODAY -> lbs (the athlete switched units since)");
  eq(storedAttemptUnit({ exercise: "Snatch", weight: 118 }, row([{ name: "Snatch", unit: "kg" }]), "lbs"), "kg", "unstamped + kg twin -> kg");
  eq(storedAttemptUnit({ exercise: "Pull-Up", weight: 45 }, row([{ name: "Pull-Up", unit: "bodyweight" }]), "kg"), "kg", "a bodyweight twin is no evidence");
  eq(storedAttemptUnit({ exercise: "Snatch", weight: 250 }, row([], "Snatch 1RM is 250lbs"), "kg"), "lbs", "no twin -> the unit written in raw_message");
  eq(storedAttemptUnit({ exercise: "Snatch", weight: 250 }, row([], "Snatch max 250"), "kg"), "kg", "no evidence at all -> display unit");
  eq(storedAttemptUnit({ exercise: "Snatch", weight: 250 }, null, "lbs"), "lbs", "no row -> display unit");
  eq(storedAttemptUnit({ exercise: "Snatch", weight: 118 }, { parsed_data: JSON.stringify({ exercises: [{ name: "Snatch", unit: "kg" }] }) }, "lbs"), "kg", "parsed_data stored as a string");
  eq(storedAttemptUnit({ exercise: "Snatch", weight: 118 }, { parsed_data: "{not json" }, "lbs"), "lbs", "unparseable parsed_data does not throw");
}

// 3 ── what counts as a declared max
console.log("isDeclaredMax:");
ok(isDeclaredMax({ exercise: "Snatch", weight: 102, reps: 1, achieved: true }), "achieved single is a declared max");
ok(!isDeclaredMax({ exercise: "Snatch", weight: 102, reps: 1, achieved: false }), "a miss is not");
ok(!isDeclaredMax({ exercise: "Snatch", weight: 102, reps: 3, achieved: true }), "a triple is not");
ok(!isDeclaredMax({ exercise: "", weight: 102, reps: 1, achieved: true }), "no lift name is not");
ok(!isDeclaredMax({ exercise: "Snatch", weight: 0, reps: 1, achieved: true }), "no weight is not");
ok(!isDeclaredMax(null), "null is not");

// 4 ── the write decision
console.log("declaredMaxWrite:");
{
  const a = { exercise: "Snatch", weight: 102, reps: 1, achieved: true };
  const ins = declaredMaxWrite(a, { existing: null, estLbs: 0, displayUnit: "kg" });
  eq(ins.action, "insert", "kg athlete, nothing standing -> insert");
  eq(ins.unit, "kg", "  ...as kg");
  eq(ins.newLbs, 102 * LBS_PER_KG, "  ...compared at 224.9 lbs, not 102");

  const lb = declaredMaxWrite(a, { existing: null, estLbs: 0, displayUnit: "lbs" });
  eq(lb.unit, "lbs", "lbs athlete, same numbers -> lbs");
  eq(lb.newLbs, 102, "  ...compared at 102 lbs");

  const up = declaredMaxWrite(a, { existing: { id: 1, weight: 95, unit: "kg" }, displayUnit: "kg" });
  eq(up.action, "update", "beats a standing 95 kg row -> update (the old default SKIPPED this)");
  eq(up.oldLbs, 95 * LBS_PER_KG, "  ...old max read in its own unit");

  eq(declaredMaxWrite(a, { existing: { id: 1, weight: 105, unit: "kg" }, displayUnit: "kg" }).action, "skip", "below a standing 105 kg row -> skip");
  eq(declaredMaxWrite(a, { existing: { id: 1, weight: 102, unit: "kg" }, displayUnit: "kg" }).action, "skip", "ties the standing row -> skip");
  eq(declaredMaxWrite(a, { existing: { id: 1, weight: 220, unit: "lbs" }, displayUnit: "kg" }).action, "update", "102 kg beats a standing 220 lb row across units");
  eq(declaredMaxWrite(a, { existing: { id: 1, weight: 230, unit: "lbs" }, displayUnit: "kg" }).action, "skip", "102 kg does not beat 230 lb");

  const est = declaredMaxWrite(a, { existing: null, estLbs: 300, displayUnit: "kg" });
  eq(est.action, "insert", "a declared actual max is recorded even under a higher ESTIMATE");
  eq(est.oldLbs, 300, "  ...and reports the estimate as the prior");

  const written = declaredMaxWrite({ ...a, unit: "kg" }, { existing: null, displayUnit: "lbs" });
  eq(written.unit, "kg", "lbs athlete who wrote kg -> stored as kg");
  const writtenLb = declaredMaxWrite({ ...a, weight: 225, unit: "lbs" }, { existing: null, displayUnit: "kg" });
  eq(writtenLb.unit, "lbs", "kg athlete who wrote lbs -> stored as lbs");
  eq(writtenLb.newLbs, 225, "  ...compared at 225 lbs");

  // Implausible jump (T46), same guard the exercises loop applies — computed off
  // the RESOLVED unit so a kg/lbs mix-up trips it instead of minting a bogus max.
  const implausible = declaredMaxWrite({ exercise: "Snatch", weight: 200, reps: 1, achieved: true, unit: "kg" }, { existing: { id: 1, weight: 100, unit: "kg" }, displayUnit: "kg" });
  eq(implausible.action, "suspect", "200 kg vs a standing 100 kg max is an implausible jump, computed in kg");
  const plausibleJump = declaredMaxWrite({ exercise: "Snatch", weight: 105, reps: 1, achieved: true, unit: "kg" }, { existing: { id: 1, weight: 100, unit: "kg" }, displayUnit: "kg" });
  eq(plausibleJump.action, "update", "a normal +5 kg jump is not suspect");
  const coldStart = declaredMaxWrite({ exercise: "Snatch", weight: 500, reps: 1, achieved: true, unit: "kg" }, { existing: null, estLbs: 0, displayUnit: "kg" });
  eq(coldStart.action, "insert", "cold start (no prior max) passes through even at an absurd number, same as every other implausibleJump call site");
}

// 5 ── replay: the real 09-28 turn
console.log("replay kg-declared-max-0928:");
{
  const rp = JSON.parse(readFileSync(join(here, "../tests/replay/kg-declared-max-0928.json"), "utf8"));
  const du = rp.starting_state.display_unit;
  for (const [label, parsed] of [["parser returned no unit (pre-fix shape)", rp.parsed_before_fix], ["parser returned unit:kg", rp.parsed_after_fix]]) {
    const stamped = stampAttemptUnits(parsed, { displayUnit: du, message: rp.input_message, normalizeName: normalizeExName });
    const declared = stamped.pr_attempts.filter(isDeclaredMax);
    eq(declared.length, 1, `${label}: one declared max`);
    eq(stamped.pr_attempts[0].unit, "kg", `${label}: saved row carries unit kg`);
    for (const v of rp.variants) {
      const w = declaredMaxWrite(declared[0], { existing: v.existing, estLbs: rp.starting_state.best_estimate_lbs, displayUnit: du });
      eq(w.action, v.expect.action, `${label} / ${v.name}: action`);
      eq(w.unit, v.expect.unit, `${label} / ${v.name}: unit`);
      eq(declared[0].weight, v.expect.weight, `${label} / ${v.name}: raw weight stored`);
      if (v.expect.new_lbs_min) ok(w.newLbs > v.expect.new_lbs_min && w.newLbs < v.expect.new_lbs_max, `${label} / ${v.name}: ~224.9 lbs`);
    }
  }
  // The incident, reproduced: the OLD rule on the same input wrote 46.3 kg.
  const oldUnit = rp.parsed_before_fix.pr_attempts[0].unit === "kg" ? "kg" : "lbs";
  ok(Math.abs(toLbs(102, oldUnit) / LBS_PER_KG - 46.3) < 0.05, "old rule reproduces the 46.3 kg row (proves the fixture is the incident)");
  // Same numbers from an lbs athlete are untouched by the fix.
  eq(stampAttemptUnits(rp.parsed_before_fix, { displayUnit: "lbs" }).pr_attempts[0].unit, "lbs", "lbs athlete, no unit written -> still lbs");
  // An LBS athlete sending the incident message verbatim: kg is written on the number.
  eq(stampAttemptUnits(rp.parsed_before_fix, { displayUnit: "lbs", message: rp.input_message }).pr_attempts[0].unit, "kg", "lbs athlete who wrote 102kg -> kg");

  // Saved rows from before the fix, read under today's display unit.
  for (const c of rp.legacy_rows.rows) {
    c.row.parsed_data.pr_attempts.forEach((p, i) =>
      eq(storedAttemptUnit(p, c.row, rp.legacy_rows.display_unit_today, normalizeExName), c.expect[i], `legacy row (${c.name}): ${p.exercise} ${p.weight}`));
  }
}

// 6 ── source guards: the hard default cannot come back, the schema keeps its unit
console.log("source guards:");
{
  const srcDir = join(here, "../src");
  const files = readdirSync(srcDir).filter((f) => /\.(js|jsx)$/.test(f));
  const hardDefault = /\b(attempt|p|a)\.unit\s*===?\s*"kg"\s*\?\s*"kg"\s*:\s*"\s?l(bs|b)"/;
  for (const f of files) {
    const text = readFileSync(join(srcDir, f), "utf8");
    if (!text.includes("pr_attempts")) continue; // only files that read attempts (prs-table rows always carry a unit)
    const hits = text.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => hardDefault.test(l));
    ok(hits.length === 0, `no hard lbs default on an attempt in src/${f}${hits.length ? ` (line ${hits.map((h) => h[0]).join(", ")})` : ""}`);
  }
  const app = readFileSync(join(srcDir, "App.jsx"), "utf8");
  ok(/"pr_attempts":\[\{[^\]]*"unit":"kg"\|"lbs"\|null/.test(app), "parse schema carries unit on pr_attempts");
  ok(/parsed = stampAttemptUnits\(parsed, \{displayUnit: updatedAthlete\?\.weight_unit, message: msg/.test(app), "finalizeWorkout stamps before saving");
  ok(/declaredMaxWrite\(attempt,/.test(app), "finalizeWorkout decides through declaredMaxWrite");
  ok(/parseWorkout\(msg,[^\n]*\)\s*\.then\(p=>stampAttemptUnits\(p,/.test(app), "send() stamps the parse at the source");
}

console.log(`\n${fail === 0 ? "✓" : "✗"} pr-attempts: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
