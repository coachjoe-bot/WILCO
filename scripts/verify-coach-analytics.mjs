// ─── Row-for-row verification: coachAnalytics module vs the original client math ─
// READ-ONLY. Mirrors the discipline used for v_athlete_session_counts: before the
// dashboard switches to server-computed team analytics, prove on FULL PROD DATA that
// src/coachAnalytics.js reproduces the exact numbers the client's inline expressions
// produced. The ORACLE below is a verbatim copy of the pre-refactor src/coach.jsx
// blocks (GroupProgress strength/running; CoachOverview feel/pain/movers; the school
// leaderboard's Most Improved) — do not "fix" it; it must stay the original code.
//
// Usage: node --env-file=.env scripts/verify-coach-analytics.mjs
// (run from repo root; .env needs VITE_SUPABASE_URL + SUPABASE_SERVICE_KEY)

import assert from "node:assert";
import { sbSelect } from "../api/_supa.js";
import { bestE1RMForExercise, normalizeExName, resolveLift, liftTier } from "../src/grit.js";
import { groupIntoSessions as pcGroup, buildLiftHistory } from "../src/proofcore.js";
import {
  weekBounds, teamStrengthWeekly, teamRunningWeekly,
  weekFeelDistribution, weekPainFlags, teamMovers, mostImproved60, DAYMS,
} from "../src/coachAnalytics.js";

const enc = encodeURIComponent;

