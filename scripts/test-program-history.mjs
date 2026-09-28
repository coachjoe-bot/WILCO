// programHistory regression suite — run with: node scripts/test-program-history.mjs
// Covers the block-vs-tweak decision in snapshotProgramHistory with mocked data/AI
// deps. Deterministic, no network. Part of the Program Builder Phase B ship gate
// (docs/program-builder-build-handoff.md).

import { snapshotProgramHistory, startNextBlock, closeCurrentBlock, setBlockEnd, blockPromptState, parseTimeline, dateToIso, digestWorkouts, changedRatio, NEW_BLOCK_RATIO, deriveBlockName, refreshOpenBlockRecap, recapShortFallback, buildBlockSpanAnswer, blockSpanConflict, blockSpanNeedsAsk, wrapCardEligible } from "../src/programHistory.js";

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

const REWRITE = `BLOCK 2 — INTENSIFICATION
Mon: Comp Squat 5x3 @ 85%, Pause Squat 3x3
Wed: Comp Bench 5x3 @ 85%, CG Bench 3x5
Fri: Deadlift 4x2 @ 87%, Block Pull 3x3
Sat: Upper accessories + carries`;

// Mock harness: latest = the program_history row sbRead returns; closeBlock's
// extra reads (workouts for the recap digest, athlete_goals) return empty by
// default. calls are recorded per table.
function harness(latestRow, { haikuFails = false, workouts = [] } = {}) {
  const calls = { inserts: [], updates: [], asked: 0 };
  const deps = {
    sbRead: async (table) => {
      if (table === "program_history") return latestRow ? [latestRow] : [];
      if (table === "workouts") return workouts;
      return [];
    },
    sbInsert: async (table, data) => { calls.inserts.push({ table, data }); return [{}]; },
    sbUpdateWhere: async (table, params, data) => { calls.updates.push({ table, params, data }); return [{}]; },
    askClaude: async () => { calls.asked++; if (haikuFails) throw new Error("boom"); return "4-day strength block — squat/bench 5s"; },
  };
  return { calls, deps };
}
const openBlock = (text) => ({ id: "blk-1", program_text: text, completed_at: null, applied_at: "2026-07-01T00:00:00Z" });
// closeBlock now writes completed_at first, then (best-effort) block_recap in a
// second update — assertions pick the writes apart instead of counting them.
const closes = (calls) => calls.updates.filter((u) => u.data && u.data.completed_at);
const recaps = (calls) => calls.updates.filter((u) => u.data && u.data.block_recap);
const shortRecaps = (calls) => calls.updates.filter((u) => u.data && u.data.block_recap_short);
// T64 Fix 7a: closeBlock no longer AWAITS the recap (a chat turn racing the close
// must never wait on a Sonnet call) — it fires generateBlockRecap in the
// background instead. A caller that has already awaited closeBlock/startNextBlock/
// closeCurrentBlock must flush the microtask queue before asserting on the recap
// write landing; the completed_at stamp is on the critical path and needs no flush.
const flush = () => new Promise((r) => setTimeout(r, 10));

// ── changedRatio sanity ──────────────────────────────────────────────────────
console.log("changedRatio:");
ok(changedRatio(PROGRAM, PROGRAM) === 0, "identical text → 0");
ok(changedRatio(PROGRAM, REWRITE) > 0.9, "total rewrite → ~1");
{
  const tweak = PROGRAM.replace("@225", "@235");
  const r = changedRatio(PROGRAM, tweak);
  ok(r > 0 && r < NEW_BLOCK_RATIO, `one-line weight bump stays under the block threshold (got ${r.toFixed(2)})`);
}

// ── first save → new block with summary ──────────────────────────────────────
console.log("first save:");
{
  const { calls, deps } = harness(null);
  await snapshotProgramHistory({ athleteId: "a1", text: PROGRAM, source: "chat_save" }, deps);
  ok(calls.inserts.length === 1, "inserts exactly one row");
  ok(calls.inserts[0]?.data.source === "chat_save", "carries the source");
  ok(calls.inserts[0]?.data.block_summary?.includes("strength block"), "carries the Haiku summary");
  ok(calls.updates.length === 0, "no previous block to close");
}

// T57 s5: a contract program names its block from its own Goal line — the first
// body line can be Joe's prose intro, and half a sentence is not a block name.
console.log("block naming:");
{
  const { calls, deps } = harness(null);
  const CONTRACT = "=== BLOCK INFO ===\nGoal: Bench 245 by Oct 10\nRuns: 2026-08-19 to 2026-09-27\n\nBench trend has been solid, but the ratios tell the real story.\n\nDay 1 - Push\nBench 3x5 @ 185";
  await snapshotProgramHistory({ athleteId: "a1", text: CONTRACT, source: "library" }, deps);
  ok(calls.inserts[0]?.data.block_name === "Bench 245 by Oct 10", "contract block names itself from Goal");
}
{
  const { calls, deps } = harness(null);
  const CONTRACT = "=== BLOCK INFO ===\nGoal: Bench 245 by Oct 10\n\nDay 1 - Push\nBench 3x5 @ 185";
  await snapshotProgramHistory({ athleteId: "a1", text: CONTRACT, source: "library", blockName: "My Named Block" }, deps);
  ok(calls.inserts[0]?.data.block_name === "My Named Block", "a caller-provided name still wins over the Goal");
}

