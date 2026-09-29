// ─── GRIT — shared strength-ranking module ────────────────────────────────────
// Canonical home for the "Grit" 8-tier benchmark ladder + the e1RM/name-normalize
// primitives it depends on. Plain JS (no JSX, no React), so both the client
// (src/App.jsx's ProgressModal) and the server (api/_grit.js, imported by the
// Proof Feed engine) import the SAME math. Will tunes these thresholds — they must
// live in exactly one place, or the app and the feed silently disagree.
//
// HISTORY: this used to be duplicated — the thresholds/tier logic lived only
// inline in App.jsx's ProgressModal component, and epley1RM was hand-copied into
// api/_proof.js (drift hazard, since fixed: _proof.js now imports epley1RM from
// api/_grit.js, which re-exports this file). Extracted 2026-07 (proof-feed-v3).

// ── Epley e1RM ────────────────────────────────────────────────────────────────
// Epley only extrapolates a 1RM meaningfully from low-rep, near-maximal sets; past
// ~15 reps the estimate is nonsense (a 100-rep Murph pull-up is conditioning, not a
// max). So we cap the reps the formula ever sees, and — separately — drop above-cap
// sets from benchmark consideration entirely (see bestE1RMForExercise). This bounds
// every direct caller too (PRs, Proof Feed), so no path can mint a 953 lb "1RM".
export const MAX_E1RM_REPS = 15;
export const epley1RM = (weight, reps) => {
  if (!weight || weight <= 0) return 0;
  if (!reps || reps <= 1) return weight;
  return Math.round(weight * (1 + Math.min(reps, MAX_E1RM_REPS) / 30));
};

// ── Implausible-jump guard (T46) ─────────────────────────────────────────────
// A mistyped load logs silently and does not stay in the log: it becomes that
// lift's estimated 1RM, which sets the Benchmarks tier, feeds Crew comparison,
// and becomes the base the NEXT generated program computes its percentages from.
// One "90" typed as "900" quietly rewrites an athlete's training.
//
// Will's rule (2026-08-11): a jump too big for even a beginner to make in one
// session gets a double check — Joe asks whether it was a mistype instead of
// celebrating it. Three conditions, all required, so the guard stays quiet on
// the moves people actually make:
//
//   PCT   — the jump is ≥12% over their best known max for that lift. Will's
//           example, 275 → 315, is +14.5%; a 12% gate catches it with room, and
//           still lets a genuine +10 on a 185 bench (+5.4%) through untouched.
//   MIN   — and it is ≥20 lb in absolute terms, so light accessory work can't
//           trip it (25 lb curls → 30 is +20%, and nobody wants asking about it).
//   FLOOR — and they had a real baseline (≥65 lb) to jump FROM.
//
// COLD START: with no prior max for a lift there is nothing to compare against,
// so a first-ever absurd log still passes. That is the narrower remaining gap —
// see outputs/T46-gauntlet-findings.md.
export const IMPLAUSIBLE_JUMP_PCT = 0.12;
export const IMPLAUSIBLE_JUMP_MIN_LBS = 20;
export const IMPLAUSIBLE_JUMP_FLOOR_LBS = 65;

export const implausibleJump = (priorLbs, newLbs) => {
  const prior = Number(priorLbs) || 0;
  const next = Number(newLbs) || 0;
  if (prior < IMPLAUSIBLE_JUMP_FLOOR_LBS) return false;
  if (next - prior < IMPLAUSIBLE_JUMP_MIN_LBS) return false;
  // Ratio, not a multiply: 100 * 1.12 is 112.00000000000001 in float, so a load
  // sitting exactly on the threshold fell through the comparison.
  return next / prior >= 1 + IMPLAUSIBLE_JUMP_PCT - 1e-9;
};

// ── Parsing a timestamp that came out of the database ────────────────────────
// A Postgres `timestamp WITHOUT time zone` serializes with no offset marker —
// "2026-07-28 00:30:00.123456" — and JavaScript parses that space-separated form as
// LOCAL time. The database runs UTC, so on an Eastern device every such value landed
// 4 hours late, which pushed anything logged after 8 PM onto the NEXT DAY. That is the
// "internal clock is wrong" bug: an 8:30 PM Monday session read as Tuesday, in Joe's
// replies, in MY LOG, and in the weekly streak. The server never saw it, because
// Vercel runs UTC and the local parse was accidentally right there.
//
// The columns are timestamptz now (20260727_workouts_created_at_timestamptz), so this
// is belt-and-braces — but it is cheap, and the failure mode is silent and
// day-shifting, which is exactly the kind that earns a permanent guard. Anything
// carrying an explicit offset (Z or ±HH:MM) or already a Date is passed straight
// through untouched.
export const parseDbDate = (v) => {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v !== "string") return new Date(NaN);
  const s = v.trim();
  // "YYYY-MM-DD HH:MM:SS[.ffffff]" with NO zone → it came from a naive column, and the
  // database that wrote it runs UTC. Normalise to ISO-with-Z so every runtime agrees.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) return new Date(s.replace(" ", "T") + "Z");
  return new Date(s);
};

// ── Effective workout date ────────────────────────────────────────────────────
// The day a workout should be ATTRIBUTED to. Normally the insert time (created_at),
// but when the athlete logs a PAST session ("that was Monday's workout", "did this
// yesterday") the workout parser resolves the intended day to parsed_data.log_date
// (a "YYYY-MM-DD" string) and we honor it everywhere dates matter — the weekly
// streak, session grouping, the workout log, and the progress charts. A noon-local
// parse avoids UTC day-boundary drift. Falls back to created_at whenever log_date is
// absent or malformed, so every existing row is unaffected. Server-safe (no DOM).
export const effectiveDate = (w) => {
  const pd = typeof w?.parsed_data === "string"
    ? (() => { try { return JSON.parse(w.parsed_data); } catch { return {}; } })()
    : (w?.parsed_data || {});
  const ld = pd.log_date;
  if (ld && /^\d{4}-\d{2}-\d{2}$/.test(ld)) {
    const d = new Date(ld + "T12:00:00");
    if (!isNaN(d.getTime())) return d;
  }
  return parseDbDate(w?.created_at);
};

// Expand a logged exercise entry into its individual sets. Handles both the new
// "set_details" array (variable weight/reps per set) and legacy flat fields.
export const getExerciseSets = (ex) => {
  if (!ex) return [];
  if (Array.isArray(ex.set_details) && ex.set_details.length > 0) {
    return ex.set_details.map((s) => ({ weight: s.weight ?? ex.weight ?? 0, reps: s.reps ?? ex.reps ?? 1, warmup: !!s.warmup }));
  }
  const n = ex.sets || 1;
  return Array.from({ length: n }, () => ({ weight: ex.weight ?? 0, reps: ex.reps || 1 }));
};

// Conversion lives in units.js (T55: single source, one constant). Imported for
// local use and re-exported because grit.js is where most existing code gets it.
import { toLbs, toKg, LBS_PER_KG, getDisplayUnit, toDisplay, roundStat, exerciseUnit, exerciseLoadUnit, isUnitPending } from "./units.js";
export { toLbs, toKg, LBS_PER_KG };

// Load-bearing bodyweight movements — dips, pull-ups, chin-ups, muscle-ups — where
// the athlete's own bodyweight IS the resistance. Given bodyweight we can estimate
// a 1RM (plus any added weight, minus any assistance). Other bodyweight work
// (push-ups, planks, air squats) has no meaningful 1RM.
const LOAD_BEARING_BW = /\b(dips?|pull[ -]?ups?|chin[ -]?ups?|muscle[ -]?ups?)\b/;