// ── fetch prod data exactly the way the dashboard's loadAll does ──────────────
const PAGE = 1000;
async function paged(table, base) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await sbSelect(table, `${base}&limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(page) || !page.length) break;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

const NOW = Date.now(); // one pinned now for every computation
const since = new Date(NOW - 90 * 864e5).toISOString();
const athletes = await paged("athletes", "?order=created_at.desc,id.desc&select=id,name,weight_lbs,gender,age,school_id,coach_id");
const workouts = await paged("workouts", `?created_at=gte.${enc(since)}&order=created_at.desc,id.desc&select=id,athlete_id,created_at,parsed_data`);
console.log(`prod: ${athletes.length} athletes, ${workouts.length} workouts in 90d window`);

// ── ORACLE: verbatim client code ──────────────────────────────────────────────
// weekBounds — src/coach.jsx (local-time version)
const oWeekBounds = (ref = Date.now()) => {
  const d = new Date(ref); d.setHours(0, 0, 0, 0);
  const todayIdx = (d.getDay() + 6) % 7;
  const start = d.getTime() - todayIdx * DAYMS;
  const days = Array.from({ length: 7 }, (_, i) => {
    const dd = new Date(start + i * DAYMS);
    return { t: start + i * DAYMS, l: "MTWTFSS"[i], full: dd.toLocaleDateString("en-US", { weekday: "short" }), d: dd.getDate() };
  });
  return { start, end: start + 7 * DAYMS, days, todayIdx };
};

// GroupProgress strength + running — src/coach.jsx GroupProgress D useMemo
function oracleGroupProgress(athletes, workouts) {
  const now = NOW, WK = 7 * 864e5, WEEKS = 12, weekStart = now - WEEKS * WK;
  const wl = (wi) => new Date(weekStart + wi * WK).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const pd = (w) => typeof w.parsed_data === "string" ? (() => { try { return JSON.parse(w.parsed_data); } catch { return {}; } })() : (w.parsed_data || {});
  const woByAth = {};
  workouts.forEach(w => { (woByAth[w.athlete_id] = woByAth[w.athlete_id] || []).push(w); });

  const liftData = {};
  athletes.forEach(a => { const bw = a.weight_lbs || a.weight || 0;
    (woByAth[a.id] || []).forEach(w => { const t = new Date(w.created_at).getTime(); if (t < weekStart) return; const wi = Math.floor((t - weekStart) / WK);
      (pd(w).exercises || []).forEach(ex => { if (!ex.name) return; const lift = resolveLift(ex.name); if (!lift.tracked) return; const e = bestE1RMForExercise(ex, bw); if (!e) return;
        const L = (liftData[lift.id] = liftData[lift.id] || { name: lift.name, key: lift.id, weeks: {} }); const wk = (L.weeks[wi] = L.weeks[wi] || {}); if (!wk[a.id] || e > wk[a.id]) wk[a.id] = e; });
    });
  });
  const strength = Object.values(liftData).map(L => {
    const points = []; for (let wi = 0; wi < WEEKS; wi++) { const wk = L.weeks[wi]; if (wk) { const vals = Object.values(wk); points.push({ label: wl(wi), y: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length), n: vals.length }); } }
    const best = points.length ? Math.max(...points.map(p => p.y)) : 0;
    return { name: L.name, key: L.key, points, best };
  }).filter(L => L.points.length >= 2).sort((a, b) => liftTier(a.key) - liftTier(b.key) || b.best - a.best);

  const paceToMin = (p) => { if (!p) return null; const pts = String(p).split(":"); if (pts.length < 2) return null; const m = parseFloat(pts[0]), s = parseFloat(pts[1]); return isNaN(m) || isNaN(s) ? null : Math.round((m + s / 60) * 100) / 100; };
  const runWeeks = {};
  athletes.forEach(a => { (woByAth[a.id] || []).forEach(w => { const t = new Date(w.created_at).getTime(); if (t < weekStart) return; const wi = Math.floor((t - weekStart) / WK); const rd = pd(w).run_data; if (!rd) return; const R = (runWeeks[wi] = runWeeks[wi] || { dist: 0, pace: [], hr: [] }); const d = rd.distance_miles || rd.distance_km; if (d) R.dist += d; const pc = paceToMin(rd.pace_per_mile || rd.pace_per_km); if (pc != null) R.pace.push(pc); if (rd.heart_rate_avg) R.hr.push(rd.heart_rate_avg); }); });
  const distSeries = [], paceSeries = [], hrSeries = [];
  for (let wi = 0; wi < WEEKS; wi++) { const R = runWeeks[wi]; if (!R) continue; const label = wl(wi); if (R.dist) distSeries.push({ label, y: Math.round(R.dist * 10) / 10 }); if (R.pace.length) paceSeries.push({ label, y: Math.round(R.pace.reduce((a, b) => a + b, 0) / R.pace.length * 100) / 100 }); if (R.hr.length) hrSeries.push({ label, y: Math.round(R.hr.reduce((a, b) => a + b, 0) / R.hr.length) }); }
  return { strength, distSeries, paceSeries, hrSeries };
}

// CoachOverview feel + pain + movers — src/coach.jsx CoachOverview D useMemo
function oracleOverview(athletes, workouts) {
  const now = NOW;
  const inWin = (w, from, to = now) => { const t = new Date(w.created_at).getTime(); return t >= from && t < to; };
  const woByAth = {};
  workouts.forEach(w => { (woByAth[w.athlete_id] = woByAth[w.athlete_id] || []).push(w); });
  const wk = oWeekBounds(now);
  const weekAgo = wk.start, twoWk = wk.start - 7 * DAYMS;

  // per-row lifts (rows.map) → dlt → movers
  const rows = athletes.map(a => {
    const wo = woByAth[a.id] || [];
    const thisWk = pcGroup(wo.filter(w => inWin(w, weekAgo, wk.end)));
    const lastWk = pcGroup(wo.filter(w => inWin(w, twoWk, weekAgo)));
    const twL = buildLiftHistory(thisWk), lwL = buildLiftHistory(lastWk);
    const lifts = Object.entries(twL).map(([lift, entries]) => { const best = entries.reduce((x, y) => y.e1rm > x.e1rm ? y : x); const lw = lwL[lift]; let delta = null; if (lw) { const lb = lw.reduce((x, y) => y.e1rm > x.e1rm ? y : x); delta = best.e1rm - lb.e1rm; } return { lift, deltaVsLastWeek: delta }; });
    return { lifts };
  });
  const dlt = {};
  rows.forEach(r => (r.lifts || []).forEach(l => { if (l.deltaVsLastWeek != null) (dlt[l.lift] = dlt[l.lift] || []).push(l.deltaVsLastWeek); }));
  const movers = Object.entries(dlt).map(([lift, ds]) => ({ lift, avg: +(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(1), n: ds.length })).filter(m => m.avg > 0).sort((a, b) => b.avg - a.avg);

  const feelCounts = { great: 0, good: 0, average: 0, rough: 0 }; let feelTotal = 0;
  workouts.filter(w => inWin(w, weekAgo)).forEach(w => { const f = w.parsed_data?.session_feel; if (f && feelCounts[f] != null) { feelCounts[f]++; feelTotal++; } });

  const weekPain = []; workouts.filter(w => inWin(w, weekAgo)).forEach(w => { const pf = w.parsed_data?.pain_flags; if (pf && pf.length) { const a = athletes.find(x => x.id === w.athlete_id); weekPain.push({ name: a?.name || "Athlete", areas: pf.map(p => p.area).join(", "), at: w.created_at }); } });

  return { movers, feelCounts, feelTotal, weekPain };
}

// School leaderboard "Most Improved" — src/coach.jsx leaderboard IIFE
function oracleMostImproved(schoolAthletes, workouts) {
  const now = NOW;
  const d30 = 30 * 24 * 60 * 60 * 1000;
  return schoolAthletes.map(a => {
    const aw = workouts.filter(w => w.athlete_id === a.id);
    const rb = {}; const pb = {};
    aw.filter(w => now - new Date(w.created_at) <= d30).forEach(w => (w.parsed_data?.exercises || []).forEach(ex => { if (!ex.name || ex.unit === "bodyweight") return; const k = normalizeExName(ex.name); const e = bestE1RMForExercise(ex); if (e && (!rb[k] || e > rb[k])) rb[k] = e; }));
    aw.filter(w => { const age = now - new Date(w.created_at); return age > d30 && age <= d30 * 2; }).forEach(w => (w.parsed_data?.exercises || []).forEach(ex => { if (!ex.name || ex.unit === "bodyweight") return; const k = normalizeExName(ex.name); const e = bestE1RMForExercise(ex); if (e && (!pb[k] || e > pb[k])) pb[k] = e; }));
    let best = 0;
    Object.keys(rb).forEach(k => { if (pb[k] && pb[k] > 0) { const p = (rb[k] - pb[k]) / pb[k] * 100; if (p > best) best = p; } });
    return best > 0 ? { athlete: a, metric: `+${Math.round(best)}% est. 1RM` } : null;
  }).filter(Boolean).sort((a, b) => parseFloat(b.metric) - parseFloat(a.metric)).slice(0, 3);
}

// ── compare ───────────────────────────────────────────────────────────────────
const localTz = new Date(NOW).getTimezoneOffset();
let pass = 0;
const check = (name, oracle, ported) => {
  try { assert.deepStrictEqual(ported, oracle); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name} MISMATCH`); console.error(e.message.slice(0, 2000)); process.exitCode = 1; }
};

