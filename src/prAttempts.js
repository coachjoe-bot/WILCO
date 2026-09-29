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
import { toLbs, attemptUnit } from "./units.js";
import { implausibleJump } from "./grit.js";

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
  if (Array.isArray(ex?.set_details)) ex.set_details.forEach((s) => add(s?.weight));
  return out;
};

// ─── THE ONE RESOLVER (exercises + declared maxes, this turn) ─────────────────
// Resolves the unit of every load in a fresh parse and stamps it on the row, so
// saved parsed_data is self-describing (units.js contract: storage is the raw
// weight + unit pair). Order, for each exercise and each pr_attempts entry:
//   1. the unit written on that number in the message (its load chain)
//   2. the unit written on the SAME lift elsewhere in this message ("Back Squat
//      singles @ 70/110/150 then I missed 180kg": the squat is kg)
//   3. the parser's unit, ONLY if the message backs it: the unit stands alone as
//      a word ("all in kilos") or is written on a number no OTHER lift claims.
//      A unit written on another lift is that lift's (T46: "squat 180kg, then
//      bench 135" is a 135 LB bench for an lbs athlete; "clean 100, then curls
//      40lb" is a 100 KG clean for a kg athlete)
//   4. (declared maxes only) the same lift's set in this message, as resolved
//   5. the athlete's display unit
// Why the parser's unit is not simply trusted: told to return null when nothing
// is written, the real model still fills one in (live pass 09-28: "102 snatch"
// came back kg, "165 press" came back lbs), and its old rulebook said an
// unlabelled load is lbs. With no message to check against, the parser's unit
// stands. "bodyweight" exercises are left exactly as parsed. Pure and
// idempotent: same inputs, same stamp; the same object back when nothing changes.
export const resolveLoadUnits = (parsed, { displayUnit, message = "", normalizeName = lower } = {}) => {
  const exercises = Array.isArray(parsed?.exercises) ? parsed.exercises : [];
  const attempts = Array.isArray(parsed?.pr_attempts) ? parsed.pr_attempts : [];
  const du = displayUnit === "kg" ? "kg" : "lbs";
  const chains = message ? loadChains(message) : [];
  const liftOf = (name) => normalizeName(name || "");

  // Items in message order: exercises first (the parser lists them as performed),
  // then declared maxes.
  const items = [
    ...exercises.map((ex, i) => ({ kind: "ex", i, src: ex, lift: liftOf(ex?.name), nums: loadNumbers(ex), bw: ex?.unit === "bodyweight" })),
    ...attempts.map((p, i) => ({ kind: "pr", i, src: p, lift: liftOf(p?.exercise), nums: loadNumbers({ weight: p?.weight }), bw: false })),
  ].filter((it) => it.src);

  // Claim chains. Each exercise takes the first chain holding one of its numbers
  // at or after the previous exercise's chain (so a number repeated across two
  // lifts goes to the right one), then every chain up to the next exercise's
  // that also holds its numbers (warm-ups written apart from working sets).
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

  // 1. written on its own numbers (one unit kind across its chains, else none)
  for (const it of items) {
    const kinds = new Set();
    for (const k of it.claims) for (const n of it.nums) { const u = tokenUnit(chains[k], n); if (u) kinds.add(u); }
    it.written = kinds.size === 1 ? [...kinds][0] : null;
  }
  // 3's evidence: a unit word standing alone, or a unit written on a chain that
  // no item of a DIFFERENT lift claims.
  const backed = (it, unit) => {
    if (freeMention(message, unit)) return true;
    return chains.some((c, k) => {
      if (!c.tokens.some((t) => (t.unit || c.unit) === unit)) return false;
      return !items.some((o) => o.lift !== it.lift && o.claims.includes(k));
    });
  };
  const resolve = (it) => {
    if (it.written) return [it.written, "written"];
    const twin = [...new Set(items.filter((o) => o !== it && o.lift && o.lift === it.lift && o.written).map((o) => o.written))];
    if (twin.length === 1) return [twin[0], "same-lift"];
    const parserUnit = it.src.unit;
    if (isUnit(parserUnit) && (!message || backed(it, parserUnit))) return [parserUnit, "parser"];
    return [null, null];
  };
  for (const it of items) [it.unit, it.source] = it.bw ? ["bodyweight", "bodyweight"] : resolve(it);
  // 4 + 5
  for (const it of items) {
    if (it.unit) continue;
    if (it.kind === "pr") {
      const twin = [...new Set(items.filter((o) => o.kind === "ex" && o.lift && o.lift === it.lift && isUnit(o.unit)).map((o) => o.unit))];
      if (twin.length === 1) { it.unit = twin[0]; it.source = "set"; continue; }
    }
    it.unit = du;
    it.source = "display";
  }
  const verdict = (kind, i) => { const it = items.find((x) => x.kind === kind && x.i === i); return it ? { unit: it.unit, source: it.source, written: it.written } : null; };
  return { exercises: exercises.map((_, i) => verdict("ex", i)), pr_attempts: attempts.map((_, i) => verdict("pr", i)) };
};

// Stamp the resolved units onto the parse (see resolveLoadUnits for the order).
export const stampLoadUnits = (parsed, opts = {}) => {
  const exercises = Array.isArray(parsed?.exercises) ? parsed.exercises : [];
  const attempts = Array.isArray(parsed?.pr_attempts) ? parsed.pr_attempts : [];
  if (!exercises.length && !attempts.length) return parsed;
  const v = resolveLoadUnits(parsed, opts);

  const exUnits = exercises.map((ex, i) => (v.exercises[i] ? v.exercises[i].unit : ex?.unit));
  const prUnits = attempts.map((p, i) => (v.pr_attempts[i] ? v.pr_attempts[i].unit : p?.unit));
  const exSame = exercises.every((ex, i) => !ex || ex.unit === exUnits[i]);
  const prSame = attempts.every((p, i) => !p || p.unit === prUnits[i]);
  if (exSame && prSame) return parsed;
  return {
    ...parsed,
    ...(exSame ? {} : { exercises: exercises.map((ex, i) => (ex ? { ...ex, unit: exUnits[i] } : ex)) }),
    ...(prSame ? {} : { pr_attempts: attempts.map((p, i) => (p ? { ...p, unit: prUnits[i] } : p)) }),
  };
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