// ── no-op save ───────────────────────────────────────────────────────────────
console.log("no-op save:");
{
  const { calls, deps } = harness(openBlock(PROGRAM));
  await snapshotProgramHistory({ athleteId: "a1", text: PROGRAM, source: "manual_edit" }, deps);
  ok(calls.inserts.length === 0 && calls.updates.length === 0 && calls.asked === 0, "identical text writes nothing");
}

// ── tweak → update the open block in place ───────────────────────────────────
console.log("tweak (PR propagation):");
{
  const tweaked = PROGRAM.replace("@225", "@235").replace("@185", "@190");
  const { calls, deps } = harness(openBlock(PROGRAM));
  await snapshotProgramHistory({ athleteId: "a1", text: tweaked, source: "pr_propagation" }, deps);
  ok(calls.inserts.length === 0, "no new block for a weight bump");
  ok(calls.updates.length === 1 && calls.updates[0].data.program_text === tweaked, "open block text updated in place");
  ok(!("completed_at" in (calls.updates[0]?.data || {})), "open block stays open");
  ok(calls.asked === 0, "no Haiku spend on a tweak");
}

// ── rewrite → close old block, open new ──────────────────────────────────────
console.log("rewrite:");
{
  const { calls, deps } = harness(openBlock(PROGRAM));
  await snapshotProgramHistory({ athleteId: "a1", text: REWRITE, source: "coach_save" }, deps);
  ok(closes(calls).length === 1, "previous block closed");
  ok(calls.inserts.length === 1 && calls.inserts[0].data.program_text === REWRITE.trim(), "new block inserted");
  await flush();
  ok(recaps(calls).length === 1, "closed block got its recap (backgrounded, awaited via flush)");
}

// ── T64 Fix 3b: the short athlete-facing recap rides alongside the full one ──
console.log("short recap (T64 Fix 3b):");
{
  const { calls, deps } = harness(openBlock(PROGRAM));
  await snapshotProgramHistory({ athleteId: "a1", text: REWRITE, source: "coach_save" }, deps);
  await flush(); // recap runs in the background since Fix 7a (S1); the short recap rides the same task (S3)
  ok(shortRecaps(calls).length === 1, "closing a block also writes a short recap, in its OWN update call");
  ok(!("block_recap" in shortRecaps(calls)[0].data) && !("block_recap_short" in recaps(calls)[0].data), "the two writes carry distinct fields — never bundled into one payload (so a missing column on one can never fail the other)");
  ok(calls.asked === 3, "recap + short-recap condense + the new block's own summary line — never re-derived from raw logs");
}
{
  // The short-recap call is its OWN best-effort try/catch (see closeBlock):
  // it must never be able to cost the full recap or the completed_at stamp,
  // which is exactly what "additive column not yet applied to prod" needs —
  // an "unknown column" failure here degrades silently to the render fallback.
  const { calls, deps } = harness(openBlock(PROGRAM));
  const originalAsk = deps.askClaude;
  let n = 0;
  // Identify the short-recap call by its own shape (120 tokens on Haiku), not by call order: the recap runs in the background since Fix 7a, so order is no longer fixed.
  deps.askClaude = async (...args) => { n++; if (args[2] === 120 && /haiku/.test(String(args[4]))) throw new Error("unknown column block_recap_short"); return originalAsk(...args); };
  await snapshotProgramHistory({ athleteId: "a1", text: REWRITE, source: "coach_save" }, deps);
  await flush(); // recap runs in the background since Fix 7a (S1); the short recap rides the same task (S3)
  ok(recaps(calls).length === 1, "the full recap still lands even when the short-recap step throws");
  ok(closes(calls).length === 1, "and the block still closes");
  ok(shortRecaps(calls).length === 0, "no short-recap write when its own call fails");
}

// recapShortFallback: the render's own funnel — stored short, else first two
// sentences of the full recap (every real row on prod today has no short
// version yet), else nothing. Never throws on a bare/partial row.
console.log("recapShortFallback:");
{
  ok(recapShortFallback({ block_recap_short: "You squatted twice, bench once. On track for the goal.", block_recap: "A much longer paragraph that should never be shown when a short version exists." })
    === "You squatted twice, bench once. On track for the goal.", "a stored short recap wins outright");
  ok(recapShortFallback({ block_recap: "First sentence here. Second sentence here. Third sentence that should be cut." })
    === "First sentence here. Second sentence here.", "no short version: falls back to the first two sentences of the full recap");
  ok(recapShortFallback({ block_recap: "Only one sentence here." }) === "Only one sentence here.", "a one-sentence recap isn't truncated further");
  ok(recapShortFallback({}) === "", "no recap at all → empty, never throws");
  ok(recapShortFallback(null) === "", "null block → empty, never throws");
}

