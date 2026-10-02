// T70 Stats regression suite — the guard rail for src/stats.js.
// Run with: node scripts/test-stats.mjs
//
// These numbers go on a share card with the athlete's name on it, so the rules
// that decide them get a case each: working sets only, warm-ups out, kg rows
// converted once, bodyweight work counts sets and reps but no tonnage, a
// unit-unresolved row adds nothing weight-based, PRs hit matches the Benchmarks
// hero's loop, sessions follow the 3-hour grouping, ranges are exact to the day,
// streaks follow Sunday-start weeks, comparisons pick a readable object.

import { computeAthleteStats, statsInRange, liftWeeklySeries, tonnageComparison, weekKey, shiftDay, dayKey, STATS_VERSION, monthNumbers, weeklyMiles } from "../src/stats.js";
import { sessionTonnage, groupIntoSessions, computeGritSnapshot } from "../src/grit.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("  ✗ " + msg); } };
const eq = (got, want, msg) => ok(Object.is(got, want), `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (got, want, tol, msg) => ok(Math.abs(got - want) <= tol, `${msg}: got ${got}, want ${want}±${tol}`);

const TZ = "America/New_York";
const NOW = "2026-10-02T16:00:00Z";
let seq = 0;
// A workout row at a given UTC time with exercises. Times are chosen midday so
// the New York calendar day is unambiguous.
const W = (iso, exercises, extra = {}) => ({
  id: "w" + (++seq), athlete_id: "a1", created_at: iso,
  parsed_data: { exercises, ...(extra.parsed_data || {}) },
  ...(extra.duration_seconds ? { duration_seconds: extra.duration_seconds } : {}),
});
const EX = (name, sets, reps, weight, unit = "lbs", more = {}) => ({ name, sets, reps, weight, unit, ...more });

// ── tonnage rules ─────────────────────────────────────────────────────────────
{
  const rows = [W("2026-09-01T16:00:00Z", [EX("Bench Press", 3, 5, 200)])];
  const s = computeAthleteStats(rows, { tz: TZ, now: NOW });
  eq(s.version, STATS_VERSION, "version stamped");
  eq(s.lifetime.tonnage, 3000, "3x5 at 200 = 3000 lb");
  eq(s.lifetime.sets, 3, "sets counted");
  eq(s.lifetime.reps, 15, "reps counted");
  eq(s.lifetime.sessions, 1, "one session");
  eq(s.lifetime.tonnage, sessionTonnage(rows[0].parsed_data.exercises), "tonnage equals the session card's number");
}
{
  // kg row converts once; a warm-up set is excluded from tonnage AND sets.
  const rows = [W("2026-09-01T16:00:00Z", [EX("Back Squat", null, null, null, "kg", { set_details: [{ weight: 60, reps: 5, warmup: true }, { weight: 100, reps: 5 }, { weight: 100, reps: 5 }] })])];
  const s = computeAthleteStats(rows, { tz: TZ, now: NOW });
  near(s.lifetime.tonnage, 2 * 5 * 100 * 2.20462, 1, "kg working sets converted once, warm-up excluded");
  eq(s.lifetime.sets, 2, "warm-up not a working set");
  eq(s.lifetime.reps, 10, "warm-up reps not counted");
  near(s.lifts[0].heaviest, 220, 1, "heaviest in lbs-equivalent");
}
{
  // Bodyweight work: sets and reps count, tonnage does not.
  const rows = [W("2026-09-01T16:00:00Z", [EX("Push-ups", 4, 20, 0, "bodyweight")])];
  const s = computeAthleteStats(rows, { tz: TZ, now: NOW });
  eq(s.lifetime.tonnage, 0, "bodyweight adds no tonnage");
  eq(s.lifetime.sets, 4, "bodyweight sets count");
  eq(s.lifetime.reps, 80, "bodyweight reps count");
  eq(s.lifetime.prs, 0, "push-ups never a PR");
}
{
  // Unit-unresolved row: nothing weight-based, sets/reps still facts.
  const rows = [W("2026-09-01T16:00:00Z", [EX("Deadlift", 3, 3, 180, "lbs", { unit_suspect: true })])];
  const s = computeAthleteStats(rows, { tz: TZ, now: NOW });
  eq(s.lifetime.tonnage, 0, "pending unit adds no tonnage");
  eq(s.lifts[0].e1rm, 0, "pending unit sets no e1RM");
  eq(s.lifetime.prs, 0, "pending unit is not a PR");
  eq(s.lifetime.sets, 3, "pending unit still counts sets");
}
{
  // Weight 0 / reps 0 sets add nothing.
  const rows = [W("2026-09-01T16:00:00Z", [EX("Bench Press", 2, 0, 200), EX("Bench Press", 1, 5, 0)])];
  const s = computeAthleteStats(rows, { tz: TZ, now: NOW });
  // Legacy flat fields default reps to 1 (getExerciseSets), so "2 sets at 200" with
  // no reps still moves 400 lb. The point is agreement with the session card.
  eq(s.lifetime.tonnage, sessionTonnage(rows[0].parsed_data.exercises), "legacy no-reps rows agree with sessionTonnage");
  eq(s.lifetime.tonnage, 400, "zero weight adds nothing; missing reps default to 1");
}

// ── PRs hit = the Benchmarks hero's loop ──────────────────────────────────────
{
  const rows = [
    W("2026-08-03T16:00:00Z", [EX("Bench Press", 3, 5, 185)]),          // first best counts
    W("2026-08-10T16:00:00Z", [EX("Bench Press", 3, 5, 185)]),          // same: no PR
    W("2026-08-17T16:00:00Z", [EX("Bench Press", 3, 5, 195)]),          // better: PR
    W("2026-08-24T16:00:00Z", [EX("Bench Press", 1, 20, 135)]),         // 20 reps: over the rep cap, never a PR
    W("2026-08-31T16:00:00Z", [EX("Band Pull-apart", 3, 12, 20)]),      // any known lift's first e1RM counts (the hero's rule)
    W("2026-09-07T16:00:00Z", [EX("Back Squat", 3, 5, 275)]),           // first squat: PR
  ];
  const s = computeAthleteStats(rows, { tz: TZ, now: NOW });
  eq(s.lifetime.prs, 4, "4 PRs: first bench, bench up, first pull-apart, first squat (20-rep bench never counts)");
  const snap = computeGritSnapshot(rows, [], { bodyweightLbs: 180 });
  eq(s.lifetime.prs, snap.prsHit, "matches computeGritSnapshot.prsHit");
  const bench = s.lifts.find((l) => l.id === s.lifts.find((x) => /bench/i.test(x.name)).id);
  eq(bench.prs, 2, "per-lift PR count");
  eq(bench.days.length, 4, "one tuple per day the lift was logged");
  eq(bench.days[2][6], 1, "PR flagged on the day it happened");
  ok(s.lifts.every((l) => typeof l.tracked === "boolean"), "tracked flag carried on every lift");
}
{
  // Bodyweight pull-ups score a PR only with a bodyweight given.
  const rows = [W("2026-09-01T16:00:00Z", [EX("Pull-ups", 3, 8, 0, "bodyweight")])];
  eq(computeAthleteStats(rows, { tz: TZ, now: NOW }).lifetime.prs, 0, "no bodyweight: pull-ups no PR");
  eq(computeAthleteStats(rows, { tz: TZ, now: NOW, bodyweightLbs: 180 }).lifetime.prs, 1, "with bodyweight: pull-ups PR");
}

// ── sessions, days, months, streaks ───────────────────────────────────────────
{
  const rows = [
    W("2026-09-01T16:00:00Z", [EX("Bench Press", 3, 5, 200)], { duration_seconds: 3600 }),
    W("2026-09-01T17:00:00Z", [EX("Row", 3, 10, 100)]),                  // same session (1h gap)
    W("2026-09-01T23:30:00Z", [EX("Curl", 3, 10, 30)]),                  // 7:30pm NY, >3h gap: 2nd session, same NY day
    W("2026-09-03T16:00:00Z", [], { parsed_data: { exercises: [], run_data: { distance_miles: 3.1 } } }),
    W("2026-09-05T03:30:00Z", [EX("Deadlift", 1, 5, 315)]),             // 11:30pm NY on Sep 4
    W("2026-09-15T16:00:00Z", [EX("Deadlift", 1, 5, 315)]),
    W("2026-09-29T16:00:00Z", [EX("Deadlift", 1, 5, 335)]),
  ];
  const s = computeAthleteStats(rows, { tz: TZ, now: NOW });
  eq(s.lifetime.sessions, groupIntoSessions(rows).length, "sessions = groupIntoSessions");
  eq(s.lifetime.sessions, 6, "6 sessions");
  const d1 = s.days.find((d) => d.d === "2026-09-01");
  eq(d1.sessions, 2, "two sessions on Sep 1 (NY day)");
  eq(d1.tonnage, 3000 + 3000 + 900, "day tonnage sums both sessions");
  eq(d1.duration_s, 3600, "duration summed where stamped");
  eq(s.days.find((d) => d.d === "2026-09-04")?.sessions, 1, "11:30pm UTC+ row lands on the NY day");
  eq(s.days.find((d) => d.d === "2026-09-03")?.runs, 1, "run counted");
  eq(s.lifetime.miles, 3.1, "miles summed");
  eq(s.lifetime.first_day, "2026-09-01", "first day");
  eq(s.lifetime.last_day, "2026-09-29", "last day");
  eq(s.lifetime.biggest_session.d, "2026-09-01", "biggest session day");
  eq(s.lifetime.biggest_session.tonnage, 6000, "biggest session = one session, not the day");
  eq(s.months.length, 1, "one month");
  eq(s.lifetime.biggest_month.m, "2026-09", "biggest month");
  eq(s.lifetime.biggest_month.sessions, 6, "biggest month sessions");
  // Weeks (Sunday start): Aug 30, Sep 13, Sep 27 → no two consecutive except... Aug30 week holds Sep1,3,4; Sep13 week; Sep27 week.
  eq(s.lifetime.longest_streak_weeks, 1, "no consecutive weeks");
  eq(s.lifetime.current_streak_weeks, 1, "last week trained = current streak alive (now Oct 2, this week starts Sep 27)");
}
{
  // A 4-week streak, then a gap, then 2 weeks.
  const rows = ["2026-08-04", "2026-08-11", "2026-08-18", "2026-08-25", "2026-09-15", "2026-09-22"].map((d) => W(`${d}T16:00:00Z`, [EX("Bench Press", 3, 5, 200)]));
  const s = computeAthleteStats(rows, { tz: TZ, now: NOW });
  eq(s.lifetime.longest_streak_weeks, 4, "longest streak 4");
  eq(s.lifetime.current_streak_weeks, 2, "last trained week Sep 20, now in the week of Sep 27 → still alive at 2");
}
{
  // Same, but "now" inside the week right after the last trained week keeps it alive.
  const rows = ["2026-09-15", "2026-09-22"].map((d) => W(`${d}T16:00:00Z`, [EX("Bench Press", 3, 5, 200)]));
  const s = computeAthleteStats(rows, { tz: TZ, now: "2026-10-01T16:00:00Z" });
  eq(s.lifetime.current_streak_weeks, 2, "streak alive through the following week");
  const s2 = computeAthleteStats(rows, { tz: TZ, now: "2026-10-08T16:00:00Z" });
  eq(s2.lifetime.current_streak_weeks, 0, "streak dead two weeks later");
}
{
  eq(weekKey("2026-10-02"), "2026-09-27", "Friday Oct 2 → week of Sun Sep 27");
  eq(weekKey("2026-09-27"), "2026-09-27", "Sunday is its own week start");
  eq(shiftDay("2026-03-08", 1), "2026-03-09", "DST day arithmetic");
  eq(dayKey(new Date("2026-09-05T03:30:00Z"), TZ), "2026-09-04", "dayKey in zone");
  eq(dayKey(new Date("2026-09-05T03:30:00Z"), "Not/AZone"), dayKey(new Date("2026-09-05T03:30:00Z"), null), "bad zone falls back");
}

// ── ranges ───────────────────────────────────────────────────────────────────
{
  const rows = [
    W("2026-04-20T16:00:00Z", [EX("Bench Press", 3, 5, 150)]),
    W("2026-07-10T16:00:00Z", [EX("Bench Press", 3, 5, 185), EX("Back Squat", 5, 5, 225)]),
    W("2026-09-03T16:00:00Z", [EX("Bench Press", 3, 5, 200)]),   // exactly 30 days before Oct 2 → inside 1M
    W("2026-09-02T16:00:00Z", [EX("Back Squat", 3, 5, 275)]),    // 31 days before → outside 1M
    W("2026-09-25T16:00:00Z", [EX("Bench Press", 3, 3, 225), EX("Back Squat", 2, 5, 285)]),
  ];
  const s = computeAthleteStats(rows, { tz: TZ, now: NOW, bodyweightLbs: 180 });
  const all = statsInRange(s, "ALL", { now: NOW });
  eq(all.sessions, 5, "ALL sessions");
  eq(all.tonnage, s.lifetime.tonnage, "ALL tonnage = lifetime");
  eq(all.favorite.name.toLowerCase().includes("bench"), true, "favorite by sets = bench (12 sets)");
  const m1 = statsInRange(s, "1M", { now: NOW });
  eq(m1.from, "2026-09-03", "1M window starts 30 days ago inclusive");
  eq(m1.sessions, 2, "1M sessions");
  eq(m1.tonnage, 3000 + 3 * 3 * 225 + 2 * 5 * 285, "1M tonnage exact to the day");
  eq(m1.lifts.length, 2, "1M lifts");
  eq(m1.favorite.name.toLowerCase().includes("bench"), true, "1M favorite bench (6 sets vs 2)");
  eq(m1.best_lift.name.toLowerCase().includes("squat"), true, "1M best lift by e1RM = squat");
  eq(m1.best_lift.e1rm, Math.round(285 * (1 + 5 / 30)), "1M best e1RM");
  eq(m1.prs, 3, "1M PRs: bench 200 (over Jul's 185), bench 225, squat 285 (over Sep 2's 275)");
  const m3 = statsInRange(s, "3M", { now: NOW });
  eq(m3.sessions, 4, "3M sessions (Jul 10 is 84 days back)");
  const y1 = statsInRange(s, "1Y", { now: NOW });
  eq(y1.sessions, 5, "1Y sessions");
  const empty = statsInRange(null, "1M", { now: NOW });
  eq(empty.sessions, 0, "null stats → zeros");
  eq(empty.favorite, null, "null stats → no favorite");
}
{
  // Weekly series for the long graph: week's best e1RM, one point per week.
  const rows = [
    W("2026-09-01T16:00:00Z", [EX("Bench Press", 3, 5, 185)]),
    W("2026-09-03T16:00:00Z", [EX("Bench Press", 3, 5, 195)]),  // same week → one point, the higher
    W("2026-09-15T16:00:00Z", [EX("Bench Press", 3, 5, 205)]),
  ];
  const s = computeAthleteStats(rows, { tz: TZ, now: NOW });
  const bench = s.lifts[0];
  const pts = liftWeeklySeries(s, bench.id, { now: NOW });
  eq(pts.length, 2, "two weeks → two points");
  eq(pts[0].week, "2026-08-30", "first week key");
  eq(pts[0].y, Math.round(195 * (1 + 5 / 30)), "week best e1RM");
  eq(liftWeeklySeries(s, bench.id, { now: NOW, metric: "tonnage" })[0].y, 3 * 5 * 185 + 3 * 5 * 195, "tonnage metric sums the week");
  eq(liftWeeklySeries(s, "nope", { now: NOW }).length, 0, "unknown lift → empty");
}

// ── comparisons ──────────────────────────────────────────────────────────────
{
  eq(tonnageComparison(1100), null, "under two of the smallest object → nothing");
  eq(tonnageComparison(1284900).text, "51 school buses", "1.28M lb → school buses, whole number");
  eq(tonnageComparison(98400).text, "21 pickup trucks", "98k lb → pickup trucks");
  eq(tonnageComparison(18250).text, "30 grizzly bears", "18k lb → bears (3.9 trucks is too few to picture)");
  eq(tonnageComparison(2140600).text, "13 Space Shuttle orbiters", "2.1M lb → shuttles");
  eq(tonnageComparison(9000).text, "15 grizzly bears", "9k lb → bears");
  eq(tonnageComparison(4000).text, "6.7 grizzly bears", "under 10 → one decimal");
  eq(tonnageComparison(1284900, { unit: "kg" }).objectWeight, 11340, "kg object weight");
}

// ── monthly numbers + weekly miles ───────────────────────────────────────────
{
  const mk = (d, w) => W(`${d}T16:00:00Z`, [EX("Bench Press", 3, 5, w)]);
  const rows = [
    mk("2026-08-05", 185), mk("2026-08-12", 185), mk("2026-08-19", 190), mk("2026-08-26", 190),   // previous 30 days (Aug 4 .. Sep 2)
    mk("2026-09-08", 195), mk("2026-09-15", 200), mk("2026-09-22", 205), mk("2026-09-29", 210),   // this 30 days (Sep 3 .. Oct 2)
    W("2026-09-20T16:00:00Z", [], { parsed_data: { exercises: [], run_data: { distance_miles: 4 } } }),
    W("2026-09-21T16:00:00Z", [], { parsed_data: { exercises: [], run_data: { distance_km: 8.04672 } } }),
  ];
  const s = computeAthleteStats(rows, { tz: TZ, now: NOW });
  const m = monthNumbers(s, { now: NOW });
  eq(m.sessions, 6, "this month: 4 lifts + 2 runs");
  eq(m.sessions_prev, 4, "last month: 4");
  eq(m.tonnage, 15 * (195 + 200 + 205 + 210), "this month tonnage");
  eq(m.tonnage_prev, 15 * (185 + 185 + 190 + 190), "last month tonnage");
  eq(m.prs, 4, "four rising benches = four PRs this month");
  eq(m.favorite, "Bench Press", "favorite");
  eq(m.best_lift.e1rm, Math.round(210 * (1 + 5 / 30)), "best lift this month");
  eq(m.comparison.text, "20 grizzly bears", "comparison attached");
  eq(monthNumbers(computeAthleteStats(rows.slice(0, 3), { tz: TZ, now: NOW }), { now: NOW }), null, "thin month → no block");
  eq(monthNumbers(null), null, "no stats → null");
  const wm = weeklyMiles(s, "ALL", { now: NOW });
  eq(wm.length, 1, "two runs in one week → one point");
  eq(wm[0].y, 9, "miles summed, km converted");
  eq(weeklyMiles(s, "1M", { now: "2026-11-15T12:00:00Z" }).length, 0, "out of range → none");
}

// ── empty / malformed input ───────────────────────────────────────────────────
{
  const s = computeAthleteStats([], { tz: TZ, now: NOW });
  eq(s.lifetime.sessions, 0, "empty history");
  eq(s.lifetime.first_day, null, "no first day");
  eq(s.lifetime.biggest_session, null, "no biggest session");
  eq(s.lifetime.longest_streak_weeks, 0, "no streak");
  const chatOnly = computeAthleteStats([{ id: "c", athlete_id: "a1", created_at: "2026-09-01T16:00:00Z", parsed_data: { exercises: [], general_notes: "hi" } }], { tz: TZ, now: NOW });
  eq(chatOnly.lifetime.sessions, 0, "chat-only row is not a session");
  eq(chatOnly.source_rows, 1, "but it is a source row");
  const strPd = computeAthleteStats([{ id: "s", athlete_id: "a1", created_at: "2026-09-01T16:00:00Z", parsed_data: { exercises: [{ name: "Bench Press", sets: 1, reps: 1, weight: 100 }] } }], { tz: TZ, now: NOW });
  eq(strPd.lifetime.tonnage, 100, "legacy row without unit reads as lbs");
}

console.log(`\nstats: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
