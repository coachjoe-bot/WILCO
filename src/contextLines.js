// ─── ATHLETE CONTEXT: THE LINES THE TAB COMPUTES (T69-C) ─────────────────────
// Will 10-01: "this section is going to be very important for the app". Most of
// the Athlete Context tab is NOT stored. It is worked out, every time the tab
// opens, from the place each fact already lives, so it can never go stale and
// there is nothing to clean:
//   Body    pain areas from the pain ledger (src/painLedger.js painStatus),
//           the lifts each area limits, maxes in the unit they were logged in,
//           limiters from strengthRatios, bodyweight
//   Prefs   the typed training prefs, and which unit the athlete uses per lift
//   Week    sessions, set volume, lifts planned and not logged, PRs, and the
//           resolver's week: the numbers the proof brief computes, from the
//           same pure functions, without waiting for Sunday
//   Goal    progress on each measurable target in the goal
// Every sentence here is written for the athlete to read: plain words, one
// text colour, no coach shorthand ("Your last three weeks were 2, 3 and 2
// sessions", never "trains 6d/wk, logs 2-3"). No em dashes.
// Pure, no I/O, no React. Suite: scripts/test-context-lines.mjs.
import { extractEvents, painLoads, AREA_FAMILIES, areaLabel, dayKey, fmtDay, rowDay, CURRENT_STATES } from "./painLedger.js";
import {
  resolveLift, bestE1RMForExercise, getExerciseSets, showMax, factUnit, goalTargets, strengthRatios, computeGritSnapshot,
  groupIntoSessions as gritGroup, effectiveDate, liftTier, toLbs, isRealSession,
} from "./grit.js";
import { isUnitPending } from "./units.js";
import { totalSetVolume } from "./proofcore.js";
import { normalizePrefs, prefsPromptLines, PREF_FIELDS, describePref } from "./trainingPrefs.js";
import { plannedLifts, sameLift } from "./turnFacts.js";
import { parseProgramShape, extractDaySessionText, currentPosition } from "./programPosition.js";

