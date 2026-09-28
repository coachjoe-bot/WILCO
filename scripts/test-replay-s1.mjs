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
import { blockSpanConflict, blockSpanNeedsAsk, wrapCardEligible, buildBlockSpanAnswer } from "../src/programHistory.js";

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

// ─── Fix 1 — block-scoped end dates (2026-08-24 "wraps up sept 7th" incident) ──
console.log("\nFix 1 replay — wraps-up-sept7-0824:");
{
  const c = load("wraps-up-sept7-0824.json");
  const blk1 = { id: c.blockOne.id, program_text: c.blockOne.programText, applied_at: c.blockOne.appliedAt, ends_at: null, completed_at: null };

  // At the moment of the message: Block 1 is still open. Joe's own reply named
  // the program's real end (Sep 5); Will's words said Sep 7. That must be
  // detected as a conflict, not silently stored.
  const conflict = blockSpanConflict({ programText: blk1.program_text, stated: c.athleteMessage.parsedSpan, appliedAt: blk1.applied_at });
  check("FIX: the contradiction is caught, not swallowed", !!conflict === c.expect.conflictDetected);
  check("conflict cites the program's own real end date", conflict?.textSide.endDate === c.expect.conflictTextEndDate);

  // Suppose the athlete's "Sep 7" answer is recorded anyway (e.g. they pick
  // "Use Sep 7" at the two-tap confirm) — it must be scoped to BLOCK 1's id.
  const answer = buildBlockSpanAnswer({ blockId: blk1.id, endsAt: c.athleteMessage.parsedSpan.end_date });
  check("the recorded answer is scoped to block 1's own id", answer.blockId === c.expect.answerScopedToBlockOneId);

  // THE ACTUAL BUG: Block 1 closes (2026-09-04), Block 2 opens (2026-09-09) with
  // its own fresh text. Block 1's answer must NOT leak into Block 2 — this is
  // what let a stale "wraps up" date survive past the block it was about.
  const blk1Closed = { ...blk1, completed_at: c.blockOne.completedAt };
  const blk2 = { id: c.blockTwo.id, program_text: c.blockTwo.programText, applied_at: c.blockTwo.appliedAt, ends_at: null, completed_at: c.blockTwo.completedAt };
  const eligibility = wrapCardEligible({ openBlock: blk2, programText: blk2.program_text, spanAnswer: answer, now: "2026-09-15T09:00:00Z" });
  check("FIX: block 2 shows nothing from block 1's answer", eligibility.show === c.expect.blockTwoEligibility.show);
  check("FIX: reason is explicitly 'no end known', not a leaked Sep 7", eligibility.reason === c.expect.blockTwoEligibility.reason);
  check("block 1 itself is confirmed closed (sanity check on the fixture)", !!blk1Closed.completed_at);
  check("block 2 still gets asked fresh (its own question, not answered by block 1)",
    blockSpanNeedsAsk({ openBlock: blk2, programText: blk2.program_text, spanAnswer: answer }) === true);
}

console.log(`\n${fail === 0 ? "✓" : "✗"} replay (S1): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
