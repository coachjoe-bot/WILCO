// statesBlockEnd regression suite — run with: node scripts/test-block-end.mjs
// T64 S6 (verifier BUG-1): an athlete stating when their program ends must reach
// the block-span branch (conflict check, two-tap confirm, block-scoped storage)
// whatever the phrasing, and must never ALSO be saved as a free-text memory note.
// Pure, deterministic, no network. Picked up by scripts/run-tests.mjs's glob.
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statesBlockEnd, resolveStatedSpan, blockSpanConflict } from "../src/programHistory.js";

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const bad = (msg) => { fail++; console.error("  ✗ " + msg); };
const ok = (cond, msg) => { if (!cond) bad(msg); };

// Monday 2026-09-28, noon-ish UTC: the same calendar day under any US zone.
const MON = new Date("2026-09-28T16:00:00Z");

console.log("statesBlockEnd — positives (dates):");
const dates = [
  ["No my program wraps up sept 20th", "2026-09-20"],
  ["hey just so you know this program actually wraps up Sept 15th, not sooner", "2026-09-15"],
  ["it wraps up October 1st", "2026-10-01"],
  ["my program ends Oct 1", "2026-10-01"],
  ["My block ends on October 3", "2026-10-03"],
  ["this block finishes Sept 30", "2026-09-30"],
  ["the program runs through Oct 12", "2026-10-12"],
  ["it runs until the 15th", "2026-10-15"],
  ["my cycle goes through November 2nd", "2026-11-02"],
  ["program goes until 10/20", "2026-10-20"],
  ["the block is over on Oct 18", "2026-10-18"],
  ["the last day of my program is October 9th", "2026-10-09"],
  ["last day is Oct 4", "2026-10-04"],
  ["my program is done Oct 30", "2026-10-30"],
  ["program's done on the 25th", "2026-10-25"],
  ["it ends end of the month", "2026-09-30"],
  ["block wraps up at the end of the month", "2026-09-30"],
  ["my program ends end of next month", "2026-10-31"],
  ["my program ends next Friday", "2026-10-09"],
  ["this one wraps up Friday", "2026-10-02"],
  ["it finishes on 10/1", "2026-10-01"],
  ["it ends 10/1/2026", "2026-10-01"],
  ["this program wraps up on the 15th of October", "2026-10-15"],
  ["program ends october 1st 2026", "2026-10-01"],
  ["current block ends Oct 11", "2026-10-11"],
  ["My training block finishes the 30th", "2026-09-30"],
  ["fyi my plan will end Nov 8", "2026-11-08"],
  ["my meso wraps up 2026-10-25", "2026-10-25"],
  ["yeah it officially ends Oct 6. I'll need a new one after", "2026-10-06"],
  ["the program should wrap up Oct 2", "2026-10-02"],
  ["I have 3 more weeks on this block", "2026-10-19"],
  ["4 weeks left in my program", "2026-10-26"],
  ["this program goes through tomorrow", "2026-09-29"],
];
for (const [text, want] of dates) {
  const r = statesBlockEnd(text, MON);
  ok(r && r.end_date === want && r.kind === "date", `"${text}" → end_date ${want} (got ${JSON.stringify(r)})`);
}

console.log("statesBlockEnd — positives (weeks / repeating):");
const weeks = [
  ["it's a 6 week block", 6],
  ["its a 6 week block", 6],
  ["this is an 8 week program", 8],
  ["my program is 8 weeks long", 8],
  ["the block runs 6 weeks", 6],
  ["it lasts 12 weeks", 12],
  ["I'm on a 10-week cycle", 10],
  ["my program is eight weeks", 8],
];
for (const [text, want] of weeks) {
  const r = statesBlockEnd(text, MON);
  ok(r && r.weeks === want && r.kind === "weeks", `"${text}" → weeks ${want} (got ${JSON.stringify(r)})`);
}
const repeating = ["my program just repeats", "it just repeats", "no end date", "my program doesn't end", "it's ongoing, same week every week", "this plan never ends, I run it until I change it"];
for (const text of repeating) {
  const r = statesBlockEnd(text, MON);
  ok(r && r.repeating === true && r.kind === "repeating", `"${text}" → repeating (got ${JSON.stringify(r)})`);
}