// ── closed latest never evolves in place ─────────────────────────────────────
console.log("closed latest:");
{
  const closed = { ...openBlock(PROGRAM), completed_at: "2026-07-20T00:00:00Z" };
  const tweaked = PROGRAM.replace("@225", "@235");
  const { calls, deps } = harness(closed);
  await snapshotProgramHistory({ athleteId: "a1", text: tweaked, source: "manual_edit" }, deps);
  ok(calls.inserts.length === 1, "similar save after a close still opens a NEW block");
  ok(closes(calls).length === 0, "the already-closed block is left alone");
}

// ── same identity → evolve in place, however big the edit ────────────────────
// Will 08-28: a check-in change that rewrote more than half the sheet under an
// unchanged "BLOCK 1 — ROAD TO 315" header closed the running block and opened
// a twin — the same block showed as current AND past. Identity beats the ratio.
console.log("same-identity rewrite:");
{
  const heavyEdit = `Week 1
Day 1 - Squat Day
Front Squat 4x3 @ 120kg
Snatch Pull 4x3 @ 110kg
Split Jerk 5x1 @ 100kg

Day 2 - Bench Day
Bench held 5x5 @ 205
Snatch Balance 3x2 @ 80kg`;
  ok(changedRatio(PROGRAM, heavyEdit) >= NEW_BLOCK_RATIO, "the edit really is past the ratio threshold");
  ok(deriveBlockName(PROGRAM) === deriveBlockName(heavyEdit), "and the block identity is unchanged");
  const { calls, deps } = harness(openBlock(PROGRAM));
  await snapshotProgramHistory({ athleteId: "a1", text: heavyEdit, source: "checkin_change" }, deps);
  ok(calls.inserts.length === 0, "same-named open block never spawns a twin");
  ok(closes(calls).length === 0, "and the running block is not closed");
  ok(calls.updates.length === 1 && calls.updates[0].data.program_text === heavyEdit, "text evolves in place");
}

// ── forceNewBlock overrides similarity ───────────────────────────────────────
console.log("forceNewBlock:");
{
  const nearSame = PROGRAM.replace("@225", "@230");
  const { calls, deps } = harness(openBlock(PROGRAM));
  await snapshotProgramHistory({ athleteId: "a1", text: nearSame, source: "chat_replace", forceNewBlock: true }, deps);
  ok(calls.inserts.length === 1, "explicit replace always opens a new block");
  ok(closes(calls).length === 1, "and closes the old one");
}

// ── cleared program → close only ─────────────────────────────────────────────
console.log("cleared program:");
{
  const { calls, deps } = harness(openBlock(PROGRAM));
  await snapshotProgramHistory({ athleteId: "a1", text: "", source: "manual_edit" }, deps);
  ok(calls.inserts.length === 0, "no row for an empty program");
  ok(closes(calls).length === 1, "open block closed");
}

// ── AI failure never costs the snapshot or the close ─────────────────────────
console.log("summary failure:");
{
  const { calls, deps } = harness(null, { haikuFails: true });
  await snapshotProgramHistory({ athleteId: "a1", text: PROGRAM, source: "chat_save" }, deps);
  ok(calls.inserts.length === 1 && calls.inserts[0].data.block_summary === null, "row lands with a null summary");
}
{
  const { calls, deps } = harness(openBlock(PROGRAM), { haikuFails: true });
  await snapshotProgramHistory({ athleteId: "a1", text: REWRITE, source: "coach_save" }, deps);
  ok(closes(calls).length === 1, "recap failure still stamps completed_at");
  ok(recaps(calls).length === 0, "no recap written on AI failure");
  ok(calls.inserts.length === 1, "new block still lands");
}

