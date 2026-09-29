// ─── DECLARED MAXES (parsed_data.pr_attempts) — unit + write decision ─────────
// Pure logic pulled out of finalizeWorkout so it has a suite
// (scripts/test-pr-attempts.mjs). The 09-28 incident: the parse schema had no unit
// on pr_attempts, the writer defaulted a missing unit to "lbs", and a kg athlete's
// "Hit a 102kg snatch today, new PR" landed in manual_one_rms as 102 LBS (46.3 kg).
// manual_one_rms is the ACTUAL 1RM store and outranks every estimate, so Joe then
// quoted 46.3 kg back as the athlete's best. With a higher row already standing the
// same default silently skipped the real PR instead.
//
// T65 widened the same fix to every logged set (parsed_data.exercises): a kg
// athlete's "squat 5x3 at 140" was saved as a 140 LB squat because the parser's
// rulebook called an unlabelled load lbs. Exercises and declared maxes now go
// through ONE this-turn resolver, stampLoadUnits (below).
//
// TWO resolvers, because "no unit on the attempt" means different things:
//   • THIS TURN (stampLoadUnits, alias stampAttemptUnits): the athlete's display unit is contemporaneous
//     with the message, so it is the right fallback.
//   • A STORED ROW (storedAttemptUnit): rows saved before the fix carry no unit, and
//     the athlete may have switched units since (the founder logged in lbs until
//     late August, kg after). Today's display unit says nothing about a June row,
//     so the row's own evidence is read first.
import { toLbs, attemptUnit, addedLoadUnit } from "./units.js";
import { implausibleJump, resolveLift, effectiveDate, bestE1RMForExercise, epley1RM, IMPLAUSIBLE_JUMP_FLOOR_LBS, IMPLAUSIBLE_JUMP_MIN_LBS, IMPLAUSIBLE_JUMP_PCT } from "./grit.js";

const isUnit = (u) => u === "kg" || u === "lbs";
const lower = (s) => String(s || "").toLowerCase().trim();

// ─── LOAD CHAINS: the athlete's own numbers and the unit written on them ──────
// T65. A "chain" is one load expression as the athlete typed it: numbers joined
// by "/", ",", "-", "x" or "+" ("100/110/120kg", "20kg/50/70/118", "120,140, 140
// kg", "BW/+25lbs/+25lbs", "130lbs//150lbs"). A unit written anywhere in a chain
// covers every number in it (both conventions appear in real logs: unit on the
// last number, unit on the first). Plain whitespace, words, "@" and line breaks
// end a chain, so "squat 180kg, then bench 135" is two chains and the kg stays on
// the squat. A chain that is a percentage, an RPE/RIR, a time or a distance is
// not a load and is dropped.
const UNIT_TOKEN = "kilograms?|kilos?|kgs?|lbs?|pounds?|#";
// "(?![a-wyz])" (case-insensitive): a unit word is a unit only when a letter does
// not continue it ("kgb", "lbsomething"), but "100kgx3" is 100 kg for 3. A number
// glued to a letter other than "x" ("A2" superset label, "W3") is not a load;
// "3x8" still reads as 3, x, 8.
const TOKEN_RE = new RegExp(`(?<![\\d.a-wyz])(\\d+(?:\\.\\d+)?)(?![.\\d])(?:\\s?(${UNIT_TOKEN})(?![a-wyz]))?`, "gi");
const JOINER_RE = /^\s*(?:\/+\s*\+?|,\s*\+?|-|x|×|\+)\s*$/i;
const NOT_LOAD_AFTER = /^\s*(?:%|:\d|rpe\b|rir\b|reps?\b|sets?\b|s\b|secs?\b|seconds?\b|mins?\b|minutes?\b|m\b|mi\b|miles?\b|km\b|yds?\b|yards?\b|ft\b|in\b|cal\b|cals\b|mph\b|bpm\b)/i;
const NOT_LOAD_BEFORE = /(?:rpe|rir)\s*@?\s*$/i;
const unitOfWord = (w) => (!w ? null : /^k/i.test(w) ? "kg" : "lbs");

