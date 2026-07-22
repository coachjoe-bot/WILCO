// programDiff regression suite — run with: node scripts/test-program-diff.mjs
// Covers lineDiff/diffStats/findPlacement/mergeGuard against a realistic
// multi-day program fixture. Deterministic, no network, no randomness.

import { lineDiff, diffStats, findPlacement, mergeGuard } from "../src/programDiff.js";

let fail = 0;
const bad = (msg) => { fail++; console.error("  ✗ " + msg); };
const ok = (cond, msg) => { if (!cond) bad(msg); };

const PROGRAM = `Week 1
Day 1 - Squat Day
Back Squat 5x5 @225
Leg Press 3x10
Leg Curl 3x12

Day 2 - Bench Day
Bench Press 5x5 @185
Incline DB Press 3x10
Tricep Pushdown 3x15

Day 3 - Deadlift Day
Deadlift 3x5 @275
Barbell Row 4x8
Face Pull 3x15`;

// ── lineDiff: single-line swap ────────────────────────────────────────────────
console.log("lineDiff — single-line swap:");
{
  const swapped = PROGRAM.replace("Back Squat 5x5 @225", "Back Squat 5x5 @235");
  const diff = lineDiff(PROGRAM, swapped);
  const dels = diff.filter((d) => d.type === "del");
  const adds = diff.filter((d) => d.type === "add");
  ok(dels.length === 1 && dels[0].text === "Back Squat 5x5 @225", "expected exactly one del of the old squat line");
  ok(adds.length === 1 && adds[0].text === "Back Squat 5x5 @235", "expected exactly one add of the new squat line");
  const sameCount = diff.filter((d) => d.type === "same").length;
  ok(sameCount === PROGRAM.split("\n").length - 1, "every other line should be untouched");
  if (!fail) console.log("  ✓ single-line swap detected cleanly");
}

// ── diffStats ──────────────────────────────────────────────────────────────────
console.log("diffStats:");
{
  const f0 = fail;
  const diff = [
    { type: "same", text: "a" }, { type: "same", text: "b" },
    { type: "del", text: "c" }, { type: "add", text: "d" }, { type: "add", text: "e" },
  ];
  const stats = diffStats(diff);
  ok(stats.added === 2, `expected added=2, got ${stats.added}`);
  ok(stats.removed === 1, `expected removed=1, got ${stats.removed}`);
  ok(stats.unchanged === 2, `expected unchanged=2, got ${stats.unchanged}`);
  // oldLineCount = removed + unchanged = 3; changedRatio = (2+1)/3 = 1
  ok(Math.abs(stats.changedRatio - 1) < 1e-9, `expected changedRatio=1, got ${stats.changedRatio}`);
  if (fail === f0) console.log("  ✓ counts + ratio correct");
}

// ── findPlacement ──────────────────────────────────────────────────────────────
console.log("findPlacement:");
{
  const f0 = fail;
  const p = findPlacement(PROGRAM, "Back Squat");
  ok(!!p, "expected a placement hit for Back Squat");
  if (p) {
    ok(/Day 1/i.test(p.dayLabel || ""), `expected dayLabel to reference Day 1, got "${p.dayLabel}"`);
    ok(p.currentLine === "Back Squat 5x5 @225", `expected currentLine to be the squat line, got "${p.currentLine}"`);
  }
  // × normalization — a program written with the unicode multiplication sign.
  const unicodeProgram = PROGRAM.replace(/x5/g, "×5").replace(/x10/g, "×10").replace(/x12/g, "×12").replace(/x8/g, "×8").replace(/x15/g, "×15");
  const p2 = findPlacement(unicodeProgram, "bench press");
  ok(!!p2 && /Day 2/i.test(p2.dayLabel || ""), "expected case-insensitive × match under Day 2");
  // No match.
  const p3 = findPlacement(PROGRAM, "Overhead Press");
  ok(p3 === null, "expected null when the lift isn't in the program");
  if (fail === f0) console.log("  ✓ placement + day-label + × normalization + null-miss all correct");
}

// ── mergeGuard ─────────────────────────────────────────────────────────────────
console.log("mergeGuard:");
{
  const f0 = fail;
  // blank
  let g = mergeGuard(PROGRAM, "   ");
  ok(!g.ok && /empty/i.test(g.reason || ""), "expected blank rewrite to be rejected");
  // truncated (well over 200 chars original, new text far shorter)
  g = mergeGuard(PROGRAM, "Week 1\nDay 1 - Squat Day\nBack Squat 5x5 @225");
  ok(!g.ok && /short|truncat/i.test(g.reason || ""), "expected a much-shorter rewrite to be rejected as truncated");
  // rewrote everything (every line changed)
  const rewroteEverything = PROGRAM.split("\n").map((l) => (l ? l + " !!" : l)).join("\n");
  g = mergeGuard(PROGRAM, rewroteEverything);
  ok(!g.ok && /most|everything|change/i.test(g.reason || ""), "expected a total rewrite to be rejected");
  // surgical one-line change — passes
  const surgical = PROGRAM.replace("Back Squat 5x5 @225", "Back Squat 5x5 @235");
  g = mergeGuard(PROGRAM, surgical);
  ok(g.ok, `expected a one-line surgical change to pass, got reason: ${g.reason}`);
  ok(g.text === surgical, "expected mergeGuard to return the (unfenced) text unchanged");
  // fence-stripping
  g = mergeGuard(PROGRAM, "```\n" + surgical + "\n```");
  ok(g.ok, `expected fenced surgical change to pass, got reason: ${g.reason}`);
  ok(g.text === surgical, "expected fences to be stripped from the returned text");
  g = mergeGuard(PROGRAM, "```text\n" + surgical + "\n```");
  ok(g.ok, "expected a language-tagged fence to be stripped too");
  if (fail === f0) console.log("  ✓ blank/truncated/rewritten-everything rejected; surgical + fenced accepted");
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nAll program-diff tests passed.");
process.exit(fail ? 1 : 0);