// ── startNextBlock: same text, explicit boundary ─────────────────────────────
console.log("startNextBlock:");
{
  const { calls, deps } = harness(openBlock(PROGRAM), { workouts: [
    { created_at: "2026-07-03T18:00:00Z", parsed_data: { exercises: [{ name: "Back Squat", sets: 5, reps: 5, weight: 225 }] } },
  ] });
  const did = await startNextBlock({ athleteId: "a1", programText: PROGRAM }, deps);
  ok(did === true, "transition happens on an open block");
  ok(closes(calls).length === 1, "old block closed");
  await flush();
  ok(recaps(calls).length === 1, "old block recapped from the logs (backgrounded, awaited via flush)");
  ok(calls.inserts.length === 1 && calls.inserts[0].data.source === "next_block", "new row opens with source next_block");
  ok(calls.inserts[0].data.program_text === PROGRAM.trim() || calls.inserts[0].data.program_text === PROGRAM, "same program text carries over");
}
{
  const closed = { ...openBlock(PROGRAM), completed_at: "2026-07-20T00:00:00Z" };
  const { calls, deps } = harness(closed);
  const did = await startNextBlock({ athleteId: "a1", programText: PROGRAM }, deps);
  ok(did === false && calls.inserts.length === 0 && calls.updates.length === 0, "no open block → no-op");
}
{
  const { calls, deps } = harness(openBlock(PROGRAM));
  await startNextBlock({ athleteId: "a1", programText: PROGRAM, source: "goal_change" }, deps);
  ok(calls.inserts[0]?.data.source === "goal_change", "goal-switch boundary carries its own source");
}

// ── block dates: timeline parse + snapshot stamping + end management ─────────
console.log("block dates:");
{
  ok(JSON.stringify(parseTimeline("2026-08-01 to 2026-09-12")) === JSON.stringify({ start: "2026-08-01", end: "2026-09-12" }), "start-to-end parses");
  ok(JSON.stringify(parseTimeline("wraps 2026-09-12")) === JSON.stringify({ start: null, end: "2026-09-12" }), "single date reads as END");
  ok(JSON.stringify(parseTimeline("no dates here")) === JSON.stringify({ start: null, end: null }), "no dates → nulls");
  ok(dateToIso("2026-08-01") === "2026-08-01T12:00:00Z" && dateToIso("garbage") === null, "dateToIso guards its input");
}
{
  const { calls, deps } = harness(null);
  await snapshotProgramHistory({ athleteId: "a1", text: PROGRAM, source: "builder", forceNewBlock: true, startsAt: "2026-08-01T12:00:00Z", endsAt: "2026-09-12T12:00:00Z" }, deps);
  ok(calls.inserts[0]?.data.applied_at === "2026-08-01T12:00:00Z", "timeline start stamps applied_at (the week-1 anchor)");
  ok(calls.inserts[0]?.data.ends_at === "2026-09-12T12:00:00Z", "timeline end stamps ends_at");
}
{
  const { calls, deps } = harness(null);
  await snapshotProgramHistory({ athleteId: "a1", text: PROGRAM, source: "chat_save" }, deps);
  ok(!("ends_at" in (calls.inserts[0]?.data || {})), "no timeline → no ends_at field");
}
{
  const { calls, deps } = harness(openBlock(PROGRAM));
  const did = await setBlockEnd({ athleteId: "a1", endsAt: "2026-08-24T12:00:00Z" }, deps);
  ok(did === true && String(calls.updates[0]?.data.ends_at || "").startsWith("2026-08-24"), "setBlockEnd stamps the open block");
  ok(await setBlockEnd({ athleteId: "a1", endsAt: "not a date" }, deps) === false, "garbage end date refused");
}
{
  const closed = { ...openBlock(PROGRAM), completed_at: "2026-07-20T00:00:00Z" };
  const { deps } = harness(closed);
  ok(await setBlockEnd({ athleteId: "a1", endsAt: "2026-08-24T12:00:00Z" }, deps) === false, "closed block gets no end date");
}
{
  const { calls, deps } = harness(openBlock(PROGRAM));
  const did = await closeCurrentBlock({ athleteId: "a1" }, deps);
  ok(did === true && closes(calls).length === 1, "closeCurrentBlock closes");
  await flush();
  ok(recaps(calls).length === 1, "…and recaps (backgrounded, awaited via flush)");
  ok(calls.inserts.length === 0, "…and opens NOTHING (next save starts the next chapter)");
}
{
  ok(blockPromptState({ endsAt: null }) === null, "no end date → no prompt");
  ok(blockPromptState({ endsAt: "2026-08-24T12:00:00Z", now: "2026-08-01T12:00:00Z" }) === null, "far out → quiet");
  ok(blockPromptState({ endsAt: "2026-08-24T12:00:00Z", now: "2026-08-20T12:00:00Z" }) === "ending", "inside 7 days → ending");
  ok(blockPromptState({ endsAt: "2026-08-24T12:00:00Z", now: "2026-08-25T12:00:00Z" }) === "ended", "past → ended");
}

