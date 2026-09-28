// T64 S1 replay corpus — Will's real failing chat turns, replayed against the
// pure modules that now own the decision, so a regression here means a real
// incident would recur. Run with: node scripts/test-replay-s1.mjs
//
// Each tests/replay/*.json fixture stores the athlete's real input, the real
// starting state, and the invariants the fix must hold. This file is the S1
// runner for its three fixtures (Fix 7, Fix 1, Fix 4); other sessions run their
// own bugs' fixtures with their own runners.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { currentPosition } from "../src/programPosition.js";

const here = dirname(fileURLToPath(import.meta.url));
const replayDir = join(here, "..", "tests", "replay");
const load = (name) => JSON.parse(readFileSync(join(replayDir, name), "utf8"));

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}`); } };

// ─── Fix 7 — stale position cache + day/label mixup (2026-09-09 incident) ────
console.log("Fix 7 replay — joe-stale-position-0909:");
{
  const c = load("joe-stale-position-0909.json");

  const posOld = currentPosition({ programText: c.programText, startedOn: c.oldBlockAppliedAt, sessions: [], now: c.athleteMessageAt });
  check("old block's start still reproduces the ORIGINAL bug (week 4)", posOld.week === c.expect.withOldBlockStart.week);
  check("old block's label", posOld.label.includes(c.expect.withOldBlockStart.label_contains));

  const posNew = currentPosition({ programText: c.programText, startedOn: c.newBlockAppliedAt, sessions: [], now: c.athleteMessageAt });
  check("FIX: the new block's own start resolves week 1, not week 4", posNew.week === c.expect.withNewBlockStart.week);
  check("new block's label", posNew.label.includes(c.expect.withNewBlockStart.label_contains));

  const posOv = currentPosition({ programText: c.programText, startedOn: c.newBlockAppliedAt, override: c.athleteOverride, sessions: [], now: c.athleteMessageAt });
  const exp = c.expect.withOverride;
  check("athlete's stated day wins: week", posOv.week === exp.week);
  check("athlete's stated day wins: day", posOv.day === exp.day);
  check("label is Tuesday, not Monday", posOv.label.includes(exp.label_contains));
  check("not read as a rest day", posOv.isRestDay === exp.isRestDay);
  check("sessionText resolved at all", !!posOv.sessionText);
  for (const s of exp.sessionText_contains) {
    check(`FIX: session text contains "${s}" (the real Tuesday session)`, (posOv.sessionText || "").includes(s));
  }
  for (const s of exp.sessionText_excludes) {
    check(`FIX: session text never quotes Monday's "${s}" line`, !new RegExp(`\\b${s}\\b`, "i").test(posOv.sessionText || ""));
  }
}

console.log(`\n${fail === 0 ? "✓" : "✗"} replay (S1): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
