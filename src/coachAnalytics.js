// ─── COACH TEAM ANALYTICS — shared aggregation module (C2 follow-up) ──────────
// The six roster-wide aggregations the coach dashboard's Overview / Group-Progress
// tabs used to compute in the browser over the raw 90-day workout window, extracted
// VERBATIM so the server (api/coach-analytics.js) computes them instead and ships
// compact summaries — not ~58k raw rows at 500 athletes — to the phone.
//
// Plain JS (no JSX/DOM), imported by BOTH sides:
//   client  src/coach.jsx            (weekBounds only — display math stays local)
//   server  api/_coachanalytics.js   (re-export, same pattern as api/_grit.js)
//
// PARITY CONTRACT: every function body is a copy of the client expression it
// replaced (see scripts/verify-coach-analytics.mjs, which asserts deepStrictEqual
// against the original inline code on full prod data). Don't "clean up" the math
// here without re-running that harness — matching the client row-for-row is the
// entire point, same discipline as v_athlete_session_counts.
//
// VERIFIED 2026-07-20: harness run against all prod data (39 athletes, 806 workouts
// in the 90d window) — all 11 checks deepStrictEqual-identical to the original
// client expressions (strength/running/feel/pain/movers full-roster, most-improved
// per school, movers+strength per coach roster, weekBounds tz-path vs local).
//
// Timezone: the dashboard's windows are the COACH'S local Mon–Sun week / local
// date labels. The server runs UTC, so every entry point takes tzOffsetMinutes
// (the client's `new Date().getTimezoneOffset()`). Omitted ⇒ host-local behavior,
// bit-identical to the old inline client code (what the harness relies on).

import {
  bestE1RMForExercise, normalizeExName, resolveLift, liftTier,
} from "./grit.js";
import {
  groupIntoSessions as pcGroup, buildLiftHistory,
} from "./proofcore.js";

export const DAYMS = 86400000;
const WK = 7 * 864e5;

// Shift so UTC accessors read the coach's wall clock (local = UTC − offsetMin).
const shift = (t, tzOffsetMinutes) => t - tzOffsetMinutes * 60000;

// "Jul 20"-style label at the coach's wall clock (GroupProgress week labels).
const weekLabel = (t, tzOffsetMinutes) =>
  tzOffsetMinutes == null
    ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : new Date(shift(t, tzOffsetMinutes)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// Fixed Mon–Sun calendar week. Single source of the "this week" window for the
// whole Overview — every stat card and the briefing share it (no rolling 7d).
// (Moved from src/coach.jsx; the no-offset path is byte-for-byte that code.)
export const weekBounds = (ref = Date.now(), tzOffsetMinutes) => {
  if (tzOffsetMinutes == null) {
    const d = new Date(ref); d.setHours(0, 0, 0, 0);
    const todayIdx = (d.getDay() + 6) % 7;                    // Mon=0 … Sun=6
    const start = d.getTime() - todayIdx * DAYMS;
    const days = Array.from({ length: 7 }, (_, i) => {
      const dd = new Date(start + i * DAYMS);
      return { t: start + i * DAYMS, l: "MTWTFSS"[i], full: dd.toLocaleDateString("en-US", { weekday: "short" }), d: dd.getDate() };
    });
    return { start, end: start + 7 * DAYMS, days, todayIdx };
  }
  // Server path: same boundaries computed at the coach's wall clock via the offset.
  const d = new Date(shift(ref, tzOffsetMinutes)); d.setUTCHours(0, 0, 0, 0);
  const todayIdx = (d.getUTCDay() + 6) % 7;
  const start = d.getTime() + tzOffsetMinutes * 60000 - todayIdx * DAYMS; // back to real UTC ms
  const days = Array.from({ length: 7 }, (_, i) => {
    const dd = new Date(shift(start + i * DAYMS, tzOffsetMinutes));
    return { t: start + i * DAYMS, l: "MTWTFSS"[i], full: dd.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }), d: dd.getUTCDate() };
  });
  return { start, end: start + 7 * DAYMS, days, todayIdx };
};

// parsed_data may come back as a string in some cases — parse it if so.
const pd = (w) => typeof w.parsed_data === "string" ? (() => { try { return JSON.parse(w.parsed_data); } catch { return {}; } })() : (w.parsed_data || {});

