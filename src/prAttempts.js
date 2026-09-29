// ─── DECLARED MAXES (parsed_data.pr_attempts) — unit + write decision ─────────
// Pure logic pulled out of finalizeWorkout so it has a suite
// (scripts/test-pr-attempts.mjs). The 09-28 incident: the parse schema had no unit
// on pr_attempts, the writer defaulted a missing unit to "lbs", and a kg athlete's
// "Hit a 102kg snatch today, new PR" landed in manual_one_rms as 102 LBS (46.3 kg).
// manual_one_rms is the ACTUAL 1RM store and outranks every estimate, so Joe then
// quoted 46.3 kg back as the athlete's best. With a higher row already standing the
// same default silently skipped the real PR instead.
//
// TWO resolvers, because "no unit on the attempt" means different things:
//   • THIS TURN (stampAttemptUnits): the athlete's display unit is contemporaneous
//     with the message, so it is the right fallback.
//   • A STORED ROW (storedAttemptUnit): rows saved before the fix carry no unit, and
//     the athlete may have switched units since (the founder logged in lbs until
//     late August, kg after). Today's display unit says nothing about a June row,
//     so the row's own evidence is read first.
import { toLbs, attemptUnit } from "./units.js";
import { implausibleJump } from "./grit.js";

const isUnit = (u) => u === "kg" || u === "lbs";
const lower = (s) => String(s || "").toLowerCase().trim();

// The unit written ON that number in the athlete's own words ("102kg", "250 lbs"),
// else null. Deterministic backstop for the parser's "unit" field.
export const writtenUnit = (message, weight) => {
  if (!message || weight == null || weight === "") return null;
  const n = String(weight).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?<![\\d.])${n}\\s?(kgs?|kilos?|kilograms?|lbs?|pounds?)\\b`, "i").exec(String(message));
  return m ? (/^k/i.test(m[1]) ? "kg" : "lbs") : null;
};

// Does the athlete's message name this unit anywhere ("whole session in kilos",
// "20kg/50/70/118")? Used to decide whether the parser's unit is a reading or a guess.
const UNIT_WORD = { kg: /(\d\s?|\b)(kgs?|kilos?|kilograms?)\b/i, lbs: /(\d\s?|\b)(lbs?|pounds?)\b/i };
export const mentionsUnit = (message, unit) => !!(UNIT_WORD[unit] && UNIT_WORD[unit].test(String(message || "")));

// The same lift logged as a set in the same message/row: same bar, same unit.
const twinUnit = (attempt, exercises, normalizeName) => {
  const name = normalizeName(attempt?.exercise);
  if (!name) return null;
  const twin = (Array.isArray(exercises) ? exercises : []).find((ex) => ex && isUnit(ex.unit) && normalizeName(ex.name) === name);
  return twin ? twin.unit : null;
};

// Stamp the resolved unit onto every attempt BEFORE the row is saved, so stored
// parsed_data is self-describing and survives the athlete flipping their display
// unit later. Order:
//   1. the unit written on that number in the athlete's own words
//   2. the parser's unit, IF the message names that unit somewhere
//   3. a kg twin set
//   4. the athlete's display unit
// Why the parser's unit is not simply trusted: told to return null when nothing is
// written, the real model still fills one in (live pass 09-28: "102 snatch" came
// back kg, "165 press" came back lbs). A guessed "lbs" on a kg athlete is the
// original bug, so a unit the message never names is treated as no unit. Same for
// a twin set that says "lbs": that is the parser's default for an unlabelled load.
// With no message to check against, the parser's unit stands. Same inputs always
// give the same stamp; same object back when nothing changes.
export const stampAttemptUnits = (parsed, { displayUnit, message = "", normalizeName = lower } = {}) => {
  const list = parsed?.pr_attempts;
  if (!Array.isArray(list) || !list.length) return parsed;
  const resolve = (p) => {
    const w = writtenUnit(message, p.weight);
    if (w) return w;
    if (isUnit(p.unit) && (!message || mentionsUnit(message, p.unit))) return p.unit;
    if (twinUnit(p, parsed.exercises, normalizeName) === "kg") return "kg";
    return attemptUnit({ ...p, unit: null }, displayUnit);
  };
  const units = list.map((p) => (p ? resolve(p) : null));
  if (list.every((p, i) => !p || p.unit === units[i])) return parsed;
  return { ...parsed, pr_attempts: list.map((p, i) => (p ? { ...p, unit: units[i] } : p)) };
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