console.log("statesBlockEnd — negatives:");
const negatives = [
  "my season ends Oct 1",
  "class ends at 3",
  "when does my program end?",
  "does it end on the 15th?",
  "how many weeks is my program",
  "Bench 3x5 @ 185, program ends Oct 1",
  "Squat 5x5 225lbs today, felt good",
  "my trip ends Sunday",
  "semester ends Dec 15",
  "my lease ends Oct 1",
  "the meet is Oct 1",
  "my last block was 8 weeks",
  "the next block will be 6 weeks",
  "the new program ends Nov 1",
  "I want my program to end Oct 1",
  "if my program ends Oct 1 what should I do",
  "it ends at 3pm",
  "today's session ends with conditioning",
  "my program ended last week",
  "my deload week ends Friday",
  "my cut ends in 8 weeks",
  "the gym closes at 9 on Friday",
  "my program has me benching on Friday",
  "practice goes until 6 tonight",
  "my program ends when I say so",
  "what's after the program ends on the 20th?",
  "my program week ends Sunday",
  "it ends with deadlifts",
  "my program ends on a Friday",
];
for (const text of negatives) {
  const r = statesBlockEnd(text, MON);
  ok(r === null, `NEGATIVE "${text}" must not fire (got ${JSON.stringify(r)})`);
}

console.log("statesBlockEnd — year resolution against local today:");
{
  const DEC = new Date("2026-12-10T16:00:00Z");
  ok(statesBlockEnd("my program wraps up Jan 10", DEC)?.end_date === "2027-01-10", "Jan 10 said in December → next year");
  ok(statesBlockEnd("my program wraps up Dec 1", DEC)?.end_date === "2026-12-01", "a date 9 days past stays this year (it is ending now)");
  ok(statesBlockEnd("it wraps up Sept 15th", MON)?.end_date === "2026-09-15", "13 days past stays this year");
  ok(statesBlockEnd("my program ends 2/30", MON) === null, "an impossible date is not a date");
}

console.log("resolveStatedSpan — detector wins, disagreement surfaced:");
{
  const det = statesBlockEnd("it wraps up October 1st", MON);
  const a = resolveStatedSpan({ parserSpan: null, detected: det });
  ok(a.span.end_date === "2026-10-01" && a.source === "detector" && !a.disagree && a.blockEndStated, "parser missed → detector fills the span");
  const b = resolveStatedSpan({ parserSpan: { weeks: null, end_date: "2026-10-02", repeating: false }, detected: det });
  ok(b.span.end_date === "2026-10-01" && b.disagree, "parser and detector disagree → detector's date wins, disagree flagged");
  const c = resolveStatedSpan({ parserSpan: { weeks: null, end_date: "2026-10-01", repeating: false }, detected: det });
  ok(!c.disagree, "same answer → no disagreement");
  const d = resolveStatedSpan({ parserSpan: { weeks: 6, end_date: null, repeating: null }, detected: null });
  ok(d.source === "parser" && d.blockEndStated, "detector silent → the parser's span still rides (unchanged behavior)");
  const e = resolveStatedSpan({ parserSpan: { weeks: null, end_date: null, repeating: null }, detected: null });
  ok(e.span === null && !e.blockEndStated, "nothing stated anywhere → nothing, and the memory channel is untouched");
}

console.log("replay — BUG-1 paraphrases (tests/replay/block-end-paraphrases-0928.json):");
{
  const rp = JSON.parse(fs.readFileSync(join(here, "../tests/replay/block-end-paraphrases-0928.json"), "utf8"));
  const today = new Date(rp.today);
  for (const c of rp.cases) {
    const det = statesBlockEnd(c.text, today);
    ok(det && det.end_date === c.expectEndDate, `replay "${c.text}" → ${c.expectEndDate}`);
    const r = resolveStatedSpan({ parserSpan: c.parserSpan, detected: det });
    const conflict = blockSpanConflict({ programText: rp.programText, stated: r.span, appliedAt: rp.appliedAt });
    ok(!!conflict === rp.expect.conflictForEvery, `replay "${c.text}" reaches the conflict check and conflicts with the program's own end`);
    ok(conflict && conflict.textSide.endDate === rp.expect.textSideEndDate, `replay "${c.text}" program side is ${rp.expect.textSideEndDate}`);
    ok(r.blockEndStated === true, `replay "${c.text}": the remember-this channel is told the fact already has its home (no athlete_context note)`);
  }
}

if (fail) { console.error(`\n${fail} FAILED`); process.exit(1); }
console.log("\nAll block-end checks green.");
