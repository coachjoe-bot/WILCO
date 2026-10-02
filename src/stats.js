// ─── T70 STATS — the athlete's career numbers, computed once, stored once ────
// One pure function turns an athlete's raw workout rows into the summary the
// Stats tab, the share card, the monthly Proof numbers block, the 1Y/ALL graph
// ranges and the coach team-totals card all read. The server recomputes it after
// every workouts write (api/_stats.js) and stores it as ONE row per athlete in
// `athlete_stats`, so the app never has to load a 500-row history to say
// "1,284,900 lb moved".
//
// Every number is derived through the SAME helpers the rest of the app uses
// (grit.js / units.js): working sets only, warm-ups out, bodyweight work adds
// sets and reps but no tonnage, a unit-unresolved row adds nothing weight-based,
// e1RM is rep-capped Epley, lifts are merged by the taxonomy. "PRs hit" is the
// Benchmarks hero's own loop, so the two surfaces can never disagree.
// Signup baselines live in `prs`, not here, so they never count (Will, 10-02).
//
// Shape is version-stamped (STATS_VERSION): bump it when the shape changes and
// the nightly rebuild recomputes every athlete.

import { isRealSession, groupIntoSessions, effectiveDate, getExerciseSets, bestE1RMForExercise, resolveLift, sessionTonnage } from "./grit.js";
import { toLbs, exerciseUnit, isUnitPending, LBS_PER_KG } from "./units.js";

export const STATS_VERSION = 1;

// Calendar day in the athlete's own timezone (IANA, from athletes.proof_timezone),
// as "YYYY-MM-DD". Falls back to the runtime's local day when the zone is missing
// or invalid, which on Vercel means UTC — the same day effectiveDate() already
// uses for the session count.
const dayFmtCache = new Map();
export const dayKey = (date, tz) => {
  const key = tz || "";
  let fmt = dayFmtCache.get(key);
  if (!fmt) {
    try { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit" }); }
    catch { fmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }); }
    dayFmtCache.set(key, fmt);
  }
  return fmt.format(date);
};

// Day arithmetic on "YYYY-MM-DD" keys, done in UTC so DST never shifts a key.
const keyToUtc = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const utcToKey = (ms) => new Date(ms).toISOString().slice(0, 10);
export const shiftDay = (k, days) => utcToKey(keyToUtc(k) + days * 864e5);
// Week key = the Sunday that starts the week (the app's week turns on Sunday).
export const weekKey = (k) => shiftDay(k, -new Date(keyToUtc(k)).getUTCDay());
const monthKey = (k) => k.slice(0, 7);

const workingSets = (ex) => {
  const all = getExerciseSets(ex);
  return all.some((s) => !s.warmup) ? all.filter((s) => !s.warmup) : all;
};

const getPD = (w) => {
  const pd = w?.parsed_data;
  if (typeof pd === "string") { try { return JSON.parse(pd); } catch { return {}; } }
  return pd || {};
};