// Best estimated 1RM across the WORKING sets of a logged exercise (lbs-equivalent).
// `bwLbs` (athlete bodyweight) is optional: pass it to score load-bearing bodyweight
// lifts; omit it and bodyweight lifts return 0.
export const bestE1RMForExercise = (ex, bwLbs = 0) => {
  if (!ex || isUnitPending(ex)) return 0; // unit unconfirmed: nothing derived (T65)
  const isBW = ex.unit === "bodyweight";
  let bwLoad = 0;
  if (isBW) {
    if (!bwLbs || !LOAD_BEARING_BW.test((ex.name || "").toLowerCase())) return 0;
    bwLoad = bwLbs + (ex.added_weight || 0) - (ex.assist_weight || 0);
    if (bwLoad <= 0) return 0;
  }
  const all = getExerciseSets(ex);
  const sets = all.some((s) => !s.warmup) ? all.filter((s) => !s.warmup) : all;
  let best = 0;
  sets.forEach((s) => {
    // A set above the rep cap is endurance/conditioning, not a near-max effort — it
    // carries no valid 1RM signal, so it never establishes or beats a benchmark.
    if (s.reps > MAX_E1RM_REPS) return;
    const lbs = isBW ? bwLoad : toLbs(s.weight, ex.unit);
    const e1rm = epley1RM(lbs, s.reps);
    if (e1rm > best) best = e1rm;
  });
  return best;
};

// ── Exercise-name normalization (same rules as the log/PR/progress screens) ───
// Structure-aware, not just string-deletion. Order of operations matters:
// abbreviations → compound-word folding → plural folding → paren UNWRAP (the
// content is kept — "(close grip)" is a lift-defining qualifier, deleting it used
// to silently merge close-grip bench into bench press) → execution-descriptor
// strip → modifier reorder (grip/arm qualifiers move to the front so word order
// can never split one lift into two).

// Lift-defining modifiers that athletes write in any position ("bench press close
// grip", "(close grip)", "close-grip bench"). Extracted and re-prepended in THIS
// fixed order so every word order collapses to one id.
const MOD_PHRASES = [
  "close grip", "wide grip", "narrow grip", "neutral grip", "reverse grip",
  "underhand", "overhand", "single arm", "single leg", "behind the neck",
];

// Precompiled per-phrase regexes (normalizeExName used to build these with
// `new RegExp` on EVERY call — ~10 allocations per name, on the hottest string
// path shared by the app tabs, QuickLog, coach dashboard, and the proof cron).
// `test` is deliberately NON-global: a reused /g/ regex carries lastIndex state
// across calls, so .test() on one would silently skip matches. `strip` is global,
// which is safe to share — String.replace with a /g/ regex ignores lastIndex.
const MOD_PHRASE_RES = MOD_PHRASES.map((m) => ({
  phrase: m,
  test: new RegExp("\\b" + m + "\\b"),
  strip: new RegExp("\\b" + m + "\\b", "g"),
}));

// Unambiguous sub-phrase synonyms, applied after modifiers are extracted so one
// entry covers every grip/arm variant of the phrase. Keep TRUE synonyms only.
const PHRASE_SYNONYMS = [
  [/\bseated horizontal row\b/g, "seated cable row"],
  [/\bseated row\b/g, "seated cable row"],
  [/\btricep pressdown\b/g, "tricep pushdown"],
  [/\bcable pushdown\b/g, "tricep pushdown"],
];

export const normalizeExName = (name) => {
  if (!name) return "";
  let n = name.toLowerCase().trim()
    .replace(/\s+/g, " ")
    // "Clean + Jerk" / "clean & jerk" / "C&J" are the classic lift, not a complex.
    // Narrow on purpose: a real complex ("clean + front squat + jerk") keeps its +.
    .replace(/\bc\s*[&+n]\s*j\b/g, "clean and jerk")
    .replace(/\bclean\s*[&+]\s*jerk\b/g, "clean and jerk")
    .replace(/\bohp\b/g, "overhead press")
    .replace(/\bbb\b/g, "barbell")
    .replace(/\bdb\b/g, "dumbbell")
    .replace(/\bkb\b/g, "kettlebell")
    .replace(/\brdl\b/g, "romanian deadlift")
    .replace(/pull[ -]?ups?\b/g, "pull-up")
    .replace(/chin[ -]?ups?\b/g, "chin-up")
    .replace(/push[ -]?ups?\b/g, "push-up")
    // Compound movements written open, hyphenated, or closed → one closed form
    // ("tricep push down" / "lat pull-down" / "press down" → pushdown/pulldown).
    .replace(/\b(push|pull|press)[ -]down\b/g, "$1down")
    .replace(/\bpull[ -]over\b/g, "pullover")
    .replace(/\bkick[ -]back\b/g, "kickback")
    .replace(/\bstep[ -]up\b/g, "step-up");
  n = n
    .replace(/(ch|sh|x|z)es\b/g, "$1")
    .replace(/sses\b/g, "ss")
    .replace(/([^s])s\b/g, "$1");
  n = n.replace(/\bbench\b(?!\s*press)/g, "bench press");
  if (n === "squat" || n === "barbell squat") n = "back squat";
  n = n
    // UNWRAP parens — keep the words. Qualifiers survive to the modifier pass;
    // execution junk inside them is stripped by the descriptor rules below.
    .replace(/[()]/g, " ")
    .replace(/\b(?:from|off)(?:\s+(?:the|a))?\s+(?:floor|ground)\b/g, " ")
    .replace(/\b(?:dead[\s-]?stop|touch[\s-]?and[\s-]?go|tng)\b/g, " ")
    .replace(/\b(?:paused?|tempo|slow|controlled|eccentric)\b/g, " ")
    .replace(/\b\d+\s*(?:sec(?:ond)?s?|count|ct)\b/g, " ")
    .replace(/\bw\/?\b/g, " ")
    .replace(/\s+/g, " ").trim();
  // Modifier canonicalization: unify spellings, then move lift-defining modifiers
  // to the front in MOD_PHRASES order — "bench press close grip", "close-grip
  // bench press" and "bench press (close grip)" all become "close grip bench press".
  n = n
    .replace(/\b(close|wide|narrow|neutral|reverse)[ -]?grip\b/g, "$1 grip")
    .replace(/\bone[ -](arm|leg)\b/g, "single $1")
    .replace(/\bsingle[ -](arm|leg)\b/g, "single $1");
  const mods = [];
  for (const { phrase, test, strip } of MOD_PHRASE_RES) {
    if (test.test(n)) { mods.push(phrase); n = n.replace(strip, " "); }
  }
  n = n.replace(/\s+/g, " ").trim();
  for (const [re, out] of PHRASE_SYNONYMS) n = n.replace(re, out);
  n = (mods.join(" ") + " " + n).replace(/\s+/g, " ").trim();
  return n;
};

const CANON_DISPLAY = { "back squat": "Back Squat" };
export const displayForKey = (key, fallback) => CANON_DISPLAY[key] || fallback;
export const cleanerName = (a, b) => (!a ? (b || "") : !b ? a : (b.length < a.length ? b : a));

// ─── CANONICAL LIFT TAXONOMY ──────────────────────────────────────────────────
// The three progress surfaces (Benchmarks, Strength, PRs) and the server Proof Feed
// USED to disagree about what counts as "the same lift": Benchmarks grouped by
// getBenchKey (~25 canonical lifts) while Strength/PRs grouped by the raw normalized
// name. So "deadlift" and "conventional deadlift" merged in one tab but split in the
// others, weighted sit-ups showed up twice, and a bare "lift" charted as a mystery
// bar. resolveLift() is the single funnel every surface now goes through, so they
// can never bucket a lift differently again.
//
//   resolveLift(rawName) -> { id, name, benchKey, bwLoaded, tracked }
//     id       — canonical grouping key. GROUP BY THIS everywhere.
//     name     — canonical display name.
//     benchKey — BENCH_THRESHOLDS key, or null if the lift isn't ranked.
//     bwLoaded — load-bearing bodyweight lift (pull-up/dip/chin-up/muscle-up): its
//                number is a "bodyweight + added" total, not a bare barbell weight.
//     tracked  — false for junk / un-trackable names ("lift", "workout", a bare
//                generic token) → dropped from every progress list.
//
// HOW IT STAYS CONSISTENT: exact synonyms live in LIFT_ALIASES (one line each);
// everything else falls through to normalizeExName. Add a new alias and it fixes all
// three tabs at once — that's the whole point. Merge only TRUE synonyms here; real
// variants (deficit deadlift, RDL, trap-bar, sumo) stay their own tracked lift.