export const loadChains = (message) => {
  const text = String(message || "");
  const chains = [];
  let cur = null;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) {
    const tok = { value: Number(m[1]), unit: unitOfWord(m[2]), start: m.index, end: m.index + m[0].length };
    if (cur && JOINER_RE.test(text.slice(cur.end, tok.start))) {
      cur.tokens.push(tok);
      cur.end = tok.end;
    } else {
      cur = { start: tok.start, end: tok.end, tokens: [tok] };
      chains.push(cur);
    }
  }
  return chains
    .filter((c) => {
      if (c.tokens.some((t) => t.unit)) return true; // a written weight unit settles it
      return !NOT_LOAD_AFTER.test(text.slice(c.end, c.end + 12)) && !NOT_LOAD_BEFORE.test(text.slice(Math.max(0, c.start - 6), c.start));
    })
    .map((c) => {
      const kinds = [...new Set(c.tokens.map((t) => t.unit).filter(Boolean))];
      return { ...c, unit: kinds.length === 1 ? kinds[0] : null, mixed: kinds.length > 1 };
    });
};

// The unit a chain gives one number in it: the token's own unit, else the chain's.
const tokenUnit = (chain, value) => {
  const t = chain.tokens.find((k) => Math.abs(k.value - value) < 1e-9);
  if (!t) return undefined; // number not in this chain
  return t.unit || chain.unit || null;
};
const chainHas = (chain, nums) => nums.some((n) => chain.tokens.some((k) => Math.abs(k.value - n) < 1e-9));

// The unit written ON that number in the athlete's own words ("102kg", "250 lbs",
// or a chain that carries one: "20kg/50/70/118" -> 118 is kg), else null.
export const writtenUnit = (message, weight) => {
  if (!message || weight == null || weight === "") return null;
  const n = Number(weight);
  if (!Number.isFinite(n)) return null;
  for (const c of loadChains(message)) {
    const u = tokenUnit(c, n);
    if (u) return u;
  }
  return null;
};

// Does the athlete's message name this unit anywhere ("whole session in kilos",
// "20kg/50/70/118")?
const UNIT_WORD = { kg: /(\d\s?|\b)(kgs?|kilos?|kilograms?)\b/i, lbs: /(\d\s?|\b)(lbs?|pounds?)\b/i };
export const mentionsUnit = (message, unit) => !!(UNIT_WORD[unit] && UNIT_WORD[unit].test(String(message || "")));
// A unit word standing on its own, not attached to a number: "all in kilos
// today", "kg session". This is a statement about the whole message.
const FREE_WORD = { kg: /(?<![\d.]\s?)\b(kgs?|kilos?|kilograms?)\b/i, lbs: /(?<![\d.]\s?)\b(lbs?|pounds?)\b/i };
const freeMention = (message, unit) => !!(FREE_WORD[unit] && FREE_WORD[unit].test(String(message || "")));

// Every number an exercise's load is made of (top set, per-set ladder, added load).
const loadNumbers = (ex) => {
  const out = [];
  const add = (v) => { const n = Number(v); if (v != null && v !== "" && Number.isFinite(n) && n > 0) out.push(n); };
  add(ex?.weight);
  add(ex?.added_weight);
  add(ex?.assist_weight);
  if (Array.isArray(ex?.set_details)) ex.set_details.forEach((s) => add(s?.weight));
  return out;
};