// ── the compute ──────────────────────────────────────────────────────────────
// workouts: raw rows (id, athlete_id, created_at, parsed_data, duration_seconds).
// opts.bodyweightLbs scores load-bearing bodyweight lifts (pull-ups, dips) for
// e1RM / PRs exactly as the Benchmarks tab does; opts.tz is the athlete's zone.
export function computeAthleteStats(workouts, opts = {}) {
  const bw = Number(opts.bodyweightLbs) || 0;
  const tz = opts.tz || null;
  const rows = (workouts || []).filter(isRealSession);
  const sorted = [...rows].sort((a, b) => effectiveDate(a) - effectiveDate(b));

  const days = new Map();   // dayKey -> day totals
  const lifts = new Map();  // lift id -> lifetime per-lift totals + per-day tuples
  const day = (k) => {
    let d = days.get(k);
    if (!d) { d = { d: k, sessions: 0, sets: 0, reps: 0, tonnage: 0, prs: 0, duration_s: 0, runs: 0, miles: 0 }; days.set(k, d); }
    return d;
  };
  const lift = (id, name, tracked) => {
    let l = lifts.get(id);
    if (!l) { l = { id, name, tracked, sets: 0, reps: 0, tonnage: 0, e1rm: 0, heaviest: 0, prs: 0, first: null, last: null, days: new Map() }; lifts.set(id, l); }
    return l;
  };

  // Per-exercise accumulation. One pass, chronological, so the PR loop below can
  // share it (first best counts; a later best must clear the old one by 0.5 lb,
  // byte-for-byte the Benchmarks hero's rule in grit.js computeGritSnapshot).
  const best = {};
  let prsHit = 0;
  for (const w of sorted) {
    const pd = getPD(w);
    const k = dayKey(effectiveDate(w), tz);
    const d = day(k);
    for (const ex of pd.exercises || []) {
      if (!ex || !ex.name) continue;
      const r = resolveLift(ex.name);
      const l = lift(r.id, r.name || ex.name, !!r.tracked);
      const pending = isUnitPending(ex);
      const isBW = exerciseUnit(ex) === "bodyweight";
      const sets = workingSets(ex);
      let exSets = 0, exReps = 0, exTon = 0, exHeavy = 0;
      for (const s of sets) {
        exSets++;
        const reps = Number(s.reps) || 0;
        if (reps > 0) exReps += reps;
        if (pending || isBW) continue;
        const lbs = toLbs(Number(s.weight) || 0, ex.unit);
        if (lbs > 0 && reps > 0) { exTon += lbs * reps; if (lbs > exHeavy) exHeavy = lbs; }
      }
      const e1 = pending ? 0 : bestE1RMForExercise(ex, bw);
      let pr = 0;
      if (r.tracked && e1) {
        if (!(r.id in best)) { best[r.id] = e1; pr = 1; }
        else if (e1 > best[r.id] + 0.5) { best[r.id] = e1; pr = 1; }
      }
      prsHit += pr;
      d.sets += exSets; d.reps += exReps; d.prs += pr;
      l.sets += exSets; l.reps += exReps; l.tonnage += exTon; l.prs += pr;
      if (e1 > l.e1rm) l.e1rm = e1;
      if (exHeavy > l.heaviest) l.heaviest = exHeavy;
      if (!l.first) l.first = k;
      l.last = k;
      let t = l.days.get(k);
      if (!t) { t = { sets: 0, reps: 0, tonnage: 0, e1rm: 0, heaviest: 0, prs: 0 }; l.days.set(k, t); }
      t.sets += exSets; t.reps += exReps; t.tonnage += exTon; t.prs += pr;
      if (e1 > t.e1rm) t.e1rm = e1;
      if (exHeavy > t.heaviest) t.heaviest = exHeavy;
    }
  }

  // Sessions: the app's own grouping (3-hour gap, new_session flag). Tonnage per
  // session goes through sessionTonnage so the Stats hero and the My Log session
  // card add up the same way.
  let biggestSession = null;
  for (const s of groupIntoSessions(sorted)) {
    const first = s.entries[0];
    const k = dayKey(effectiveDate(first), tz);
    const d = day(k);
    d.sessions++;
    const exercises = s.entries.flatMap((e) => getPD(e).exercises || []);
    const ton = sessionTonnage(exercises);
    d.tonnage += ton;
    for (const e of s.entries) {
      const dur = Number(e.duration_seconds) || 0;
      if (dur > 0) d.duration_s += dur;
      const run = getPD(e).run_data;
      if (run && typeof run === "object") {
        d.runs++;
        const mi = Number(run.distance_miles) || (Number(run.distance_km) || 0) / 1.609344;
        if (mi > 0) d.miles += mi;
      }
    }
    if (!biggestSession || ton > biggestSession.tonnage) biggestSession = { d: k, tonnage: ton };
  }

  const dayList = [...days.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
  const lifetime = {
    sessions: 0, sets: 0, reps: 0, tonnage: 0, prs: prsHit, duration_s: 0, runs: 0, miles: 0,
    first_day: dayList[0]?.d || null, last_day: dayList[dayList.length - 1]?.d || null,
    biggest_session: biggestSession,
    biggest_month: null,
    longest_streak_weeks: 0,
    current_streak_weeks: 0,
  };
  const months = new Map();
  const weeks = new Set();
  for (const d of dayList) {
    d.tonnage = Math.round(d.tonnage); d.miles = Math.round(d.miles * 100) / 100;
    lifetime.sessions += d.sessions; lifetime.sets += d.sets; lifetime.reps += d.reps;
    lifetime.tonnage += d.tonnage; lifetime.duration_s += d.duration_s; lifetime.runs += d.runs; lifetime.miles += d.miles;
    if (d.sessions > 0) weeks.add(weekKey(d.d));
    const mk = monthKey(d.d);
    let m = months.get(mk);
    if (!m) { m = { m: mk, sessions: 0, sets: 0, reps: 0, tonnage: 0, prs: 0 }; months.set(mk, m); }
    m.sessions += d.sessions; m.sets += d.sets; m.reps += d.reps; m.tonnage += d.tonnage; m.prs += d.prs;
  }
  lifetime.miles = Math.round(lifetime.miles * 100) / 100;
  const monthList = [...months.values()].sort((a, b) => (a.m < b.m ? -1 : 1));
  for (const m of monthList) {
    const b = lifetime.biggest_month;
    if (!b || m.sessions > b.sessions || (m.sessions === b.sessions && m.tonnage > b.tonnage)) lifetime.biggest_month = { ...m };
  }
  // Streaks: consecutive calendar weeks (Sunday start) with at least one session.
  const weekList = [...weeks].sort();
  let run = 0, longest = 0, prev = null;
  for (const wk of weekList) {
    run = prev && shiftDay(prev, 7) === wk ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = wk;
  }
  lifetime.longest_streak_weeks = longest;
  // "Current" = the streak is alive if it reaches this week or last week.
  const nowKey = dayKey(opts.now ? new Date(opts.now) : new Date(), tz);
  const thisWeek = weekKey(nowKey);
  lifetime.current_streak_weeks = prev && (prev === thisWeek || shiftDay(prev, 7) === thisWeek) ? run : 0;

  const liftList = [...lifts.values()].map((l) => ({
    id: l.id, name: l.name, tracked: l.tracked,
    sets: l.sets, reps: l.reps, tonnage: Math.round(l.tonnage), e1rm: Math.round(l.e1rm), heaviest: Math.round(l.heaviest), prs: l.prs,
    first: l.first, last: l.last,
    // Compact per-day tuples: [day, sets, reps, tonnage, e1rm, heaviest, prs]
    days: [...l.days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, t]) => [k, t.sets, t.reps, Math.round(t.tonnage), Math.round(t.e1rm), Math.round(t.heaviest), t.prs]),
  })).sort((a, b) => b.sets - a.sets || b.tonnage - a.tonnage);

  return {
    version: STATS_VERSION,
    tz: tz || null,
    source_rows: (workouts || []).length,
    lifetime,
    days: dayList,
    months: monthList,
    lifts: liftList,
  };
}

