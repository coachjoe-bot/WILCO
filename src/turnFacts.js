// ─── TURN FACTS — what was PERFORMED, stated in code (T64 S2) ────────────────
// Sep 2: the athlete logged Behind the Neck Snatch Grip Push Press 5x3 climbing
// 60/80/90/100/100 kg; the temp program prescribed 5x2; Joe called the top set
// "a clean double". The parser stored the log correctly. Nothing handed to Joe
// said what was performed, so he reached for the plan's number. Same doctrine as
// the PR CHECK block: compute the fact, inject it, Joe quotes it and never
// re-derives it.
//
// performedLines(exercises, {displayUnit, planText}) -> ["<lift>: 5 sets of 3,
//   60/80/90/100/100 kg, top set 100 kg x 3 (plan was 5x2)", ...]
// Pure. Reads set_details first (the per-set truth), the flat fields second.

import { resolveLift, getExerciseSets } from "./grit.js";
import { toDisplay, roundStat } from "./units.js";

const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

// A plan line's lift name often carries a day label or bullet in front of it
// ("Monday Front squat 4x3", "* Front squat 4×3"); strip those before resolving.
const LEAD_NOISE = /^(?:[*•\-–—]+\s*|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|rsday|urday|sday)?\b\s*[:\-–—]?\s*|day\s*\d+\s*[:\-–—]?\s*|week\s*\d+\s*[:\-–—]?\s*|wk\s*\d+\s*|[a-z]\d\.?\s+)+/i;
const SCHEME_RE = /([A-Za-z][A-Za-z &'’+\-/()]{2,70}?)\s+(\d{1,2})\s*[x×]\s*(\d{1,3}(?:\s*\+\s*\d{1,2})*)(?![\d])/g;

// The ONE scheme the plan prescribes for this lift, or null when the plan does
// not name it or names it with more than one scheme (ambiguous: say nothing).
export function planSchemeFor(liftName, planText) {
  const text = String(planText || "");
  if (!text || !liftName) return null;
  const target = resolveLift(liftName).id;
  const found = new Set();
  for (const line of text.split(/\r?\n/)) {
    SCHEME_RE.lastIndex = 0;
    let m;
    while ((m = SCHEME_RE.exec(line))) {
      const name = m[1].replace(LEAD_NOISE, "").replace(/[()]/g, " ").trim();
      if (!name) continue;
      if (resolveLift(name).id !== target) continue;
      found.add(`${+m[2]}x${m[3].replace(/\s+/g, "")}`);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

const unitLabel = (u) => (u === "kg" ? "kg" : "lbs");

export function performedLine(ex, { displayUnit, planText } = {}) {
  if (!ex || !ex.name) return null;
  const name = ex.name;
  // timed holds: "2 sets of 60 s"
  if (ex.time_per_set_seconds > 0) {
    const n = ex.sets || 1;
    return `${name}: ${n} set${n === 1 ? "" : "s"} of ${fmtNum(ex.time_per_set_seconds)} s held`;
  }
  const all = getExerciseSets(ex);
  const bodyweight = ex.unit === "bodyweight";
  const working = all.filter((s) => !s.warmup);
  const warm = all.length - working.length;
  const sets = working.length ? working : all;
  if (!sets.length) return null;
  const scheme = ex.rep_scheme && /\+/.test(ex.rep_scheme) ? ex.rep_scheme : null;
  const repsList = sets.map((s) => s.reps);
  const sameReps = repsList.every((r) => r === repsList[0]);
  const du = displayUnit === "kg" || displayUnit === "lbs" ? displayUnit : (bodyweight ? "lbs" : ex.unit);
  const w = (v) => (ex.unit === du || bodyweight ? fmtNum(v) : fmtNum(roundStat(toDisplay(v, ex.unit, du), du)));
  const U = unitLabel(bodyweight ? "lbs" : du);
  const each = ex.load_basis === "each" ? " each" : "";
  const n = sets.length;
  let body;

  if (bodyweight) {
    const added = ex.added_weight > 0 ? ` plus ${fmtNum(ex.added_weight)} lbs` : ex.assist_weight > 0 ? `, ${fmtNum(ex.assist_weight)} lbs assisted` : "";
    const perSetLoad = sets.some((s) => s.weight > 0);
    const statedReps = ex.reps > 0 || (Array.isArray(ex.set_details) && ex.set_details.some((s) => s && s.reps > 0));
    if (!statedReps) return null; // no reps, no time: nothing true to state
    if (perSetLoad) {
      body = `${n} set${n === 1 ? "" : "s"}: ${sets.map((s) => (s.weight > 0 ? `+${fmtNum(s.weight)} lbs x ${s.reps}` : `bodyweight x ${s.reps}`)).join(", ")}`;
    } else if (sameReps) {
      body = `${n} set${n === 1 ? "" : "s"} of ${scheme || repsList[0]}, bodyweight${added}`;
    } else {
      body = `${n} sets of ${repsList.join("/")} reps, bodyweight${added}`;
    }
  } else {
    const loads = sets.map((s) => s.weight);
    if (!loads.some((v) => v > 0)) return null;
    const sameLoad = loads.every((v) => v === loads[0]);
    const top = sets.reduce((b, s) => (!b || s.weight > b.weight || (s.weight === b.weight && s.reps > b.reps) ? s : b), null);
    if (sameReps && sameLoad) {
      body = `${n} set${n === 1 ? "" : "s"} of ${scheme || repsList[0]} at ${w(loads[0])} ${U}${each}`;
    } else if (sameReps) {
      body = `${n} sets of ${scheme || repsList[0]}, ${loads.map(w).join("/")} ${U}${each}, top set ${w(top.weight)} ${U} x ${top.reps}`;
    } else {
      // reps differ set to set (a missed rep, a drop): state every set
      body = `${n} sets: ${sets.map((s) => `${w(s.weight)} x ${s.reps}`).join(", ")} ${U}${each}, top set ${w(top.weight)} ${U} x ${top.reps}`;
    }
  }
  if (warm > 0) body += `, after ${warm} warm-up set${warm === 1 ? "" : "s"}`;
  const plan = planSchemeFor(name, planText);
  if (plan) {
    const did = `${n}x${scheme || (sameReps ? repsList[0] : "")}`;
    if (!sameReps || plan !== did) body += ` (plan was ${plan})`;
  }
  return `${name}: ${body}`;
}

export function performedLines(exercises, opts = {}) {
  return (Array.isArray(exercises) ? exercises : []).map((ex) => performedLine(ex, opts)).filter(Boolean);
}

// The block for the chat turn. Final the way PR verdicts are final.
export function performedBlock(exercises, opts = {}) {
  const lines = performedLines(exercises, opts);
  if (!lines.length) return "";
  return `PERFORMED — THIS MESSAGE'S LOG (computed by the app from the saved log; FINAL. Sets, reps and loads here are what they did. Never describe a set with a rep word or number that is not in these lines, and never swap in the program's prescription):\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
