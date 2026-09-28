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
eq(displayWeights("@ BW+25lb", "kg"), "@ BW+25lb", "T64/BUG6 bodyweight-plus never matches the @N pattern");
eq(displayWeights("135 x 5", "kg"), "135 x 5", "T64/BUG6 sets x reps with no @ is never touched");
eq(displayWeights("@ 20kg", "lbs"), "@ 20kg", "T64/BUG6 an explicit-kg load for an lbs athlete stays kg (no reverse conversion)");
eq(displayWeights("Bench 3x8 @ 70%", "kg"), "Bench 3x8 @ 70%", "T64/BUG6 a bare percentage is never a load");
eq(displayWeights("@ 20 kglb", "kg"), "@ 20 kg", "T64/BUG6 HEALS the corrupted artifact — number stays (already converted), stray unit dropped");
eq(displayWeights("@ 20 kglbs", "kg"), "@ 20 kg", "T64/BUG6 heals the pluralized corrupted artifact too");
eq(draftInUnit(draftInUnit("Incline DB Bench 3x8 @ 45lb", "kg"), "kg"), "Incline DB Bench 3x8 @ 20 kg", "T64/BUG6 double application of the live-repro line is a no-op, never a compounding re-convert");
eq(draftInUnit("@ 20 kglb", "kg"), "@ 20 kg", "T64/BUG6 draftInUnit heals the corrupted artifact the same way");
eq(draftInUnit(draftInUnit("@ 20 kglb", "kg"), "kg"), "@ 20 kg", "T64/BUG6 double-heal is stable");

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