// ── range views ──────────────────────────────────────────────────────────────
// 1M / 3M / 1Y / ALL over the stored summary. Day granularity, so "this month"
// is exactly the last 30 days and never a rounded week. Returns the same keys
// the lifetime block has, plus the per-lift list for the window (sets-desc, so
// [0] is the favorite) and the best lift by e1RM.
export const RANGES = { "1M": 30, "3M": 91, "1Y": 365, "ALL": null };

export function statsInRange(stats, range = "ALL", opts = {}) {
  const span = RANGES[range] === undefined ? null : RANGES[range];
  const tz = stats?.tz || opts.tz || null;
  const nowKey = dayKey(opts.now ? new Date(opts.now) : new Date(), tz);
  const from = span == null ? null : shiftDay(nowKey, -(span - 1));
  const inWin = (k) => !from || k >= from;
  const out = { range, from, to: nowKey, sessions: 0, sets: 0, reps: 0, tonnage: 0, prs: 0, duration_s: 0, runs: 0, miles: 0, training_days: 0, biggest_session: null, lifts: [], best_lift: null, favorite: null };
  if (!stats) return out;
  if (!from) {
    Object.assign(out, {
      sessions: stats.lifetime.sessions, sets: stats.lifetime.sets, reps: stats.lifetime.reps, tonnage: stats.lifetime.tonnage,
      prs: stats.lifetime.prs, duration_s: stats.lifetime.duration_s, runs: stats.lifetime.runs, miles: stats.lifetime.miles,
      training_days: stats.days.length, biggest_session: stats.lifetime.biggest_session,
    });
    out.lifts = stats.lifts.map((l) => ({ id: l.id, name: l.name, tracked: l.tracked, sets: l.sets, reps: l.reps, tonnage: l.tonnage, e1rm: l.e1rm, heaviest: l.heaviest, prs: l.prs }));
  } else {
    for (const d of stats.days) {
      if (!inWin(d.d)) continue;
      out.training_days++;
      out.sessions += d.sessions; out.sets += d.sets; out.reps += d.reps; out.tonnage += d.tonnage; out.prs += d.prs;
      out.duration_s += d.duration_s; out.runs += d.runs; out.miles += d.miles;
      if (d.sessions && (!out.biggest_session || d.tonnage > out.biggest_session.tonnage)) out.biggest_session = { d: d.d, tonnage: d.tonnage };
    }
    out.miles = Math.round(out.miles * 100) / 100;
    for (const l of stats.lifts) {
      const acc = { id: l.id, name: l.name, tracked: l.tracked, sets: 0, reps: 0, tonnage: 0, e1rm: 0, heaviest: 0, prs: 0 };
      for (const t of l.days) {
        if (!inWin(t[0])) continue;
        acc.sets += t[1]; acc.reps += t[2]; acc.tonnage += t[3]; acc.prs += t[6];
        if (t[4] > acc.e1rm) acc.e1rm = t[4];
        if (t[5] > acc.heaviest) acc.heaviest = t[5];
      }
      if (acc.sets > 0) out.lifts.push(acc);
    }
    out.lifts.sort((a, b) => b.sets - a.sets || b.tonnage - a.tonnage);
  }
  out.favorite = out.lifts[0] || null;
  out.best_lift = out.lifts.filter((l) => l.tracked && l.e1rm > 0).sort((a, b) => b.e1rm - a.e1rm)[0] || null;
  return out;
}

