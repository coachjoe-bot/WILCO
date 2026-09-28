// ─── T55 UNITS SUITE ──────────────────────────────────────────────────────────
// Locks the single-source conversion contract:
//   1. lbs↔kg round trips are lossless (display always converts from the RAW
//      stored pair, so flipping the toggle back and forth never re-rounds).
//   2. Display rounding: stats to 1 lb / 0.5 kg, working loads to 5 lb / 2.5 kg.
//   3. NO stray conversion constants outside src/units.js — the four hand-copies
//      (two different constants) are what caused the TestFlight kg leaks.
// Run: node scripts/test-units.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LBS_PER_KG, toLbs, toKg, toDisplay, roundStat, roundLoad, fmtWeightIn,
  setDisplayUnit, getDisplayUnit, unitLabel, displayStat,
} from "../src/units.js";
import { displayWeights, draftInUnit } from "../src/boot.js";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.error(`✗ ${name}`); } };
const eq = (a, b, name) => ok(Object.is(a, b) || a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// 1 ── raw conversions, one constant
eq(toLbs(100, "kg"), 100 * LBS_PER_KG, "toLbs kg→lbs uses THE constant");
eq(toLbs(225, "lbs"), 225, "toLbs identity on lbs");
eq(toKg(100, "kg"), 100, "toKg identity on kg");
ok(Math.abs(toKg(220.462, "lbs") - 100) < 1e-9, "toKg lbs→kg");

// 2 ── round-trip losslessness: display from the RAW pair is stable under any
// number of toggle flips (identity when units match; derived values converge
// after one conversion and never drift again).
for (const [w, unit] of [[110, "kg"], [102.5, "kg"], [225, "lbs"], [137.5, "lbs"], [61, "kg"]]) {
  setDisplayUnit(unit); // display in the unit it was typed in → EXACT echo
  eq(toDisplay(w, unit), w, `raw pair echoes exactly in its own unit (${w}${unit})`);
  // flip 6 times: the shown number in each unit must be identical every visit
  const seen = { lbs: null, kg: null };
  for (let i = 0; i < 6; i++) {
    const du = i % 2 ? "kg" : "lbs";
    setDisplayUnit(du);
    const shown = roundStat(toDisplay(w, unit), du);
    if (seen[du] == null) seen[du] = shown;
    eq(shown, seen[du], `no cumulative rounding on flip ${i} (${w}${unit} shown as ${du})`);
  }
}

// 3 ── rounding rules
setDisplayUnit("kg");
eq(roundStat(242.51), 242.5, "stat rounds to 0.5 kg");
eq(roundLoad(101.2), 100, "load rounds to 2.5 kg");
setDisplayUnit("lbs");
eq(roundStat(242.51), 243, "stat rounds to 1 lb");
eq(roundLoad(242.51), 245, "load rounds to 5 lb");
eq(fmtWeightIn(110, "kg"), "243lbs", "kg row formatted for a lbs athlete (stat)");
setDisplayUnit("kg");
eq(fmtWeightIn(110, "kg"), "110kg", "kg row echoes exactly for a kg athlete");
eq(unitLabel(), "kg", "unitLabel follows the registry");
eq(displayStat(220.462), 100, "lbs-derived value shown in kg");

// 4 ── displayWeights honors the athlete's unit
setDisplayUnit("lbs");
eq(displayWeights("Front Squat 3x5 @ 225"), "Front Squat 3x5 @ 225 lbs", "lbs mode unchanged");
eq(displayWeights("Bench 3x5 @ 225", "kg"), "Bench 3x5 @ 102.5 kg", "kg mode converts bare loads to 2.5 kg steps");
eq(displayWeights("Bench 3x5 @ 185 (75%)", "kg"), "Bench 3x5 @ 75% (85 kg)", "kg mode converts %-sourced loads");
eq(displayWeights("Squat 5x3 @ 100kg", "kg"), "Squat 5x3 @ 100kg", "already-kg lines pass through");
eq(displayWeights("Row 3x8 @ 135 lbs", "kg"), "Row 3x8 @ 60 kg", "explicit-lbs lines convert in kg mode");

// 4c ── T64 Fix 6: the "lb" (singular)/multi-value/unit-spelling regression suite.
// BUG 6 (diagnosis C): the old regex's "already tagged" lookahead only knew
// "lbs" (plural), so "@ 45lb" converted the number AND left "lb" stitched onto
// the output — "@ 20 kglb". Every fuzz case from the diagnosis report plus the
// plan's gap hunters, locked in permanently.
eq(displayWeights("Incline DB Bench 3x8 @ 45lb", "kg"), "Incline DB Bench 3x8 @ 20 kg", "T64/BUG6 the exact live repro: singular no-space lb");
eq(displayWeights("Incline DB Bench 3x8 @ 45 lb", "kg"), "Incline DB Bench 3x8 @ 20 kg", "T64/BUG6 singular spaced lb");
eq(displayWeights("Incline DB Bench 3x8 @ 45 lb/hand", "kg"), "Incline DB Bench 3x8 @ 20 kg/hand", "T64/BUG6 per-hand qualifier kept, not duplicated");
eq(displayWeights("Incline DB Bench 3x8 @ 45lb DBs", "kg"), "Incline DB Bench 3x8 @ 20 kg DBs", "T64/BUG6 trailing free text kept, one space");
eq(displayWeights("Incline DB Bench 3x8 @ 45#", "kg"), "Incline DB Bench 3x8 @ 20 kg", "T64/BUG6 gym-slang # for lbs");
eq(displayWeights("Incline DB Bench 3x8 @ 45 pounds", "kg"), "Incline DB Bench 3x8 @ 20 kg", "T64/BUG6 spelled-out pounds");
eq(displayWeights("@ 100/110/120lb", "kg"), "@ 45/50/55 kg", "T64/BUG6 multi-value slash chain, one unit at the end");
eq(displayWeights("@ 40-45lb", "kg"), "@ 17.5-20 kg", "T64/BUG6 dash-range chain");
eq(displayWeights("Squat 5x3 @ 60/80/90/100/100kg", "kg"), "Squat 5x3 @ 60/80/90/100/100kg", "T64/BUG6 already-kg multi-value chain passes through untouched");
// T64/BUG6b (S3b): "@ BW+25lb" WAS wrongly left unchanged (the "@N" pattern
// didn't allow a "BW+" prefix before the number) — that's the "Dips 3x8 @
// BW+25lb -> unchanged" bug from the S3b fix-wave prompt. Now converts; see
// section 4d below for the full BW+/BW- suite.
eq(displayWeights("@ BW+25lb", "kg"), "@ BW+12.5 kg", "T64/BUG6b bodyweight-plus converts the number, keeps the BW+ prefix");
eq(displayWeights("135 x 5", "kg"), "135 x 5", "T64/BUG6 sets x reps with no @ is never touched");
eq(displayWeights("@ 20kg", "lbs"), "@ 20kg", "T64/BUG6 an explicit-kg load for an lbs athlete stays kg (no reverse conversion)");
eq(displayWeights("Bench 3x8 @ 70%", "kg"), "Bench 3x8 @ 70%", "T64/BUG6 a bare percentage is never a load");
eq(displayWeights("@ 20 kglb", "kg"), "@ 20 kg", "T64/BUG6 HEALS the corrupted artifact — number stays (already converted), stray unit dropped");
eq(displayWeights("@ 20 kglbs", "kg"), "@ 20 kg", "T64/BUG6 heals the pluralized corrupted artifact too");
eq(draftInUnit(draftInUnit("Incline DB Bench 3x8 @ 45lb", "kg"), "kg"), "Incline DB Bench 3x8 @ 20 kg", "T64/BUG6 double application of the live-repro line is a no-op, never a compounding re-convert");
eq(draftInUnit("@ 20 kglb", "kg"), "@ 20 kg", "T64/BUG6 draftInUnit heals the corrupted artifact the same way");
eq(draftInUnit(draftInUnit("@ 20 kglb", "kg"), "kg"), "@ 20 kg", "T64/BUG6 double-heal is stable");

// 4d ── T64 Fix 6b: non-weight numbers after "@" are never loads; explicitly
// lbs-tagged numbers convert anywhere (@ or not); BW+/BW- keeps its prefix.
// `ld(lb)` mirrors the app's own working-load rounding (2.5 kg steps) exactly
// so expected numbers are computed, never hand-rounded.
const ld = (lb) => Math.round((lb / LBS_PER_KG) / 2.5) * 2.5;

// -- a clock time / pace after "@" is never a load (both athlete units) --
eq(draftInUnit("Run 400m x 6 @ 1:30", "kg"), "Run 400m x 6 @ 1:30", "T64/BUG6b clock time untouched (kg athlete)");
eq(draftInUnit(draftInUnit("Run 400m x 6 @ 1:30", "kg"), "kg"), "Run 400m x 6 @ 1:30", "T64/BUG6b clock time idempotent");
eq(displayWeights("Run 400m x 6 @ 1:30", "lbs"), "Run 400m x 6 @ 1:30", "T64/BUG6b clock time untouched (lbs athlete) — the live repro");
eq(displayWeights(displayWeights("Run 400m x 6 @ 1:30", "lbs"), "lbs"), "Run 400m x 6 @ 1:30", "T64/BUG6b clock time idempotent (lbs athlete)");
eq(draftInUnit("Run 3 mi @ 8:30 pace", "kg"), "Run 3 mi @ 8:30 pace", "T64/BUG6b pace untouched");
eq(draftInUnit(draftInUnit("Run 3 mi @ 8:30 pace", "kg"), "kg"), "Run 3 mi @ 8:30 pace", "T64/BUG6b pace idempotent");

// -- a duration/count/distance word glued to the number is never a load --
eq(draftInUnit("Plank 3x @ 60s", "kg"), "Plank 3x @ 60s", "T64/BUG6b seconds untouched, not '60 kgs'");
eq(draftInUnit(draftInUnit("Plank 3x @ 60s", "kg"), "kg"), "Plank 3x @ 60s", "T64/BUG6b seconds idempotent");
eq(draftInUnit("Rest 90 sec between sets", "kg"), "Rest 90 sec between sets", "T64/BUG6b 'sec' (no @) untouched");
eq(draftInUnit("Plank 3x @ 45 seconds", "kg"), "Plank 3x @ 45 seconds", "T64/BUG6b spelled-out seconds untouched");
eq(draftInUnit("Row 3x @ 2 min", "kg"), "Row 3x @ 2 min", "T64/BUG6b minutes untouched");
eq(draftInUnit("Box jump 3x5 @ 24in", "kg"), "Box jump 3x5 @ 24in", "T64/BUG6b inches untouched, not '10 kgin'");
eq(draftInUnit(draftInUnit("Box jump 3x5 @ 24in", "kg"), "kg"), "Box jump 3x5 @ 24in", "T64/BUG6b inches idempotent (not '5 kg kgin')");
eq(draftInUnit("Sled push @ 20 yds", "kg"), "Sled push @ 20 yds", "T64/BUG6b yards untouched");
eq(draftInUnit("Row @ 500m", "kg"), "Row @ 500m", "T64/BUG6b meters untouched");
eq(draftInUnit("Bike @ 12mph", "kg"), "Bike @ 12mph", "T64/BUG6b mph untouched");
eq(draftInUnit("Finisher @ 20 cal", "kg"), "Finisher @ 20 cal", "T64/BUG6b calories untouched");
eq(draftInUnit("Assault bike @ 15 rounds", "kg"), "Assault bike @ 15 rounds", "T64/BUG6b rounds untouched");
eq(draftInUnit("Sprint @ 10 reps", "kg"), "Sprint @ 10 reps", "T64/BUG6b reps untouched");

// -- BW+/BW- prefix: the number converts, the prefix survives, one unit tag --
eq(draftInUnit("Dips 3x8 @ BW+25lb", "kg"), `Dips 3x8 @ BW+${ld(25)} kg`, "T64/BUG6b BW+lb converts the number, keeps BW+");
eq(draftInUnit(draftInUnit("Dips 3x8 @ BW+25lb", "kg"), "kg"), `Dips 3x8 @ BW+${ld(25)} kg`, "T64/BUG6b BW+ idempotent");
eq(draftInUnit("Dips 3x8 @ BW + 25 lb", "kg"), `Dips 3x8 @ BW+${ld(25)} kg`, "T64/BUG6b spaced 'BW + 25 lb' normalizes the same way");
eq(draftInUnit("Pull-ups 3x8 @ BW-10lb", "kg"), `Pull-ups 3x8 @ BW-${ld(10)} kg`, "T64/BUG6b BW-lb keeps the minus sign");
eq(displayWeights("Dips 3x8 @ BW+25lb", "lbs"), "Dips 3x8 @ BW+25lb", "T64/BUG6b BW+lb untouched for an lbs athlete (already the right unit)");

// -- explicitly lbs-tagged numbers convert wherever they sit, "@" or not --
eq(draftInUnit("DB curls 2x10 at 40lb", "kg"), `DB curls 2x10 at ${ld(40)} kg`, "T64/BUG6b 'at 40lb' (no @) converts");
eq(draftInUnit(draftInUnit("DB curls 2x10 at 40lb", "kg"), "kg"), `DB curls 2x10 at ${ld(40)} kg`, "T64/BUG6b 'at 40lb' idempotent");
eq(draftInUnit("Carry 2x45lb", "kg"), `Carry 2x${ld(45)} kg`, "T64/BUG6b '2x45lb' converts only the 45, never the set count");
eq(draftInUnit(draftInUnit("Carry 2x45lb", "kg"), "kg"), `Carry 2x${ld(45)} kg`, "T64/BUG6b '2x45lb' idempotent");
eq(draftInUnit("Farmer carry 40lb DBs", "kg"), `Farmer carry ${ld(40)} kg DBs`, "T64/BUG6b bare tag + trailing free text (no @)");
eq(displayWeights("DB curls 2x10 at 40lb", "kg"), `DB curls 2x10 at ${ld(40)} kg`, "T64/BUG6b same bare-tag pass runs under displayWeights too");
eq(displayWeights("DB curls 2x10 at 40lb", "lbs"), "DB curls 2x10 at 40lb", "T64/BUG6b lbs athlete: bare tag untouched (already the athlete's unit)");

// -- must-not-change controls (T64-S3b) --
eq(draftInUnit("3x8 @ 70%", "kg"), "3x8 @ 70%", "T64/BUG6b control: bare percentage");
eq(draftInUnit("5x5 @ RPE 8", "kg"), "5x5 @ RPE 8", "T64/BUG6b control: RPE with no number before it");
eq(draftInUnit("4x3 @ 97.5kg (75%)", "kg"), "4x3 @ 97.5kg (75%)", "T64/BUG6b control: already-kg with a %-source trailer");
eq(draftInUnit("Pull-ups 3x8", "kg"), "Pull-ups 3x8", "T64/BUG6b control: rep-only, no @");
eq(draftInUnit("Week 3 Day 2", "kg"), "Week 3 Day 2", "T64/BUG6b control: week/day numbers");
eq(draftInUnit("Sep 9, 2026", "kg"), "Sep 9, 2026", "T64/BUG6b control: a date");
eq(draftInUnit("Tempo 3-1-1 @ 95lb", "kg"), `Tempo 3-1-1 @ ${ld(95)} kg`, "T64/BUG6b control: tempo prefix untouched, the real @-load after it converts");
eq(draftInUnit("5x3 @ 60/80/90/100/100kg", "kg"), "5x3 @ 60/80/90/100/100kg", "T64/BUG6b control: already-kg multi-value chain");
eq(draftInUnit("@ 20 kglb", "kg"), "@ 20 kg", "T64/BUG6b control: heals the corrupted artifact (regression guard)");
eq(draftInUnit("@ 20 kglb (75%)", "kg"), "@ 20 kg (75%)", "T64/BUG6b control: heals the corrupted artifact with a %-source trailer");

// -- property test: 300 lines built from random combinations of the fragments
// above must always be idempotent, and never contain a two-unit collision or
// a unit word glued directly to trailing letters.
const FRAGMENTS = [
  "Run 400m x 6 @ 1:30", "Run 3 mi @ 8:30 pace", "Plank 3x @ 60s", "Rest 90 sec between sets",
  "Row 3x @ 2 min", "Box jump 3x5 @ 24in", "Sled push @ 20 yds", "Row @ 500m", "Bike @ 12mph",
  "Finisher @ 20 cal", "Assault bike @ 15 rounds", "Sprint @ 10 reps", "Dips 3x8 @ BW+25lb",
  "Pull-ups 3x8 @ BW-10lb", "DB curls 2x10 at 40lb", "Carry 2x45lb", "Farmer carry 40lb DBs",
  "3x8 @ 70%", "5x5 @ RPE 8", "4x3 @ 97.5kg (75%)", "Pull-ups 3x8", "Week 3 Day 2", "Sep 9, 2026",
  "Tempo 3-1-1 @ 95lb", "5x3 @ 60/80/90/100/100kg", "@ 20 kglb", "Incline DB Bench 3x8 @ 45lb",
  "Bench 3x5 @ 185 (75%)", "Squat 5x3 @ 100kg", "Front Squat 3x5 @ 225",
];
// Deterministic PRNG (mulberry32) — reproducible across runs, no dependency.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(6402026);
let propFail = 0;
const BAD_COLLISION = /kg\s*(lb|kg|s\b|in\b|:)/i;
const BAD_GLUE = /\d\s*kg[a-z]/i;
for (let i = 0; i < 300; i++) {
  const n = 1 + Math.floor(rand() * 3);
  const lines = [];
  for (let j = 0; j < n; j++) lines.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]);
  const line = lines.join("\n");
  const once = draftInUnit(line, "kg");
  const twice = draftInUnit(once, "kg");
  if (once !== twice) { propFail++; console.error(`✗ property: not idempotent\n  in:    ${JSON.stringify(line)}\n  once:  ${JSON.stringify(once)}\n  twice: ${JSON.stringify(twice)}`); continue; }
  if (BAD_COLLISION.test(once)) { propFail++; console.error(`✗ property: two-unit collision in ${JSON.stringify(once)}`); continue; }
  if (BAD_GLUE.test(once)) { propFail++; console.error(`✗ property: unit glued to trailing letters in ${JSON.stringify(once)}`); continue; }
}
ok(propFail === 0, `property test: 300 generated lines, idempotent + no unit collisions (${propFail} failed)`);