// ── T64 Fix 7a: the recap is decoupled from the block boundary itself ────────
// The close's completed_at stamp (and the new block's row) are what the very
// next chat turn's position read depends on — the recap is not. Before this fix
// closeBlock AWAITED the whole recap (a Sonnet call plus two reads) before the
// caller's promise resolved, which is exactly the window a fast-following chat
// message could race.
console.log("Fix 7a — recap decoupled from the close:");
{
  let recapSettled = false;
  const { calls, deps } = harness(openBlock(PROGRAM));
  const realAsk = deps.askClaude;
  deps.askClaude = async (sys, user, maxTokens) => {
    if (maxTokens === 600) {
      // The recap call specifically — artificially slow, to prove the close
      // doesn't wait on it.
      await new Promise((r) => setTimeout(r, 30));
      recapSettled = true;
      return "Block recap text.";
    }
    return realAsk(sys, user, maxTokens);
  };
  const start = Date.now();
  await snapshotProgramHistory({ athleteId: "a1", text: REWRITE, source: "coach_save" }, deps);
  const elapsed = Date.now() - start;
  ok(closes(calls).length === 1, "old block closed without waiting for the recap");
  ok(!recapSettled, "the artificially slow recap has NOT resolved yet");
  ok(recaps(calls).length === 0, "…so no recap write has landed yet either");
  ok(elapsed < 25, `snapshot returned well before the 30ms recap delay (took ${elapsed}ms)`);
  await new Promise((r) => setTimeout(r, 40));
  ok(recapSettled && recaps(calls).length === 1, "recap lands afterward, in the background");
}

// ── T64 Fix 7a: onBlockStart primes the caller's cache before slow AI calls ──
console.log("Fix 7a — onBlockStart:");
{
  const primed = [];
  const { calls, deps } = harness(openBlock(PROGRAM));
  deps.onBlockStart = (text, startedOn) => primed.push({ text, startedOn });
  await snapshotProgramHistory({ athleteId: "a1", text: REWRITE, source: "coach_save", startsAt: "2026-08-01T00:00:00Z" }, deps);
  ok(primed.length === 1 && primed[0].text === REWRITE.trim() && primed[0].startedOn === "2026-08-01T00:00:00Z",
    "new block primes with ITS OWN start, not the old block's");
}
{
  // Same-block evolution: the start hasn't moved, but the caller still gets a
  // prime under the new text's identity so a racing chat turn never falls
  // through to a cache miss mid-write.
  const primed = [];
  const { calls, deps } = harness(openBlock(PROGRAM));
  deps.onBlockStart = (text, startedOn) => primed.push({ text, startedOn });
  const tweaked = PROGRAM.replace("@225", "@235");
  await snapshotProgramHistory({ athleteId: "a1", text: tweaked, source: "pr_propagation" }, deps);
  ok(primed.length === 1 && primed[0].text === tweaked && primed[0].startedOn === "2026-07-01T00:00:00Z",
    "evolve-in-place primes with the block's UNCHANGED start");
}
{
  const primed = [];
  const { calls, deps } = harness(openBlock(PROGRAM));
  deps.onBlockStart = (text, startedOn) => primed.push({ text, startedOn });
  await startNextBlock({ athleteId: "a1", programText: PROGRAM }, deps);
  ok(primed.length === 1 && primed[0].text === PROGRAM, "startNextBlock primes too");
}
{
  // A no-op save (identical text on an open block) makes no history write at
  // all — nothing to prime either, since nothing about the block changed.
  const primed = [];
  const { calls, deps } = harness(openBlock(PROGRAM));
  deps.onBlockStart = (text, startedOn) => primed.push({ text, startedOn });
  await snapshotProgramHistory({ athleteId: "a1", text: PROGRAM, source: "manual_edit" }, deps);
  ok(primed.length === 0, "no-op save primes nothing");
}

// ── T64 Fix 1: block dates belong to the block ────────────────────────────────
// Will's real 08-24 incident: he typed "wraps up sept 7th" against a block whose
// own text said Sep 5; the app stored his number on the ATHLETE row with no tie
// to that block, so it silently outlived it. These are the module's own tests;
// tests/replay/wraps-up-sept7-0824.json + scripts/test-replay-s1.mjs replay the
// literal incident end to end.
console.log("Fix 1 — block span answers are scoped to the block:");

const DURATION_TEXT = "BLOCK 1 — ROAD TO 315\nDuration: 3 Weeks (Aug 17 to Sep 5)\n\nDay 1 - Squat\nBack Squat 5x5 @225";
const UNKNOWN_SPAN_TEXT = PROGRAM; // no Duration/Runs/repeating language at all
const blockA = { id: "blk-A", program_text: DURATION_TEXT, applied_at: "2026-08-16T22:54:04.413Z", ends_at: null, completed_at: null };

{
  const a = buildBlockSpanAnswer({ blockId: "blk-A", weeks: 6, repeating: false });
  ok(a.blockId === "blk-A" && a.weeks === 6 && a.repeating === false && !!a.answeredAt, "buildBlockSpanAnswer shapes the record");
  ok(buildBlockSpanAnswer({ blockId: "blk-A", weeks: "not a number" }).weeks === null, "garbage weeks becomes null, not NaN");
}