// Weekly points for one lift across the whole history (the 1Y/ALL graph series):
// the week's best e1RM, one point per week that has the lift.
export function liftWeeklySeries(stats, liftId, { range = "ALL", now, metric = "e1rm" } = {}) {
  const l = (stats?.lifts || []).find((x) => x.id === liftId);
  if (!l) return [];
  const span = RANGES[range] === undefined ? null : RANGES[range];
  const nowKey = dayKey(now ? new Date(now) : new Date(), stats.tz || null);
  const from = span == null ? null : shiftDay(nowKey, -(span - 1));
  const idx = metric === "heaviest" ? 5 : metric === "tonnage" ? 3 : 4;
  const byWeek = new Map();
  for (const t of l.days) {
    if (from && t[0] < from) continue;
    if (!(t[idx] > 0)) continue;
    const wk = weekKey(t[0]);
    const cur = byWeek.get(wk);
    byWeek.set(wk, metric === "tonnage" ? (cur || 0) + t[idx] : Math.max(cur || 0, t[idx]));
  }
  return [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([w, y]) => ({ week: w, y }));
}

// ── comparisons ──────────────────────────────────────────────────────────────
// "That is 51 school buses." One object per number, chosen so the count reads
// as a count (at least 2 of something, the biggest thing that still gives 2).
// Weights are the commonly quoted figures, rounded; the point is scale, not
// a spec sheet. kg athletes get the same objects in kg.
export const COMPARISON_OBJECTS = [
  { lbs: 600, one: "a grizzly bear", many: "grizzly bears" },
  { lbs: 1000, one: "a grand piano", many: "grand pianos" },
  { lbs: 4700, one: "a pickup truck", many: "pickup trucks" },
  { lbs: 13000, one: "an African elephant", many: "African elephants" },
  { lbs: 25000, one: "a school bus", many: "school buses" },
  { lbs: 165000, one: "a Space Shuttle orbiter", many: "Space Shuttle orbiters" },
  { lbs: 300000, one: "a blue whale", many: "blue whales" },
  { lbs: 450000, one: "the Statue of Liberty", many: "Statues of Liberty" },
  { lbs: 970000, one: "a loaded Boeing 747", many: "loaded Boeing 747s" },
  { lbs: 10000000, one: "the Eiffel Tower", many: "Eiffel Towers" },
];

// Among objects that give a count of at least 2, take the one whose count sits
// nearest 30 on a log scale: "51 school buses" beats "2.9 Statues of Liberty"
// (too few to picture) and "273 pickup trucks" (too many to picture).
const COMPARISON_TARGET = Math.log(30);
export function tonnageComparison(lbs, { unit = "lbs" } = {}) {
  const v = Number(lbs) || 0;
  let pick = null, bestDist = Infinity;
  for (const o of COMPARISON_OBJECTS) {
    const raw = v / o.lbs;
    if (raw < 2) continue;
    const dist = Math.abs(Math.log(raw) - COMPARISON_TARGET);
    if (dist < bestDist) { bestDist = dist; pick = o; }
  }
  if (!pick) return null;
  const raw = v / pick.lbs;
  const count = raw >= 10 ? Math.round(raw) : Math.round(raw * 10) / 10;
  const label = count === 1 ? pick.one : pick.many;
  const objectWeight = unit === "kg" ? Math.round(pick.lbs / LBS_PER_KG) : pick.lbs;
  return { count, label, text: `${count} ${label}`, object: pick.one, objectWeight, unit };
}

// A session count that honors the thin-history rule (Will 10-02): best lift,
// favorite exercise and the share card unlock at 10 sessions; streak and
// biggest month need a full month on the books.
export const STATS_UNLOCK_SESSIONS = 10;
export const statsUnlocked = (stats) => (stats?.lifetime?.sessions || 0) >= STATS_UNLOCK_SESSIONS;