// ─── THE ONE RESOLVER (exercises + declared maxes, this turn) ─────────────────
// Resolves the unit of every load in a fresh parse and stamps it on the row, so
// saved parsed_data is self-describing (units.js contract: storage is the raw
// weight + unit pair). Order, for each exercise and each pr_attempts entry:
//   1. "written"   the unit written on that number in the message (its load chain)
//   2. "same-lift" the unit written on the SAME lift elsewhere in this message
//                  ("Back Squat singles @ 70/110/150 then I missed 180kg": kg)
//   3. "parser"    the parser's unit, ONLY if the message backs it: the unit
//                  stands alone as a word ("all in kilos") or is written on a
//                  number no OTHER lift claims. A unit written on another lift
//                  is that lift's (T46: "squat 180kg, then bench 135" is a 135 LB
//                  bench for an lbs athlete; "clean 100, then curls 40lb" is a
//                  100 KG clean for a kg athlete)
//      "set"       (declared maxes only) the same lift's set in this message
//   4. "history"   the unit this athlete has used for THIS lift (resolveLift
//                  identity) in the last 180 days, by recency: the last 3 logs
//                  agree -> that unit; they disagree -> the most recent of them
//                  written or athlete-confirmed; else the most recent. Unconfirmed
//                  (unit_suspect) logs are no evidence.
//                  Athletes mix units by lift (the founder: bars in kg; dumbbells,
//                  machines and his bench in lbs), so the setting alone misfiles.
//   5. "display"   the athlete's unit setting
// Guard on 4 and 5: when the load in the resolved unit is an implausible jump over
// the lift's own recent best (grit.js implausibleJump, both in lbs) AND the other
// unit reads as a plausible load, the unit is kept as resolved and the load is
// marked `suspect`; finalizeWorkout then runs the existing "hold up before I bank
// it" ask. Never a silent flip either way.
// Why the parser's unit is not simply trusted: told to return null when nothing
// is written, the real model still fills one in (live 09-29: "squat 180kg, then
// bench 135" came back kg on the bench 5 of 5 times). With no message to check
// against, the parser's unit stands. "bodyweight" exercises are left exactly as
// parsed. A load already stamped (it carries `unit_source`) is final. Pure: the
// history is handed in as data (the client's workoutHistory rows).
const HISTORY_DAYS = 180;
// unit_source values that mean the ATHLETE settled the unit (answering the app's
// "kg or lbs?", editing the row, or correcting it in chat).
export const CONFIRMED_SOURCES = new Set(["athlete_confirmed", "edit", "correction"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const liftIdOf = (name) => resolveLift(name || "").id;
const rowPD = (row) => {
  const pd = row?.parsed_data;
  if (typeof pd !== "string") return pd || {};
  try { return JSON.parse(pd); } catch { return {}; }
};
const rowTime = (row) => { const t = effectiveDate(row)?.getTime?.(); return Number.isFinite(t) ? t : NaN; };

// Chains + claims + the unit WRITTEN on each item's own numbers (step 1).
const readMessage = (exercises, attempts, message, liftOf) => {
  const chains = message ? loadChains(message) : [];
  const items = [
    ...exercises.map((ex, i) => ({ kind: "ex", i, src: ex, lift: liftOf(ex?.name), nums: loadNumbers(ex), bw: ex?.unit === "bodyweight" })),
    ...attempts.map((p, i) => ({ kind: "pr", i, src: p, lift: liftOf(p?.exercise), nums: loadNumbers({ weight: p?.weight }), bw: false })),
  ].filter((it) => it.src);
  // Each exercise takes the first chain holding one of its numbers at or after the
  // previous exercise's chain (a number repeated across two lifts goes to the right
  // one), then every chain up to the next exercise's that also holds its numbers
  // (warm-ups written apart from working sets).
  const exItems = items.filter((it) => it.kind === "ex");
  let cursor = 0;
  for (const it of exItems) {
    if (!it.nums.length) { it.primary = -1; continue; }
    let idx = chains.findIndex((c, k) => k >= cursor && chainHas(c, it.nums));
    if (idx >= 0) cursor = idx + 1;
    else idx = chains.findIndex((c) => chainHas(c, it.nums));
    it.primary = idx;
  }
  for (const it of exItems) {
    it.claims = [];
    if (it.primary < 0) continue;
    const nextStarts = exItems.map((o) => o.primary).filter((p) => p > it.primary);
    const stop = nextStarts.length ? Math.min(...nextStarts) : chains.length;
    for (let k = it.primary; k < stop; k++) if (chainHas(chains[k], it.nums)) it.claims.push(k);
  }
  for (const it of items.filter((x) => x.kind === "pr")) {
    it.claims = [];
    if (!it.nums.length) continue;
    const otherLift = (k) => exItems.some((o) => o.lift !== it.lift && o.claims.includes(k));
    let idx = chains.findIndex((c, k) => chainHas(c, it.nums) && !otherLift(k));
    if (idx < 0) idx = chains.findIndex((c) => chainHas(c, it.nums));
    if (idx >= 0) it.claims.push(idx);
  }
  for (const it of items) {
    const kinds = new Set();
    for (const k of it.claims) for (const n of it.nums) { const u = tokenUnit(chains[k], n); if (u) kinds.add(u); }
    it.written = kinds.size === 1 ? [...kinds][0] : null;
  }
  return { chains, items };
};

// The athlete's recent logs of each lift in `liftIds`, newest first:
// [{ t, stored, written, e1 }] (weighted kg/lbs sets only, within 180 days of now).
const liftHistory = (history, liftIds, now, added = false) => {
  const out = new Map([...liftIds].map((id) => [id, []]));
  if (!Array.isArray(history) || !out.size) return out;
  for (const row of history) {
    const t = rowTime(row);
    if (!Number.isFinite(t) || t > now || now - t > HISTORY_DAYS * DAY_MS) continue;
    const exs = Array.isArray(rowPD(row).exercises) ? rowPD(row).exercises : [];
    if (added) {
      // T68: the same log of an ADDED load, read off its own stamp. A row without
      // `added_unit` predates the stamp and is no evidence (its unit was never
      // decided by anyone, every reader just assumed lbs).
      for (const ex of exs) {
        if (!ex || ex.unit !== "bodyweight" || !isUnit(ex.added_unit) || !loadNumbers(ex).length || !out.has(liftIdOf(ex.name))) continue;
        out.get(liftIdOf(ex.name)).push({ t, stored: ex.added_unit, written: ex.added_unit_source === "written" ? ex.added_unit : null, confirmed: CONFIRMED_SOURCES.has(ex.added_unit_source), e1: 0 });
      }
      continue;
    }
    // An unconfirmed (unit_suspect) load is not evidence for anything.
    const hits = exs.map((ex, i) => [ex, i]).filter(([ex]) => ex && isUnit(ex.unit) && !ex.unit_suspect && loadNumbers(ex).length && out.has(liftIdOf(ex.name)));
    if (!hits.length) continue;
    const { items } = readMessage(exs, [], row?.raw_message || "", liftIdOf);
    for (const [ex, i] of hits) {
      const it = items.find((x) => x.kind === "ex" && x.i === i);
      out.get(liftIdOf(ex.name)).push({ t, stored: ex.unit, written: it?.written || null, confirmed: CONFIRMED_SOURCES.has(ex.unit_source), e1: bestE1RMForExercise(ex) || 0 });
    }
  }
  for (const logs of out.values()) logs.sort((a, b) => b.t - a.t);
  return out;
};
// Recency, not the oldest written word (orchestrator 09-29, after the founder's
// C&J: a months-old "290lbs" must not outrank his recent kg logs). The lift's
// last 3 logs: all agree -> that unit; they disagree -> the most recent of them
// whose unit was written in its message or confirmed by the athlete; none of
// those -> the most recent. A unit switch therefore settles within one written
// or confirmed log, and stays settled.
const HISTORY_WINDOW = 3;
const historyUnit = (logs) => {
  if (!logs || !logs.length) return null;
  const last = logs.slice(0, HISTORY_WINDOW);
  if (last.every((l) => l.stored === last[0].stored)) return last[0].stored;
  const sure = last.find((l) => l.written || l.confirmed);
  if (sure) return sure.confirmed ? sure.stored : sure.written;
  return last[0].stored;
};
// "Implausible against the lift's own history", in BOTH directions, on grit.js's
// implausibleJump thresholds (lbs): a jump over the recent best, or a collapse
// below it by the same margin. A unit read the wrong way is a factor of 2.2, so
// the switch-over case the guard exists for ("C&J 130" filed as lbs by a kg
// lifter whose last WRITTEN C&J was 290 lbs) is a collapse, not a jump. The
// "other unit is plausible" half keeps ordinary light days out: a light day read
// in the other unit is a 2x jump, never plausible.
const offBest = (best, e1) => {
  if (!(e1 > 0)) return false;
  if (implausibleJump(best, e1)) return true;
  return best >= IMPLAUSIBLE_JUMP_FLOOR_LBS && best - e1 >= IMPLAUSIBLE_JUMP_MIN_LBS && best / e1 >= 1 + IMPLAUSIBLE_JUMP_PCT - 1e-9;
};
const loadE1 = (it, unit) => (it.kind === "ex"
  ? bestE1RMForExercise({ ...it.src, unit, unit_suspect: undefined })
  : epley1RM(toLbs(Number(it.src.weight) || 0, unit), Number(it.src.reps) || 1)) || 0;

// The lift's best estimated 1RM (lbs) over the same 180-day history the resolver
// reads, for the "hold up" ask when the unit guard fires and no prs/manual row stands.
export const liftRecentBestLbs = (history, name, now = Date.now()) => {
  const id = liftIdOf(name);
  if (!id) return 0;
  return (liftHistory(history, new Set([id]), Number(now) || Date.now()).get(id) || []).reduce((m, l) => Math.max(m, l.e1), 0);
};

export const resolveLoadUnits = (parsed, { displayUnit, message = "", normalizeName = lower, history = [], now = Date.now() } = {}) => {
  const exercises = Array.isArray(parsed?.exercises) ? parsed.exercises : [];
  const attempts = Array.isArray(parsed?.pr_attempts) ? parsed.pr_attempts : [];
  const du = displayUnit === "kg" ? "kg" : "lbs";
  const { chains, items } = readMessage(exercises, attempts, message, (name) => normalizeName(name || ""));

  // 3's evidence: a unit word standing alone, or a unit written on a chain that
  // no item of a DIFFERENT lift claims.
  const backed = (it, unit) => {
    if (freeMention(message, unit)) return true;
    return chains.some((c, k) => {
      if (!c.tokens.some((t) => (t.unit || c.unit) === unit)) return false;
      return !items.some((o) => o.lift !== it.lift && o.claims.includes(k));
    });
  };
  for (const it of items) {
    if (it.src.unit_source && (isUnit(it.src.unit) || it.src.unit === "bodyweight")) {
      [it.unit, it.source, it.suspect] = [it.src.unit, it.src.unit_source, !!it.src.unit_suspect];
      continue;
    }
    if (it.bw) { [it.unit, it.source] = ["bodyweight", "bodyweight"]; continue; }
    if (it.written) { [it.unit, it.source] = [it.written, "written"]; continue; }
    const twin = [...new Set(items.filter((o) => o !== it && o.lift && o.lift === it.lift && o.written).map((o) => o.written))];
    if (twin.length === 1) { [it.unit, it.source] = [twin[0], "same-lift"]; continue; }
    const parserUnit = it.src.unit;
    if (isUnit(parserUnit) && (!message || backed(it, parserUnit))) { [it.unit, it.source] = [parserUnit, "parser"]; continue; }
  }
  // Declared maxes: the same lift's set in this message, as resolved.
  for (const it of items) {
    if (it.unit || it.kind !== "pr") continue;
    const twin = [...new Set(items.filter((o) => o.kind === "ex" && o.lift && o.lift === it.lift && isUnit(o.unit)).map((o) => o.unit))];
    if (twin.length === 1) [it.unit, it.source] = [twin[0], "set"];
  }
  // 4 + 5, with the plausibility guard.
  const open = items.filter((it) => !it.unit);
  if (open.length) {
    const ids = new Set(open.map((it) => liftIdOf(it.kind === "ex" ? it.src.name : it.src.exercise)).filter(Boolean));
    const hist = liftHistory(history, ids, Number(now) || Date.now());
    for (const it of open) {
      const logs = hist.get(liftIdOf(it.kind === "ex" ? it.src.name : it.src.exercise)) || [];
      const hu = historyUnit(logs);
      [it.unit, it.source] = hu ? [hu, "history"] : [du, "display"];
      const best = logs.reduce((m, l) => Math.max(m, l.e1), 0);
      if (best > 0 && it.nums.length) {
        const other = it.unit === "kg" ? "lbs" : "kg";
        it.suspect = offBest(best, loadE1(it, it.unit)) && !offBest(best, loadE1(it, other));
      }
    }
  }
  // T68: the unit of an ADDED load on a bodyweight lift ("BW+20", assist, per-set
  // weights). The row's own unit is "bodyweight", so this is a second answer beside
  // it, decided by the same order: written on the number (it.written), the same
  // lift elsewhere in the message, that lift's last 3 logs of an added load, the
  // athlete's setting. No step for the parser's unit: a bodyweight row's `unit`
  // says "bodyweight", so the parser has no unit to offer for the load. No plausibility
  // guard either: bodyweight is not a stored 1RM and nothing derived is written from it.
  const addedItems = items.filter((it) => it.kind === "ex" && it.bw && it.nums.length);
  if (addedItems.length) {
    const ids = new Set(addedItems.map((it) => liftIdOf(it.src.name)).filter(Boolean));
    const hist = liftHistory(history, ids, Number(now) || Date.now(), true);
    for (const it of addedItems) {
      if (it.src.added_unit_source && isUnit(it.src.added_unit)) { [it.addedUnit, it.addedSource] = [it.src.added_unit, it.src.added_unit_source]; continue; }
      if (it.written) { [it.addedUnit, it.addedSource] = [it.written, "written"]; continue; }
      const twin = [...new Set(items.filter((o) => o !== it && o.lift && o.lift === it.lift && o.written).map((o) => o.written))];
      if (twin.length === 1) { [it.addedUnit, it.addedSource] = [twin[0], "same-lift"]; continue; }
      const hu = historyUnit(hist.get(liftIdOf(it.src.name)) || []);
      [it.addedUnit, it.addedSource] = hu ? [hu, "history"] : [du, "display"];
    }
  }
  const verdict = (kind, i) => {
    const it = items.find((x) => x.kind === kind && x.i === i);
    return it ? { unit: it.unit, unitSource: it.source, source: it.source, written: it.written, suspect: !!it.suspect, addedUnit: it.addedUnit || null, addedSource: it.addedSource || null } : null;
  };
  return { exercises: exercises.map((_, i) => verdict("ex", i)), pr_attempts: attempts.map((_, i) => verdict("pr", i)) };
};

// Stamp the resolved units onto the parse (see resolveLoadUnits for the order):
// `unit`, `unit_source` (which step decided), and `unit_suspect: true` when the
// guard fired. A bodyweight lift's added/assist load gets `added_unit` +
// `added_unit_source` the same way (T68). A stamped load is final, so a second
// stamp returns the same object.
export const stampLoadUnits = (parsed, opts = {}) => {
  const exercises = Array.isArray(parsed?.exercises) ? parsed.exercises : [];
  const attempts = Array.isArray(parsed?.pr_attempts) ? parsed.pr_attempts : [];
  if (!exercises.length && !attempts.length) return parsed;
  const v = resolveLoadUnits(parsed, opts);
  const apply = (x, r) => {
    if (!x || !r) return x;
    if (r.unitSource === "bodyweight") {
      // Bodyweight work is left exactly as parsed, except that an added/assist/per-set
      // load gets its own unit beside the number (T68). Nothing else on the row moves.
      if (!r.addedUnit || (x.added_unit === r.addedUnit && x.added_unit_source === r.addedSource)) return x;
      return { ...x, added_unit: r.addedUnit, added_unit_source: r.addedSource };
    }
    if (x.unit === r.unit && x.unit_source === r.unitSource && !!x.unit_suspect === r.suspect) return x;
    const { unit_suspect, ...rest } = x;
    return { ...rest, unit: r.unit, unit_source: r.unitSource, ...(r.suspect ? { unit_suspect: true } : {}) };
  };
  const ex2 = exercises.map((x, i) => apply(x, v.exercises[i]));
  const pr2 = attempts.map((x, i) => apply(x, v.pr_attempts[i]));
  const exSame = ex2.every((x, i) => x === exercises[i]);
  const prSame = pr2.every((x, i) => x === attempts[i]);
  if (exSame && prSame) return parsed;
  return { ...parsed, ...(exSame ? {} : { exercises: ex2 }), ...(prSame ? {} : { pr_attempts: pr2 }) };
};

// The 09-28 name, kept so the declared-max fix's call sites and suite read the
// same function. There is ONE resolver; this is it.
export const stampAttemptUnits = stampLoadUnits;

// The same lift logged as a set in the same message/row: same bar, same unit.
const twinUnit = (attempt, exercises, normalizeName) => {
  const name = normalizeName(attempt?.exercise);
  if (!name) return null;
  const twin = (Array.isArray(exercises) ? exercises : []).find((ex) => ex && isUnit(ex.unit) && normalizeName(ex.name) === name);
  return twin ? twin.unit : null;
};

// The unit of an attempt read back out of a saved workouts row. Stamped rows answer
// for themselves. Unstamped (pre-fix) rows: the row's twin set in either unit, then
// the unit written on that number in raw_message, and only then the display unit.
export const storedAttemptUnit = (attempt, row, displayUnit, normalizeName = lower) => {
  if (isUnit(attempt?.unit)) return attempt.unit;
  let pd = row?.parsed_data;
  if (typeof pd === "string") { try { pd = JSON.parse(pd); } catch { pd = null; } }
  return twinUnit(attempt, pd?.exercises, normalizeName)
    || writtenUnit(row?.raw_message, attempt?.weight)
    || attemptUnit(attempt, displayUnit);
};

// An achieved true single counts as a declared ACTUAL 1RM.
export const isDeclaredMax = (p) => !!(p && p.reps === 1 && p.achieved && p.exercise && p.weight);

// What finalizeWorkout should do with one declared max (already stamped).
//   existing  = the standing manual_one_rms row for the lift (or null)
//   estLbs    = best estimated 1RM on record in lbs (only read when no row stands)
// Returns {action:"insert"|"update"|"skip"|"suspect", unit, newLbs, oldLbs}. The
// weight is stored RAW with its unit (units.js contract); lbs is for comparison only.
export const declaredMaxWrite = (attempt, { existing = null, estLbs = 0, displayUnit } = {}) => {
  const unit = attemptUnit(attempt, displayUnit);
  const newLbs = toLbs(attempt.weight, unit);
  const oldLbs = existing ? toLbs(existing.weight, existing.unit) : (estLbs || 0);
  // A declared max is still a claim, not a receipt (T46's guard, same one the
  // exercises loop applies): too big a jump over the known best gets a sanity-check
  // verdict instead of silently becoming the athlete's max. Computed off the
  // RESOLVED unit, so a kg/lbs mix-up trips this instead of minting a bogus max —
  // a fresh kg athlete's cold start (no prior max) still passes through untouched,
  // same as every other implausibleJump call site (the floor gate needs a real
  // baseline to compare against).
  if (implausibleJump(oldLbs, newLbs)) return { action: "suspect", unit, newLbs, oldLbs };
  // Not actually a new max: leave the standing actual 1RM as it is.
  if (existing && newLbs <= oldLbs) return { action: "skip", unit, newLbs, oldLbs };
  return { action: existing ? "update" : "insert", unit, newLbs, oldLbs };
};

// The ask when the unit guard fired (unit_suspect): which unit was it? Stated in
// the unit it was filed under, with the other reading beside it. Deterministic,
// never a model call. checks: [{exercise, weight, unit}].
export const unitCheckMessage = (checks) => {
  const list = (Array.isArray(checks) ? checks : []).filter((c) => c && c.exercise && c.weight != null && isUnit(c.unit));
  if (!list.length) return "";
  const lbl = (u) => (u === "kg" ? "kg" : "lbs");
  const flip = (u) => (u === "kg" ? "lbs" : "kg");
  const lines = list.map((c) => `${c.exercise} at ${c.weight} ${lbl(c.unit)} doesn't line up with your recent ${c.exercise} numbers. ${c.weight} ${lbl(flip(c.unit))} would.`);
  const one = list.length === 1;
  return `Quick check before I bank ${one ? "that" : "those"}.\n${lines.join("\n")}\n\n${one ? "Which was it" : "Which were they"}, kg or lbs? I'll file ${one ? "it" : "them"} the way you say.`;
};

// ─── ONE VOICE ON A FLAGGED TURN (AI contract rule 5) ─────────────────────────
// The loads the app is asking about, from a stamped parse.
export const pendingUnitLoads = (parsed) => [
  ...(Array.isArray(parsed?.exercises) ? parsed.exercises : []).filter((x) => x?.unit_suspect).map((x) => ({ exercise: x.name, weight: x.weight, unit: x.unit })),
  ...(Array.isArray(parsed?.pr_attempts) ? parsed.pr_attempts : []).filter((x) => x?.unit_suspect).map((x) => ({ exercise: x.exercise, weight: x.weight, unit: x.unit })),
].filter((x) => x.exercise);

// The computed fact Joe gets in the turn's dynamic context when the app will ask.
export const unitCheckFact = (parsed) => {
  const loads = pendingUnitLoads(parsed);
  if (!loads.length) return "";
  const names = [...new Set(loads.map((l) => l.exercise))].join(", ");
  // T67 (09-29): "talk about the rest of the session" with nothing else in the
  // log made Joe describe the day's planned lifts as logged, 5 of 5 on main.
  // The app states what else this log holds.
  const others = [...new Set((Array.isArray(parsed?.exercises) ? parsed.exercises : []).filter((x) => x?.name && !x.unit_suspect).map((x) => x.name))];
  const rest = others.length
    ? `The rest of this log (${others.join(", ")}) gets your usual reply.`
    : "Nothing else is in this log: the reply is one short line that it is noted, and it names no other lift as done.";
  return `UNIT CHECK (computed by the app, FINAL): the app itself is asking the athlete, in its own message right after yours, whether ${names} ${loads.length > 1 ? "were" : "was"} logged in kg or lbs. It will not bank ${loads.length > 1 ? "those lifts" : "that lift"} until they answer. In your reply: do not question that number, do not ask about its unit, do not celebrate it, do not call it a PR, and do not restate its weight in either unit. ${rest}`;
};

// Did Joe's reply already ask about a flagged lift's unit or number? Then the app
// does not ask a second time (the kg/lbs chips still answer it). A question
// sentence that names kg/lbs/unit, or a flagged load's number.
export const replyAsksUnit = (reply, loads = []) => {
  const qs = String(reply || "").split(/(?<=[.!?])\s+|\n+/).filter((x) => /\?\s*$/.test(x.trim()));
  if (!qs.length) return false;
  const nums = (Array.isArray(loads) ? loads : []).map((l) => Number(l.weight)).filter((n) => Number.isFinite(n) && n > 0);
  return qs.some((q) => /\b(kgs?|kilos?|kilograms?|lbs?|pounds?|units?)\b/i.test(q)
    || nums.some((n) => new RegExp(`(?<![\\d.])${String(n).replace(".", "\\.")}(?![\\d])`).test(q)));
};

// The athlete answered "kg" or "lbs": settle every pending load in the row.
// Returns { parsed_data, bank } where bank is the subset to run the normal
// derived writes on (the confirmed loads, and nothing else). Pure.
export const confirmPendingUnits = (parsedData, unit) => {
  if (!isUnit(unit)) return { parsed_data: parsedData, bank: { exercises: [], pr_attempts: [] } };
  const settle = (x) => {
    if (!x?.unit_suspect) return x;
    const { unit_suspect, ...rest } = x;
    return { ...rest, unit, unit_source: "athlete_confirmed" };
  };
  const exs = Array.isArray(parsedData?.exercises) ? parsedData.exercises : [];
  const prs = Array.isArray(parsedData?.pr_attempts) ? parsedData.pr_attempts : [];
  const ex2 = exs.map(settle), pr2 = prs.map(settle);
  return {
    parsed_data: { ...(parsedData || {}), exercises: ex2, pr_attempts: pr2 },
    bank: { exercises: ex2.filter((x, i) => x !== exs[i]), pr_attempts: pr2.filter((x, i) => x !== prs[i]) },
  };
};

// The loads a manual EDIT settled (T68). The My Log edit sheet clears `unit_suspect`
// when the athlete picks a unit by hand, which is the same answer the chips give, so
// it banks the same way. Given the row's parsed_data before and after the edit,
// returns { exercises, pr_attempts }: the AFTER version of every load that was
// pending before and no longer is (matched by lift; a removed lift is not settled).
// Nothing pending before, or still pending after, returns nothing to bank. Pure.
export const settledLoads = (before, after) => {
  const key = (x) => liftIdOf(x?.name || x?.exercise || "") || lower(x?.name || x?.exercise);
  const pending = (pd, list) => new Set((Array.isArray(pd?.[list]) ? pd[list] : []).filter((x) => x?.unit_suspect).map(key));
  const settled = (list) => {
    const was = pending(before, list);
    return (Array.isArray(after?.[list]) ? after[list] : []).filter((x) => x && !x.unit_suspect && was.has(key(x)));
  };
  return { exercises: settled("exercises"), pr_attempts: settled("pr_attempts") };
};

// A typed answer to the app's "kg or lbs?" ("kg", "it was lbs", "kilos").
export const unitAnswer = (text) => {
  const m = /^\s*(?:it|that|those|they)?\s*(?:was|were)?\s*(?:in\s+)?(kgs?|kilos?|kilograms?|lbs?|pounds?)\s*[.!]?\s*$/i.exec(String(text || ""));
  return m ? (/^k/i.test(m[1]) ? "kg" : "lbs") : null;
};
