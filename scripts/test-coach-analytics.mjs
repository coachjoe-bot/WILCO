// Coach-analytics regression suite — guard rail for src/coachAnalytics.js.
// Run with: node scripts/test-coach-analytics.mjs
//
// Synthetic-fixture checks for the six server-computed team aggregations, so CI
// keeps the module honest without a network. The authoritative parity proof against
// the ORIGINAL client math on full prod data is scripts/verify-coach-analytics.mjs
// (run once before the dashboard switched; re-run after any change to this module).

import assert from "node:assert";
import {
  weekBounds, teamStrengthWeekly, teamRunningWeekly,
  weekFeelDistribution, weekPainFlags, teamMovers, mostImproved60, DAYMS,
} from "../src/coachAnalytics.js";

// Pinned clock: Mon 2026-07-20 15:00 local (tz handled per-test).
const NOW = new Date(2026, 6, 20, 15, 0, 0).getTime();
const H = 3600000;
const at = (daysAgo, hour = 12) => new Date(NOW - daysAgo * DAYMS + (hour - 12) * H).toISOString();
let wid = 0;
const wo = (athlete_id, created_at, parsed_data) => ({ id: `w${++wid}`, athlete_id, created_at, parsed_data });
const lift = (name, weight, reps, extra = {}) => ({ name, weight, reps, sets: 1, unit: "lbs", ...extra });

const A = { id: "a1", name: "Ava", weight_lbs: 150, gender: "female", age: 17, school_id: "s1" };
const B = { id: "b1", name: "Ben", weight_lbs: 200, gender: "male", age: 18, school_id: "s1" };
const roster = [A, B];

let pass = 0;
const check = (name, actual, expected) => {
  try { assert.deepStrictEqual(actual, expected); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n${e.message}`); process.exitCode = 1; }
};

// ── weekBounds: tz-offset path must equal the local path on this machine ──────
{
  const local = weekBounds(NOW);
  const viaTz = weekBounds(NOW, new Date(NOW).getTimezoneOffset());
  check("weekBounds tz path == local path", viaTz, local);
  check("weekBounds Monday start", new Date(local.start).getDay(), 1);
}
const wk = weekBounds(NOW);

// ── teamStrengthWeekly: per-athlete weekly best, averaged; <2 points dropped ──
{
  const rows = [
    wo(A.id, at(10), { exercises: [lift("Back Squat", 200, 5)] }),   // wk10: e1RM 233
    wo(A.id, at(10, 14), { exercises: [lift("Back Squat", 180, 5)] }),// same wk, lower — ignored (max per athlete-week)
    wo(B.id, at(10), { exercises: [lift("back squat", 300, 1)] }),   // wk10: 300 → avg (233+300)/2 = 267 (round)
    wo(A.id, at(3), { exercises: [lift("Squat", 210, 5)] }),         // this wk: 245 — "Squat" must merge into back squat
    wo(A.id, at(80), { exercises: [lift("Bench Press", 100, 5)] }),  // bench: only 1 week → filtered out (<2 points)
  ];
  const s = teamStrengthWeekly(roster, rows, NOW);
  check("strength: one lift survives (needs ≥2 weekly points)", s.map(x => x.key), ["back squat"]);
  check("strength: weekly avg of per-athlete bests + name merge", s[0].points.map(p => ({ y: p.y, n: p.n })), [{ y: 267, n: 2 }, { y: 245, n: 1 }]);
}

// ── teamRunningWeekly: distance sums, pace/hr averages ────────────────────────
{
  const rows = [
    wo(A.id, at(9), { run_data: { distance_miles: 3, pace_per_mile: "8:00", heart_rate_avg: 150 } }),
    wo(B.id, at(9, 14), { run_data: { distance_miles: 2, pace_per_mile: "9:30" } }),
    wo(A.id, at(2), { run_data: { distance_km: 5 } }),
  ];
  const r = teamRunningWeekly(roster, rows, NOW);
  check("running: weekly distance sum + km fallback", r.distSeries.map(p => p.y), [5, 5]);
  check("running: pace averaged in minutes", r.paceSeries.map(p => p.y), [8.75]);
  check("running: hr series only when present", r.hrSeries.map(p => p.y), [150]);
}

// ── weekFeelDistribution: this-week only; out-of-vocab ("hard") dropped ───────
{
  const rows = [
    wo(A.id, at(0, 9), { exercises: [], session_feel: "great" }),
    wo(B.id, at(0, 10), { exercises: [], session_feel: "hard" }),   // stray prod value — not counted
    wo(A.id, at(9), { exercises: [], session_feel: "good" }),       // last week — out of window
  ];
  check("feel: vocab guard + week window", weekFeelDistribution(rows, wk, NOW),
    { feelCounts: { great: 1, good: 0, average: 0, rough: 0 }, feelTotal: 1 });
}

// ── weekPainFlags: this-week flags, joined areas, athlete name ────────────────
{
  const rows = [
    wo(A.id, at(0, 9), { pain_flags: [{ area: "knee" }, { area: "hip" }] }),
    wo(B.id, at(8), { pain_flags: [{ area: "back" }] }),            // last week — excluded
  ];
  const p = weekPainFlags(rows, roster, wk, NOW);
  check("pain: week window + area join", p.map(x => ({ name: x.name, areas: x.areas })), [{ name: "Ava", areas: "knee, hip" }]);
}

// ── teamMovers: avg e1RM delta this week vs last, positive only ───────────────
{
  // NOW is a Monday, so "this week" spans only Monday itself; at(3)/at(5) land in
  // the prior Mon–Sun week (wk.start−7d … wk.start).
  const rows = [
    wo(A.id, at(3), { exercises: [lift("Bench Press", 100, 5)] }),  // last wk: 117
    wo(A.id, at(0, 9), { exercises: [lift("Bench Press", 110, 5)] }),// this wk: 128 → +11
    wo(B.id, at(5), { exercises: [lift("Deadlift", 400, 3)] }),     // last wk: 440
    wo(B.id, at(0, 9), { exercises: [lift("Deadlift", 380, 3)] }),  // this wk: 418 → negative, filtered
  ];
  const m = teamMovers(roster, rows, wk, NOW);
  check("movers: positive deltas only, avg per lift", m, [{ lift: "bench press", avg: 11, n: 1 }]);
}

// ── mostImproved60: current 30d best vs prior 30d best, top 3 by % ────────────
{
  const rows = [
    wo(A.id, at(45), { exercises: [lift("Back Squat", 200, 1)] }),  // prior window: 200
    wo(A.id, at(10), { exercises: [lift("Back Squat", 220, 1)] }),  // current: 220 → +10%
    wo(B.id, at(45), { exercises: [lift("Bench Press", 200, 1)] }),
    wo(B.id, at(10), { exercises: [lift("Bench Press", 300, 1)] }), // +50% → first
  ];
  check("mostImproved: % gain ranking across the 60d windows", mostImproved60(roster, rows, NOW),
    [{ athlete_id: "b1", metric: "+50% est. 1RM" }, { athlete_id: "a1", metric: "+10% est. 1RM" }]);
}

console.log(`\n${process.exitCode ? "FAILED" : `ALL ${pass} CHECKS PASSED`}`);
