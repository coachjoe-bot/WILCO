// programHistory regression suite — run with: node scripts/test-program-history.mjs
// Covers the block-vs-tweak decision in snapshotProgramHistory with mocked data/AI
// deps. Deterministic, no network. Part of the Program Builder Phase B ship gate
// (docs/program-builder-build-handoff.md).

import { snapshotProgramHistory, startNextBlock, closeCurrentBlock, setBlockEnd, blockPromptState, parseTimeline, dateToIso, digestWorkouts, changedRatio, NEW_BLOCK_RATIO, deriveBlockName, refreshOpenBlockRecap, recapShortFallback } from "../src/programHistory.js";

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
  ok(recaps(calls).length === 1, "closed block got its recap");
  ok(calls.inserts.length === 1 && calls.inserts[0].data.program_text === REWRITE.trim(), "new block inserted");
}

// ── T64 Fix 3b: the short athlete-facing recap rides alongside the full one ──
console.log("short recap (T64 Fix 3b):");
{
  const { calls, deps } = harness(openBlock(PROGRAM));
  await snapshotProgramHistory({ athleteId: "a1", text: REWRITE, source: "coach_save" }, deps);
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
  deps.askClaude = async (...args) => { n++; if (n === 2) throw new Error("unknown column block_recap_short"); return originalAsk(...args); };
  await snapshotProgramHistory({ athleteId: "a1", text: REWRITE, source: "coach_save" }, deps);
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
  ok(recaps(calls).length === 1, "old block recapped from the logs");
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
  ok(did === true && closes(calls).length === 1 && recaps(calls).length === 1, "closeCurrentBlock closes + recaps");
  ok(calls.inserts.length === 0, "…and opens NOTHING (next save starts the next chapter)");
}
{
  ok(blockPromptState({ endsAt: null }) === null, "no end date → no prompt");
  ok(blockPromptState({ endsAt: "2026-08-24T12:00:00Z", now: "2026-08-01T12:00:00Z" }) === null, "far out → quiet");
  ok(blockPromptState({ endsAt: "2026-08-24T12:00:00Z", now: "2026-08-20T12:00:00Z" }) === "ending", "inside 7 days → ending");
  ok(blockPromptState({ endsAt: "2026-08-24T12:00:00Z", now: "2026-08-25T12:00:00Z" }) === "ended", "past → ended");
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
