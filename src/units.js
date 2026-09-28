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

// One load token = "@ <chain>[<unit>][<per-side>]". (?![.\d]) right after the
// chain stops the engine from ever backtracking into a shorter prefix of the
// number (the historic ".5 kg" / "@ 7.5 kg.5 kg" bug, and the same class of
// bug that would otherwise let "@ 70%" backtrack to matching "@ 7" so the
// trailing "(?!\s*%)" could succeed). That trailing lookahead is what keeps a
// bare percentage from ever being treated as a load.
const loadRe = () => new RegExp(`@\\s*(${UNIT_CHAIN})(?![.\\d])(?:\\s*(${UNIT_WORD}))?(${PER_SIDE})?(?!\\s*%)`, "gi");
// The "@ <chain>[<unit>] (source)" form: a %/RPE source LEADS for display
// ("@ 75% (20 kg)"); draftInUnit always keeps the number first.
const loadSrcRe = () => new RegExp(`@\\s*(${UNIT_CHAIN})(?![.\\d])(?:\\s*(${UNIT_WORD}))?(${PER_SIDE})?\\s*\\(([^)]+)\\)`, "gi");

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
  out = out.replace(loadRe(), (m, chain, rawUnit, perSide) => {
    const r = resolveLoadChain(chain, rawUnit, targetUnit, cv);
    if (r === null) return m;
    return onMatch({ m, converted: r === "LABEL_ONLY" ? chain : r, perSide: perSide || "" });
  });
  return out;
}