// Vague / non-lift names that should never appear as a tracked lift or a chart.
const LIFT_JUNK = new Set([
  "lift", "lifts", "exercise", "exercises", "workout", "workouts", "movement",
  "circuit", "wod", "amrap", "emom", "metcon", "conditioning", "cardio",
  "accessory", "accessories", "warmup", "warm up", "cooldown", "cool down",
  "stretch", "stretching", "mobility", "superset", "complex", "finisher",
  "misc", "other", "training", "session", "set", "sets", "rep", "reps",
]);

// Exact-synonym → canonical id. Keys and values are BOTH normalizeExName output
// (space form). A value that equals its key is a no-op; listed only for clarity.
const LIFT_ALIASES = {
  // Deadlift family — "conventional/standard/regular" all mean the default pull.
  "conventional deadlift": "deadlift",
  "standard deadlift": "deadlift",
  "regular deadlift": "deadlift",
  "straight bar deadlift": "deadlift",
  // Deficit deadlift is its OWN lift — but "deficit pull" is just another name for it.
  "deficit pull": "deficit deadlift",
  // Sit-ups — every spelling collapses to one.
  "situp": "sit-up",
  "sit up": "sit-up",
  "weighted situp": "weighted sit-up",
  "weighted sit up": "weighted sit-up",
  // Load-bearing bodyweight lifts — the added/strict qualifier is a modifier, not a
  // separate lift, so a plain and a weighted pull-up are the SAME tracked lift.
  "weighted pull-up": "pull-up",
  "strict pull-up": "pull-up",
  "weighted chin-up": "chin-up",
  "strict chin-up": "chin-up",
  "weighted dip": "dip",
  "chest dip": "dip",
  "muscle up": "muscle-up",
  "weighted muscle up": "muscle-up",
  "weighted muscle-up": "muscle-up",
  // Pushdowns — compound folding gets the spelling; these get the true synonyms.
  "triceps pushdown": "tricep pushdown",
  "tricep cable pushdown": "tricep pushdown",
  "rope pushdown": "tricep pushdown",
  "tricep rope pushdown": "tricep pushdown",
};

// Load-bearing bodyweight lifts (by canonical id) — their number is a bodyweight +
// added total. Membership by id, NOT substring, so "scapula pull-up" stays out.
export const BW_LOADED_IDS = new Set(["pull-up", "chin-up", "dip", "muscle-up"]);

// Canonical display names for alias TARGETS + lifts whose observed spelling we don't
// want to surface. Anything not here falls back to the cleaner observed name.
const LIFT_CANON = {
  "deadlift": "Deadlift", "deficit deadlift": "Deficit Deadlift",
  "romanian deadlift": "Romanian Deadlift", "trap bar deadlift": "Trap Bar Deadlift",
  "sumo deadlift": "Sumo Deadlift", "back squat": "Back Squat", "front squat": "Front Squat",
  "pull-up": "Pull-Up", "chin-up": "Chin-Up", "dip": "Dip", "muscle-up": "Muscle-Up",
  "sit-up": "Sit-Up", "weighted sit-up": "Weighted Sit-Up",
  "clean and jerk": "Clean & Jerk", "tricep pushdown": "Tricep Pushdown",
  "lat pulldown": "Lat Pulldown", "seated cable row": "Seated Cable Row",
  "close grip seated cable row": "Seated Cable Row (Close Grip)",
  "close grip bench press": "Close-Grip Bench Press",
};
export const displayForLift = (id, fallback) => LIFT_CANON[id] || CANON_DISPLAY[id] || fallback || id;

const BIG_LIFT_RE = /\b(snatch|clean and jerk|clean|jerk|squat|deadlift|bench press|overhead press|dips?|pull[ -]?ups?|chin[ -]?ups?|rows?)\b/;
export const liftTier = (key) => (BIG_LIFT_RE.test(key || "") ? 0 : 1);

// ─── BENCHMARK TIERS ("Grit" ladder) ──────────────────────────────────────────
// 8 tiers, ranking the LIFT not the lifter. Below the first cut-line = Rookie.
export const TIER_NAMES = ["ROOKIE", "GRITTY", "SHARP", "STRONG", "ELITE", "DOMINANT", "UNTOUCHABLE", "LEGENDARY"];
// LED-lit neon ramp (night-gym re-skin). Keeps the low->high heat logic and roughly
// the same hue per rung; ELITE stays warm/gold-family but drops the literal old brand
// hex. PROPOSAL — pending Will's approval; this also retunes athlete Benchmarks.
// Tier ramp, theme-split 08-10 (Will's Draft-2 call): the neon HUD ramp belongs to
// the dark freeze; the light brand gets a muted 8-step ramp that lives inside its
// world (grey → blue-greys → navy → forest → bronze → terracotta → violet).
// localStorage is guarded so node (test suites) and any server import fall back
// to the light set — TIER_NAMES/points/thresholds are theme-independent.
const TIER_COLORS_DARK = ["#7a8798", "#3a7bff", "#37e6ff", "#2ee6a8", "#ffd34d", "#ff8a3d", "#ff4d5e", "#b46dff"];
const TIER_COLORS_LIGHT = ["#8B9199", "#6E86A8", "#5B7FB5", "#28508B", "#3C6B54", "#8A6B2F", "#9C4A2F", "#6B4E8E"];
const GRIT_DARK = (() => { try { return typeof localStorage !== "undefined" && localStorage.getItem("wilco_theme") === "dark"; } catch (_) { return false; } })();
export const TIER_COLORS = GRIT_DARK ? TIER_COLORS_DARK : TIER_COLORS_LIGHT;
// Strength Score points per tier — each level worth more than the last.
export const TIER_POINTS = [10, 25, 50, 100, 175, 275, 400, 600];
// Flavor line per tier (shown in the Top Rank classification popover).
export const TIER_DESC = ["just off the ground", "on the come-up", "lookin' sharp", "just plain solid", "top of the gym", "a cut above", "national-class", "truly incredible"];
// Load-bearing bodyweight lifts show a cleaner name + a "bodyweight + added" readout.