console.log("Fix 1 — blockSpanConflict:");
{
  const c = blockSpanConflict({ programText: DURATION_TEXT, stated: { weeks: 5, end_date: null, repeating: false } });
  ok(c && c.textSide.weeks === 3, "athlete's stated length disagrees with the text's own 3-week duration → conflict");
}
ok(blockSpanConflict({ programText: DURATION_TEXT, stated: { weeks: 3, end_date: null, repeating: false } }) === null,
  "restating the SAME length as the text is not a conflict");
ok(blockSpanConflict({ programText: UNKNOWN_SPAN_TEXT, stated: { weeks: 6, end_date: null, repeating: false } }) === null,
  "text doesn't declare a span at all → nothing to contradict, no conflict");
ok(blockSpanConflict({ programText: DURATION_TEXT, stated: { weeks: null, end_date: null, repeating: true } })?.textSide.weeks === 3,
  "text says a fixed length, athlete says it repeats → conflict");
{
  const REPEAT_TEXT = "Push/Pull/Legs, repeats every week, no end date.\nDay 1 - Push\nBench 3x5 @185\nDay 2 - Pull\nRow 3x8\nDay 3 - Legs\nSquat 3x5";
  ok(blockSpanConflict({ programText: REPEAT_TEXT, stated: { weeks: 4, end_date: null, repeating: false } }) !== null,
    "text says it repeats, athlete gives it a hard length → conflict");
  ok(blockSpanConflict({ programText: REPEAT_TEXT, stated: { weeks: null, end_date: null, repeating: true } }) === null,
    "text and athlete both say repeating → agreement, no conflict");
}

console.log("Fix 1 — blockSpanNeedsAsk:");
ok(blockSpanNeedsAsk({ openBlock: blockA, programText: DURATION_TEXT, spanAnswer: null }) === false,
  "the text already answers it (3-week duration) → never ask");
ok(blockSpanNeedsAsk({ openBlock: { ...blockA, program_text: UNKNOWN_SPAN_TEXT }, programText: UNKNOWN_SPAN_TEXT, spanAnswer: null }) === true,
  "no ends_at, text silent, no answer → ask");
ok(blockSpanNeedsAsk({ openBlock: { ...blockA, program_text: UNKNOWN_SPAN_TEXT, ends_at: "2026-09-05T12:00:00Z" }, programText: UNKNOWN_SPAN_TEXT, spanAnswer: null }) === false,
  "already resolved (ends_at set) → never ask");
ok(blockSpanNeedsAsk({ openBlock: { ...blockA, program_text: UNKNOWN_SPAN_TEXT }, programText: UNKNOWN_SPAN_TEXT, spanAnswer: buildBlockSpanAnswer({ blockId: "blk-A", repeating: true }) }) === false,
  '"no end date" recorded for THIS block → never asks again for it');
ok(blockSpanNeedsAsk({ openBlock: { ...blockA, id: "blk-B", program_text: UNKNOWN_SPAN_TEXT }, programText: UNKNOWN_SPAN_TEXT, spanAnswer: buildBlockSpanAnswer({ blockId: "blk-A", repeating: true }) }) === true,
  "GAP HUNTER: a NEW block (different id) must still be asked — an old block's answer never carries over");
ok(blockSpanNeedsAsk({ openBlock: { ...blockA, program_text: UNKNOWN_SPAN_TEXT }, programText: "a completely different program now, mid-replace", spanAnswer: null }) === false,
  "program text changed since this row was snapshotted (a save mid-flight) → don't ask about stale text");

