// ─── TURN FACTS SUITE (T64 S2, bug 5) ────────────────────────────────────────
// Locks the performed-set lines Joe quotes: what was DONE, from set_details,
// with the plan's different prescription named as the plan.
// Run: node scripts/test-turn-facts.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performedLine, performedLines, performedBlock, planSchemeFor, logHeadline, logFocusBlock, planDayFor, plannedLifts, isMainLift, sameLift } from "../src/turnFacts.js";
import { prCheckLines, bestE1RMForExercise, resolveLift, effectiveDate } from "../src/grit.js";
import { toLbs } from "../src/units.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const eq = (a, b, n) => ok(a === b, `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// replay: Sep 2 "clean double"
{
  const rp = JSON.parse(fs.readFileSync(join(here, "../tests/replay/bug5-clean-double.json"), "utf8"));
  const lines = performedLines(rp.parsed_exercises, { displayUnit: rp.starting_state.display_unit, planText: rp.starting_state.plan_text });
  eq(lines[0], "Behind the Neck Snatch Grip Push Press: 5 sets of 3, 60/80/90/100/100 kg, top set 100 kg x 3 (plan was 5x2)", "Sep 2 push press line");
  eq(lines[1], "Push Press: 5 sets of 3, 60/70/80/90/90 kg, top set 90 kg x 3 (plan was 5x2)", "push press is its own lift, not the BTN variant");
  ok(!/double/i.test(lines.join(" ")), "no 'double' anywhere in the facts");
  ok(lines[2].startsWith("DB Lateral Raise: 3 sets of 8 at 18"), `lbs lift shown in the athlete's kg (got ${lines[2]})`);
  const blk = performedBlock(rp.parsed_exercises, { displayUnit: "kg", planText: rp.starting_state.plan_text });
  ok(blk.includes("FINAL") && blk.includes("never swap in the program's prescription"), "block states finality");
}
// straight sets read naturally
eq(performedLine({ name: "Back Squat", sets: 3, reps: 5, weight: 140, unit: "kg" }, { displayUnit: "kg" }), "Back Squat: 3 sets of 5 at 140 kg", "straight sets");
// missed rep on the last set: shown per set
eq(performedLine({ name: "Front Squat", unit: "kg", set_details: [{ weight: 102, reps: 3 }, { weight: 102, reps: 3 }, { weight: 102, reps: 3 }, { weight: 102, reps: 2 }] }, { displayUnit: "kg" }),
  "Front Squat: 4 sets: 102 x 3, 102 x 3, 102 x 3, 102 x 2 kg, top set 102 kg x 3", "missed rep on the last set shows per set");
// warm-ups excluded from the count, named
eq(performedLine({ name: "Clean & Jerk", unit: "kg", set_details: [{ weight: 70, reps: 1, warmup: true }, { weight: 90, reps: 1, warmup: true }, { weight: 110, reps: 1 }, { weight: 120, reps: 1 }] }, { displayUnit: "kg" }),
  "Clean & Jerk: 2 sets of 1, 110/120 kg, top set 120 kg x 1, after 2 warm-up sets", "warm-ups named, not counted");
