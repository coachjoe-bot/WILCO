// ─── PROOFCORE REGRESSION SUITE ──────────────────────────────────────────────
// proofcore.js is the shared deterministic engine: the SERVER Proof Feed engine
// (api/_proofcore.js re-exports it) and the CLIENT coach Overview both compute
// from it, so a drift here shows up as the dashboard and the emailed edition
// disagreeing about the same week. These are the pure functions with real
// decision logic — session grouping, PR truth, plateau/pain detection, tiers.
//
//   node scripts/test-proofcore.mjs
//
import {
  groupIntoSessions, isRealSession, buildLiftHistory, detectPlateaus,
  aggregateInjuries, painTrend, trueImprovementPRs, classifyTiers,
  totalSetVolume, buildOneRMs,
} from "../src/proofcore.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
};
// Workout row helper. `h` is hours from a fixed base — no Date.now(), so the
// suite can't go flaky at a day boundary.
const BASE = Date.parse("2026-07-20T08:00:00.000Z");
const w = (h, exercises, extra = {}) => ({
  id: `w${h}`, athlete_id: "a1",
  created_at: new Date(BASE + h * 3600e3).toISOString(),
  parsed_data: { exercises, pain_flags: [], ...extra },
});
const ex = (name, sets, reps, weight, unit = "lbs") => ({ name, sets, reps, weight, unit });

console.log("groupIntoSessions — the 3h window:");
check("entries inside 3h merge into one session",
  groupIntoSessions([w(0, [ex("Back Squat", 3, 5, 225)]), w(1, [ex("Bench Press", 3, 5, 185)])]).length, 1);
check("a gap over 3h splits into two",
  groupIntoSessions([w(0, [ex("Back Squat", 3, 5, 225)]), w(4, [ex("Bench Press", 3, 5, 185)])]).length, 2);
check("new_session:true splits even inside the window",
  groupIntoSessions([w(0, [ex("Back Squat", 3, 5, 225)]), w(1, [ex("Bench Press", 3, 5, 185)], { new_session: true })]).length, 2);
check("chat-only rows (no exercises, no run) never form a session",
  groupIntoSessions([w(0, []), w(1, [])]).length, 0);
check("out-of-order rows are sorted before grouping",
  groupIntoSessions([w(4, [ex("Bench Press", 3, 5, 185)]), w(0, [ex("Back Squat", 3, 5, 225)])]).length, 2);
check("a run counts as a real session", isRealSession({ parsed_data: { exercises: [], run_data: { distance_miles: 3 } } }), true);
check("an empty row is not a real session", isRealSession({ parsed_data: { exercises: [] } }), false);

console.log("\ntrueImprovementPRs — baselines excluded:");
const pr = (exercise, e1rm, day) => ({ athlete_id: "a1", exercise, estimated_1rm: e1rm, weight: e1rm, reps: 1, created_at: `2026-07-${String(day).padStart(2, "0")}T12:00:00Z` });
check("the first row for a lift is a baseline, not a PR",
  trueImprovementPRs([pr("Back Squat", 300, 1)]).length, 0);
check("a genuine improvement counts",
  trueImprovementPRs([pr("Back Squat", 300, 1), pr("Back Squat", 315, 2)]).map(p => p.exercise), ["Back Squat"]);
check("a regression does not count",
  trueImprovementPRs([pr("Back Squat", 315, 1), pr("Back Squat", 300, 2)]).length, 0);
check("noise under the 0.5 threshold does not count",
  trueImprovementPRs([pr("Back Squat", 300, 1), pr("Back Squat", 300.2, 2)]).length, 0);
check("rows are ordered by date, not array order",
  trueImprovementPRs([pr("Back Squat", 315, 5), pr("Back Squat", 300, 1)]).map(p => p.estimated_1rm), [315]);