const DAY = 86400000;
const pd = (w) => (typeof w?.parsed_data === "string" ? (() => { try { return JSON.parse(w.parsed_data); } catch { return {}; } })() : (w?.parsed_data || {}));
const cap = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());
const exNorm = (name) => String(name || "").toLowerCase().replace(/\bdb\b/g, "dumbbell");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDay = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${MON[d.getUTCMonth()]} ${d.getUTCDate()}` : ""; };

// ── pain lines (Body) ────────────────────────────────────────────────────────
const STATE_WORD = { serious: "serious", new: "new", active: "active", open: "still open", easing: "easing", quiet: "quiet", cleared: "cleared" };
const sideOf = (r) => (r.side === "left" || r.side === "right" ? `${cap(r.side)} ${r.label}` : cap(r.label));

// The heaviest working top set of an exercise in the unit it was logged in.
const topLoad = (ex) => {
  const sets = getExerciseSets(ex).filter((s) => !s.warmup && s.weight > 0);
  return sets.reduce((m, s) => Math.max(m, Number(s.weight) || 0), 0);
};

// What each area limits, from what the ledger already knows (nothing stored):
// the lift it hurt on (lastDuring) and, when there is one, a lift from the same
// movement family trained since the last mention with no mention that day, with
// its top load in the unit it was logged in.
export function painLimits(rec, rows, { unit = "lbs", tz } = {}) {
  const fam = AREA_FAMILIES[rec.area];
  const mentionDays = new Set(extractEvents(rows, { tz }).filter((e) => e.type === "mention" && e.area === rec.area).map((e) => e.day));
  const hurtLift = rec.lastDuring ? resolveLift(rec.lastDuring) : null;
  const best = new Map();
  if (fam) {
    for (const w of rows || []) {
      if (!isRealSession(w)) continue;
      const day = rowDay(w, tz);
      if (!day || day <= rec.lastAt || mentionDays.has(day)) continue;
      for (const ex of pd(w).exercises || []) {
        if (!ex || !ex.name || ex.unit === "bodyweight" || isUnitPending(ex)) continue;
        if (!fam.test(exNorm(ex.name))) continue;
        const load = topLoad(ex);
        if (!(load > 0)) continue;
        const id = resolveLift(ex.name).id;
        const u = factUnit(ex, unit);
        const lbs = toLbs(load, ex.unit);
        const cur = best.get(id);
        if (!cur || lbs > cur.lbs) best.set(id, { id, name: ex.name, lbs, unit: u });
      }
    }
  }
  const list = [...best.values()].sort((a, b) => b.lbs - a.lbs);
  // prefer a lift other than the one that hurt (the "I can still do this" fact);
  // when only the lift that hurt has been trained since, that is the fact
  const other = list.find((x) => !hurtLift || x.id !== hurtLift.id) || list[0] || null;
  return {
    hurt: rec.lastDuring ? { lift: rec.lastDuring, day: rec.lastAt } : null,
    freeSince: other ? { name: other.name, display: showMax(other.lbs, other.unit) } : null,
  };
}

// One entry per open or recently cleared area, the ledger's own records.
// notes: athlete_memory rows (a work-around is a Body note tied to the area).
export function painTabLines({ records = [], rows = [], notes = [], unit = "lbs", tz } = {}) {
  const lines = [];
  for (const r of records || []) {
    if (!r || !r.area) continue;
    const cleared = r.state === "cleared";
    const lim = painLimits(r, rows, { unit, tz });
    const work = (notes || []).find((n) => n && n.status !== "deleted" && n.area_key === r.area) || null;
    const when = cleared ? (r.clearedOn || r.lastAt) : r.lastAt;
    const head = cleared ? `${sideOf(r)}, cleared ${fmtDay(when)}` : `${sideOf(r)}, ${STATE_WORD[r.state] || r.state}, last mentioned ${fmtDay(r.lastAt)}`;
    const sub = [];
    if (lim.hurt) sub.push(`It hurt on ${String(lim.hurt.lift).toLowerCase()} (${fmtDay(lim.hurt.day)}).`);
    if (lim.freeSince) sub.push(`${cap(lim.freeSince.name)} has been pain-free since, up to ${lim.freeSince.display}.`);
    lines.push({
      area: r.area, label: sideOf(r), state: r.state, stateWord: STATE_WORD[r.state] || r.state, cleared,
      current: CURRENT_STATES.includes(r.state), lastAt: r.lastAt, clearedOn: r.clearedOn || null,
      head, sub: sub.join(" "), chip: `Tracked, ${fmtDay(when)}`, workaround: work,
    });
  }
  return lines;
}

// ── maxes and limiters (Body) ────────────────────────────────────────────────
const MAX_LIFTS = new Set(["back squat", "front squat", "bench press", "deadlift", "overhead press", "snatch", "clean and jerk", "power clean", "power snatch", "clean", "push press", "squat"]);
// The same sources chat's KNOWN 1RMs block reads (App.jsx getJoeReply): best
// e1RM per canonical lift from history, then the athlete's actual 1RMs
// (manual_one_rms) replace the estimate. Each is said in the unit THAT lift was
// logged in (T68 factUnit), never converted to a display unit.
export function maxesTab({ rows = [], manualRMs = [], bodyweightLbs = 0, unit = "lbs", limit = 6 } = {}) {
  const byEx = {};
  for (const w of rows || []) for (const ex of pd(w).exercises || []) {
    if (!ex || !ex.name) continue;
    const e1 = bestE1RMForExercise(ex, bodyweightLbs);
    if (!e1) continue;
    const lift = resolveLift(ex.name);
    if (!byEx[lift.id] || e1 > byEx[lift.id].e1rm) byEx[lift.id] = { id: lift.id, name: lift.name, e1rm: e1, unit: factUnit(ex, unit), actual: false };
  }
  for (const m of manualRMs || []) {
    const lift = resolveLift(m.normalized_exercise || m.exercise);
    byEx[lift.id] = { id: lift.id, name: lift.name || m.exercise, e1rm: toLbs(Number(m.weight) || 0, m.unit), unit: m.unit === "kg" ? "kg" : "lbs", actual: true };
  }
  const all = Object.values(byEx).filter((x) => x.e1rm > 0).sort((a, b) => b.e1rm - a.e1rm);
  // the lifts an athlete quotes (a pull or a complex is not a "max")
  const big = all.filter((x) => MAX_LIFTS.has(x.id));
  const chosen = (big.length >= 2 ? big : all.filter((x) => liftTier(x.id) === 0 && !/pull|complex|\+/.test(x.id))).slice(0, limit);
  return {
    items: chosen.map((x) => ({ name: x.name, display: showMax(x.e1rm, x.unit), actual: x.actual })),
    line: chosen.map((x) => `${cap(x.name.toLowerCase())} ${showMax(x.e1rm, x.unit)}`).join(", "),
  };
}

export function limiterLines({ rows = [], manualRMs = [], bodyweightLbs = 0, gender = null, age = null, max = 3 } = {}) {
  let all = [];
  try { all = computeGritSnapshot(rows, manualRMs, { bodyweightLbs, gender, age }).allLifts || []; } catch (_) { all = []; }
  const flagged = strengthRatios(all).filter((r) => r.flag !== "in-band").slice(0, max);
  return flagged.map((r) => {
    const pct = Math.round(r.ratio * 100);
    const band = `${Math.round(r.lo * 100)} to ${Math.round(r.hi * 100)}`;
    const gap = r.flag === "low" ? (r.off >= 0.1 ? "behind" : "a little behind") : (r.off >= 0.1 ? "well ahead" : "a little ahead");
    return `${cap(r.num)} is ${pct}% of your ${r.den} (${band} is typical). That is ${gap}.`;
  });
}

// ── preferences ─────────────────────────────────────────────────────────────
// Confirmed typed prefs, one plain line each, plus which unit the athlete uses
// per lift (they mix: barbell in kg, bench in lbs).
export function prefsLines(prefs) {
  const p = normalizePrefs(prefs);
  const out = [];
  for (const [k, f] of Object.entries(PREF_FIELDS)) {
    if (p[k] == null || p[k] === f.dflt) continue;
    out.push(`${f.label}: ${describePref(k, p[k])}`);
  }
  return out;
}
export function unitsByLift(rows = [], { unit = "lbs", perLift = 3 } = {}) {
  const latest = new Map();
  for (const w of [...(rows || [])].sort((a, b) => effectiveDate(b) - effectiveDate(a))) {
    for (const ex of pd(w).exercises || []) {
      if (!ex || !ex.name || ex.unit === "bodyweight" || isUnitPending(ex)) continue;
      const lift = resolveLift(ex.name);
      if (!lift.tracked) continue;
      if (!latest.has(lift.id)) latest.set(lift.id, { name: lift.name, unit: factUnit(ex, unit) });
    }
  }
  const kg = [], lbs = [];
  // quotable lifts first (a complex or a pull is noise in a sentence)
  const ranked = [...latest.entries()].filter(([id, x]) => !/\+|complex/i.test(x.name)).sort((a, b) => (MAX_LIFTS.has(b[0]) ? 1 : 0) - (MAX_LIFTS.has(a[0]) ? 1 : 0));
  for (const [, x] of ranked) (x.unit === "kg" ? kg : lbs).push(x.name);
  if (!kg.length && !lbs.length) return "";
  const nm = (a) => a.slice(0, perLift).map((s) => s.toLowerCase()).join(", ");
  if (!kg.length || !lbs.length) return `You log in ${kg.length ? "kg" : "lbs"}.`;
  return `You log ${nm(kg)} in kg and ${nm(lbs)} in lbs.`;
}

// ── goal progress ───────────────────────────────────────────────────────────
// currentByLift: {liftId: {lbs, unit}} from maxesTab inputs. One line per
// measurable target in the goal; a goal with no number gets none.
export function goalProgressLines(goal, maxItems = [], { unit = "lbs" } = {}) {
  const by = {};
  for (const m of maxItems || []) by[resolveLift(m.name).id] = m;
  return goalTargets(goal).slice(0, 4).map((t) => {
    const lift = resolveLift(t.lift);
    const cur = by[lift.id];
    const target = showMax(t.targetLbs, unit);
    return cur ? `${cap(lift.name.toLowerCase())} ${target}: you are at ${cur.display}.` : `${cap(lift.name.toLowerCase())} ${target}: no number logged yet.`;
  });
}

// ── This week ───────────────────────────────────────────────────────────────
// The proof brief's numbers (api/trigger-proof-feed.js briefFor): this week is
// the last 7 days, last week the 7 before, grouped into sessions the same way,
// set volume from totalSetVolume. rows must cover the last 14 days or more (the
// tab reads a dedicated 28-day window: workoutHistory is only the newest 100
// rows, chat messages included, and would undercount a chatty athlete).
export function thisWeekTab({ rows = [], athlete = {}, prs = [], position = null, programText = "", now = new Date() } = {}) {
  const t = new Date(now).getTime();
  const at = (w) => effectiveDate(w).getTime();
  const real = (rows || []).filter(isRealSession);
  const thisRows = real.filter((w) => at(w) >= t - 7 * DAY);
  const lastRows = real.filter((w) => at(w) >= t - 14 * DAY && at(w) < t - 7 * DAY);
  const thisSessions = groupIntoSessionsLocal(thisRows), lastSessions = groupIntoSessionsLocal(lastRows);
  // planned this week and not logged: the resolver's week, every day's lifts
  let planned = [];
  try {
    const shape = parseProgramShape(programText || "");
    const week = position && position.hasWeeks && position.weekKnown ? position.week : null;
    const texts = shape.dayTemplate.length
      ? shape.dayTemplate.map((label) => extractDaySessionText(programText, { week: shape.hasWeeks ? week : null, dayLabel: label }) || "")
      : (String(programText || "").length < 1500 ? [programText] : []);
    for (const tx of texts) for (const p of plannedLifts(tx)) if (!planned.some((q) => sameLift(q.name, p.name))) planned.push(p);
  } catch (_) { planned = []; }
  const loggedNames = thisRows.flatMap((w) => (pd(w).exercises || []).map((e) => e && e.name).filter(Boolean));
  const notLogged = planned.filter((p) => !loggedNames.some((n) => sameLift(n, p.name))).map((p) => p.name.toLowerCase());
  const recentPRs = (prs || []).filter((p) => p && p.date && Date.parse(p.date) >= t - 7 * DAY);
  const days = Number(athlete.training_days_per_week) || null;
  const sets = totalSetVolume(thisSessions), lastSets = totalSetVolume(lastSessions);
  return {
    sessions: thisSessions.length, lastSessions: lastSessions.length, plannedDays: days,
    sets, lastSets, notLogged: notLogged.slice(0, 6), prs: recentPRs.slice(0, 3).map((p) => ({ exercise: p.exercise, weight: p.weight, unit: p.unit === "kg" ? "kg" : "lbs", reps: p.reps })),
  };
}
function groupIntoSessionsLocal(rows) {
  // the proof brief's grouping (rows within 3 hours are one session)
  const sorted = [...rows].sort((a, b) => effectiveDate(a) - effectiveDate(b));
  const groups = [];
  for (const w of sorted) {
    const last = groups[groups.length - 1];
    if (last && effectiveDate(w) - effectiveDate(last[last.length - 1]) <= 3 * 3600000) last.push(w);
    else groups.push([w]);
  }
  return groups;
}

export function thisWeekLines(tw, { position = null, blockName = "", unit = "lbs" } = {}) {
  const lines = [];
  if (position && position.dayTemplate && position.dayTemplate.length) {
    const where = position.hasWeeks && position.weekKnown ? `Week ${position.week}${position.weekCount ? ` of ${position.weekCount}` : ""}` : (position.label && /^day\s*\d/i.test(position.label) ? position.label : `Day ${position.day}${position.label ? `: ${position.label}` : ""}`);
    lines.push(`${blockName ? `${blockName}, ` : ""}${where}`);
  }
  const ofPlan = tw.plannedDays ? ` of ${tw.plannedDays}` : "";
  lines.push(`${tw.sessions}${ofPlan} session${tw.sessions === 1 && !ofPlan ? "" : "s"} (${tw.lastSessions} last week), ${tw.sets} sets (${tw.lastSets} last week)`);
  if (tw.notLogged.length) lines.push(`Not logged yet: ${tw.notLogged.join(", ")}`);
  for (const p of tw.prs) lines.push(`PR: ${String(p.exercise).toLowerCase()} ${p.weight} ${p.unit}${p.reps && p.reps > 1 ? ` x ${p.reps}` : ""}`);
  return lines;
}

// ── "last checked" and "due" copy for stored lines ──────────────────────────
export function checkedLabel(row, { rollout = null } = {}) {
  const c = row && (row.confirmed_at || null);
  if (c) return `Checked ${shortDay(c)}`;
  const made = row && row.created_at ? shortDay(row.created_at) : "";
  return made ? `Saved ${made}` : "";
}

export { dayKey };