console.log("Fix 1 — wrapCardEligible:");
{
  const nearEnd = { ...blockA, program_text: UNKNOWN_SPAN_TEXT, ends_at: "2026-09-05T12:00:00Z" };
  const r = wrapCardEligible({ openBlock: nearEnd, programText: UNKNOWN_SPAN_TEXT, spanAnswer: null, now: "2026-09-01T09:00:00Z" });
  ok(r.show === true && r.kind === "ending" && r.endsAt === "2026-09-05T12:00:00Z", "common path: block has an end date, card shows 'ending'");
}
{
  // Will's real incident, reconstructed: block A's own answer must never leak
  // into block B, even though block B is now the open/current one.
  const answerFromBlockA = buildBlockSpanAnswer({ blockId: "blk-A", endsAt: "2026-09-07T12:00:00Z" });
  const blockB = { id: "blk-B", program_text: "WEEK 1\nDay 1 - Push\nBench 3x5 @185", applied_at: "2026-09-09T21:12:54.705Z", ends_at: null, completed_at: null };
  const r = wrapCardEligible({ openBlock: blockB, programText: blockB.program_text, spanAnswer: answerFromBlockA, now: "2026-09-10T09:00:00Z" });
  ok(r.show === false && r.reason === "no_end_known", "GAP HUNTER: new block inherits nothing from block A's answer");
}
{
  // "No end date" — recorded once, never re-derived from anything else on the block.
  const openNoEnd = { ...blockA, program_text: UNKNOWN_SPAN_TEXT };
  const noEndAnswer = buildBlockSpanAnswer({ blockId: "blk-A", repeating: true });
  const r = wrapCardEligible({ openBlock: openNoEnd, programText: UNKNOWN_SPAN_TEXT, spanAnswer: noEndAnswer, now: "2027-01-01T09:00:00Z" });
  ok(r.show === false && r.reason === "repeating", '"no end date" holds forever, even a year later — never shows the card');
}
{
  // Program replaced while the card would have been on screen: current text no
  // longer matches the block's own saved text (a fire-and-forget snapshot that
  // hasn't caught up, or a genuinely different program now live).
  const stale = { ...blockA, ends_at: "2026-09-05T12:00:00Z" };
  const r = wrapCardEligible({ openBlock: stale, programText: "A totally different program now on the athlete row", spanAnswer: null, now: "2026-09-01T09:00:00Z" });
  ok(r.show === false && r.reason === "program_text_changed", "program replaced mid-flight → shows nothing, never a stale date");
}
{
  // Block closed manually the same day the card would have fired.
  const closedToday = { ...blockA, program_text: UNKNOWN_SPAN_TEXT, ends_at: "2026-09-01T12:00:00Z", completed_at: "2026-09-01T08:00:00Z" };
  const r = wrapCardEligible({ openBlock: closedToday, programText: UNKNOWN_SPAN_TEXT, spanAnswer: null, now: "2026-09-01T09:00:00Z" });
  ok(r.show === false && r.reason === "no_open_block", "manually closed block never shows the card, however close its end date was");
}
{
  // Zero history: brand new block, nothing known yet.
  const fresh = { id: "blk-new", program_text: UNKNOWN_SPAN_TEXT, applied_at: "2026-09-28T09:00:00Z", ends_at: null, completed_at: null };
  const r = wrapCardEligible({ openBlock: fresh, programText: UNKNOWN_SPAN_TEXT, spanAnswer: null, now: "2026-09-28T09:05:00Z" });
  ok(r.show === false && r.reason === "no_end_known", "brand new block with zero history → nothing to show, not a guess");
}
{
  // A weeks-only answer (no explicit end date) still resolves against the
  // BLOCK's own applied_at, not "now" or any other anchor.
  const openWeeks = { ...blockA, program_text: UNKNOWN_SPAN_TEXT, applied_at: "2026-08-01T00:00:00Z" };
  const weeksAnswer = buildBlockSpanAnswer({ blockId: "blk-A", weeks: 5 });
  const r = wrapCardEligible({ openBlock: openWeeks, programText: UNKNOWN_SPAN_TEXT, spanAnswer: weeksAnswer, now: "2026-09-03T09:00:00Z" });
  ok(r.show === true, "resolves a date from the weeks-only answer");
  ok(new Date(r.endsAt).toISOString().slice(0, 10) === "2026-09-05", "5 weeks from the block's OWN applied_at (Aug 1), not from now");
}
{
  // GAP HUNTER: athlete with zero history rows — no program_history row at all
  // for this athlete (a brand-new account, or one that predates the table).
  // Both eligibility functions must degrade to "nothing to show/ask", never throw.
  ok(wrapCardEligible({ openBlock: null, programText: PROGRAM, spanAnswer: null }).show === false,
    "no program_history row at all → card never shows");
  ok(wrapCardEligible({ openBlock: null, programText: PROGRAM, spanAnswer: null }).reason === "no_open_block",
    "reason is explicit, not a silent false");
  ok(blockSpanNeedsAsk({ openBlock: null, programText: PROGRAM, spanAnswer: null }) === false,
    "no open block → never asks (nothing to pin the answer to)");
}

console.log("Fix 1 — blockSpanConflict cross-type (text states WEEKS, athlete states a DATE, or vice versa):");
{
  // This is the shape of Will's REAL program (a numbered-week block with no
  // printed end date — parseBlockSpan reads "Duration: 3 Weeks" as weeks:3, never
  // an endDate) crossed with his real answer shape (a calendar date, "sept 7th").
  // The same-type-only checks above (weeks-vs-weeks, date-vs-date) never compare
  // these two — this is the exact gap that let his real Sep 7 answer through.
  const appliedAt = "2026-08-17T00:00:00Z"; // block's own start
  ok(blockSpanConflict({ programText: DURATION_TEXT, stated: { weeks: null, end_date: "2026-10-01", repeating: false }, appliedAt })?.textSide.weeks === 3,
    "text says 3 weeks (~Sep 7), athlete's stated date is weeks later → conflict, cross-type");
  ok(blockSpanConflict({ programText: DURATION_TEXT, stated: { weeks: null, end_date: "2026-09-07", repeating: false }, appliedAt }) === null,
    "text's 3-week estimate lands within 2 days of the stated date → normal week-boundary slop, not a conflict");
  ok(blockSpanConflict({ programText: DURATION_TEXT, stated: { weeks: null, end_date: "2026-09-07", repeating: false } }) === null,
    "no appliedAt supplied → cross-type check is skipped entirely (never a false positive from a missing anchor)");
  // Reverse direction: text states an explicit date (RUNS_RE contract style),
  // athlete states a week count that disagrees once anchored to the block start.
  const RUNS_TEXT = "Runs: 2026-08-17 to 2026-09-05\nDay 1 - Squat\nBack Squat 5x5 @225";
  const conflict = blockSpanConflict({ programText: RUNS_TEXT, stated: { weeks: 6, end_date: null, repeating: false }, appliedAt });
  ok(conflict && conflict.textSide.endDate === "2026-09-05", "text's explicit end date vs a disagreeing stated week count → conflict, cross-type reverse");
}