const byAthlete = (rows) => {
  const m = {};
  rows.forEach((r) => { (m[r.athlete_id] = m[r.athlete_id] || []).push(r); });
  return m;
};

// ── #1 GroupProgress ▸ Strength: weekly team-average e1RM per lift (12-wk) ────
export function teamStrengthWeekly(athletes, workouts, now = Date.now(), tzOffsetMinutes, WEEKS = 12) {
  const weekStart = now - WEEKS * WK;
  const woByAth = byAthlete(workouts);
  const liftData = {};
  athletes.forEach(a => { const bw = a.weight_lbs || a.weight || 0;
    (woByAth[a.id] || []).forEach(w => { const t = new Date(w.created_at).getTime(); if (t < weekStart) return; const wi = Math.floor((t - weekStart) / WK);
      (pd(w).exercises || []).forEach(ex => { if (!ex.name) return; const lift = resolveLift(ex.name); if (!lift.tracked) return; const e = bestE1RMForExercise(ex, bw); if (!e) return;
        const L = (liftData[lift.id] = liftData[lift.id] || { name: lift.name, key: lift.id, weeks: {} }); const wk = (L.weeks[wi] = L.weeks[wi] || {}); if (!wk[a.id] || e > wk[a.id]) wk[a.id] = e; });
    });
  });
  return Object.values(liftData).map(L => {
    const points = []; for (let wi = 0; wi < WEEKS; wi++) { const wk = L.weeks[wi]; if (wk) { const vals = Object.values(wk); points.push({ label: weekLabel(weekStart + wi * WK, tzOffsetMinutes), y: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length), n: vals.length }); } }
    const best = points.length ? Math.max(...points.map(p => p.y)) : 0;
    return { name: L.name, key: L.key, points, best };
  }).filter(L => L.points.length >= 2).sort((a, b) => liftTier(a.key) - liftTier(b.key) || b.best - a.best);
}

// ── #2 GroupProgress ▸ Running: weekly team totals / averages (12-wk) ─────────
export function teamRunningWeekly(athletes, workouts, now = Date.now(), tzOffsetMinutes, WEEKS = 12) {
  const weekStart = now - WEEKS * WK;
  const woByAth = byAthlete(workouts);
  const paceToMin = (p) => { if (!p) return null; const pts = String(p).split(":"); if (pts.length < 2) return null; const m = parseFloat(pts[0]), s = parseFloat(pts[1]); return isNaN(m) || isNaN(s) ? null : Math.round((m + s / 60) * 100) / 100; };
  const runWeeks = {};
  athletes.forEach(a => { (woByAth[a.id] || []).forEach(w => { const t = new Date(w.created_at).getTime(); if (t < weekStart) return; const wi = Math.floor((t - weekStart) / WK); const rd = pd(w).run_data; if (!rd) return; const R = (runWeeks[wi] = runWeeks[wi] || { dist: 0, pace: [], hr: [] }); const d = rd.distance_miles || rd.distance_km; if (d) R.dist += d; const pc = paceToMin(rd.pace_per_mile || rd.pace_per_km); if (pc != null) R.pace.push(pc); if (rd.heart_rate_avg) R.hr.push(rd.heart_rate_avg); }); });
  const distSeries = [], paceSeries = [], hrSeries = [];
  for (let wi = 0; wi < WEEKS; wi++) { const R = runWeeks[wi]; if (!R) continue; const label = weekLabel(weekStart + wi * WK, tzOffsetMinutes); if (R.dist) distSeries.push({ label, y: Math.round(R.dist * 10) / 10 }); if (R.pace.length) paceSeries.push({ label, y: Math.round(R.pace.reduce((a, b) => a + b, 0) / R.pace.length * 100) / 100 }); if (R.hr.length) hrSeries.push({ label, y: Math.round(R.hr.reduce((a, b) => a + b, 0) / R.hr.length) }); }
  return { distSeries, paceSeries, hrSeries };
}

// Shared this-week predicate (CoachOverview's inWin, weekBounds-based).
const inWin = (w, from, to) => { const t = new Date(w.created_at).getTime(); return t >= from && t < to; };