// Per-lift bodyweight-multiple cut-lines to REACH each tier 1..7 (Rookie = below [0]).
// [Gritty, Sharp, Strong, Elite, Dominant, Untouchable, Legendary]. Anchored to
// published standards (Strength Level) for the lower rungs and competition/record
// ratios up top; first-draft values, tunable. Weighted pull-up/dip ratios are
// (bodyweight + added load) / bodyweight, so 1.0 = a clean bodyweight rep.
export const BENCH_THRESHOLDS = {
  male: {
    "back squat":     [0.75, 1.25, 1.5,  2.0,  2.5,  2.75, 3.0 ],
    "front squat":    [0.6,  1.0,  1.25, 1.75, 2.25, 2.5,  2.75],
    "deadlift":       [1.0,  1.5,  1.75, 2.25, 2.75, 3.0,  3.25],
    "bench press":    [0.5,  0.75, 1.25, 1.5,  2.0,  2.25, 2.5 ],
    "overhead press": [0.4,  0.55, 0.75, 1.0,  1.25, 1.4,  1.55],
    "barbell row":    [0.5,  0.75, 1.0,  1.25, 1.5,  1.75, 2.0 ],
    "weighted pull-up":[1.0, 1.15, 1.3,  1.5,  1.75, 2.0,  2.25],
    "weighted dip":   [1.0,  1.2,  1.4,  1.65, 1.9,  2.15, 2.4 ],
    "snatch":         [0.5,  0.75, 1.0,  1.25, 1.5,  1.65, 1.75],
    "clean and jerk": [0.5,  0.75, 1.25, 1.5,  1.75, 1.9,  2.1 ],
    "clean":          [0.55, 0.8,  1.3,  1.55, 1.8,  1.95, 2.15],
    "jerk":           [0.55, 0.8,  1.3,  1.6,  1.85, 2.0,  2.2 ],
    "power clean":    [0.5,  0.75, 1.1,  1.35, 1.6,  1.75, 1.9 ],
    "incline bench press":     [0.45, 0.65, 1.05, 1.3,  1.7,  1.9,  2.15],
    "trap bar deadlift":       [1.05, 1.55, 1.85, 2.35, 2.85, 3.1,  3.4 ],
    "romanian deadlift":       [0.85, 1.25, 1.5,  1.9,  2.35, 2.55, 2.75],
    "hip thrust":              [0.9,  1.4,  1.8,  2.5,  3.1,  3.4,  3.75],
    "push press":              [0.5,  0.7,  0.95, 1.25, 1.55, 1.75, 1.95],
    "dumbbell bench press":    [0.25, 0.4,  0.55, 0.75, 0.95, 1.05, 1.15],
    "dumbbell shoulder press": [0.15, 0.25, 0.35, 0.5,  0.65, 0.72, 0.8 ],
    "barbell curl":            [0.2,  0.3,  0.45, 0.55, 0.7,  0.78, 0.85],
  },
  female: {
    "back squat":     [0.6,  0.9,  1.1,  1.4,  1.75, 1.95, 2.2 ],
    "front squat":    [0.45, 0.7,  0.9,  1.2,  1.5,  1.7,  1.9 ],
    "deadlift":       [0.75, 1.1,  1.35, 1.6,  2.0,  2.2,  2.4 ],
    "bench press":    [0.3,  0.5,  0.75, 1.0,  1.3,  1.45, 1.6 ],
    "overhead press": [0.28, 0.4,  0.55, 0.7,  0.9,  1.0,  1.1 ],
    "barbell row":    [0.35, 0.55, 0.7,  0.9,  1.1,  1.3,  1.5 ],
    "weighted pull-up":[1.0, 1.1,  1.2,  1.35, 1.5,  1.65, 1.8 ],
    "weighted dip":   [1.0,  1.1,  1.25, 1.4,  1.6,  1.8,  2.0 ],
    "snatch":         [0.35, 0.5,  0.65, 0.85, 1.05, 1.15, 1.25],
    "clean and jerk": [0.4,  0.55, 0.85, 1.05, 1.25, 1.35, 1.5 ],
    "clean":          [0.42, 0.6,  0.9,  1.1,  1.3,  1.4,  1.55],
    "jerk":           [0.42, 0.6,  0.9,  1.12, 1.32, 1.45, 1.6 ],
    "power clean":    [0.38, 0.55, 0.8,  1.0,  1.2,  1.3,  1.45],
    "incline bench press":     [0.25, 0.45, 0.65, 0.85, 1.1,  1.25, 1.4 ],
    "trap bar deadlift":       [0.8,  1.15, 1.4,  1.7,  2.1,  2.3,  2.5 ],
    "romanian deadlift":       [0.65, 0.95, 1.15, 1.35, 1.7,  1.85, 2.05],
    "hip thrust":              [0.8,  1.2,  1.6,  2.2,  2.75, 3.0,  3.3 ],
    "push press":              [0.35, 0.5,  0.7,  0.9,  1.15, 1.25, 1.4 ],
    "dumbbell bench press":    [0.12, 0.2,  0.32, 0.45, 0.6,  0.67, 0.75],
    "dumbbell shoulder press": [0.08, 0.15, 0.22, 0.3,  0.42, 0.47, 0.52],
    "barbell curl":            [0.1,  0.18, 0.28, 0.35, 0.45, 0.5,  0.55],
  }
};

// Current tier index (0=Rookie .. 7=Legendary) for a bodyweight ratio vs a lift's cut-lines.
export const tierForRatio = (ratio, thresh) => { let t = 0; for (let i = 0; i < thresh.length; i++) { if (ratio >= thresh[i]) t = i + 1; } return t; };

// Bodyweight-fair thresholds. The ×bodyweight multiple to reach a tier scales as
// (refBW / BW)^exp: heavier lifters need a slightly lower multiple, lighter a slightly
// higher one (so a 250 and a 150 lb lifter are judged fairly). GENTLE exponent
// (0.17, well under the pure 2/3-allometric 1/3) so small lifters aren't over-nerfed.
export const REF_BW = { male: 200, female: 150 };
export const BW_SCALE_EXP = 0.17;
export const bwTierFactor = (bodyweight, genderKey) => {
  const ref = REF_BW[genderKey] || REF_BW.male;
  if (!bodyweight || bodyweight <= 0) return 1;
  return Math.min(1.2, Math.max(0.85, Math.pow(ref / bodyweight, BW_SCALE_EXP)));
};

// Age-fair thresholds. Continuous multiplier on the cut-lines, anchored to the
// inverse of the coefficients sanctioned meets score with (Foster for juniors under
// 23, McCulloch for masters 40+): prime = 23-40 at 1.0, teens ramp up to it, masters
// ease down from it. Piecewise-linear between anchors, clamped at the ends; unknown
// age ranks as prime.
export const AGE_TIER_ANCHORS = [
  [13, 0.78], [14, 0.81], [16, 0.88], [18, 0.94], [20, 0.97], [23, 1.0],
  [40, 1.0], [45, 0.96], [50, 0.92], [55, 0.86], [60, 0.79], [65, 0.74],
  [70, 0.68], [75, 0.62], [80, 0.56], [85, 0.51], [90, 0.46],
];
export const ageTierFactor = (age) => {
  if (age == null || !(age > 0)) return 1;
  const a = AGE_TIER_ANCHORS;
  if (age <= a[0][0]) return a[0][1];
  if (age >= a[a.length - 1][0]) return a[a.length - 1][1];
  for (let i = 1; i < a.length; i++) {
    if (age <= a[i][0]) {
      const [x0, y0] = a[i - 1], [x1, y1] = a[i];
      return y0 + (y1 - y0) * (age - x0) / (x1 - x0);
    }
  }
  return 1;
};
export const scaledThresholds = (threshRaw, bodyweight, genderKey, age) => {
  const f = bwTierFactor(bodyweight, genderKey) * ageTierFactor(age);
  return threshRaw.map((t) => t * f);
};

// Map a normalized exercise name to a BENCH_THRESHOLDS key (null if not benchmarked).
// Order matters: most specific first, and Olympic PULL/DEADLIFT/BALANCE accessory
// variants (much heavier than the competition lift) and complexes are excluded so
// they never inflate a rank.
export const getBenchKey = (normalized) => {
  if (!normalized) return null;
  const n = normalized.toLowerCase();
  if (n.includes("+")) return null;
  if (/(snatch|clean).*(pull|deadlift|balance|shrug|high\s*pull)/.test(n) ||
      /(pull|deadlift|balance|shrug|high\s*pull).*(snatch|clean)/.test(n)) return null;
  if (n.includes("overhead squat")) return null;
  if (/(split squat|bulgarian|goblet|pistol|hack squat|sissy|single[ -]?leg)/.test(n)) return null;
  if (/(shrug|carry|farmer|march|\bwalk)/.test(n)) return null;
  // Reduced-ROM / paused deadlift variants are their OWN lift — never let them rank
  // against the full competition deadlift standard (they'd deflate the real rank).
  if (/(deficit|block|rack pull|rack deadlift|pin pull|pin deadlift|halting|segment)/.test(n)) return null;
  if (n.includes("clean and jerk") || n.includes("clean & jerk")) return "clean and jerk";
  if (n.includes("power clean")) return "power clean";
  if (n.includes("snatch")) return "snatch";
  if (n.includes("push press")) return "push press";
  if (n.includes("jerk")) return "jerk";
  if (n.includes("clean")) return "clean";
  if (n.includes("front squat")) return "front squat";
  if (n.includes("squat")) return "back squat";
  if (/(romanian|\brdl\b|stiff[ -]?leg)/.test(n)) return "romanian deadlift";
  if (/(trap|hex)[ -]?bar/.test(n)) return "trap bar deadlift";
  if (n.includes("deadlift")) return "deadlift";
  if (n.includes("hip thrust")) return "hip thrust";
  if (/\b(dumbbell|db)\b/.test(n) && /(press|bench)/.test(n))
    return /(bench|floor|incline|chest)/.test(n) ? "dumbbell bench press" : "dumbbell shoulder press";
  if (n.includes("arnold press")) return "dumbbell shoulder press";
  if (n.includes("incline bench") || n.includes("incline press")) return "incline bench press";
  // Close-grip bench is its own tracked lift — now that the normalizer keeps the
  // "(close grip)" qualifier it must never rank against the full bench standard.
  if (/\bclose grip\b.*bench/.test(n)) return null;
  if (n.includes("bench press") || n === "bench" || n.includes("barbell bench")) return "bench press";
  if (n.includes("overhead press") || n.includes("ohp") || n === "press" || n.includes("military press") || n.includes("strict press")) return "overhead press";
  if (/(barbell|\bbb\b|ez[ -]?bar)[ -]?curl/.test(n)) return "barbell curl";
  // Pull-ups/dips rank on the bodyweight standard — but only the real movement.
  // Machine, scapular, and assisted variants aren't the same lift and would corrupt
  // the rank, so they fall through to null (still tracked, just not benchmarked).
  if (/\b(pull[ -]?up|chin[ -]?up)\b/.test(n)) return /(scap|machine|assist)/.test(n) ? null : "weighted pull-up";
  if (/\bdips?\b/.test(n)) return /(machine|assist)/.test(n) ? null : "weighted dip";
  if (n.includes("barbell row") || n.includes("bent over row") || n.includes("bent-over row") || n.includes("pendlay")) return "barbell row";
  return null;
};