// bodyweight
eq(performedLine({ name: "Pull-Up", sets: 3, reps: 10, unit: "bodyweight" }), "Pull-Up: 3 sets of 10, bodyweight", "bodyweight reps");
eq(performedLine({ name: "Pull-Up", unit: "bodyweight", set_details: [{ reps: 8 }, { reps: 8, weight: 25 }, { reps: 8, weight: 25 }] }), "Pull-Up: 3 sets: bodyweight x 8, +25 lbs x 8, +25 lbs x 8", "weighted bodyweight per set");
eq(performedLine({ name: "Weighted Pull-Up", sets: 3, reps: 5, unit: "bodyweight", added_weight: 45 }), "Weighted Pull-Up: 3 sets of 5, bodyweight plus 45 lbs", "added weight");
eq(performedLine({ name: "Weighted Sit-Up", unit: "bodyweight" }), null, "bodyweight with no reps is skipped");
// timed
eq(performedLine({ name: "Plank", sets: 2, time_per_set_seconds: 60, unit: "bodyweight" }), "Plank: 2 sets of 60 s held", "timed work");
// plan 5x2 vs logged 5x3 in a multi-line program; ambiguous plan says nothing
eq(planSchemeFor("Front Squat", "WEEK 2\nTUE\n* Front squat 4×3 @ 97.5 kg\nWEEK 3\n* Front squat 5×3 @ 104 kg"), null, "two schemes for one lift: ambiguous, no plan note");
eq(planSchemeFor("Front Squat", "Monday Front squat 4x3 at 250 Snatch pull 4x3 at 240"), "4x3", "day label in front of the lift is stripped");
eq(planSchemeFor("Push Press", "* Behind the Neck Snatch Grip Push Press 5x2 @ 60 kg"), null, "a longer lift name is not this lift");
eq(performedLine({ name: "Back Squat", sets: 3, reps: 5, weight: 140, unit: "kg" }, { displayUnit: "kg", planText: "Back squat 3x5 @ 140" }), "Back Squat: 3 sets of 5 at 140 kg", "plan matches: no plan note");
// complex rep scheme
eq(performedLine({ name: "Muscle Snatch + Hang Snatch", sets: 4, reps: 1, rep_scheme: "1+1", unit: "lbs", set_details: [{ weight: 135, reps: 1 }, { weight: 165, reps: 1 }, { weight: 185, reps: 1 }, { weight: 185, reps: 1 }] }, { displayUnit: "lbs" }),
  "Muscle Snatch + Hang Snatch: 4 sets of 1+1, 135/165/185/185 lbs, top set 185 lbs x 1", "complex keeps its rep scheme");
// per-hand dumbbells
eq(performedLine({ name: "Incline Dumbbell Bench Press", sets: 3, reps: 8, weight: 60, unit: "lbs", load_basis: "each" }, { displayUnit: "lbs" }), "Incline Dumbbell Bench Press: 3 sets of 8 at 60 lbs each", "per-hand load");


// ─── LOG HEADLINE (T64 S5) ───────────────────────────────────────────────────
// The chat turn's two indexes, built the way getJoeBotReply builds them (bests
// for PR CHECK; the LAST TIME PER EXERCISE index), from history BEFORE the log.
function indexes(rows, manual = []) {
  const best = {};
  for (const w of rows) for (const ex of w.parsed_data?.exercises || []) {
    const e1 = bestE1RMForExercise(ex, 0); if (!e1) continue;
    const l = resolveLift(ex.name);
    if (!best[l.id] || e1 > best[l.id].e1rm) best[l.id] = { name: l.name, e1rm: e1 };
  }
  for (const m of manual) best[resolveLift(m.exercise).id] = { name: m.exercise, e1rm: toLbs(m.weight, m.unit), actual: true };
  const lastDone = new Map();
  [...rows].sort((a, b) => effectiveDate(b) - effectiveDate(a)).forEach((w) => (w.parsed_data?.exercises || []).forEach((e) => {
    const id = resolveLift(e.name).id; if (!lastDone.has(id)) lastDone.set(id, { name: e.name, date: effectiveDate(w), ex: e });
  }));
  return { best, lastDone };
}
const NOW = new Date("2026-09-20T18:00:00Z");
const daysAgo = (d, h = 0) => new Date(NOW.getTime() - d * 864e5 - h * 36e5).toISOString();
const row = (at, exercises) => ({ created_at: at, parsed_data: { exercises } });
const kg = (name, sets, reps, weight, extra = {}) => ({ name, sets, reps, weight, unit: "kg", ...extra });
function head({ exercises, rows = [], manual = [{ exercise: "Back Squat", weight: 180, unit: "kg" }], unit = "kg", sport = "Olympic Weightlifting", painTurn = null, plan = "", resolverLabel = null, now = NOW }) {
  const { best, lastDone } = indexes(rows, manual);
  const prLines = prCheckLines(exercises, best, unit);
  const planDay = plan ? planDayFor({ programText: plan, loggedNames: exercises.map((e) => e.name), resolverLabel }) : null;
  return logHeadline({ exercises, prLines, lastDone, painTurn, planDay, sport, displayUnit: unit, now });
}
const HIST = [
  row(daysAgo(5), [kg("Snatch", 6, 1, 100), kg("Clean & Jerk", 5, 1, 125)]),
  row(daysAgo(3), [kg("Back Squat", 5, 3, 150), kg("Front Squat", 4, 3, 110), { name: "DB Lateral Raise", sets: 3, reps: 12, weight: 25, unit: "lbs" }]),
];
const PLAN = "Day 1 - Squat\nBack Squat 5x3 @ 80%\nFront Squat 4x3\nDB Lateral Raise 3x12\n\nDay 2 - Classic\nSnatch 6x1 @ 80%\nClean & Jerk 5x1 @ 80%\nBack Extensions 3x10";