// ── phase names + retire's completedAt override ──────────────────────────────
console.log("phase names + retire:");
{
  const { calls, deps } = harness(null);
  await snapshotProgramHistory({ athleteId: "a1", text: PROGRAM, source: "chat_save" }, deps);
  ok(calls.inserts[0]?.data.block_name === "Week 1", "name defaults from the program header line");
}
{
  const { calls, deps } = harness(null);
  await snapshotProgramHistory({ athleteId: "a1", text: PROGRAM, source: "builder", blockName: "Summer Grind" }, deps);
  ok(calls.inserts[0]?.data.block_name === "Summer Grind", "explicit name wins over the header");
}
{
  const { calls, deps } = harness(openBlock(PROGRAM));
  await closeCurrentBlock({ athleteId: "a1", completedAt: "2026-07-20T12:00:00Z" }, deps);
  ok(String(closes(calls)[0]?.data.completed_at || "").startsWith("2026-07-20"), "retire closes at the last-workout date, not now");
}
{
  const { calls, deps } = harness(openBlock(PROGRAM));
  await closeCurrentBlock({ athleteId: "a1", completedAt: "garbage" }, deps);
  ok(!!closes(calls)[0]?.data.completed_at && !String(closes(calls)[0].data.completed_at).startsWith("garbage"), "garbage override falls back to now");
}

// ── digestWorkouts formatting ────────────────────────────────────────────────
console.log("digestWorkouts:");
{
  const d = digestWorkouts([
    { created_at: "2026-07-03T18:00:00Z", parsed_data: { exercises: [{ name: "Back Squat", sets: 5, reps: 5, weight: 225 }, { name: "Pull-Up", sets: 3, reps: 10, weight: null }] } },
    { created_at: "2026-07-04T18:00:00Z", parsed_data: {} },
  ]);
  ok(/2026-07-03: Back Squat 5x5 @225lbs, Pull-Up 3x10/.test(d), `session line formatted, lbs labeled (T55: kg AND lbs both carry labels now) (got "${d}")`);
  ok(!/2026-07-04/.test(d), "empty session omitted");
  ok(digestWorkouts([]) === "" && digestWorkouts(null) === "", "empty/garbage input → empty digest");
}

// ── refreshOpenBlockRecap: the current card's live summary (Will 08-28) ──────
console.log("refreshOpenBlockRecap:");
{
  const workouts = [{ created_at: "2026-07-03T18:00:00Z", parsed_data: { exercises: [{ name: "Back Squat", sets: 5, reps: 5, weight: 225 }] } }];
  const { calls, deps } = harness(openBlock(PROGRAM), { workouts });
  const text = await refreshOpenBlockRecap({ athleteId: "a1" }, deps);
  ok(!!text, "open block with logs gets a live recap");
  ok(recaps(calls).length === 1 && recaps(calls)[0].data.block_recap === text, "recap written to the open row");
  ok(closes(calls).length === 0 && calls.inserts.length === 0, "refresh never closes or inserts anything");
}
{
  const closed = { ...openBlock(PROGRAM), completed_at: "2026-07-20T00:00:00Z" };
  const { calls, deps } = harness(closed, { workouts: [{ created_at: "2026-07-03T18:00:00Z", parsed_data: { exercises: [{ name: "Back Squat", sets: 5, reps: 5, weight: 225 }] } }] });
  ok((await refreshOpenBlockRecap({ athleteId: "a1" }, deps)) === null, "a closed latest block is left alone");
  ok(calls.updates.length === 0, "and nothing is written");
}
{
  const { calls, deps } = harness(openBlock(PROGRAM), { workouts: [] });
  ok((await refreshOpenBlockRecap({ athleteId: "a1" }, deps)) === null, "no logged sessions → no recap, never filler");
  ok(calls.asked === 0 && calls.updates.length === 0, "and no AI spend");
}
{
  const { deps } = harness(null);
  ok((await refreshOpenBlockRecap({ athleteId: "a1" }, deps)) === null, "no history rows at all → null");
}

if (fail) { console.error(`\n${fail} FAILED`); process.exit(1); }
console.log("\nAll program-history checks green.");