// ── resolveLift — the one funnel every progress surface goes through ────────────
// normalizeExName → alias-collapse → canonical descriptor. See the taxonomy header
// above for the contract. `observedName` (optional) is the raw name as logged, used
// only as the display fallback for lifts with no canonical entry.
// Memo cache: raw name → frozen resolved descriptor. Exercise names repeat
// massively (an athlete has ~10-40 distinct names across hundreds of resolveLift
// calls per ProgressModal open / proof-cron athlete), so a hit replaces ~40 regex
// ops with one Map lookup. Only the (rawName, no-observedName) shape is cached —
// observedName changes the display fallback, so those rare calls compute fresh.
// Results are frozen so a caller can't mutate the shared cached object. Bounded:
// cleared wholesale past MAX (simpler than LRU; real vocabularies never get there).
const RESOLVE_CACHE = new Map();
const RESOLVE_CACHE_MAX = 2000;

// ── chart series for ONE lift: taxonomy-exact, one point per day ─────────────
// Replaces the check-in chart's substring match ("snatch" absorbed Snatch-Grip
// Deadlift, Snatch Pull and Power Snatch), which graphed several different
// movements as one lift and printed impossible est-1RMs (Will, 2026-08-10).
// Matching goes through resolveLift so only entries resolving to the same lift id
// plot, and bestE1RMForExercise supplies the value (working sets only, rep-capped —
// the same number every other progress surface shows). One point per calendar day
// (the day's max), so two same-day entries can't duplicate an x-axis label.
export const liftSeriesPoints = (rows, liftName, { limit = 8, bwLbs = 0 } = {}) => {
  const targetId = resolveLift(liftName).id;
  const byDay = new Map();
  for (const w of rows || []) {
    const pd = typeof w?.parsed_data === "string"
      ? (() => { try { return JSON.parse(w.parsed_data); } catch { return {}; } })()
      : (w?.parsed_data || {});
    for (const ex of pd.exercises || []) {
      if (!ex.name) continue;
      if (resolveLift(ex.name).id !== targetId) continue;
      const e1 = bestE1RMForExercise(ex, bwLbs);
      if (!e1) continue;
      const day = new Date(effectiveDate(w));
      day.setHours(0, 0, 0, 0);
      const k = day.getTime();
      if (!byDay.has(k) || e1 > byDay.get(k)) byDay.set(k, e1);
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-limit)
    .map(([ts, y]) => ({ y: Math.round(y), label: new Date(ts).toLocaleDateString("en-US", { month: "numeric", day: "numeric" }) }));
};

export const resolveLift = (rawName, observedName) => {
  if (observedName === undefined) {
    const hit = RESOLVE_CACHE.get(rawName);
    if (hit) return hit;
    if (RESOLVE_CACHE.size >= RESOLVE_CACHE_MAX) RESOLVE_CACHE.clear();
    const out = Object.freeze(resolveLiftUncached(rawName, undefined));
    RESOLVE_CACHE.set(rawName, out);
    return out;
  }
  return resolveLiftUncached(rawName, observedName);
};

const resolveLiftUncached = (rawName, observedName) => {
  const norm = normalizeExName(rawName);
  const isJunk = !norm || LIFT_JUNK.has(norm) || norm.length < 2;
  if (isJunk) return { id: norm, name: observedName || rawName || "", benchKey: null, bwLoaded: false, tracked: false };
  const id = LIFT_ALIASES[norm] || norm;
  return {
    id,
    name: displayForLift(id, observedName || rawName),
    benchKey: getBenchKey(id),
    bwLoaded: BW_LOADED_IDS.has(id),
    tracked: true,
  };
};

// Shared "bodyweight + added" sub-label for load-bearing bodyweight lifts, used
// identically in the Benchmarks, Strength, and PR tabs. e1rm is a lbs-equivalent
// total (bodyweight + added). Returns null when we can't split it (no bodyweight).
export const bwLoadLabel = (e1rm, bodyweightLbs) => {
  if (!bodyweightLbs || bodyweightLbs <= 0) return null;
  const du = getDisplayUnit();
  const stat = (lbs) => roundStat(toDisplay(lbs, "lbs", du), du);
  const added = Math.round(e1rm - bodyweightLbs);
  const u = du === "kg" ? "kg" : "lbs";
  return added > 0
    ? `${stat(bodyweightLbs)} + ${stat(added)} ${u} (bodyweight + added)`
    : `${stat(bodyweightLbs)} ${u} (bodyweight)`;
};

// ─── PURE SNAPSHOT COMPUTATION ─────────────────────────────────────────────────
// Reproduces the ProgressModal's inline rank computation (src/App.jsx, the
// "Benchmark counter stats" block) as a pure function so both the client and the
// server compute Grit rank IDENTICALLY off the same inputs. Takes raw workout rows
// (parsed_data JSON, same shape as the `workouts` table) + manual_one_rms rows +
// the athlete's bodyweight/gender/age, and returns the ranked-lift list, Strength
// Score, Top Rank tier index, and lifetime PRs-hit count.
//
// `workouts` — array of { created_at, parsed_data: {exercises:[...]} | JSON string }
// `manualRMs` — array of { normalized_exercise|exercise, weight, unit }
// `opts` — { bodyweightLbs, gender: "Female"|other, age }
// ─── GOAL TARGETS ────────────────────────────────────────────────────────────
// Normalize one athlete_goals row into its measurable targets. Lives here rather
// than in api/_crew.js because BOTH sides need it: the server composes crew rows
// from it, and the client fires a goal-hit moment off it. This module is the
// established client/server single source (api/_grit.js re-exports it), so there
// is no hand-copy to drift.
//
// parsed_targets holds every lift-and-weight target found in one goal_text. The
// legacy parsed_lift/target_lbs pair is the fallback for goals parsed before
// multi-target parsing existed.
export function goalTargets(goal) {
  if (!goal) return [];
  const raw = Array.isArray(goal.parsed_targets) ? goal.parsed_targets : null;
  const list = raw && raw.length
    ? raw
    : (goal.parsed_lift && goal.target_lbs
        ? [{ lift: goal.parsed_lift, target_lbs: goal.target_lbs, target_date: goal.target_date }]
        : []);
  return list
    .map((t) => ({
      lift: t && t.lift ? String(t.lift).trim() : null,
      targetLbs: Number(t && t.target_lbs),
      targetDate: t && t.target_date ? String(t.target_date) : null,
    }))
    .filter((t) => t.lift && Number.isFinite(t.targetLbs) && t.targetLbs > 0);
}

export function computeGritSnapshot(workouts, manualRMs, opts = {}) {
  const bodyweight = opts.bodyweightLbs || 0;
  const genderKey = opts.gender === "Female" ? "female" : "male";
  const age = opts.age ?? null;

  const getPD = (w) => {
    if (typeof w.parsed_data === "string") { try { return JSON.parse(w.parsed_data); } catch { return {}; } }
    return w.parsed_data || {};
  };

  // Best e1RM per CANONICAL lift from workout history (resolveLift is the single
  // grouping funnel — see the taxonomy header — so this matches the app tabs exactly).
  const byEx = {};
  // Coach-dashboard scale path (C2): seed the per-lift bests from the athlete's `prs`
  // rows (one row per exercise, already the all-time best estimated_1rm in lbs —
  // prs.estimated_1rm was itself epley(bestE1RMForExercise)). ADDITIVE with the
  // workouts loop below, not a replacement: prs excludes bodyweight lifts (recalc
  // skips unit==="bodyweight"), so weighted pull-up/dip benchmarks still come from
  // whatever workouts the caller passes (the coach view passes its recent window;
  // higher number wins on overlap). The manual_one_rms overlay also still applies.
  (opts.seedFromPRs || []).forEach((p) => {
    if (!p.exercise) return;
    const lift = resolveLift(p.exercise);
    if (!lift.tracked) return;
    const e1rm = Number(p.estimated_1rm) || 0;
    if (!(e1rm > 0)) return;
    const unit = p.unit === "bodyweight" ? "lbs" : (p.unit || "lbs");
    if (!byEx[lift.id] || e1rm > byEx[lift.id].e1rm) byEx[lift.id] = { key: lift.id, name: lift.name, e1rm, unit };
  });
  (workouts || []).forEach((w) => {
    const pd = getPD(w);
    (pd.exercises || []).forEach((ex) => {
      if (!ex.name) return;
      const lift = resolveLift(ex.name);
      if (!lift.tracked) return;
      const e1rm = bestE1RMForExercise(ex, bodyweight);
      if (!e1rm) return;
      const unit = exerciseLoadUnit(ex);
      if (!byEx[lift.id]) byEx[lift.id] = { key: lift.id, name: lift.name, e1rm, unit };
      else if (e1rm > byEx[lift.id].e1rm) byEx[lift.id].e1rm = e1rm;
    });
  });

  // Overlay actual 1RMs (manual_one_rms) — higher of estimate vs actual wins.
  (manualRMs || []).forEach((m) => {
    const lift = resolveLift(m.normalized_exercise || m.exercise);
    if (!lift.tracked) return;
    const lbs = toLbs(m.weight, m.unit);
    if (!(lbs > 0)) return;
    if (!byEx[lift.id]) byEx[lift.id] = { key: lift.id, name: lift.name, e1rm: lbs, unit: "lbs", actual: true };
    else if (lbs >= byEx[lift.id].e1rm) { byEx[lift.id].e1rm = lbs; byEx[lift.id].actual = true; }
  });

  // Benchmark lifts the athlete has logged (or has an actual 1RM for).
  const benchmarked = Object.entries(byEx).map(([k, ex]) => {
    const benchKey = getBenchKey(k);
    if (!benchKey) return null;
    const threshRaw = BENCH_THRESHOLDS[genderKey]?.[benchKey];
    if (!threshRaw) return null;
    const thresh = scaledThresholds(threshRaw, bodyweight, genderKey, age);
    return { key: k, name: ex.name, e1rm: ex.e1rm, benchKey, thresh, actual: !!ex.actual };
  }).filter(Boolean);

  // Exactly ONE entry per bench key: keep the highest number; on a tie prefer actual.
  const bestByKey = {};
  benchmarked.forEach((b) => {
    const cur = bestByKey[b.benchKey];
    if (!cur || b.e1rm > cur.e1rm || (b.e1rm === cur.e1rm && b.actual && !cur.actual)) bestByKey[b.benchKey] = b;
  });
  const rankedLifts = Object.values(bestByKey);

  const tierIdxOf = (b) => (bodyweight ? tierForRatio(b.e1rm / bodyweight, b.thresh) : 0);
  const strengthScore = bodyweight ? rankedLifts.reduce((s, b) => s + TIER_POINTS[tierIdxOf(b)], 0) : 0;
  const topTierIdx = (bodyweight && rankedLifts.length) ? Math.max(...rankedLifts.map(tierIdxOf)) : -1;

  // PRs Hit — lifetime count of new-best moments across every lift (first best counts).
  let prsHit = 0;
  {
    const best = {};
    [...(workouts || [])].sort((a, b) => effectiveDate(a) - effectiveDate(b)).forEach((w) => {
      const pd = getPD(w);
      (pd.exercises || []).forEach((ex) => {
        if (!ex.name) return;
        const lift = resolveLift(ex.name);
        if (!lift.tracked) return;
        const e = bestE1RMForExercise(ex, bodyweight);
        if (!e) return;
        const k = lift.id;
        if (!(k in best)) { best[k] = e; prsHit++; }
        else if (e > best[k] + 0.5) { best[k] = e; prsHit++; }
      });
    });
  }

  return {
    rankedLifts: rankedLifts.map((b) => ({ key: b.key, name: b.name, benchKey: b.benchKey, e1rm: b.e1rm, tierIdx: tierIdxOf(b) })),
    // T55/T53: EVERY tracked lift from the same merge (prs rollups + workout
    // e1RMs + the manual_one_rms overlay), not just benchmarked ones — with the
    // actual flag so consumers can tell a declared/tested 1RM from an estimate.
    // The Builder reads this instead of reimplementing max resolution.
    allLifts: Object.values(byEx).sort((a, b) => b.e1rm - a.e1rm)
      .map((x) => ({ key: x.key, name: x.name, e1rm: x.e1rm, actual: !!x.actual })),
    strengthScore,
    topTierIdx,
    topTierName: topTierIdx >= 0 ? TIER_NAMES[topTierIdx] : null,
    prsHit,
  };
}

// ─── SESSION SUMMARY (MY LOG session cards) ──────────────────────────────────
// Tonnage and top set for a session, from the exercises the card is already
// rendering. Both are lbs-equivalent so a kg-logged lift doesn't silently
// undercount the total — the Strength/PRs tabs had exactly that bug (A-list) and
// it is not worth reintroducing one card lower.
//
// WARM-UPS ARE EXCLUDED from tonnage, matching bestE1RMForExercise: a card that
// counts a 45lb bar warm-up toward "12,450 lbs moved" is quietly flattering, and
// the number stops meaning anything across sessions. Bodyweight work contributes
// no tonnage (there is no load to count without knowing bodyweight per rep).

// Total lbs-equivalent moved in a session: sum of weight x reps over working sets.
export function sessionTonnage(exercises) {
  let total = 0;
  for (const ex of exercises || []) {
    if (!ex || ex.unit === "bodyweight" || isUnitPending(ex)) continue;
    const all = getExerciseSets(ex);
    const sets = all.some((s) => !s.warmup) ? all.filter((s) => !s.warmup) : all;
    for (const s of sets) {
      const lbs = toLbs(s.weight || 0, ex.unit);
      const reps = s.reps || 0;
      if (lbs > 0 && reps > 0) total += lbs * reps;
    }
  }
  return Math.round(total);
}

// The session's heaviest single working set, as {name, weight, reps, unit}.
// Reported in the unit it was LOGGED in (a kg lifter should see kg on their own
// card); comparison is done in lbs-equivalent so the winner is the real one.
export function sessionTopSet(exercises) {
  let best = null, bestLbs = 0;
  for (const ex of exercises || []) {
    if (!ex || ex.unit === "bodyweight" || !ex.name || isUnitPending(ex)) continue;
    const all = getExerciseSets(ex);
    const sets = all.some((s) => !s.warmup) ? all.filter((s) => !s.warmup) : all;
    for (const s of sets) {
      const w = s.weight || 0;
      if (w <= 0 || !(s.reps > 0)) continue;
      const lbs = toLbs(w, ex.unit);
      if (lbs > bestLbs) { bestLbs = lbs; best = { name: cleanerName(ex.name), weight: w, reps: s.reps, unit: exerciseUnit(ex) }; }
    }
  }
  return best;
}

// ─── SESSION GROUPING ────────────────────────────────────────────────────────
// Lives here rather than in App.jsx because effectiveDate (the thing it sorts by)
// already does, because it's pure and server-safe, and because it decides the
// number the athlete sees on their header and the coach sees on the roster — the
// one that ratcheted DOWN once already. Now covered by scripts/test-session-grouping.mjs.
//
// A "real session" is a row with actual work in it: exercises or a run. Chat-only
// rows, form reviews and program pastes are all workouts-table rows too, and none
// of them are a training session.
//
// NOTE on parsed_data: this reads it directly rather than through a JSON.parse
// tolerant accessor, matching the App.jsx original byte for byte (every row in the
// database is jsonb-object today; verified 2026-07-23). proofcore's isRealSession
// twin DOES parse legacy strings — if a string-typed row ever appears, these two
// will disagree about the session count, and this is the one to change.
export const isRealSession = (w) => w?.parsed_data?.exercises?.length > 0 || !!w?.parsed_data?.run_data;

// Entries within gapMs of each other (same athlete) are ONE session.
// parsed_data.new_session === true forces a split even inside the window — that's
// the flag the "same workout or new session?" chip writes, so an explicit answer
// from the athlete always beats the time heuristic.
export const groupIntoSessions = (workouts, gapMs = 3*60*60*1000) => {
  const byAthlete = {};
  (workouts || []).filter(isRealSession).forEach(w => {
    if(!byAthlete[w.athlete_id]) byAthlete[w.athlete_id] = [];
    byAthlete[w.athlete_id].push(w);
  });
  const sessions = [];
  Object.values(byAthlete).forEach(entries => {
    const sorted = [...entries].sort((a,b)=>effectiveDate(a)-effectiveDate(b));
    let lastTime = null; let cur = null;
    sorted.forEach(w => {
      const t = effectiveDate(w).getTime();
      if(!lastTime || w.parsed_data?.new_session===true || t-lastTime>gapMs){
        cur = {entries:[w],athleteId:w.athlete_id}; sessions.push(cur);
      } else { cur.entries.push(w); }
      lastTime = t;
    });
  });
  return sessions;
};

// ─── STRENGTH RATIOS + RATE OF PROGRESS (T53 #4) ─────────────────────────────
// Pure arithmetic over resolved maxes — zero AI calls. The ratio sheet turns a
// number dump into a coaching read (ranked limiters vs published strength-ratio
// bands); the rate sheet answers "is this goal reachable by this date" from the
// athlete's own observed trend. Both feed the Builder's interview context.
// Bands are classic S&C reference ratios (Stone/NSCA-style, wide on purpose —
// they flag LIMITERS, they don't diagnose); Will tunes them here, one place.
export const RATIO_STANDARDS = [
  { num: "front squat", den: "back squat", lo: 0.80, hi: 0.90, label: "Front squat vs back squat" },
  { num: "deadlift", den: "back squat", lo: 1.05, hi: 1.25, label: "Deadlift vs back squat" },
  { num: "bench press", den: "back squat", lo: 0.60, hi: 0.75, label: "Bench vs back squat" },
  { num: "overhead press", den: "bench press", lo: 0.60, hi: 0.70, label: "Overhead press vs bench" },
  { num: "snatch", den: "back squat", lo: 0.58, hi: 0.66, label: "Snatch vs back squat" },
  { num: "clean and jerk", den: "back squat", lo: 0.72, hi: 0.82, label: "Clean & jerk vs back squat" },
  { num: "snatch", den: "clean and jerk", lo: 0.78, hi: 0.86, label: "Snatch vs clean & jerk" },
];

// allLifts = computeGritSnapshot(...).allLifts. Returns ratios the athlete has
// both numbers for, flagged low/high/in-band, sorted worst-first (limiters lead).
export function strengthRatios(allLifts) {
  const by = {};
  for (const l of allLifts || []) if (l?.key && l.e1rm > 0) by[l.key] = l.e1rm;
  const out = [];
  for (const r of RATIO_STANDARDS) {
    const n = by[r.num], d = by[r.den];
    if (!n || !d) continue;
    const ratio = n / d;
    const flag = ratio < r.lo ? "low" : ratio > r.hi ? "high" : "in-band";
    // Distance outside the band, as a fraction — 0 when in-band; sorts limiters.
    const off = ratio < r.lo ? (r.lo - ratio) / r.lo : ratio > r.hi ? (ratio - r.hi) / r.hi : 0;
    out.push({ ...r, ratio: Math.round(ratio * 100) / 100, flag, off });
  }
  return out.sort((a, b) => b.off - a.off);
}

// One prompt-ready line naming the ranked limiters (empty when nothing flags).
export function ratioLimitersLine(allLifts) {
  const flagged = strengthRatios(allLifts).filter((r) => r.flag !== "in-band").slice(0, 3);
  if (!flagged.length) return "";
  return flagged.map((r) =>
    `${r.label} is ${r.ratio} (${r.flag === "low" ? "below" : "above"} the ${r.lo}-${r.hi} band — ${r.flag === "low" ? `${r.num} is the limiter` : `${r.den} is lagging`})`
  ).join("; ");
}

// Observed rate of progress for one lift from logged history (lbs/week of e1RM
// trend, first-vs-best over the actual time span), vs the rate the goal needs.
// rows = workout rows (any order); lift = free-text name (resolved internally).
export function rateOfProgress(rows, lift, goalLbs, goalDateIso, { minWeeks = 2 } = {}) {
  const id = resolveLift(lift).id;
  const points = [];
  for (const w of Array.isArray(rows) ? rows : []) {
    let pd = w?.parsed_data;
    if (typeof pd === "string") { try { pd = JSON.parse(pd); } catch { pd = null; } }
    for (const ex of pd?.exercises || []) {
      if (!ex?.name || resolveLift(ex.name).id !== id) continue;
      const e = bestE1RMForExercise(ex);
      if (e > 0) points.push({ t: effectiveDate(w).getTime(), e });
    }
  }
  if (points.length < 2) return { known: false, points: points.length };
  points.sort((a, b) => a.t - b.t);
  const first = points[0], best = points.reduce((a, b) => (b.e > a.e ? b : a));
  const weeks = Math.max(minWeeks, (best.t - first.t) / 6.048e8);
  const observedPerWeek = (best.e - first.e) / weeks;
  const out = { known: true, current: Math.round(best.e), observedPerWeek: Math.round(observedPerWeek * 10) / 10,
    points: points.length, spanDays: Math.round((points[points.length - 1].t - first.t) / 86400000) };
  if (goalLbs > 0 && goalDateIso) {
    const weeksLeft = Math.max(0.5, (Date.parse(goalDateIso) - Date.now()) / 6.048e8);
    out.requiredPerWeek = Math.round(((goalLbs - best.e) / weeksLeft) * 10) / 10;
    out.weeksLeft = Math.round(weeksLeft * 10) / 10;
    out.feasible = out.requiredPerWeek <= Math.max(observedPerWeek * 1.5, 1);
  }
  return out;
}

// ─── FEASIBILITY ARGUMENT (W39.5, Will-blessed 08-17) ─────────────────────────
// History-gated: an athlete with a real logged trend on the goal lift gets the
// full code-computed argument; below the gate the model is TOLD there is no
// trend and forbidden from claiming one. Never blocks a goal — it informs the
// Builder's timeline negotiation, once.
export const FEASIBILITY_GATE = { points: 6, spanDays: 21 };

// Find the benchmark lift a free-text goal names ("Bench 315 by Dec 25" → bench
// press; "Front squat 275" → front squat, not back squat). resolveLift is fuzzy
// — "bench by december" still resolves benchKey "bench press" — so every n-gram
// match is TRIMMED to its core: drop edge words while the benchKey holds, and a
// dropped word that yields a DIFFERENT benchKey (front|squat) stops the trim.
// Longest core wins, so "front squat" beats the bare "squat" inside it.
export function goalLiftFromText(goalText) {
  const words = String(goalText || "").toLowerCase().replace(/[^a-z&\s]/g, " ").split(/\s+/).filter(Boolean);
  const cores = new Map(); // core phrase -> resolved lift
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      let seg = words.slice(i, i + n);
      const key = resolveLift(seg.join(" ")).benchKey;
      if (!key) continue;
      const bk = (arr) => resolveLift(arr.join(" ")).benchKey;
      let moved = true;
      while (moved && seg.length > 1) {
        moved = false;
        if (bk(seg.slice(1)) === key) { seg = seg.slice(1); moved = true; continue; }
        if (bk(seg.slice(0, -1)) === key) { seg = seg.slice(0, -1); moved = true; }
      }
      const core = seg.join(" ");
      if (!cores.has(core)) cores.set(core, resolveLift(core));
    }
  }
  let best = null, bestLen = 0;
  for (const [core, lift] of cores) {
    if (core.split(" ").length > bestLen) { best = lift; bestLen = core.split(" ").length; }
  }
  return best;
}

