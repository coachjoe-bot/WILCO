// ─── UNITS — THE single source for lbs↔kg (T55) ───
// Every conversion in the app lives here. Four hand-copies of toLbs (two different
// constants) caused the kg leaks Will hit in TestFlight; do not add a fifth.
//
// Contract:
//   • STORAGE is always the raw (weight, unit) pair exactly as the athlete typed it.
//     Lossless by construction. Never store a converted or rounded number.
//   • DISPLAY converts from that raw pair in ONE step (identity when units match),
//     so flipping the Settings toggle back and forth never re-rounds a number.
//   • Derived values (e1RM, tonnage, diffs) are computed in lbs internally and
//     converted to the display unit only at the moment they're shown.
//   • Rounding happens ONLY at display: stats (PRs, e1RMs) to 1 lb / 0.5 kg,
//     working loads to 5 lb / 2.5 kg (Will's rule: no decimal working weights).
// Server code imports this via api/_units.js (same pattern as api/_grit.js).

export const LBS_PER_KG = 2.20462;

// Raw conversions — no rounding. Same signature/semantics as the old grit.js toLbs.
export const toLbs = (weight, unit) => (unit === "kg" ? weight * LBS_PER_KG : weight);
export const toKg = (weight, unit) => (unit === "kg" ? weight : weight / LBS_PER_KG);

// The athlete's chosen display unit. Set once at boot from athletes.weight_unit and
// again when the Settings toggle flips; read by every formatter below so no surface
// can drift from the setting.
let DISPLAY_UNIT = "lbs";
export const setDisplayUnit = (u) => { DISPLAY_UNIT = u === "kg" ? "kg" : "lbs"; };
export const getDisplayUnit = () => DISPLAY_UNIT;

// A declared max / attempt (parsed_data.pr_attempts[]) → the unit its number is in.
// The unit the athlete WROTE on that number wins. With none written, the number is
// in the athlete's own display unit, never a hard "lbs": a kg lifter's "102 snatch"
// filed as 102 lbs became a 46.3 kg ACTUAL 1RM that outranked every estimate (09-28).
// Every pr_attempts reader resolves through here; do not hand-copy the ternary.
export const attemptUnit = (attempt, displayUnit = DISPLAY_UNIT) =>
  attempt?.unit === "kg" || attempt?.unit === "lbs" ? attempt.unit : (displayUnit === "kg" ? "kg" : "lbs");

// A logged set (parsed_data.exercises[]) → the unit its numbers are in. T65: every
// row saved since carries a resolved "kg" | "lbs" | "bodyweight", stamped at parse
// time by src/prAttempts.js stampLoadUnits (unit written on the number, the same
// lift in the message, the parser's unit when the message backs it, then the
// athlete's own unit). A row with no unit predates that: the pre-T65 parser always
// filled one in and called an unlabelled load lbs, and on 2026-09-29 the only
// unit-less rows in prod (7) carried no weight at all, so legacy reads as "lbs".
// Every exercise reader resolves through here; do not hand-copy the ternary.
export const exerciseUnit = (ex) =>
  ex?.unit === "kg" || ex?.unit === "lbs" || ex?.unit === "bodyweight" ? ex.unit : "lbs";
// The unit to do weight math in for a set's WEIGHT. A bodyweight row has no weight
// of its own (its added/assist/per-set loads read through addedLoadUnit below, T68),
// so this stays "lbs" for it, which is also the unit a bodyweight lift's derived
// e1RM is labelled in.
export const exerciseLoadUnit = (ex) => (exerciseUnit(ex) === "kg" ? "kg" : "lbs");

// The unit of a bodyweight row's ADDED load ("BW+20": added_weight, assist_weight,
// and per-set weights on a unit:"bodyweight" exercise). The exercise's own `unit`
// is "bodyweight" there, so it cannot carry the load's unit; T68 stamps that on the
// row as `added_unit` ("kg" | "lbs", beside `added_unit_source`) through the same
// resolver as every other load (src/prAttempts.js stampLoadUnits). A row with no
// `added_unit` predates T68: every reader assumed lbs for it, and it keeps that
// meaning, so nothing already stored changes value. Every reader of an added load
// resolves through here; do not hand-write "lbs" next to added_weight again.
export const addedLoadUnit = (ex) => (ex?.added_unit === "kg" || ex?.added_unit === "lbs" ? ex.added_unit : "lbs");