// 4b ── draftInUnit: the SHEET/CARD converter — number-FIRST shape preserved
// (the text stays the editable, loggable draft), explicit kg suffix, idempotent.
eq(draftInUnit("Bench 3x5 @ 185 (75%)", "kg"), "Bench 3x5 @ 85 kg (75%)", "kg draft keeps number-first, converts, tags kg");
eq(draftInUnit("Bench 3x5 @ 225", "kg"), "Bench 3x5 @ 102.5 kg", "bare load converts to 2.5 kg steps");
eq(draftInUnit("Row 3x8 @ 135 lbs", "kg"), "Row 3x8 @ 60 kg", "explicit-lbs converts");
eq(draftInUnit("Bench 5x5 @ 185 (RPE 8)", "kg"), "Bench 5x5 @ 85 kg (RPE 8)", "RPE-sourced converts, tag kept");
eq(draftInUnit("Squat 5x3 @ 100 kg", "kg"), "Squat 5x3 @ 100 kg", "already-kg passes through (idempotent)");
eq(draftInUnit(draftInUnit("Bench 3x5 @ 185 (75%)", "kg"), "kg"), "Bench 3x5 @ 85 kg (75%)", "double application is a no-op");
eq(draftInUnit("Weighted Dips 3x8 @ ___", "kg"), "Weighted Dips 3x8 @ ___", "blanks untouched");
eq(draftInUnit("Push-ups 3x20\nPlank 3x60s\nWeighted Pull-ups 3x8 +25", "kg"), "Push-ups 3x20\nPlank 3x60s\nWeighted Pull-ups 3x8 +25", "no-@ lines untouched");
eq(draftInUnit("Bench 3x5 @ 185 (75%)", "lbs"), "Bench 3x5 @ 185 (75%)", "lbs mode is identity");
eq(draftInUnit("Day 2 – Pull\n\nDeadlift 3x5 @ 315 (80%)\nBarbell Row 3x10 @ 135 (last time)", "kg"),
   "Day 2 – Pull\n\nDeadlift 3x5 @ 142.5 kg (80%)\nBarbell Row 3x10 @ 60 kg (last time)", "multi-line draft converts per line");

// 5 ── stray-constant gate: no 2.2… conversion literal outside units.js
const roots = ["src", "api"];
const offenders = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) { if (!/node_modules|assets/.test(p)) walk(p); continue; }
    if (!/\.(js|jsx|mjs)$/.test(f)) continue;
    if (p.endsWith("src/units.js") || p.endsWith("scripts/test-units.mjs")) continue;
    const txt = readFileSync(p, "utf8");
    for (const [i, line] of txt.split("\n").entries()) {
      if (/2\.20?4?6?2?\d*\s*[*/]|[*/]\s*2\.20?4?6?2?\d*|0\.4535/.test(line) && !/LBS_PER_KG/.test(line)) {
        offenders.push(`${p}:${i + 1}: ${line.trim().slice(0, 90)}`);
      }
    }
  }
};
roots.forEach(walk);
ok(offenders.length === 0, `no stray conversion constants outside units.js\n${offenders.join("\n")}`);

console.log(`\n${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