// taxonomy: main vs accessory
ok(isMainLift("Back Squat") && isMainLift("Snatch") && isMainLift("Push Press") && isMainLift("Split Jerk from Rack") && isMainLift("Pull-Up"), "compounds are main lifts");
ok(!isMainLift("DB Lateral Raise") && !isMainLift("Barbell Curl") && !isMainLift("Seated Cable Row") && !isMainLift("Plank") && !isMainLift("Back Extensions"), "isolation, cable and core work are accessories");
ok(sameLift("Split Jerk", "Split Jerk from Rack") && !sameLift("Push Press", "Behind the Neck Snatch Grip Push Press"), "start position is not a different lift; a longer variant is");

// a. serious pain beats a PR
{
  const h = head({ exercises: [kg("Snatch", 3, 1, 105)], rows: HIST, painTurn: { areas: ["knee"], serious: true, verdicts: { knee: "address_now" } } });
  eq(h.kind, "pain_serious", "serious pain outranks a snatch PR"); ok(/knee/.test(h.line) && h.alsoAsk === null, "serious pain line names the area, asks nothing else");
}
// b. a NEW PR carries the number and the old best
{
  const h = head({ exercises: [kg("Snatch", 3, 1, 105)], rows: HIST });
  eq(h.kind, "pr", "made single above the best is the headline"); ok(/105 kg/.test(h.line) && /100 kg/.test(h.line), `PR line carries new and old (got ${h.line})`);
}
// c. a mild acknowledge_once does NOT outrank a PR; alone, it leads
{
  const pt = { areas: ["elbow"], serious: false, verdicts: { elbow: "acknowledge_once" } };
  eq(head({ exercises: [kg("Snatch", 3, 1, 105)], rows: HIST, painTurn: pt }).kind, "pr", "PR beats a mild acknowledge_once");
  const h = head({ exercises: [kg("Back Squat", 5, 3, 150)], rows: HIST, painTurn: pt });
  eq(h.kind, "pain", "acknowledge_once leads when nothing outranks it"); ok(/elbow \(acknowledge_once\)/.test(h.line), "pain line carries the verdict");
  eq(head({ exercises: [kg("Back Squat", 5, 3, 150)], rows: HIST, painTurn: { areas: ["knee"], serious: false, verdicts: { knee: "offer_change_once" } } }).kind, "pain", "offer_change_once leads too");
  eq(head({ exercises: [kg("Back Squat", 5, 3, 150)], rows: HIST, painTurn: { areas: ["knee"], serious: false, verdicts: { knee: "none" } } }).kind, "none", "verdict none is not a headline");
}
// two PRs in one log: sport-central first, else the biggest jump
{
  const exs = [kg("Snatch", 3, 1, 102), kg("Front Squat", 3, 1, 130)];
  const h = head({ exercises: exs, rows: HIST });
  eq(h.kind, "pr", "two PRs: one headline"); ok(/^Snatch:/.test(h.line), `weightlifter: the snatch leads over a bigger front squat jump (got ${h.line})`);
  const g = head({ exercises: exs, rows: HIST, sport: "General Fitness" });
  ok(/^Front Squat:/.test(g.line), `no central lift: biggest jump leads (got ${g.line})`);
}
// PR on an accessory + progress on a main lift: the main lift leads, no estimated max
{
  const exs = [kg("Back Squat", 5, 3, 155), { name: "DB Lateral Raise", sets: 3, reps: 12, weight: 35, unit: "lbs" }];
  const { best } = indexes(HIST);
  ok(prCheckLines(exs, best, "kg").some((l) => /DB Lateral Raise: NEW ESTIMATED PR/.test(l)), "fixture: the raise IS an estimated PR");
  const h = head({ exercises: exs, rows: HIST });
  eq(h.kind, "progress", "main-lift progress beats an accessory PR");
  ok(/Back Squat: 155 kg x 3 today, up from 150 kg x 3 on/.test(h.line), `progress line carries both numbers (got ${h.line})`);
  ok(!/raise|estimat/i.test(h.line), "no accessory, no estimate in the headline");
}
// d. reps up at the same load is a step; fewer reps at a heavier load is not
eq(head({ exercises: [kg("Back Squat", 5, 5, 150)], rows: HIST }).kind, "progress", "same load, more reps");
eq(head({ exercises: [kg("Back Squat", 3, 2, 155)], rows: HIST }).kind, "none", "heavier but fewer reps is not a clear step (no estimate games)");
// the accessory's estimated max never headlines, even when the main lift has nothing
{
  const h = head({ exercises: [kg("Back Squat", 5, 3, 150), { name: "DB Lateral Raise", sets: 3, reps: 12, weight: 35, unit: "lbs" }], rows: HIST });
  eq(h.kind, "none", "flat main lift + accessory estimated PR = nothing notable");
}
// e. missing main lift: with a headline above it, and without
{
  const withPr = head({ exercises: [kg("Snatch", 3, 1, 105), kg("Back Extensions", 3, 10, 20)], rows: HIST, plan: PLAN });
  eq(withPr.kind, "pr", "missing C&J does not displace the PR");
  ok(/Clean & Jerk/.test(withPr.alsoAsk || "") && !/Back Extensions/.test(withPr.alsoAsk || ""), `alsoAsk names the missing main lift (got ${withPr.alsoAsk})`);
  const PLAN3 = PLAN.replace("Clean & Jerk 5x1 @ 80%", "Clean & Jerk 5x1 @ 80%\nFront Squat 3x2");
  eq(head({ exercises: [kg("Snatch", 6, 1, 90)], rows: HIST, plan: PLAN }).alsoAsk, null, "a one-lift highlight is not checked for gaps");
  const flat = head({ exercises: [kg("Snatch", 6, 1, 90), kg("Front Squat", 3, 2, 110)], rows: HIST, plan: PLAN3 });
  eq(flat.kind, "plan_gap", "nothing above: the gap is the headline"); ok(/Clean & Jerk/.test(flat.line) && flat.alsoAsk, "plan_gap carries the question");
  // accessory missing from the plan is never asked about
  const noAcc = head({ exercises: [kg("Back Squat", 5, 3, 150), kg("Front Squat", 4, 3, 110)], rows: HIST, plan: PLAN });
  eq(noAcc.kind, "none", "plan matched except an accessory: nothing notable"); eq(noAcc.alsoAsk, null, "a skipped accessory earns no question");
  // a planned lift logged earlier this session is not missing
  const split = [...HIST, row(new Date(NOW.getTime() - 40 * 60000).toISOString(), [kg("Clean & Jerk", 5, 1, 110)])];
  eq(head({ exercises: [kg("Snatch", 6, 1, 90), kg("Front Squat", 3, 2, 110)], rows: split, plan: PLAN3 }).alsoAsk, null, "C&J logged 40 minutes ago counts as done");
  // pain turns never ask about a skipped lift
  eq(head({ exercises: [kg("Snatch", 6, 1, 90), kg("Front Squat", 3, 2, 110)], rows: HIST, plan: PLAN3, painTurn: { areas: ["knee"], serious: false, verdicts: { knee: "acknowledge_once" } } }).alsoAsk, null, "pain headline: no skipped-lift question");
}
// f. matches the plan exactly, no progress: nothing notable
{
  const h = head({ exercises: [kg("Back Squat", 5, 3, 150), kg("Front Squat", 4, 3, 110), { name: "DB Lateral Raise", sets: 3, reps: 12, weight: 25, unit: "lbs" }], rows: HIST, plan: PLAN });
  eq(h.kind, "none", "plan done as last time"); eq(h.alsoAsk, null, "nothing to ask");
  ok(/nothing stands out/.test(logFocusBlock(h)) && /acknowledgment, and that is the whole reply/.test(logFocusBlock(h)), "none block: acknowledgment alone");
}
// bodyweight or timed only
{
  eq(head({ exercises: [{ name: "Plank", sets: 3, time_per_set_seconds: 60, unit: "bodyweight" }, { name: "Pull-Up", sets: 3, reps: 8, unit: "bodyweight" }] }).kind, "none", "bodyweight/timed with no history: nothing notable");
  const bw = head({ exercises: [{ name: "Pull-Up", sets: 3, reps: 10, unit: "bodyweight" }], rows: [row(daysAgo(4), [{ name: "Pull-Up", sets: 3, reps: 8, unit: "bodyweight" }])] });
  eq(bw.kind, "progress", "pull-ups 3x10 after 3x8 is a step"); ok(/bodyweight x 10 today, up from bodyweight x 8/.test(bw.line), `bodyweight step line (got ${bw.line})`);
  eq(head({ exercises: [{ name: "Plank", sets: 3, time_per_set_seconds: 90, unit: "bodyweight" }], rows: [row(daysAgo(4), [{ name: "Plank", sets: 3, time_per_set_seconds: 60, unit: "bodyweight" }])] }).kind, "none", "timed holds never headline");
}
// planDayFor: best overlap; an unbroken tie is no day
{
  eq(planDayFor({ programText: PLAN, loggedNames: ["Snatch"] })?.label, "Day 2 - Classic", "snatch log matches the classic day");
  const tie = "Day 1\nBack Squat 5x3\nBench Press 3x5\n\nDay 2\nBack Squat 3x3\nDeadlift 3x3";
  eq(planDayFor({ programText: tie, loggedNames: ["Back Squat"] }), null, "tie with no resolver day: no plan day");
  eq(planDayFor({ programText: tie, loggedNames: ["Back Squat"], resolverLabel: "Day 2" })?.label, "Day 2", "tie goes to the resolver's day");
  eq(planDayFor({ programText: PLAN, loggedNames: ["Bicep Curl"] }), null, "no overlap: no plan day");
}
// the block: no word or sentence counts, the ask-for-depth escape is always there
{
  const b = logFocusBlock({ kind: "pr", line: "Snatch: new PR.", alsoAsk: "X was on today's plan. Ask once." });
  ok(!/\b\d+\s+(?:words?|sentences?)\b/i.test(b) && !/\b(?:two|three|four|five)\s+(?:words?|sentences?)\b/i.test(b), "no counts in the block");
  ok(/answer it as fully as they asked/.test(b) && /never limits an answer they asked for/.test(b), "depth on request is never limited");
  ok(/Question: X was on/.test(b) && /then that one question/.test(b), "alsoAsk rides as one question");
}