check("each lift keeps its own baseline",
  trueImprovementPRs([pr("Back Squat", 300, 1), pr("Bench Press", 200, 2), pr("Bench Press", 210, 3)]).map(p => p.exercise), ["Bench Press"]);

console.log("\ndetectPlateaus — 3+ sessions inside a 2.5lb band:");
const hist = (vals) => ({ "back squat": vals.map((e1rm, i) => ({ e1rm, date: BASE + i * 864e5 })) });
check("three flat sessions flag a plateau", detectPlateaus(hist([300, 301, 300])), ["back squat"]);
check("a climbing lift does not flag", detectPlateaus(hist([300, 310, 320])), []);
check("fewer than 3 sessions never flags", detectPlateaus(hist([300, 300])), []);
check("only the LAST 3 are judged (early spread ignored)", detectPlateaus(hist([250, 300, 301, 300])), ["back squat"]);

console.log("\naggregateInjuries / painTrend — resolved areas excluded:");
const painSession = (area) => [[{ parsed_data: { exercises: [ex("Back Squat", 3, 5, 225)], pain_flags: [{ area }] } }]];
check("an unresolved flag is counted", aggregateInjuries(painSession("knee")).counts, { knee: 1 });
check("a resolved area is excluded", aggregateInjuries(painSession("knee"), ["knee"]).counts, {});
check("resolved matching is case-insensitive", aggregateInjuries(painSession("Knee"), ["knee"]).counts, {});
check("pain appearing only last week reads as clearing",
  painTrend([], painSession("knee")[0] ? painSession("knee") : []).direction, "clearing");
check("more flags than last week reads as worsening",
  painTrend([[{ parsed_data: { exercises: [], pain_flags: [{ area: "knee" }, { area: "hip" }] } }]], painSession("knee")).direction, "worsening");
check("no pain either week reads as steady", painTrend([], []).direction, "steady");

console.log("\nclassifyTiers — strengths vs weaknesses:");
const agg = (n, t) => ({ name: n, avgTier: t });
const ct = classifyTiers([agg("Deadlift", 6), agg("Back Squat", 5), agg("Bench Press", 2), agg("Overhead Press", 1)]);
check("Elite+ (tier>=4) become strengths", ct.strengths.map(s => s.name), ["Deadlift", "Back Squat"]);
check("low tiers become weaknesses", ct.weaknesses.map(s => s.name).includes("Overhead Press"), true);
check("an all-mid roster still gets both lists", (() => {
  const r = classifyTiers([agg("A", 3), agg("B", 3), agg("C", 3)]);
  return r.strengths.length > 0 && r.weaknesses.length > 0;
})(), true);

console.log("\nbuildOneRMs / totalSetVolume:");
check("a manual 1RM overrides the PR estimate",
  buildOneRMs([{ exercise: "Back Squat", estimated_1rm: 300, weight: 300, reps: 1 }],
              [{ exercise: "Back Squat", normalized_exercise: "back squat", weight: 330, unit: "lbs" }])["back squat"], 330);
// NOTE: totalSetVolume counts WORKING SETS, not tonnage — it backs the coach
// dashboard's "working sets" volume card, and warm-ups must not inflate it.
check("volume counts working sets, not tonnage",
  totalSetVolume([[{ parsed_data: { exercises: [ex("Back Squat", 3, 5, 200)] } }]]), 3);
check("warm-up sets are excluded from the count",
  totalSetVolume([[{ parsed_data: { exercises: [{
    ...ex("Back Squat", 5, 5, 225),
    set_details: [
      { weight: 135, reps: 5, warmup: true }, { weight: 185, reps: 5, warmup: true },
      { weight: 225, reps: 5 }, { weight: 225, reps: 5 }, { weight: 225, reps: 5 },
    ],
  }] } }]]), 3);

console.log(`\n${fail === 0 ? "All" : ""} ${pass} proofcore checks pass${fail ? `, ${fail} FAILED` : "."}`);
process.exit(fail === 0 ? 0 : 1);