// A load on a bodyweight row (added, assist or per-set weight) -> number in `to`
// (default: the display unit). One conversion from the raw pair, never rounded.
export const addedLoadIn = (ex, value, to = DISPLAY_UNIT) => toDisplay(value, addedLoadUnit(ex), to);

// A load whose unit the app could not settle (src/prAttempts.js marks it
// unit_suspect and asks "kg or lbs?"). Until the athlete answers, NOTHING is
// derived from it: no e1RM, no PR, no tonnage, no benchmark, no load comparison.
// The row itself is kept (the log is never lost). Every derived reader skips it
// through here.
export const isUnitPending = (ex) => ex?.unit_suspect === true;

// A raw stored (weight, unit) pair → number in the display unit. One conversion, ever.
export const toDisplay = (weight, unit, displayUnit = DISPLAY_UNIT) =>
  displayUnit === "kg" ? toKg(Number(weight) || 0, unit === "kg" ? "kg" : "lbs")
                       : toLbs(Number(weight) || 0, unit === "kg" ? "kg" : "lbs");

export const roundStat = (v, displayUnit = DISPLAY_UNIT) =>
  displayUnit === "kg" ? Math.round(v * 2) / 2 : Math.round(v);
export const roundLoad = (v, displayUnit = DISPLAY_UNIT) =>
  displayUnit === "kg" ? Math.round(v / 2.5) * 2.5 : Math.round(v / 5) * 5;

// Format a raw stored pair in the display unit. kind: "stat" (default) | "load".
export const fmtWeightIn = (weight, unit, { displayUnit = DISPLAY_UNIT, kind = "stat", space = false } = {}) => {
  const v = kind === "load" ? roundLoad(toDisplay(weight, unit, displayUnit), displayUnit)
                            : roundStat(toDisplay(weight, unit, displayUnit), displayUnit);
  return `${v}${space ? " " : ""}${displayUnit === "kg" ? "kg" : "lbs"}`;
};

// Format an ALREADY-lbs derived value (e1RM, tonnage, diff) in the display unit.
export const fmtLbsValue = (lbs, opts = {}) => fmtWeightIn(lbs, "lbs", opts);

// Bare display number (no unit suffix) for an already-lbs derived value.
export const displayStat = (lbs, displayUnit = DISPLAY_UNIT) =>
  roundStat(toDisplay(lbs, "lbs", displayUnit), displayUnit);

// The unit label alone, for JSX that renders number and suffix separately.
export const unitLabel = (displayUnit = DISPLAY_UNIT) => (displayUnit === "kg" ? "kg" : "lbs");

// ─── LOAD-EXPRESSION TOKENIZER (T64 Fix 6) ───────────────────────────────────
// src/boot.js's displayWeights()/draftInUnit() rewrite a program's "@ N" load
// text into the athlete's unit. Their old regexes matched a single bare number
// and excluded it from conversion only when already followed by the LITERAL
// "lbs" (plural) — "lb" (singular), "45#", "45 pounds" and multi-value loads
// ("100/110/120lb", "40-45lb") all slipped past that exclusion, got converted,
// and left their original unit text stitched onto the output ("45lb" -> the
// regex consumed only "45", so the replacement "20 kg" landed right in front
// of the untouched "lb" -> "20 kglb"). This tokenizer is the single funnel
// both functions call: it finds the WHOLE load expression after "@" (every
// number in it, however many, chained by /, -, x or a bare space; an optional
// unit word in any spelling; an optional per-side qualifier), decides ONCE
// whether it needs converting, and emits the target unit exactly once.
//
// The one-way contract (Will's original design, kept exactly): programs are
// authored in lbs unless a line says otherwise; a kg athlete gets every lbs
// load converted; an explicitly-kg-tagged load is never converted to lbs (no
// reverse path exists, or is wanted — "a unit applies only to the lift it is
// written on"). An untagged number is implied lbs.
const UNIT_NUM = "\\d+(?:\\.\\d+)?";
// One or more numbers chained by /, - or x (e.g. "100/110/120", "40-45", a
// single "45" is the n=1 case of the same pattern).
const UNIT_CHAIN = `${UNIT_NUM}(?:\\s*[\\/\\-x]\\s*${UNIT_NUM})*`;
// Every unit spelling this app has ever seen written, longest/most-specific
// first: "kglbs?" is the exact corrupted double-unit artifact the old bug
// produced ("20 kglb") — matching it here lets a corrupted row HEAL (repair
// the label, leave the already-converted number alone) instead of being
// re-matched as a bare number and converted a second time.
const UNIT_WORD = "(?:kglbs?\\b|lbs\\b|lb\\b|kgs\\b|kg\\b|kilograms\\b|kilogram\\b|kilos\\b|kilo\\b|pounds\\b|pound\\b|#)";
const CORRUPT_UNIT_RE = /^kglbs?$/i;
// A per-side / DB-count qualifier right after the load, captured WITH its own
// leading whitespace (or none, for "/hand") so it is reproduced byte-for-byte,
// never re-spaced or duplicated by the conversion.
const PER_SIDE = "(?:\\s*\\/\\s*hand|\\s*\\/\\s*side|\\s+each side|\\s+per side|\\s+each)";