// replay: the founder's Sep 2 log (screenshot 5)
{
  const rp = JSON.parse(fs.readFileSync(join(here, "../tests/replay/log-reply-focus.json"), "utf8"));
  const src = JSON.parse(fs.readFileSync(join(here, "../tests/replay", rp.exercises_from), "utf8"));
  const st = rp.starting_state;
  const h = head({ exercises: src.parsed_exercises, rows: st.history, unit: st.display_unit, sport: st.sport, plan: st.plan_text, now: new Date(rp.now) });
  eq(h.kind, rp.expect.kind, "Sep 2: kind");
  for (const s of rp.expect.line_has) ok(h.line.includes(s), `Sep 2 headline has "${s}" (got ${h.line})`);
  for (const s of rp.expect.ask_has) ok((h.alsoAsk || "").includes(s), `Sep 2 question has "${s}" (got ${h.alsoAsk})`);
  for (const s of rp.expect.never) ok(!new RegExp(s, "i").test(`${h.line} ${h.alsoAsk}`), `Sep 2: nothing about "${s}"`);
  ok(!/Push Press was|Push Press and/.test(h.alsoAsk || ""), "both push presses were logged: neither is asked about");
  ok(!/\b\d+\s+(?:words?|sentences?)\b/i.test(logFocusBlock(h)), "Sep 2 block: no counts");
}

console.log(`\n${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