// ── #3 Overview: session_feel distribution, current Mon–Sun week ──────────────
// No UI consumer today (the old client compute was dead code) — computed for the
// endpoint payload so a future donut/report reads it. The `feelCounts[f]!=null`
// guard intentionally drops out-of-vocab values (prod contains a stray "hard").
export function weekFeelDistribution(workouts, wk, now = Date.now()) {
  const feelCounts = { great: 0, good: 0, average: 0, rough: 0 }; let feelTotal = 0;
  workouts.filter(w => inWin(w, wk.start, now)).forEach(w => { const f = pd(w).session_feel; if (f && feelCounts[f] != null) { feelCounts[f]++; feelTotal++; } });
  return { feelCounts, feelTotal };
}

// ── #4 Overview: this-week pain flags ─────────────────────────────────────────
export function weekPainFlags(workouts, athletes, wk, now = Date.now()) {
  const weekPain = []; workouts.filter(w => inWin(w, wk.start, now)).forEach(w => { const pf = pd(w).pain_flags; if (pf && pf.length) { const a = athletes.find(x => x.id === w.athlete_id); weekPain.push({ name: a?.name || "Athlete", areas: pf.map(p => p.area).join(", "), at: w.created_at }); } });
  return weekPain;
}

// ── #5 Overview: team strength movement — avg e1RM delta per lift, wk vs last ─
export function teamMovers(athletes, workouts, wk, now = Date.now()) {
  const woByAth = byAthlete(workouts);
  const weekAgo = wk.start, twoWk = wk.start - 7 * DAYMS;
  const dlt = {};
  athletes.forEach(a => {
    const wo = woByAth[a.id] || [];
    const thisWk = pcGroup(wo.filter(w => inWin(w, weekAgo, wk.end)));
    const lastWk = pcGroup(wo.filter(w => inWin(w, twoWk, weekAgo)));
    const twL = buildLiftHistory(thisWk), lwL = buildLiftHistory(lastWk);
    Object.entries(twL).forEach(([lift, entries]) => { const best = entries.reduce((x, y) => y.e1rm > x.e1rm ? y : x); const lw = lwL[lift]; if (!lw) return; const lb = lw.reduce((x, y) => y.e1rm > x.e1rm ? y : x); (dlt[lift] = dlt[lift] || []).push(best.e1rm - lb.e1rm); });
  });
  return Object.entries(dlt).map(([lift, ds]) => ({ lift, avg: +(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(1), n: ds.length })).filter(m => m.avg > 0).sort((a, b) => b.avg - a.avg);
}

// ── #6 School leaderboard: "Most Improved" — best %-gain in est. 1RM, 60d ─────
// Current 30d window vs the prior 30d. Returns {athlete_id, metric} (top 3);
// the client rejoins athlete_id → its roster row for display.
export function mostImproved60(schoolAthletes, workouts, now = Date.now()) {
  const d30 = 30 * 24 * 60 * 60 * 1000;
  const woByAth = byAthlete(workouts);
  return schoolAthletes.map(a => {
    const aw = woByAth[a.id] || [];
    const rb = {}; const pb = {};
    aw.filter(w => now - new Date(w.created_at) <= d30).forEach(w => (pd(w).exercises || []).forEach(ex => { if (!ex.name || ex.unit === "bodyweight") return; const k = normalizeExName(ex.name); const e = bestE1RMForExercise(ex); if (e && (!rb[k] || e > rb[k])) rb[k] = e; }));
    aw.filter(w => { const age = now - new Date(w.created_at); return age > d30 && age <= d30 * 2; }).forEach(w => (pd(w).exercises || []).forEach(ex => { if (!ex.name || ex.unit === "bodyweight") return; const k = normalizeExName(ex.name); const e = bestE1RMForExercise(ex); if (e && (!pb[k] || e > pb[k])) pb[k] = e; }));
    let best = 0;
    Object.keys(rb).forEach(k => { if (pb[k] && pb[k] > 0) { const p = (rb[k] - pb[k]) / pb[k] * 100; if (p > best) best = p; } });
    return best > 0 ? { athlete_id: a.id, metric: `+${Math.round(best)}% est. 1RM` } : null;
  }).filter(Boolean).sort((a, b) => parseFloat(b.metric) - parseFloat(a.metric)).slice(0, 3);
}