// The goal's target load in lbs (kg converts; date-like small numbers ignored).
export function goalTargetLbs(goalText) {
  let best = 0;
  for (const m of String(goalText || "").matchAll(/(\d{2,4}(?:\.\d+)?)\s*(kg|lbs?|lb)?/gi)) {
    const n = Number(m[1]);
    if (!n) continue;
    const lbs = /kg/i.test(m[2] || "") ? toLbs(n, "kg") : n;
    if (lbs >= 45 && lbs <= 1200 && lbs > best) best = lbs;
  }
  return best || null;
}

// One prompt-ready line. rows = workout rows; timelineText = the timeline cell
// ("YYYY-MM-DD to YYYY-MM-DD") whose end date anchors the required rate.
export function feasibilityLine(rows, goalText, timelineText) {
  const lift = goalLiftFromText(goalText);
  const target = goalTargetLbs(goalText);
  if (!lift || !target) return "";
  const endM = String(timelineText || "").match(/(\d{4}-\d{2}-\d{2})\s*$/);
  const rp = rateOfProgress(rows, lift.id, target, endM ? endM[1] : null);
  const full = rp.known && rp.points >= FEASIBILITY_GATE.points && rp.spanDays >= FEASIBILITY_GATE.spanDays;
  if (!full) {
    return `FEASIBILITY (code-computed): not enough logged ${lift.name} history for a trend (${rp.points || 0} sessions). Pace the timeline by doctrine — make NO claims about what their data shows.`;
  }
  let line = `FEASIBILITY (code-computed): ${lift.name} trend ${rp.observedPerWeek >= 0 ? "+" : ""}${rp.observedPerWeek} lb/wk over ${rp.spanDays} days (${rp.points} sessions), current est ${rp.current} lb; goal ${Math.round(target)} lb`;
  if (rp.requiredPerWeek != null) {
    const verdict = rp.requiredPerWeek <= 0 ? "ALREADY THERE — retest and retire or raise the goal"
      : rp.requiredPerWeek <= Math.max(rp.observedPerWeek, 0) * 1.1 + 0.25 ? "ON TRACK"
      : rp.requiredPerWeek <= Math.max(rp.observedPerWeek, 0) * 1.5 + 1 ? "TIGHT — say what has to be true"
      : "UNREALISTIC IN THIS WINDOW — negotiate the date or the number, or set a block gate";
    line += ` needs ${rp.requiredPerWeek} lb/wk over the ${rp.weeksLeft} wk left — ${verdict}.`;
  } else {
    line += `; no end date pinned yet — use this trend when proposing one.`;
  }
  return line;
}