console.log("\n— weekBounds (tz-offset path vs local path) —");
check("weekBounds", oWeekBounds(NOW), weekBounds(NOW, localTz));

console.log("\n— full-roster (master view) —");
const og = oracleGroupProgress(athletes, workouts);
check("strength 12wk", og.strength, teamStrengthWeekly(athletes, workouts, NOW, localTz));
check("running 12wk", { distSeries: og.distSeries, paceSeries: og.paceSeries, hrSeries: og.hrSeries }, teamRunningWeekly(athletes, workouts, NOW, localTz));
const oo = oracleOverview(athletes, workouts);
const wk = weekBounds(NOW, localTz);
check("feel week", { feelCounts: oo.feelCounts, feelTotal: oo.feelTotal }, weekFeelDistribution(workouts, wk, NOW));
check("weekPain", oo.weekPain, weekPainFlags(workouts, athletes, wk, NOW));
check("movers", oo.movers, teamMovers(athletes, workouts, wk, NOW));

console.log("\n— per-school Most Improved —");
const schools = [...new Set(athletes.map(a => a.school_id).filter(Boolean))];
for (const sid of schools) {
  const schoolAthletes = athletes.filter(a => a.school_id === sid);
  if (schoolAthletes.length < 2) continue;
  const oracle = oracleMostImproved(schoolAthletes, workouts).map(e => ({ athlete_id: e.athlete.id, metric: e.metric }));
  check(`mostImproved school=${sid.slice(0, 8)} (${schoolAthletes.length} athletes)`, oracle, mostImproved60(schoolAthletes, workouts, NOW));
}

console.log("\n— per-coach scoped roster (regular-coach view) —");
const coachIds = [...new Set(athletes.map(a => a.coach_id).filter(Boolean))];
for (const cid of coachIds) {
  const roster = athletes.filter(a => a.coach_id === cid);
  if (!roster.length) continue;
  const ids = new Set(roster.map(a => a.id));
  const wos = workouts.filter(w => ids.has(w.athlete_id));
  const o = oracleOverview(roster, wos);
  check(`movers coach=${cid.slice(0, 8)} (${roster.length} ath)`, o.movers, teamMovers(roster, wos, wk, NOW));
  const g = oracleGroupProgress(roster, wos);
  check(`strength coach=${cid.slice(0, 8)}`, g.strength, teamStrengthWeekly(roster, wos, NOW, localTz));
}

console.log(`\n${process.exitCode ? "FAILED" : `ALL ${pass} CHECKS PASSED`} (pinned now=${new Date(NOW).toISOString()}, tz=${localTz})`);
