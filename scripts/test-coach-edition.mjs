// Coach Edition regression suite — the guard rail for the pure team-report math in
// src/proofcore.js (buildCoachTeamBrief + buildCoachQuestionBank).
// Run with: node scripts/test-coach-edition.mjs
//
// These two build the weekly Coach's Edition — the report that gets EMAILED, so a
// wrong number is a wrong claim sitting in a coach's inbox with no way to retract
// it. The cases that matter most are the ones where the roster is thin or partly
// unprogrammed: a roster where half the athletes have no program must not report a
// team adherence that silently averages only the other half without saying so, and
// a lift only ONE athlete performs must never be labelled a team strength or
// weakness.

import { buildCoachTeamBrief, buildCoachQuestionBank } from "../src/proofcore.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("  ✗ " + msg); } };
const eq = (got, want, msg) => ok(Object.is(got, want), `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// One roster row in the shape the enrich step hands over.
const row = (name, o = {}) => ({
  athlete: { name },
  score: "score" in o ? o.score : 80,   // ?? would swallow an explicit null (= no program)
  truePRs: o.truePRs,
  prs: o.prs,
  snap: { rankedLifts: o.rankedLifts || [] },
  brief: {
    sessions: { thisWeek: o.thisWeek ?? 3, lastWeek: o.lastWeek ?? 3 },
    lifts: o.lifts || [],
    prs: o.briefPRs || [],
    injuries: { active: o.active || [], recurring: o.recurring || [] },
    volumeTrend: { thisWeekSets: o.volThis ?? 40, lastWeekSets: o.volLast ?? 40 },
  },
});

console.log("buildCoachTeamBrief — roster shape:");
{
  const t = buildCoachTeamBrief([]);
  eq(t.n, 0, "empty roster has no athletes");
  eq(t.activePct, 0, "empty roster is 0% active (not NaN)");
  eq(t.avgSessions, 0, "empty roster averages 0 sessions (not NaN)");
  eq(t.adherenceAvg, null, "empty roster has no adherence average");
}
{
  // Malformed rows must be dropped, not counted — a row with no brief would make
  // every downstream reduce throw or produce NaN.
  const t = buildCoachTeamBrief([row("A"), null, { athlete: { name: "B" } }, { brief: {} }]);
  eq(t.n, 1, "rows without an athlete+brief are dropped");
}
{
  const t = buildCoachTeamBrief([
    row("Marcus Ellison", { thisWeek: 3 }),
    row("Dana Whitfield", { thisWeek: 0 }),
    row("Chris Alvarez", { thisWeek: 2 }),
  ]);
  eq(t.n, 3, "counts the roster");
  eq(t.active, 2, "counts who actually trained");
  eq(t.activePct, 67, "active % rounds");
  eq(t.totalSessions, 5, "sums sessions");
  eq(t.avgSessions, 1.7, "averages sessions to one decimal");
  eq(t.quiet.length, 1, "the athlete with zero sessions is quiet");
  eq(t.quiet[0].athlete, "Dana W.", "names are shortened to first-name + initial");
}

console.log("adherence:");
{
  // The unprogrammed athletes are EXCLUDED from the average and reported
  // separately — averaging them in as zero would understate a healthy team.
  const t = buildCoachTeamBrief([
    row("A A", { score: 90 }), row("B B", { score: 70 }), row("C C", { score: null }),
  ]);
  eq(t.adherenceAvg, 80, "adherence averages only scored athletes");
  eq(t.noProgram, 1, "unprogrammed athletes are counted separately");
}
{
  const t = buildCoachTeamBrief([row("A A", { score: null }), row("B B", { score: null })]);
  eq(t.adherenceAvg, null, "a fully unprogrammed roster reports no average, not 0");
  eq(t.noProgram, 2, "…and says how many");
}
{
  const t = buildCoachTeamBrief([row("A A", { score: 40 }), row("B B", { score: 54 }), row("C C", { score: 55 })]);
  eq(t.strugglers.length, 2, "below 55 is a struggler; 55 itself is not");
  eq(t.strugglers[0].score, 40, "strugglers are worst-first");
}

console.log("strengths / weaknesses:");
{
  // A benchmark only ONE athlete performs is not a team pattern.
  const lift = (key, name, tierIdx) => ({ key, name, benchKey: key, tierIdx });
  const t = buildCoachTeamBrief([
    row("A A", { rankedLifts: [lift("back squat", "Back Squat", 4), lift("bench press", "Bench Press", 1)] }),
    row("B B", { rankedLifts: [lift("back squat", "Back Squat", 4), lift("bench press", "Bench Press", 1)] }),
    row("C C", { rankedLifts: [lift("power clean", "Power Clean", 0)] }),
  ]);
  ok(t.strengths.some((s) => /squat/i.test(s.name)), "a high team average is a strength");
  ok(t.weaknesses.some((w) => /bench/i.test(w.name)), "a low team average is a weakness");
  ok(![...t.strengths, ...t.weaknesses].some((x) => /clean/i.test(x.name)),
     "a lift only ONE athlete performs is neither (n>=2 required)");
}

console.log("PRs:");
{
  const t = buildCoachTeamBrief([
    row("A A", { truePRs: [{ exercise: "Back Squat", weight: 405, reps: 1, e1rm: 405, gain: 15 }] }),
    row("B B", { truePRs: [{ exercise: "Bench", weight: 245, reps: 3, e1rm: 268, gain: 30 }] }),
    row("C C", { truePRs: [] }),
  ]);
  eq(t.newPRs, 2, "counts true PRs across the roster");
  eq(t.notablePRs[0].exercise, "Bench", "notable PRs lead with the biggest gain, not the biggest number");
  eq(t.notablePRs[0].athlete, "B B.", "PRs carry the shortened athlete name");
}
{
  // Only the top 2 per athlete surface, so one athlete's big week can't fill the
  // whole "notable" list and hide everyone else.
  const many = Array.from({ length: 5 }, (_, i) => ({ exercise: "Lift" + i, weight: 100 + i, reps: 1, e1rm: 100 + i, gain: 50 - i }));
  const t = buildCoachTeamBrief([row("A A", { truePRs: many }), row("B B", { truePRs: many })]);
  eq(t.newPRs, 10, "every true PR still counts toward the total");
  eq(t.notablePRs.length, 4, "at most 2 per athlete are named");
}

console.log("injuries:");
{
  const t = buildCoachTeamBrief([
    row("A A", { active: ["knee"], recurring: [{ area: "knee", count: 3 }] }),
    row("B B", { active: ["knee"] }),
    row("C C", { active: ["shoulder"] }),
  ]);
  eq(t.injuryClusters.length, 1, "an area only ONE athlete reports is not a cluster");
  eq(t.injuryClusters[0].area, "knee", "the shared area is the cluster");
  eq(t.sharpInjuries[0].athlete, "A A.", "a recurring flag names the athlete");
  eq(t.sharpInjuries[0].count, 3, "…with how many sessions running");
}

console.log("volume trend:");
{
  const t = buildCoachTeamBrief([row("A A", { volThis: 50, volLast: 40 }), row("B B", { volThis: 30, volLast: 35 })]);
  eq(t.volumeTrend.thisWeekSets, 80, "this week's working sets sum");
  eq(t.volumeTrend.lastWeekSets, 75, "last week's working sets sum");
  eq(t.volumeTrend.deltaSets, 5, "delta is this minus last");
}

console.log("buildCoachQuestionBank:");
{
  const team = buildCoachTeamBrief([row("A A"), row("B B")]);
  const q = buildCoachQuestionBank(team);
  ok(Array.isArray(q), "always returns an array");
  ok(q.every((x) => x && typeof x.id === "string" && typeof x.text === "string"),
     "every question has an id and text");
  // The id is what gets stamped onto coach_context so an answered question isn't
  // re-asked tomorrow — a duplicate id would make two questions share one answer.
  eq(new Set(q.map((x) => x.id)).size, q.length, "question ids are unique");
  ok(q.every((x) => typeof x.deeper === "boolean"), "every question declares deeper");
  // Determinism: same team in, same questions out. The bank is generated fresh on
  // every open, so any nondeterminism would reshuffle the coach's list mid-read.
  eq(JSON.stringify(buildCoachQuestionBank(team)), JSON.stringify(q), "the bank is deterministic");
}
{
  // A weak lift produces an actionable "call" naming that lift.
  const lift = (key, name, tierIdx) => ({ key, name, benchKey: key, tierIdx });
  const team = buildCoachTeamBrief([
    row("A A", { rankedLifts: [lift("bench press", "Bench Press", 1)] }),
    row("B B", { rankedLifts: [lift("bench press", "Bench Press", 1)] }),
  ]);
  const q = buildCoachQuestionBank(team);
  const focus = q.find((x) => x.id === "program_focus");
  ok(!!focus, "a weak team lift raises a program-focus call");
  ok(focus.action === true, "…and it is marked actionable");
  ok(/bench/i.test(focus.text), "…and it names the lift");
}
{
  // A recurring injury raises a named, actionable call for that athlete.
  const team = buildCoachTeamBrief([row("A A", { active: ["knee"], recurring: [{ area: "knee", count: 3 }] })]);
  const q = buildCoachQuestionBank(team);
  const inj = q.find((x) => x.id === "injury_apply");
  ok(!!inj, "a recurring injury raises an injury call");
  ok(/knee/i.test(inj.text) && /A A\./.test(inj.text), "…naming the area and the athlete");
}
{
  // An empty team must not throw and must not invent calls about nobody.
  const q = buildCoachQuestionBank(buildCoachTeamBrief([]));
  ok(Array.isArray(q), "an empty roster still returns an array");
  ok(!q.some((x) => x.id === "injury_apply" || x.id === "program_focus"),
     "an empty roster raises no athlete- or lift-specific calls");
}

if (fail) { console.error(`\n${fail} FAILURE(S) (${pass} passed)`); process.exit(1); }
console.log(`\nAll ${pass} coach-edition checks pass.`);