// ── PR CHECK — deterministic verdicts for a just-parsed log (T60, 08-28) ─────
// Joe's reply used to re-derive PR comparisons itself and flubbed both the unit
// conversion and the direction ("118 kg is right under your 250 lb max" — 118 kg
// IS 260 lbs, a new PR the app was simultaneously stamping NEW MAX for). The app
// computes the verdict per lift and hands the model finished lines; the model
// never re-compares. `best` is the same {liftId: {name, e1rm(lbs), actual?}} map
// chat's KNOWN 1RMs block is built from (actual 1RM overlays the estimate), so
// chat and the NEW MAX stamp can never disagree about what beats what.
// Mirrors finalizeWorkout's celebration rules: a made single above the best on
// file is an actual PR; an e1RM rise only counts while no actual 1RM exists;
// an implausible jump gets a sanity-check verdict, not a celebration.
// T67 (09-29): a kg athlete's lines carry kg ONLY. They used to read
// "154.2 kg (340 lbs)", and the real model once read that back as "340 kg".
// One unit per athlete, the one they work in; the comparison itself is done
// here in lbs and never shown.
export const showMax = (lbs, unit = "lbs") => unit === "kg" ? `${Math.round((lbs / LBS_PER_KG) * 10) / 10} kg` : `${Math.round(lbs)} lbs`;
export function prCheckLines(exercises, best, unit = "lbs") {
  const show = (lbs) => showMax(lbs, unit);
  const lines = [];
  for (const ex of Array.isArray(exercises) ? exercises : []) {
    if (!ex || !ex.name || ex.unit === "bodyweight" || isUnitPending(ex)) continue;
    const sets = getExerciseSets(ex).filter((s) => s.weight > 0);
    if (!sets.length && !(ex.weight > 0)) continue;
    const top = sets.reduce((b, s) => (!b || toLbs(s.weight, ex.unit) > toLbs(b.weight, ex.unit)) ? s : b, null) || { weight: ex.weight, reps: ex.reps || 1 };
    const topLbs = toLbs(top.weight, ex.unit);
    const prev = best && best[resolveLift(ex.name).id];
    if (!prev || !(prev.e1rm > 0)) {
      lines.push(`${ex.name}: first record on file for this lift (top ${show(topLbs)}) — nothing to compare against yet.`);
      continue;
    }
    const singleLbs = sets.filter((s) => s.reps === 1).reduce((m, s) => Math.max(m, toLbs(s.weight, ex.unit)), 0);
    const e1 = bestE1RMForExercise(ex) || 0;
    const challenger = Math.max(singleLbs, prev.actual ? 0 : e1);
    const prevLabel = `${show(prev.e1rm)} ${prev.actual ? "actual 1RM" : "estimated 1RM"}`;
    if (challenger > prev.e1rm) {
      if (implausibleJump(prev.e1rm, challenger)) {
        lines.push(`${ex.name}: logged ${show(challenger)} vs previous best ${prevLabel} — implausibly far above it; sanity-check the number conversationally, no celebration yet.`);
      } else if (singleLbs > prev.e1rm) {
        lines.push(`${ex.name}: NEW PR — made single at ${show(singleLbs)}, ABOVE the previous best ${prevLabel}.`);
      } else {
        lines.push(`${ex.name}: NEW ESTIMATED PR — top set ${show(topLbs)} works out to ${show(e1)} estimated, above the previous best ${prevLabel}.`);
      }
    } else {
      lines.push(`${ex.name}: no PR — top ${show(topLbs)}; the best on file stays ${prevLabel}.`);
    }
  }
  return lines;
}

// The chat's KNOWN 1RMs lines (T67): rows are {name, e1rm (lbs), actual?}, the
// same map prCheckLines reads. A kg athlete reads kg, never a bare lbs number
// the model has to convert (the same misread as the PR CHECK lines).
export function knownMaxLines(rows, unit = "lbs") {
  return (Array.isArray(rows) ? rows : []).map((r) => `${r.name}: ${r.actual ? "" : "~"}${showMax(r.e1rm, unit)} (${r.actual ? "actual 1RM" : "est."})`);
}
