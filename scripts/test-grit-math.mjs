// Grit tier/e1RM math regression suite — the guard rail for everything in
// src/grit.js that test-lift-taxonomy.mjs does NOT cover: the Epley 15-rep cap
// (and the above-cap set drop), age/bodyweight threshold scaling, tier boundary
// behavior, bodyweight+added lifts, effectiveDate, and computeGritSnapshot
// invariants (manual overlay ties prefer actual, seedFromPRs is additive, one
// entry per benchKey). Will tunes BENCH_THRESHOLDS/AGE_TIER_ANCHORS by hand —
// this suite is the rail that a tuning edit doesn't silently break the ladder
// shared by the athlete modal, coach dashboard, proof-feed cron, and PR detection.
// Run with: node scripts/test-grit-math.mjs

import {
  MAX_E1RM_REPS, epley1RM, effectiveDate, parseDbDate, getExerciseSets, toLbs,
  bestE1RMForExercise, tierForRatio, bwTierFactor, ageTierFactor,
  scaledThresholds, BENCH_THRESHOLDS, TIER_NAMES, TIER_POINTS,
  REF_BW, bwLoadLabel, computeGritSnapshot, resolveLift,
  sessionTonnage, sessionTopSet,
  implausibleJump, prCheckLines, knownMaxLines,
} from "../src/grit.js";

