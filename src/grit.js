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
  return new Date(w?.created_at);
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

export const toLbs = (weight, unit) => (unit === "kg" ? weight * 2.205 : weight);

// Load-bearing bodyweight movements — dips, pull-ups, chin-ups, muscle-ups — where
// the athlete's own bodyweight IS the resistance. Given bodyweight we can estimate
// a 1RM (plus any added weight, minus any assistance). Other bodyweight work
// (push-ups, planks, air squats) has no meaningful 1RM.
const LOAD_BEARING_BW = /\b(dips?|pull[ -]?ups?|chin[ -]?ups?|muscle[ -]?ups?)\b/;

// Best estimated 1RM across the WORKING sets of a logged exercise (lbs-equivalent).
// `bwLbs` (athlete bodyweight) is optional: pass it to score load-bearing bodyweight
// lifts; omit it and bodyweight lifts return 0.
export const bestE1RMForExercise = (ex, bwLbs = 0) => {
  if (!ex) return 0;
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
export const TIER_COLORS = ["#7a8798", "#3a7bff", "#37e6ff", "#2ee6a8", "#ffd34d", "#ff8a3d", "#ff4d5e", "#b46dff"];
// Strength Score points per tier — each level worth more than the last.
export const TIER_POINTS = [10, 25, 50, 100, 175, 275, 400, 600];
// Flavor line per tier (shown in the Top Rank classification popover).
export const TIER_DESC = ["just off the ground", "on the come-up", "lookin' sharp", "just plain solid", "top of the gym", "a cut above", "national-class", "truly incredible"];
// Load-bearing bodyweight lifts show a cleaner name + a "bodyweight + added" readout.
export const BENCH_DISPLAY = { "weighted pull-up": "Pull-Ups", "weighted dip": "Dips" };
export const BENCH_IS_BW = { "weighted pull-up": true, "weighted dip": true };

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
  const added = Math.round(e1rm - bodyweightLbs);
  return added > 0
    ? `${Math.round(bodyweightLbs)} + ${added} lbs (bodyweight + added)`
    : `${Math.round(bodyweightLbs)} lbs (bodyweight)`;
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
      const unit = ex.unit === "bodyweight" ? "lbs" : (ex.unit || "lbs");
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
    strengthScore,
    topTierIdx,
    topTierName: topTierIdx >= 0 ? TIER_NAMES[topTierIdx] : null,
    prsHit,
  };
}
