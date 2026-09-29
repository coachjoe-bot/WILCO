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

import { resolveLift, getExerciseSets, liftTier, toLbs } from "./grit.js";
import { toDisplay, roundStat } from "./units.js";
import { parseProgramShape, extractDaySessionText } from "./programPosition.js";

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
  return `PERFORMED — THIS MESSAGE'S LOG (computed by the app from the saved log; FINAL. Sets, reps and loads here are what they did. Say reps as the numbers here (5 sets of 3), never as words like single, double or triple, not even for the plan; never swap in the program's prescription):\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

// ─── LOG HEADLINE — the ONE thing worth saying about this log (T64 S5) ───────
// Will 09-28: replies to logs ran three paragraphs (praise, a second lift's
// estimated max, a question about a skipped lift). A log turn hands Joe many
// true facts (PERFORMED, PR CHECK, plan notes, pain, history) and nothing said
// which one matters, so he commented on several. Code ranks them here from data
// the turn already computed; Joe says the headline in his own words.
//
// Priority, first that applies:
//   a. serious pain in this message (ledger turn: serious / address_now)
//   b. a NEW PR on a main lift (sport-central lift first, else the biggest jump)
//   c. pain verdict acknowledge_once / offer_change_once for this message
//   d. a main lift up on the last time it was done (load or reps, both numbers),
//      else a main lift's first time on file (their new baseline, top set)
//   e. a main planned lift missing from a session-shaped log (two or more of
//      the day's lifts logged; several missing = a large departure, still ONE
//      question): sets alsoAsk; the headline only when nothing above applied
//   f. nothing notable
// Accessories never headline while a main lift has something; an accessory's
// estimated max never headlines at all (screenshot 5's lateral raises). An
// accessory only speaks when the log holds no main lift: a made-single PR or a
// plain load/reps step on the last time.
//
// "Main lift" comes from the lift taxonomy (src/grit.js): a benchmarked
// compound (MAIN_KEYS) or a big-lift family (liftTier 0), minus isolation,
// cable and machine work. Missing-lift detection reads the program's own day
// structure (parseProgramShape / extractDaySessionText) for the day this log
// matches best.

const ISOLATION_RE = /\b(raises?|curls?|extensions?|push ?downs?|fl(?:y|ies|yes|ys)|kickbacks?|shrugs?|calf|calves|crunch(?:es)?|planks?|face pulls?|pullovers?|band|bands|cable|machine|pec deck|ab wheel|sit-?ups?|hollow|bird dogs?|dead bugs?)\b/;
const MAIN_KEYS = new Set(["snatch", "clean and jerk", "power clean", "clean", "jerk", "push press", "front squat", "back squat", "deadlift", "romanian deadlift", "trap bar deadlift", "bench press", "incline bench press", "overhead press", "weighted pull-up", "weighted dip", "barbell row", "hip thrust"]);

export function isMainLift(name) {
  const r = resolveLift(name);
  if (!r || !r.tracked || !r.id) return false;
  if (ISOLATION_RE.test(r.id)) return false;
  if (r.benchKey && MAIN_KEYS.has(r.benchKey)) return true;
  return liftTier(r.id) === 0;
}

// The lifts a sport is built around; a PR there outranks a bigger jump elsewhere.
const OLY_RE = /\b(snatch|clean|jerk)\b/;
const OLY_NOT = /\b(pull|deadlift|balance|shrug|press|grip|high)\b/;
const SPORT_CENTRAL = {
  "Olympic Weightlifting": (id) => OLY_RE.test(id) && !OLY_NOT.test(id),
  "Powerlifting": (id) => ["back squat", "bench press", "deadlift"].includes(id),
  "Football": (id) => ["back squat", "bench press", "deadlift", "power clean", "trap bar deadlift"].includes(id),
};
export const isSportCentral = (name, sport) => { const f = SPORT_CENTRAL[sport]; return !!(f && f(resolveLift(name).id)); };

// Two names are the same lift when the taxonomy says so, or when only a start
// position differs ("Split Jerk from Rack" / "Split Jerk").
const QUALIFIER_RE = /\bfrom (?:the )?(?:rack|racks|blocks?|floor|hang|hip|knee|pins?)\b|\([^)]*\)/gi;
const bareId = (name) => resolveLift(String(name || "").replace(QUALIFIER_RE, " ").replace(/\s+/g, " ").trim()).id;
export const sameLift = (a, b) => resolveLift(a).id === resolveLift(b).id || bareId(a) === bareId(b);

// Every lift a plan text prescribes with a sets x reps scheme, in order.
const PLAN_LIFT_RE = /([A-Za-z][A-Za-z &'’+\-/]{1,70}?)\s*[:\-–—]?\s+(\d{1,2})\s*[x×]\s*(\d{1,3})/g;
export function plannedLifts(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    PLAN_LIFT_RE.lastIndex = 0;
    let m;
    while ((m = PLAN_LIFT_RE.exec(line))) {
      const name = m[1].replace(LEAD_NOISE, "").replace(/[\s:\-–—]+$/, "").trim();
      if (!/[a-z]{3}/i.test(name) || /^(sets?|reps?|rounds?|x)$/i.test(name)) continue;
      if (!resolveLift(name).tracked) continue;
      if (out.some((p) => sameLift(p.name, name))) continue;
      out.push({ name, main: isMainLift(name) });
    }
  }
  return out;
}

// The program day this log belongs to: the day whose planned lifts overlap the
// logged ones most (ties go to the resolver's day; an unbroken tie is no day).
// A program with no day structure counts as one session only when short.
export function planDayFor({ programText, loggedNames = [], resolverLabel = null, week = null } = {}) {
  const text = String(programText || "");
  if (!text.trim() || !loggedNames.length) return null;
  const shape = parseProgramShape(text);
  const days = shape.dayTemplate.length
    ? shape.dayTemplate.map((label) => ({ label, text: extractDaySessionText(text, { week: shape.hasWeeks ? week : null, dayLabel: label }) || "" }))
    : [{ label: null, text }];
  let best = [];
  let bestN = 0;
  for (const d of days) {
    const planned = plannedLifts(d.text);
    if (!d.label && planned.length > 8) continue;
    const n = loggedNames.filter((l) => planned.some((p) => sameLift(p.name, l))).length;
    if (n > bestN) { best = [{ ...d, planned }]; bestN = n; }
    else if (n === bestN && n > 0) best.push({ ...d, planned });
  }
  if (!bestN) return null;
  if (best.length > 1) {
    const r = resolverLabel && best.find((d) => d.label === resolverLabel);
    if (!r) return null;
    best = [r];
  }
  return { label: best[0].label, planned: best[0].planned, matched: bestN };
}

const topSet = (ex) => {
  const sets = getExerciseSets(ex).filter((s) => !s.warmup);
  const bw = ex.unit === "bodyweight";
  const load = (s) => (bw ? (s.weight > 0 ? s.weight : ex.added_weight > 0 ? ex.added_weight : 0) : s.weight);
  return sets.reduce((b, s) => {
    const l = load(s);
    return !b || l > b.load || (l === b.load && s.reps > b.reps) ? { load: l, reps: s.reps } : b;
  }, null);
};
const lbsOf = (ex, load) => (ex.unit === "bodyweight" ? load : toLbs(load, ex.unit));

function setText(ex, top, displayUnit) {
  if (!top) return "";
  if (ex.unit === "bodyweight") return top.load > 0 ? `bodyweight plus ${fmtNum(top.load)} lbs x ${top.reps}` : `bodyweight x ${top.reps}`;
  const du = displayUnit === "kg" || displayUnit === "lbs" ? displayUnit : ex.unit;
  const w = ex.unit === du ? fmtNum(top.load) : fmtNum(roundStat(toDisplay(top.load, ex.unit, du), du));
  return `${w} ${unitLabel(du)}${ex.load_basis === "each" ? " each" : ""} x ${top.reps}`;
}
const fmtDay = (d) => { try { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return ""; } };

// PR CHECK lines are the verdicts (src/grit.js prCheckLines); read, never re-derive.
function prVerdict(line) {
  const lbs = [...String(line).matchAll(/(\d+(?:\.\d+)?) lbs/g)].map((m) => +m[1]);
  let m;
  if ((m = line.match(/: NEW PR — made single at (.+?), ABOVE the previous best (.+?)\.\s*$/))) {
    return { kind: "pr", single: true, newText: m[1], prevText: m[2], jump: lbs.length >= 2 ? lbs[0] / lbs[lbs.length - 1] : 1 };
  }
  if ((m = line.match(/: NEW ESTIMATED PR — top set (.+?) works out to (.+?) estimated, above the previous best (.+?)\.\s*$/))) {
    return { kind: "pr", single: false, estText: m[2], prevText: m[3], jump: lbs.length >= 3 ? lbs[1] / lbs[lbs.length - 1] : 1 };
  }
  if (/: first record on file for this lift/.test(line)) return { kind: "first" };
  return null;
}

const SESSION_GAP_MS = 3 * 60 * 60 * 1000;

// logHeadline({exercises, prLines, lastDone, painTurn, planDay, sport, displayUnit, now})
//   exercises: this message's parsed exercises
//   prLines:   prCheckLines(...) output for them (the PR CHECK block's lines)
//   lastDone:  the chat turn's LAST TIME PER EXERCISE index, Map|object
//              liftId -> {name, date, ex} (history BEFORE this message)
//   painTurn:  the pain ledger's turn ({areas, serious, verdicts})
//   planDay:   planDayFor(...) result, or null
// -> {kind, line, alsoAsk}; kind in pain_serious | pr | pain | progress | first | plan_gap | none
export function logHeadline({ exercises = [], prLines = [], lastDone = null, painTurn = null, planDay = null, sport = "", displayUnit = "lbs", now = new Date() } = {}) {
  const exs = (Array.isArray(exercises) ? exercises : []).filter((e) => e && e.name);
  const nowMs = new Date(now).getTime();
  const getLast = (name) => {
    const id = resolveLift(name).id;
    const r = lastDone ? (lastDone instanceof Map ? lastDone.get(id) : lastDone[id]) : null;
    return r && r.ex ? r : null;
  };
  const sameSession = (r) => r && Math.abs(nowMs - new Date(r.date).getTime()) < SESSION_GAP_MS;

  // e: main planned lifts missing (a lift already logged earlier this session counts as done)
  let alsoAsk = null;
  let gapLine = null;
  // Only a session-shaped log (two or more lifts on the matched day) is checked
  // for gaps: "hit a 102 snatch today" is a highlight, not the whole session.
  if (planDay && Array.isArray(planDay.planned) && planDay.matched >= 2) {
    const missing = planDay.planned.filter((p) => p.main
      && !exs.some((e) => sameLift(e.name, p.name))
      && !sameSession(getLast(p.name)));
    if (missing.length) {
      const names = missing.map((p) => p.name);
      const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
      gapLine = `${list} ${names.length === 1 ? "was" : "were"} on today's plan and ${names.length === 1 ? "is" : "are"} not in this log.`;
      alsoAsk = `${gapLine} Ask once: skipped today, or just not logged?`;
    }
  }

  // pain first: serious always leads, and a pain turn never asks about a skipped lift
  const turn = painTurn && Array.isArray(painTurn.areas) ? painTurn : null;
  const areaName = (a) => String(a).replace(/_/g, " ");
  if (turn && turn.areas.length && (turn.serious || turn.areas.some((a) => turn.verdicts?.[a] === "address_now"))) {
    const areas = turn.areas.filter((a) => turn.serious || turn.verdicts?.[a] === "address_now");
    return { kind: "pain_serious", line: `Serious ${areas.map(areaName).join(" and ")} pain in this message (verdict address_now): speak to it as the PAIN LEDGER block says.`, alsoAsk: null };
  }

  // b: PRs (main lifts), from the PR CHECK verdicts
  const verdicts = exs.map((ex) => {
    const line = (prLines || []).find((l) => String(l).startsWith(`${ex.name}: `));
    return { ex, main: isMainLift(ex.name), v: line ? prVerdict(line) : null };
  });
  const prs = verdicts.filter((x) => x.v && x.v.kind === "pr");
  const pick = (list, score) => list.slice().sort((a, b) => (isSportCentral(b.ex.name, sport) - isSportCentral(a.ex.name, sport)) || (score(b) - score(a)))[0];
  const mainPrs = prs.filter((x) => x.main);
  const prLine = (x) => x.v.single
    ? `${x.ex.name}: new PR, a single at ${x.v.newText}; previous best ${x.v.prevText}.`
    : `${x.ex.name}: new estimated PR from a top set of ${setText(x.ex, topSet(x.ex), displayUnit)} (estimate ${x.v.estText}, previous best ${x.v.prevText}). Say the set; the estimate numbers are for you.`;
  if (mainPrs.length) {
    const x = pick(mainPrs, (y) => y.v.jump);
    return { kind: "pr", line: prLine(x), alsoAsk };
  }

  // c: a pain line this message earns
  if (turn && turn.areas.length) {
    const spoken = turn.areas.filter((a) => ["acknowledge_once", "offer_change_once"].includes(turn.verdicts?.[a]));
    if (spoken.length) {
      return { kind: "pain", line: `${spoken.map((a) => `${areaName(a)} (${turn.verdicts[a]})`).join(", ")}: the pain this message mentions; handle it as the PAIN LEDGER block says.`, alsoAsk: null };
    }
  }

  // d: up on the last time (load, or reps at the same load), then first time on file
  const steps = [];
  const firsts = [];
  for (const x of verdicts) {
    const cur = topSet(x.ex);
    if (!cur || !(cur.reps > 0)) continue;
    if (x.ex.time_per_set_seconds > 0) continue;
    const last = getLast(x.ex.name);
    if (last && !sameSession(last)) {
      const prev = topSet(last.ex);
      if (!prev || !(prev.reps > 0)) continue;
      const c = lbsOf(x.ex, cur.load), p = lbsOf(last.ex, prev.load);
      const up = (c > p + 0.5 && cur.reps >= prev.reps) || (Math.abs(c - p) <= 0.5 && cur.reps > prev.reps);
      if (up) steps.push({ ...x, cur, prev, last, gain: p > 0 ? (c * (1 + cur.reps / 30)) / (p * (1 + prev.reps / 30)) : 1 + (cur.reps - prev.reps) / Math.max(1, prev.reps) });
    } else if (!last && x.v && x.v.kind === "first" && cur.load > 0) {
      firsts.push({ ...x, cur });
    }
  }
  const mainSteps = steps.filter((x) => x.main);
  const stepLine = (x) => `${x.ex.name}: ${setText(x.ex, x.cur, displayUnit)} today, up from ${setText(x.last.ex, x.prev, displayUnit)} on ${fmtDay(x.last.date)}.`;
  if (mainSteps.length) return { kind: "progress", line: stepLine(pick(mainSteps, (y) => y.gain)), alsoAsk };
  const mainFirsts = firsts.filter((x) => x.main);
  if (mainFirsts.length) {
    const x = pick(mainFirsts, (y) => lbsOf(y.ex, y.cur.load));
    return { kind: "first", line: `${x.ex.name}: top set ${setText(x.ex, x.cur, displayUnit)}, the heaviest work in this log (nothing earlier on file to compare it with).`, alsoAsk };
  }

  // e as the headline, when nothing above applied
  if (gapLine) return { kind: "plan_gap", line: gapLine, alsoAsk };

  // accessories speak only when the log holds no main lift
  if (!verdicts.some((x) => x.main)) {
    const singles = prs.filter((x) => x.v.single);
    if (singles.length) return { kind: "pr", line: prLine(pick(singles, (y) => y.v.jump)), alsoAsk };
    if (steps.length) return { kind: "progress", line: stepLine(pick(steps, (y) => y.gain)), alsoAsk };
  }
  return { kind: "none", line: "", alsoAsk: null };
}