let fail = 0, pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("  ✗ " + msg); } };
const eq = (got, want, msg) => ok(Object.is(got, want), `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const approx = (got, want, msg, eps = 1e-9) => ok(Math.abs(got - want) <= eps, `${msg}: got ${got}, want ~${want}`);

// ── Epley e1RM + the 15-rep cap ───────────────────────────────────────────────
console.log("epley1RM:");
eq(MAX_E1RM_REPS, 15, "MAX_E1RM_REPS is 15");
eq(epley1RM(225, 5), 263, "225x5 → 263 (round(262.5) rounds up)");
eq(epley1RM(100, 3), 110, "100x3 → 110");
eq(epley1RM(315, 1), 315, "single = weight, no bump");
eq(epley1RM(315, 0), 315, "0 reps treated as single");
eq(epley1RM(315, null), 315, "null reps treated as single");
eq(epley1RM(0, 5), 0, "no weight → 0");
eq(epley1RM(-10, 5), 0, "negative weight → 0");
eq(epley1RM(100, 15), 150, "100x15 → 150 (cap boundary)");
eq(epley1RM(100, 20), 150, "reps clamp AT the cap: 100x20 === 100x15");
eq(epley1RM(100, 100), 150, "100-rep set can never mint a 953lb-class 1RM");

// ── toLbs / getExerciseSets ───────────────────────────────────────────────────
console.log("toLbs / getExerciseSets:");
approx(toLbs(100, "kg"), 220.462, "kg → lbs at LBS_PER_KG (2.20462)");
eq(toLbs(100, "lbs"), 100, "lbs passthrough");
{
  const sets = getExerciseSets({ weight: 200, reps: 5, sets: 3 });
  eq(sets.length, 3, "flat fields expand to `sets` entries");
  eq(sets[0].weight, 200, "flat weight carried");
  const det = getExerciseSets({ weight: 200, reps: 5, set_details: [{ weight: 135, reps: 8, warmup: true }, { reps: 3 }] });
  eq(det.length, 2, "set_details wins over flat");
  eq(det[0].warmup, true, "warmup flag preserved");
  eq(det[1].weight, 200, "set_details falls back to flat weight");
  eq(det[1].reps, 3, "set_details own reps kept");
  eq(getExerciseSets(null).length, 0, "null exercise → no sets");
}

// ── bestE1RMForExercise ───────────────────────────────────────────────────────
console.log("bestE1RMForExercise:");
eq(bestE1RMForExercise({ name: "bench press", weight: 225, reps: 5, sets: 3, unit: "lbs" }), 263, "flat 225x5 → 263");
eq(bestE1RMForExercise({
  name: "bench press", unit: "lbs",
  set_details: [{ weight: 135, reps: 5, warmup: true }, { weight: 225, reps: 3 }, { weight: 245, reps: 1 }],
}), 248, "warm-ups excluded; best working set wins (225x3=248 beats 245x1)");
eq(bestE1RMForExercise({
  name: "bench press", unit: "lbs",
  set_details: [{ weight: 135, reps: 5, warmup: true }],
}), 158, "all-warm-up exercise falls back to using every set");
eq(bestE1RMForExercise({ name: "push-up hold", weight: 100, reps: 20, sets: 1, unit: "lbs" }), 0, "above-cap set is DROPPED, not clamped — no benchmark signal");
eq(bestE1RMForExercise({
  name: "squat", unit: "lbs",
  set_details: [{ weight: 100, reps: 20 }, { weight: 80, reps: 10 }],
}), 107, "mixed: 20-rep set dropped, 80x10 → 107");
approx(bestE1RMForExercise({ name: "bench press", weight: 100, reps: 1, sets: 1, unit: "kg" }), 220.462, "kg single converts, unrounded (epley returns raw weight at reps<=1)");
// bodyweight + added (pull-up/dip)
eq(bestE1RMForExercise({ name: "Pull-Ups", unit: "bodyweight", added_weight: 45, reps: 5, sets: 1 }, 180), 263, "pull-up: (180bw + 45 added) x5 → epley(225,5)=263");
eq(bestE1RMForExercise({ name: "Dips", unit: "bodyweight", reps: 1, sets: 1, assist_weight: 50 }, 180), 130, "dip with 50 assist → 130x1");
eq(bestE1RMForExercise({ name: "Pull-Ups", unit: "bodyweight", reps: 5, sets: 1 }), 0, "no bodyweight passed → bodyweight lift returns 0");
eq(bestE1RMForExercise({ name: "push-ups", unit: "bodyweight", reps: 10, sets: 3 }, 180), 0, "non-load-bearing bodyweight (push-up) → 0");
eq(bestE1RMForExercise({ name: "Pull-Ups", unit: "bodyweight", assist_weight: 200, reps: 5, sets: 1 }, 180), 0, "assistance beyond bodyweight → load <= 0 → 0");
eq(bestE1RMForExercise(null), 0, "null exercise → 0");

// ── tierForRatio boundaries ───────────────────────────────────────────────────
console.log("tierForRatio:");
{
  const t = BENCH_THRESHOLDS.male["back squat"]; // [0.75,1.25,1.5,2.0,2.5,2.75,3.0]
  eq(tierForRatio(0, t), 0, "0 ratio → ROOKIE");
  eq(tierForRatio(0.7499, t), 0, "just under first cut → ROOKIE");
  eq(tierForRatio(0.75, t), 1, "EXACT threshold reaches the tier (>= not >)");
  eq(tierForRatio(2.0, t), 4, "2.0x squat → ELITE");
  eq(TIER_NAMES[4], "ELITE", "tier 4 named ELITE");
  eq(tierForRatio(3.0, t), 7, "top cut-line → LEGENDARY");
  eq(tierForRatio(99, t), 7, "beyond the ladder clamps at LEGENDARY");
  eq(TIER_NAMES.length, 8, "8 tiers");
  eq(TIER_POINTS.length, 8, "8 point values");
  ok(TIER_POINTS.every((p, i) => i === 0 || p > TIER_POINTS[i - 1]), "TIER_POINTS strictly increasing");
}

// ── bwTierFactor ──────────────────────────────────────────────────────────────
console.log("bwTierFactor:");
eq(bwTierFactor(200, "male"), 1, "male at ref BW (200) → exactly 1");
eq(bwTierFactor(150, "female"), 1, "female at ref BW (150) → exactly 1");
eq(REF_BW.male, 200, "male ref 200");
approx(bwTierFactor(250, "male"), Math.pow(200 / 250, 0.17), "heavier → smaller multiple, (ref/bw)^0.17");
eq(bwTierFactor(20, "male"), 1.2, "featherweight clamps at 1.2");
eq(bwTierFactor(10000, "male"), 0.85, "superheavy clamps at 0.85");
eq(bwTierFactor(0, "male"), 1, "no bodyweight → neutral 1");
eq(bwTierFactor(null, "male"), 1, "null bodyweight → neutral 1");
eq(bwTierFactor(180, "nonsense"), bwTierFactor(180, "male"), "unknown gender key falls back to male ref");

// ── ageTierFactor ─────────────────────────────────────────────────────────────
console.log("ageTierFactor:");
eq(ageTierFactor(null), 1, "unknown age ranks as prime");
eq(ageTierFactor(0), 1, "age 0 → neutral (not > 0)");
eq(ageTierFactor(-5), 1, "negative age → neutral");
eq(ageTierFactor(13), 0.78, "13 → first anchor");
eq(ageTierFactor(9), 0.78, "under first anchor clamps at 0.78");
approx(ageTierFactor(15), 0.845, "15 interpolates between [14,0.81] and [16,0.88]");
eq(ageTierFactor(23), 1, "prime starts at 23");
eq(ageTierFactor(30), 1, "prime is flat 23-40");
eq(ageTierFactor(40), 1, "prime ends at 40");
approx(ageTierFactor(43), 1 + (0.96 - 1) * (3 / 5), "43 interpolates between [40,1.0] and [45,0.96]");
eq(ageTierFactor(90), 0.46, "90 → last anchor");
eq(ageTierFactor(101), 0.46, "past last anchor clamps at 0.46");

// ── scaledThresholds ──────────────────────────────────────────────────────────
console.log("scaledThresholds:");
{
  const s = scaledThresholds([1, 2], 200, "male", 30);
  eq(s[0], 1, "prime male at ref BW → thresholds unchanged");
  eq(s[1], 2, "prime male at ref BW → thresholds unchanged (2)");
  const teen = scaledThresholds([1, 2], 200, "male", 15);
  approx(teen[0], 0.845, "15yo: cut-lines scale by ageTierFactor");
  const combo = scaledThresholds([1], 250, "male", 15);
  approx(combo[0], Math.pow(200 / 250, 0.17) * 0.845, "bw and age factors multiply");
}

// ── effectiveDate log_date fallback ───────────────────────────────────────────
console.log("effectiveDate:");
{
  const d = effectiveDate({ created_at: "2026-07-20T08:00:00Z", parsed_data: { log_date: "2026-07-18" } });
  eq(d.getFullYear(), 2026, "log_date honored (year)");
  eq(d.getMonth(), 6, "log_date honored (month)");
  eq(d.getDate(), 18, "log_date honored (day)");
  eq(d.getHours(), 12, "noon-LOCAL parse (no UTC day-boundary drift)");
  const s = effectiveDate({ created_at: "2026-07-20T08:00:00Z", parsed_data: JSON.stringify({ log_date: "2026-07-18" }) });
  eq(s.getDate(), 18, "string parsed_data is JSON-parsed");
  const bad = effectiveDate({ created_at: "2026-07-20T08:00:00Z", parsed_data: { log_date: "2026-7-8" } });
  eq(bad.toISOString(), "2026-07-20T08:00:00.000Z", "malformed log_date falls back to created_at");
  const junk = effectiveDate({ created_at: "2026-07-20T08:00:00Z", parsed_data: "not json{" });
  eq(junk.toISOString(), "2026-07-20T08:00:00.000Z", "unparseable parsed_data falls back to created_at");
}

// ── parseDbDate: the day-shift guard ──────────────────────────────────────────
// A Postgres `timestamp WITHOUT time zone` comes back with no offset, and JS parses
// that space-separated form as LOCAL — so an 8:30 PM Eastern session read as the NEXT
// DAY. The columns are timestamptz now, but the failure was silent and day-shifting,
// so the rule keeps a permanent case. Run under a fixed TZ (see below) or these are
// vacuous on a UTC machine.
console.log("parseDbDate:");
{
  // The exact shape PostgREST returns for a naive column: 00:30 UTC = 8:30 PM Mon ET.
  const naive = parseDbDate("2026-07-28 00:30:00.123456");
  eq(naive.toISOString(), "2026-07-28T00:30:00.123Z", "offset-less DB timestamp is read as UTC, not local");
  // Same instant, tz-aware form — the two must agree exactly.
  eq(parseDbDate("2026-07-28T00:30:00.123456+00:00").getTime(), naive.getTime(), "naive and tz-aware forms agree");
  eq(parseDbDate("2026-07-28T00:30:00.123Z").getTime(), naive.getTime(), "Z form agrees too");
  // "T" separator without a zone is the same case.
  eq(parseDbDate("2026-07-28T00:30:00").toISOString(), "2026-07-28T00:30:00.000Z", "T-separated, zone-less also read as UTC");
  eq(parseDbDate("2026-07-28 00:30:00").toISOString(), "2026-07-28T00:30:00.000Z", "seconds-only precision handled");
  // Explicit non-UTC offsets must be respected, never rewritten.
  eq(parseDbDate("2026-07-27T20:30:00.123456-04:00").getTime(), naive.getTime(), "explicit -04:00 offset is honored (same instant as the UTC form)");
  // Pass-throughs.
  const d = new Date("2026-07-28T00:30:00Z");
  eq(parseDbDate(d).getTime(), d.getTime(), "a Date passes through");
  eq(parseDbDate(d.getTime()).getTime(), d.getTime(), "an epoch number passes through");
  eq(Number.isNaN(parseDbDate(null).getTime()), true, "null is an invalid date, not a crash");
  eq(Number.isNaN(parseDbDate(undefined).getTime()), true, "undefined is an invalid date, not a crash");
  // And the reason it matters: effectiveDate must land on the right DAY.
  const ed = effectiveDate({ created_at: "2026-07-28 00:30:00.123456", parsed_data: {} });
  eq(ed.toISOString(), "2026-07-28T00:30:00.123Z", "effectiveDate reads a naive created_at as UTC");
}

// ── bwLoadLabel ───────────────────────────────────────────────────────────────
console.log("bwLoadLabel:");
eq(bwLoadLabel(405, 180), "180 + 225 lbs (bodyweight + added)", "added split rendered");
eq(bwLoadLabel(170, 180), "180 lbs (bodyweight)", "no positive added → plain bodyweight");
eq(bwLoadLabel(200, 0), null, "no bodyweight → null (can't split)");

// ── resolveLift memoization contract (perf change 2026-07-22) ─────────────────
console.log("resolveLift memo:");
{
  const a = resolveLift("Bench Press"), b = resolveLift("Bench Press");
  ok(a === b, "repeat single-arg call returns the SAME cached object");
  ok(Object.isFrozen(a), "cached result is frozen (callers can't corrupt the cache)");
  eq(a.id, "bench press", "cached result still resolves correctly");
  const c = resolveLift("mystery curl", "Mystery Curl");
  eq(c.name, "Mystery Curl", "observedName fallback path still works (uncached)");
  ok(!Object.isFrozen(c) || c !== resolveLift("mystery curl"), "observedName call does not poison the raw-name cache");
  eq(resolveLift("mystery curl").name, resolveLift("mystery curl").name, "raw-name lookups stay consistent");
}

// ── computeGritSnapshot invariants ────────────────────────────────────────────
console.log("computeGritSnapshot:");
const W = (name, weight, reps, extra = {}) => ({
  created_at: extra.created_at || "2026-07-01T10:00:00Z",
  parsed_data: { exercises: [{ name, weight, reps, sets: 1, unit: "lbs", ...extra.ex }] },
});
{
  // Reference athlete: male, 200 lbs, prime age → all factors exactly 1.
  const opts = { bodyweightLbs: 200, gender: "Male", age: 25 };
  const snap = computeGritSnapshot([W("Back Squat", 300, 5)], [], opts);
  eq(snap.rankedLifts.length, 1, "one ranked lift");
  eq(snap.rankedLifts[0].e1rm, 350, "300x5 → 350");
  eq(snap.rankedLifts[0].tierIdx, 3, "350/200 = 1.75x → STRONG");
  eq(snap.topTierName, "STRONG", "top tier named");
  eq(snap.strengthScore, TIER_POINTS[3], "strength score = tier points");
  eq(snap.prsHit, 1, "first-ever best counts as a PR");
}
{
  // Deadlift reference point: 400 @ 200bw = 2.0x → STRONG (thresholds 1.0/1.5/1.75/2.25…).
  const snap = computeGritSnapshot([W("conventional deadlift", 400, 1)], [], { bodyweightLbs: 200, gender: "Male", age: 30 });
  eq(snap.rankedLifts[0].benchKey, "deadlift", "alias funnels to the deadlift standard");
  eq(snap.rankedLifts[0].tierIdx, 3, "2.0x deadlift → STRONG");
}
{
  // Age scaling: 1.1x bench — prime male → SHARP(2); 15-year-old → STRONG(3).
  const prime = computeGritSnapshot([W("Bench Press", 220, 1)], [], { bodyweightLbs: 200, gender: "Male", age: 30 });
  const teen = computeGritSnapshot([W("Bench Press", 220, 1)], [], { bodyweightLbs: 200, gender: "Male", age: 15 });
  eq(prime.rankedLifts[0].tierIdx, 2, "1.1x bench, prime → SHARP");
  eq(teen.rankedLifts[0].tierIdx, 3, "1.1x bench at 15 → STRONG (age-scaled cut-lines)");
}
{
  // Female thresholds are their own table.
  const snap = computeGritSnapshot([W("Back Squat", 210, 1)], [], { bodyweightLbs: 150, gender: "Female", age: 30 });
  eq(snap.rankedLifts[0].tierIdx, 4, "female 1.4x squat → ELITE");
}
{
  // Manual overlay: manual >= estimate wins and marks actual (ties prefer actual).
  const opts = { bodyweightLbs: 200, gender: "Male", age: 30 };
  const higher = computeGritSnapshot([W("Bench Press", 250, 1)], [{ exercise: "bench press", weight: 300, unit: "lbs" }], opts);
  eq(higher.rankedLifts[0].e1rm, 300, "manual 1RM overrides lower estimate");
  const lower = computeGritSnapshot([W("Bench Press", 250, 1)], [{ exercise: "bench press", weight: 200, unit: "lbs" }], opts);
  eq(lower.rankedLifts[0].e1rm, 250, "manual below estimate never drags it down");
  const kg = computeGritSnapshot([], [{ exercise: "bench press", weight: 100, unit: "kg" }], opts);
  approx(kg.rankedLifts[0].e1rm, 220.462, "manual kg converts to lbs");
  // Tie between two ids on ONE benchKey: actual wins the dedup.
  const tie = computeGritSnapshot(
    [W("romanian deadlift", 315, 1)],
    [{ exercise: "stiff leg deadlift", weight: 315, unit: "lbs" }],
    opts
  );
  eq(tie.rankedLifts.length, 1, "one entry per benchKey (romanian + stiff-leg share the RDL standard)");
  eq(tie.rankedLifts[0].key, "stiff leg deadlift", "on an exact tie the ACTUAL 1RM entry wins the benchKey slot");
}
{
  // seedFromPRs is ADDITIVE: higher of seed vs workouts wins, never a replacement.
  const opts = { bodyweightLbs: 200, gender: "Male", age: 30 };
  const seedWins = computeGritSnapshot([W("Bench Press", 250, 1)], [], { ...opts, seedFromPRs: [{ exercise: "Bench Press", estimated_1rm: 400 }] });
  eq(seedWins.rankedLifts[0].e1rm, 400, "seed above window best wins (all-time bests survive the 100-row cap)");
  const windowWins = computeGritSnapshot([W("Bench Press", 250, 1)], [], { ...opts, seedFromPRs: [{ exercise: "Bench Press", estimated_1rm: 200 }] });
  eq(windowWins.rankedLifts[0].e1rm, 250, "window best above seed wins");
  const seedOnly = computeGritSnapshot([], [], { ...opts, seedFromPRs: [{ exercise: "Deadlift", estimated_1rm: 500 }] });
  eq(seedOnly.rankedLifts[0].e1rm, 500, "seed alone still ranks the lift");
  const junkSeed = computeGritSnapshot([], [], { ...opts, seedFromPRs: [{ exercise: "workout", estimated_1rm: 500 }, { estimated_1rm: 300 }] });
  eq(junkSeed.rankedLifts.length, 0, "junk / nameless seeds are dropped");
}
{
  // PRs Hit: first best counts, then only > best + 0.5.
  const opts = { bodyweightLbs: 200, gender: "Male", age: 30 };
  const w = [
    W("Bench Press", 200, 1, { created_at: "2026-07-01T10:00:00Z" }),
    W("Bench Press", 205, 1, { created_at: "2026-07-03T10:00:00Z" }),
    W("Bench Press", 205, 1, { created_at: "2026-07-05T10:00:00Z" }),
    W("Bench Press", 205.4, 1, { created_at: "2026-07-07T10:00:00Z" }),
  ];
  eq(computeGritSnapshot(w, [], opts).prsHit, 2, "first + one real improvement; repeats and <=0.5 bumps don't count");
  // Chronology comes from effectiveDate, so an out-of-order array still counts right.
  eq(computeGritSnapshot([...w].reverse(), [], opts).prsHit, 2, "insertion order irrelevant (sorted by effectiveDate)");
}
{
  // No bodyweight on file: lifts still list, but no ranks/score.
  const snap = computeGritSnapshot([W("Back Squat", 300, 5)], [], {});
  eq(snap.strengthScore, 0, "no bodyweight → score 0");
  eq(snap.topTierIdx, -1, "no bodyweight → no top tier");
  eq(snap.topTierName, null, "no bodyweight → null tier name");
}
{
  // Untracked junk and unbenchmarked lifts never rank.
  const opts = { bodyweightLbs: 200, gender: "Male", age: 30 };
  const snap = computeGritSnapshot([W("workout", 300, 5), W("hammer curl", 50, 10)], [], opts);
  eq(snap.rankedLifts.length, 0, "junk + non-benchmark lifts → no ranked entries");
  eq(snap.prsHit, 1, "tracked non-benchmark lift (hammer curl) still counts a PR moment");
}

// ── session summary (MY LOG session cards) ───────────────────────────────────
// These numbers sit on every session card, so a quietly wrong one is a claim the
// athlete carries around. Warm-ups excluded and kg converted — the same two things
// the Strength/PRs tabs got wrong before.
console.log("sessionTonnage / sessionTopSet:");
{
  const sq = { name: "Back Squat", sets: 5, reps: 5, weight: 315, unit: "lbs" };
  const rdl = { name: "Romanian Deadlift", sets: 3, reps: 8, weight: 225, unit: "lbs" };
  eq(sessionTonnage([sq]), 7875, "5x5 @315 = 7,875 lbs");
  eq(sessionTonnage([sq, rdl]), 7875 + 5400, "tonnage sums across exercises");
  eq(sessionTonnage([]), 0, "empty session = 0");
  eq(sessionTonnage(null), 0, "null exercises = 0, not a throw");
  eq(sessionTonnage([{ name: "Push-ups", sets: 3, reps: 20, unit: "bodyweight" }]), 0, "bodyweight work adds no tonnage");
  eq(sessionTonnage([{ name: "Squat", sets: 3, reps: 5 }]), 0, "no weight logged = no tonnage");
  // kg must convert, or a kg lifter's session reads ~45% lighter than it was.
  eq(sessionTonnage([{ name: "Squat", sets: 5, reps: 5, weight: 100, unit: "kg" }]), Math.round(100 * 2.20462 * 25), "kg converts to lbs-equivalent");
  // Warm-ups: counting the empty bar toward "lbs moved" flatters every session.
  const warmed = { name: "Bench Press", unit: "lbs", set_details: [
    { weight: 45, reps: 10, warmup: true }, { weight: 135, reps: 5, warmup: true },
    { weight: 225, reps: 5 }, { weight: 225, reps: 5 },
  ] };
  eq(sessionTonnage([warmed]), 2250, "warm-up sets are excluded from tonnage");
  eq(sessionTopSet([warmed]).weight, 225, "top set ignores warm-ups");
  // An all-warm-up entry falls back to counting them (same rule bestE1RMForExercise uses),
  // otherwise a session logged entirely as warm-ups would read as zero work.
  eq(sessionTonnage([{ name: "Bench", unit: "lbs", set_details: [{ weight: 135, reps: 5, warmup: true }] }]), 675, "all-warmup entry still counts");

  const top = sessionTopSet([sq, rdl]);
  eq(top.name, "Back Squat", "top set picks the heaviest lift");
  eq(top.weight, 315, "top set reports the working weight");
  eq(top.reps, 5, "top set reports its reps");
  eq(sessionTopSet([]), null, "no exercises → no top set");
  eq(sessionTopSet([{ name: "Plank", unit: "bodyweight", sets: 3, reps: 60 }]), null, "bodyweight-only session → no top set");
  // Reported in the logged unit, compared in lbs — 150kg beats 315lb.
  const mixed = sessionTopSet([sq, { name: "Deadlift", sets: 1, reps: 3, weight: 150, unit: "kg" }]);
  eq(mixed.unit, "kg", "top set keeps the unit it was logged in");
  eq(mixed.name, "Deadlift", "comparison happens in lbs-equivalent");
  // set_details with per-set weights: the heaviest single set wins, not the last.
  const ramp = { name: "Squat", unit: "lbs", set_details: [{ weight: 275, reps: 3 }, { weight: 335, reps: 1 }, { weight: 225, reps: 8 }] };
  eq(sessionTopSet([ramp]).weight, 335, "heaviest set wins, not the last one");
}

// ── implausible-jump guard (T46) ─────────────────────────────────────────────
// Will's rule: a leap too big for even a beginner gets a double check, not a PR
// celebration. Quiet on the moves people actually make, loud on a mistyped load.
console.log("\nimplausible jump:");
{
  // Will's own example — 275 max, suddenly 315.
  eq(implausibleJump(275, 315), true, "275 -> 315 is checked (+14.5%)");
  eq(implausibleJump(275, 305), false, "275 -> 305 is a real PR, left alone (+10.9%)");
  eq(implausibleJump(90, 900), true, "the 900 lb bench typo is caught");

  // Real progress must stay silent, or athletes learn to ignore the question.
  eq(implausibleJump(185, 195), false, "a +10 bench PR is not questioned");
  eq(implausibleJump(315, 330), false, "a +15 squat PR is not questioned");
  eq(implausibleJump(405, 425), false, "a +20 deadlift PR on a big base is not questioned");

  // Light accessory work: percentage swings are huge and meaningless there.
  eq(implausibleJump(25, 30), false, "25 -> 30 lb curls (+20%) stays quiet, under the lb floor");
  eq(implausibleJump(50, 65), false, "50 -> 65 lb stays quiet, baseline below the floor");

  // No baseline to jump from = nothing to compare (the cold-start gap, by design).
  eq(implausibleJump(0, 900), false, "no prior max means no comparison is possible");
  eq(implausibleJump(null, 500), false, "a missing baseline never throws");
  eq(implausibleJump(200, null), false, "a missing new value never throws");

  // Boundary: all three conditions are required.
  eq(implausibleJump(200, 224), true, "exactly +12% trips when the jump also clears 20 lb");
  eq(implausibleJump(200, 222), false, "+11% does not trip");
  eq(implausibleJump(100, 112), false, "+12% but only +12 lb stays quiet: the 20 lb floor also has to clear");
  eq(implausibleJump(64, 200), false, "a baseline under the 65 lb floor never trips");
}

// ── prCheckLines: code-computed PR verdicts for the chat reply (T60, 08-28) ──
// The live failure this guards: a 118 kg snatch single vs a 250 lb (113.4 kg)
// actual max got narrated by the model as "right under" the old max while the
// app stamped NEW MAX for it. Verdicts are computed here, in lbs, and handed to
// the model finished — direction can never flip again.
{
  console.log("prCheckLines:");
  const best = { snatch: { name: "Snatch", e1rm: 250, actual: true }, "bench press": { name: "Bench Press", e1rm: 300 } };
  const willCase = prCheckLines([{ name: "Snatch", sets: 1, reps: 1, weight: 118, unit: "kg" }], best, "kg");
  eq(willCase.length, 1, "one line per weighted lift");
  eq(/NEW PR/.test(willCase[0]) && /118 kg/.test(willCase[0]) && /ABOVE/.test(willCase[0]), true, "118 kg single over a 250 lb actual max is a NEW PR, stated as ABOVE (the live flub)");
  const below = prCheckLines([{ name: "Snatch", sets: 1, reps: 1, weight: 110, unit: "kg" }], best, "kg")[0];
  eq(/no PR/.test(below) && !/NEW PR/.test(below), true, "a single under the best on file is plainly no PR");
  const first = prCheckLines([{ name: "Clean", sets: 1, reps: 1, weight: 125, unit: "kg" }], best, "kg")[0];
  eq(/first record on file/.test(first), true, "an unseen lift reads as a first record, never a comparison");
  const estPr = prCheckLines([{ name: "Bench Press", sets: 5, reps: 5, weight: 275, unit: "lbs" }], best, "lbs")[0];
  eq(/NEW ESTIMATED PR/.test(estPr), true, "rep work whose e1RM beats an estimated best is an estimated PR");
  const estVsActual = prCheckLines([{ name: "Snatch", sets: 3, reps: 3, weight: 108, unit: "kg" }], best, "kg")[0];
  eq(/no PR/.test(estVsActual), true, "an e1RM never outranks an actual 1RM (mirrors finalizeWorkout)");
  const wild = prCheckLines([{ name: "Snatch", sets: 1, reps: 1, weight: 160, unit: "kg" }], best, "kg")[0];
  eq(/implausibly far above/.test(wild) && !/NEW PR/.test(wild), true, "an implausible jump gets the sanity-check verdict, not a celebration");
  eq(prCheckLines([{ name: "Push-ups", sets: 3, reps: 20, unit: "bodyweight" }], best, "lbs").length, 0, "bodyweight/unweighted work emits no verdict");
}

// ── T67: a kg athlete reads kg only (the "340 kg" misread) ────────────────────
{
  const best = { "back squat": { name: "Back Squat", e1rm: 340, actual: true } };
  const l = prCheckLines([{ name: "Back Squat", sets: 5, reps: 3, weight: 145, unit: "kg" }], best, "kg")[0];
  ok(/154\.2 kg actual 1RM/.test(l) && !/340/.test(l) && !/lbs/.test(l), `kg athlete: the lbs max is shown in kg only (got ${l})`);
  const lb = prCheckLines([{ name: "Back Squat", sets: 5, reps: 3, weight: 300, unit: "lbs" }], best, "lbs")[0];
  ok(/340 lbs actual 1RM/.test(lb) && !/kg/.test(lb), "lbs athlete: unchanged, lbs only");
  eq(JSON.stringify(knownMaxLines([{ name: "Back Squat", e1rm: 340, actual: true }, { name: "Curls", e1rm: 47.3 }], "kg")), JSON.stringify(["Back Squat: 154.2 kg (actual 1RM)", "Curls: ~21.5 kg (est.)"]), "KNOWN 1RMs in kg for a kg athlete");
  eq(JSON.stringify(knownMaxLines([{ name: "Back Squat", e1rm: 340, actual: true }, { name: "Curls", e1rm: 47.3 }], "lbs")), JSON.stringify(["Back Squat: 340 lbs (actual 1RM)", "Curls: ~47 lbs (est.)"]), "KNOWN 1RMs for lbs athletes: the old lines, byte for byte");
}

if (fail) { console.error(`\n${fail} FAILURE(S) (${pass} passed)`); process.exit(1); }
console.log(`\nAll ${pass} grit-math checks pass.`);