// An optional "BW+"/"BW-"/"BW +"/"BW -" bodyweight-plus prefix right after
// "@". Captured as two groups (the literal "BW" and the sign) so the numeric
// part alone runs through the normal chain/unit machinery below and the
// prefix is stitched back on by the caller — "@ BW+25lb" converts the 25,
// keeps "BW+" (T64 Fix 6b).
const BW_PREFIX = "(?:(BW)\\s*([+\\-])\\s*)?";

// T64 Fix 6b: a number after "@" is a LOAD only when what follows it is a
// weight unit (or nothing). Every one of these is something else entirely —
// a clock time/pace ("@ 1:30", "@ 8:30 pace"), a duration ("@ 60s", "@ 3
// min"), a distance ("@ 24in", "@ 3 mi"), a rate/count (mph, bpm, reps,
// rounds, cal, watts), or an RPE/RIR/percent tag. The old tokenizer only knew
// WEIGHT units, so anything else glued onto the number slipped through as an
// "untagged" load and got a unit word stitched onto it ("@ 1:30" -> "@ 0
// kg:30", "@ 60s" -> "@ 27.5 kgs"). This blocklist, checked immediately after
// the number chain and before any weight-unit is even attempted, rejects the
// WHOLE match so those bytes are never touched.
const NON_WEIGHT_WORD = "(?:seconds\\b|secs\\b|sec\\b|s\\b|minutes\\b|mins\\b|min\\b|hours\\b|hrs\\b|hr\\b" +
  "|inches\\b|inch\\b|in\\b|feet\\b|ft\\b|yards\\b|yds\\b|yd\\b|meters\\b|meter\\b|m\\b" +
  "|miles\\b|mile\\b|mi\\b|km\\b|mph\\b|bpm\\b|reps\\b|rep\\b|rounds\\b|round\\b" +
  "|cals\\b|cal\\b|calories\\b|watts\\b|watt\\b|rpe\\b|rir\\b|[\"'])";

// One load token = "@ [BW+]<chain>[<unit>][<per-side>]". (?![.\d]) right after
// the chain stops the engine from ever backtracking into a shorter prefix of
// the number (the historic ".5 kg" / "@ 7.5 kg.5 kg" bug, and the same class
// of bug that would otherwise let "@ 70%" backtrack to matching "@ 7" so the
// trailing "(?!\s*%)" could succeed). The "(?!\s*:)" right after it rejects a
// clock time/pace outright — a load is never followed by a colon. The
// NON_WEIGHT_WORD lookahead rejects every other non-weight token before any
// unit-word capture is even attempted. That trailing "(?!\s*%)" lookahead is
// what keeps a bare percentage from ever being treated as a load.
const loadRe = () => new RegExp(
  `@\\s*${BW_PREFIX}(${UNIT_CHAIN})(?![.\\d])(?!\\s*:)(?!\\s*${NON_WEIGHT_WORD})(?:\\s*(${UNIT_WORD}))?(${PER_SIDE})?(?!\\s*%)`,
  "gi"
);
// The "@ <chain>[<unit>] (source)" form: a %/RPE source LEADS for display
// ("@ 75% (20 kg)"); draftInUnit always keeps the number first. No BW support
// here — no observed case pairs "BW+" with a "(source)" trailer.
const loadSrcRe = () => new RegExp(
  `@\\s*(${UNIT_CHAIN})(?![.\\d])(?!\\s*:)(?!\\s*${NON_WEIGHT_WORD})(?:\\s*(${UNIT_WORD}))?(${PER_SIDE})?\\s*\\(([^)]+)\\)`,
  "gi"
);