// PR CHECK lines as Joe reads them on a log turn: an accessory's ESTIMATED PR is
// a true fact the app tracks, and a reply that celebrates it is the screenshot 5
// failure. The verdict stays; the line says it is not a talking point.
export function prLinesForReply(lines, exercises = []) {
  return (Array.isArray(lines) ? lines : []).map((l) => {
    const ex = (exercises || []).find((e) => e && e.name && String(l).startsWith(`${e.name}: `));
    return ex && !isMainLift(ex.name) && /: NEW ESTIMATED PR/.test(l)
      ? `${l} Accessory estimate: the app tracks it; leave it out unless they ask.`
      : l;
  });
}

// A stated PR the parser files only under pr_attempts ("hit a 102kg snatch
// today, new PR" parses with exercises empty) is still performed work: as a
// single it feeds the log-turn facts. Unit: the attempt's own, else the
// athlete's display unit (the athlete wrote the number in their unit).
export function logTurnExercises(parsed, displayUnit = "lbs") {
  if (!parsed) return [];
  if (Array.isArray(parsed.exercises) && parsed.exercises.length) return parsed.exercises;
  return (Array.isArray(parsed.pr_attempts) ? parsed.pr_attempts : [])
    .filter((p) => p && p.achieved && p.exercise && p.weight > 0)
    .map((p) => ({ name: p.exercise, sets: 1, reps: p.reps > 0 ? p.reps : 1, weight: p.weight, unit: p.unit === "kg" || p.unit === "lbs" ? p.unit : (displayUnit === "kg" ? "kg" : "lbs") }));
}

// The block for a log turn's dynamic tail. Short on purpose; no word counts.
export function logFocusBlock(h) {
  if (!h) return "";
  const head = h.kind === "none" ? "Headline: nothing stands out in this log." : `Headline: ${h.line}`;
  const reply = h.kind === "none"
    ? "The reply to this log is a short acknowledgment, and that is the whole reply."
    : `The reply to this log is a short acknowledgment plus the headline in one sentence${h.alsoAsk ? ", then that one question" : ""}.`;
  return `LOG REPLY FOCUS (computed by the app for this log):\n${head}${h.alsoAsk ? `\nQuestion: ${h.alsoAsk}` : ""}\nEverything above this block is for your own understanding: the numbers are there so you get it right, not to be read back. ${reply} Leave out every other lift, estimate, plan difference and history note. If they asked a question or asked for detail in this same message, answer it as fully as they asked; this block never limits an answer they asked for.`;
}