// T64 Fix 6b: a number EXPLICITLY tagged with a pounds unit converts for a kg
// athlete wherever it sits in the line, "@" or not ("at 40lb", "2x45lb",
// "40lb DBs"). This is a separate, narrower pass than loadRe/loadSrcRe above:
// it matches ONLY a single number immediately (mod whitespace) followed by an
// explicit lb/lbs/#/pound/pounds tag — never a bare/untagged number, so reps
// and set counts ("2x" in "2x45lb") are never touched, and it never tries to
// interpret a multi-number chain (that's loadRe's job, inside "@"). Anything
// the "@" passes above already converted no longer carries an "lb" substring,
// so this pass only ever catches what they left alone.
const POUND_TAG = "(?:lbs\\b|lb\\b|pounds\\b|pound\\b|#)";
const bareTagRe = () => new RegExp(`(${UNIT_NUM})\\s*(${POUND_TAG})`, "gi");

// The unit a written tag resolves to — "kg" for any kg spelling (including the
// corrupted "kglb(s)" artifact), "lbs" for any lbs spelling or "#", "lbs" when
// untagged (the program's own implied-lbs contract).
function effectiveUnit(rawUnitWord) {
  if (!rawUnitWord) return "lbs";
  const w = rawUnitWord.trim().toLowerCase();
  if (CORRUPT_UNIT_RE.test(w)) return "kg";
  if (w === "#") return "lbs";
  return w.startsWith("k") ? "kg" : "lbs";
}

// Run every number in an already-isolated chain through cv(), rejoining on
// whatever separators it was written with.
const convertChain = (chain, cv) => chain.replace(/\d+(?:\.\d+)?/g, (n) => cv(n));

// Resolve one matched load against the athlete's target unit:
//   null          -> leave the whole original match completely untouched
//     (already correctly tagged for this unit, or a clean kg tag with no
//     lbs->kg reverse path)
//   "LABEL_ONLY"  -> the numbers are right, only the unit word needs adding
//     (an untagged/implied-lbs chain, target is lbs)
//   <string>      -> the chain's numbers, converted (or, for a healed
//     corrupted-kg tag, exactly as they were — already the true kg value)
export function resolveLoadChain(chain, rawUnitWord, targetUnit, cv) {
  if (rawUnitWord) {
    const corrupted = CORRUPT_UNIT_RE.test(rawUnitWord.trim());
    const eff = corrupted ? "kg" : effectiveUnit(rawUnitWord);
    if (eff === "kg" && targetUnit === "lbs") return null; // no reverse conversion, ever
    if (eff === targetUnit) return corrupted ? chain : null; // heal the label only when corrupted; else untouched
    return convertChain(chain, cv); // eff:"lbs" -> target:"kg"
  }
  if (targetUnit === "lbs") return "LABEL_ONLY";
  return convertChain(chain, cv);
}

// Shared engine for displayWeights()/draftInUnit(): runs the source-parenthetical
// pass then the bare-load pass over `text`, handing each match to `onMatch` to
// decide the replacement (the two callers differ only in whether a %/RPE
// source reorders to lead, or whether the "kg" mode gate applies at all).
export function rewriteLoads(text, targetUnit, cv, onMatch) {
  let out = String(text || "");
  out = out.replace(loadSrcRe(), (m, chain, rawUnit, perSide, source) => {
    const r = resolveLoadChain(chain, rawUnit, targetUnit, cv);
    if (r === null) return m;
    return onMatch({ m, converted: r === "LABEL_ONLY" ? chain : r, perSide: perSide || "", source });
  });
  out = out.replace(loadRe(), (m, bw, sign, chain, rawUnit, perSide) => {
    const r = resolveLoadChain(chain, rawUnit, targetUnit, cv);
    if (r === null) return m;
    return onMatch({ m, converted: r === "LABEL_ONLY" ? chain : r, perSide: perSide || "", bw, sign });
  });
  out = rewriteBareTags(out, targetUnit, cv);
  return out;
}

// T64 Fix 6b: the "explicit lb tag, anywhere, @ or not" pass — see bareTagRe's
// comment above. Only ever runs for a kg athlete (the one-way contract: an
// lbs athlete's own unit never rewrites anything). Idempotent by construction
// — its output unit is always "kg", never "lb", so a second pass finds
// nothing left to match.
export function rewriteBareTags(text, targetUnit, cv) {
  if (targetUnit !== "kg") return String(text || "");
  return String(text || "").replace(bareTagRe(), (m, num) => `${cv(num)} kg`);
}
