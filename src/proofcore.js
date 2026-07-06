// ─── PROOF CORE — shared deterministic brief + adherence math ─────────────────
// The crypto-free, network-free, AI-free deterministic core of the Proof Feed
// engine. Extracted from api/_proof.js so BOTH the server (digest generation) and
// the client (coach dashboard Overview + briefing) compute the exact same numbers
// from the exact same code — no drift, zero tokens.
//
// Split rule (mirrors the src/grit.js ↔ api/_grit.js pattern):
//   • This file (src/) is the SOURCE OF TRUTH — pure functions, no `node:crypto`,
//     no `askClaudeServer`, no DB writes, no prompt strings.
//   • api/_proofcore.js is a one-line `export *` re-export for server callers.
//   • api/_proof.js imports from here and keeps ONLY the AI + crypto layer
//     (hashProgram, parseProgramIfNeeded, generate*), re-exporting these names so
//     existing importers (api/trigger-proof-feed.js) are unaffected.
//
// NOTE on session grouping: this `groupIntoSessions` takes ONE athlete's workouts
// and returns groups of raw workout rows (`[[w, …], …]`). The client's App.jsx has
// a DIFFERENT, multi-athlete `groupIntoSessions` returning `[{entries, athleteId}]`
// — they are intentionally distinct helpers. Use this one for per-athlete brief
// math; do not conflate the two.

import { epley1RM, computeGritSnapshot, TIER_NAMES, getBenchKey } from "./grit.js";

// ── parsed_data access ────────────────────────────────────────────────────────
export const getPD = (w) => {
  if (typeof w.parsed_data === "string") {
    try { return JSON.parse(w.parsed_data); } catch { return {}; }
  }
  return w.parsed_data || {};
};

export const isRealSession = (w) => {
  const pd = getPD(w);
  return pd.exercises?.length > 0 || !!pd.run_data;
};

// ── session grouping (3h gap; respect new_session) — SINGLE athlete in ─────────
const GAP_MS = 3 * 60 * 60 * 1000;
export const groupIntoSessions = (workouts) => {
  const real = workouts.filter(isRealSession)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const groups = [];
  let cur = null, lastTime = 0;
  real.forEach((w) => {
    const t = new Date(w.created_at).getTime();
    const pd = getPD(w);
    if (!lastTime || pd.new_session === true || t - lastTime > GAP_MS) {
      cur = [w]; groups.push(cur);
    } else {
      cur.push(w);
    }
    lastTime = t;
  });
  return groups;
};

// Re-exported for any importer that expects it from here (and from api/_proof.js,
// which re-exports this module).
export { epley1RM };

const toLbs = (w, unit) => (unit === "kg" ? w * 2.205 : w);

// Working sets of a logged exercise: prefer set_details (excluding warm-ups), else the
// flat sets/reps/weight. Mirrors the client so the digest, plateau flags, volume, and
// the Progress screen all agree — and so warm-ups never inflate e1RM or working volume.
const workingSets = (ex) => {
  if (Array.isArray(ex.set_details) && ex.set_details.length) {
    const w = ex.set_details.filter((s) => !s.warmup);
    const use = w.length ? w : ex.set_details;
    return use.map((s) => ({ weight: s.weight ?? ex.weight ?? 0, reps: s.reps ?? ex.reps ?? 1 }));
  }
  const n = ex.sets || 1;
  return Array.from({ length: n }, () => ({ weight: ex.weight ?? 0, reps: ex.reps || 1 }));
};

// ── per-lift est-1RM history across a set of sessions ─────────────────────────
// e1RM is plain Epley over working sets (matches the client) — RPE/RIR never bump it.
export const buildLiftHistory = (sessions) => {
  const byLift = {};
  for (const group of sessions) {
    const date = group[0].created_at;
    const exercises = group.flatMap((e) => getPD(e).exercises || []);
    for (const ex of exercises) {
      if (!ex.name || !ex.weight || ex.unit === "bodyweight") continue;
      const sets = workingSets(ex);
      let e1rm = 0, top = { weight: ex.weight, reps: ex.reps || 1 };
      for (const s of sets) {
        const e = epley1RM(toLbs(s.weight, ex.unit), s.reps);
        if (e > e1rm) { e1rm = e; top = s; }
      }
      const k = ex.name.toLowerCase().trim();
      if (!byLift[k]) byLift[k] = [];
      byLift[k].push({ date, e1rm, weight: top.weight, reps: top.reps || 1, sets: sets.length });
    }
  }
  return byLift;
};

export const detectPlateaus = (liftHistory) => {
  const flagged = [];
  for (const [lift, entries] of Object.entries(liftHistory)) {
    if (entries.length < 3) continue;
    const last3 = entries.slice(-3).map((e) => e.e1rm);
    if (Math.max(...last3) - Math.min(...last3) <= 2.5) flagged.push(lift);
  }
  return flagged;
};

// ── fuzzy lift-name match ─────────────────────────────────────────────────────
const normLift = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
const liftsMatch = (a, b) => {
  const x = normLift(a), y = normLift(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
};

// ── injuries: aggregate pain flags across a window ────────────────────────────
export const aggregateInjuries = (sessions, resolved = []) => {
  const resolvedSet = new Set((resolved || []).map((r) => String(r).toLowerCase()));
  const counts = {};
  for (const g of sessions) {
    const flags = g.flatMap((e) => getPD(e).pain_flags || []);
    for (const f of flags) {
      const area = String(f.area || "").toLowerCase();
      if (!area || resolvedSet.has(area)) continue;
      counts[area] = (counts[area] || 0) + 1;
    }
  }
  const recurring = Object.entries(counts).filter(([, n]) => n >= 2).map(([area, count]) => ({ area, count }));
  const active = Object.keys(counts); // anything flagged in the window
  return { active, recurring, counts };
};

// ── Grit rank movement (v3 enrichment) ────────────────────────────────────────
// Computes the athlete's CURRENT Grit snapshot (rank/Strength Score/PRs) and diffs
// it against the snapshot as of the athlete's LAST feed entry, using the SAME
// computeGritSnapshot the client's Progress screen uses — stateless: no new table,
// just recomputed twice off a date filter. `allWorkouts`/`allManualRMs` should be
// the athlete's FULL history so the "before" snapshot reflects everything known as
// of that date.
export function computeRankMovement(allWorkouts, allManualRMs, athlete, previousEntryAt) {
  const opts = {
    bodyweightLbs: athlete.weight_lbs || athlete.weight || 0,
    gender: athlete.gender,
    age: athlete.age ?? (athlete.birthday ? Math.floor((Date.now() - new Date(athlete.birthday)) / (365.25 * 24 * 3600 * 1000)) : null),
  };
  const now = computeGritSnapshot(allWorkouts, allManualRMs, opts);
  if (!previousEntryAt) {
    // No prior entry to diff against (first-ever digest) — report the snapshot with
    // no deltas rather than fabricate a "before" state.
    return { now, before: null, rankUp: false, strengthScoreDelta: null, newRankedPRs: [] };
  }
  const cutoff = new Date(previousEntryAt).getTime();
  const priorWorkouts = (allWorkouts || []).filter((w) => new Date(w.created_at).getTime() < cutoff);
  const priorManual = allManualRMs; // manual 1RMs carry no timestamp in this schema; treated as already-known (conservative — never OVER-credits a "new" PR)
  const before = computeGritSnapshot(priorWorkouts, priorManual, opts);

  const beforeByKey = Object.fromEntries(before.rankedLifts.map((b) => [b.benchKey, b]));
  const newRankedPRs = now.rankedLifts.filter((b) => {
    const prior = beforeByKey[b.benchKey];
    return !prior || b.e1rm > prior.e1rm + 0.5;
  }).map((b) => ({ name: b.name, benchKey: b.benchKey, e1rm: b.e1rm, tierIdx: b.tierIdx, tierName: TIER_NAMES[b.tierIdx] }));

  return {
    now, before,
    rankUp: now.topTierIdx > before.topTierIdx,
    strengthScoreDelta: now.strengthScore - before.strengthScore,
    newRankedPRs,
  };
}

// ─── PROGRAM ADHERENCE ────────────────────────────────────────────────────────
// Which block/week are we in right now? Best-effort from block start dates; falls
// back to block 0 / week 0 when the program gives no dates.
const resolveCurrentBlockWeek = (parsed) => {
  const blocks = parsed?.blocks || [];
  const now = Date.now();
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (!b.start) continue;
    const start = new Date(b.start).getTime();
    if (Number.isNaN(start)) continue;
    const weeks = b.weeks || 1;
    const end = start + weeks * 7 * 24 * 3600 * 1000;
    if (now >= start && now < end) {
      return { block: b, weekIndex: Math.min(weeks - 1, Math.floor((now - start) / (7 * 24 * 3600 * 1000))) };
    }
  }
  return { block: blocks[0] || null, weekIndex: 0 };
};

// Compare this week's logged work to the prescription. Emits per-lift load + a
// rolled-up VOLUME gap % (set/rep shortfall) — the spec's headline metric (§6/§8).
export function compareProgramVsActual(parsed, thisWeekSessions, oneRMs = {}) {
  if (!parsed || !Array.isArray(parsed.blocks)) return null;
  const { block, weekIndex } = resolveCurrentBlockWeek(parsed);
  if (!block) return null;

  // Prescribed working volume per lift this block (sum across the week's days).
  const prescribed = {}; // lift -> {sets, reps, pct, refLift}
  for (const day of block.days || []) {
    for (const ex of day.exercises || []) {
      if (!ex.name) continue;
      const k = ex.name.toLowerCase().trim();
      const pct = Array.isArray(ex.pct_by_week) && ex.pct_by_week.length
        ? (ex.pct_by_week[weekIndex] ?? ex.pct_by_week[ex.pct_by_week.length - 1])
        : null;
      if (!prescribed[k]) prescribed[k] = { name: ex.name, sets: 0, reps: ex.reps || 0, pct, refLift: ex.ref_1rm_lift || ex.name };
      prescribed[k].sets += ex.sets || 0;
      if (ex.reps) prescribed[k].reps = ex.reps;
    }
  }

  // Actual working volume per lift this week (sum sets, top est-1RM, top load).
  const actual = {}; // normLift -> {sets, reps, topLoad}
  const hist = buildLiftHistory(thisWeekSessions);
  for (const [lift, entries] of Object.entries(hist)) {
    let sets = 0, reps = 0, topLoad = 0;
    for (const e of entries) { sets += e.sets || 1; reps = Math.max(reps, e.reps || 0); topLoad = Math.max(topLoad, toLbs(e.weight, "lbs")); }
    actual[lift] = { sets, reps, topLoad };
  }

  const byLift = [];
  let presVol = 0, actVol = 0;
  for (const p of Object.values(prescribed)) {
    if (!p.sets) continue;
    const match = Object.entries(actual).find(([name]) => liftsMatch(name, p.name));
    const a = match ? match[1] : { sets: 0, reps: 0, topLoad: 0 };
    const pVol = p.sets * (p.reps || 1);
    const aVol = a.sets * (a.reps || (p.reps || 1));
    presVol += pVol; actVol += aVol;
    const ref1rm = oneRMs[p.refLift?.toLowerCase()?.trim()] || oneRMs[p.name.toLowerCase().trim()] || null;
    const prescribedLoad = ref1rm && p.pct ? Math.round(ref1rm * p.pct / 100) : null;
    byLift.push({
      lift: p.name,
      prescribedSets: p.sets, prescribedReps: p.reps,
      actualSets: a.sets, actualReps: a.reps,
      prescribedLoad, actualLoad: a.topLoad || null,
      volumeGapPct: pVol ? Math.max(0, Math.round((pVol - aVol) / pVol * 100)) : 0,
    });
  }
  const rolledGapPct = presVol ? Math.max(0, Math.round((presVol - actVol) / presVol * 100)) : 0;
  return {
    blockName: block.name || null,
    weekIndex,
    byLift: byLift.sort((a, b) => b.volumeGapPct - a.volumeGapPct),
    rolledGapPct,
    material: rolledGapPct >= 15,   // spec: "material" volume gap → headline section
  };
}

// ── known 1RMs from prs + manual_one_rms (lbs) ────────────────────────────────
export const buildOneRMs = (prs = [], manual = []) => {
  const map = {};
  for (const p of prs) {
    const k = String(p.exercise || "").toLowerCase().trim();
    if (!k) continue;
    const v = p.estimated_1rm || epley1RM(toLbs(p.weight, p.unit), p.reps || 1);
    if (v && (!map[k] || v > map[k])) map[k] = v;
  }
  for (const m of manual) {
    const k = String(m.exercise || m.lift || "").toLowerCase().trim();
    if (!k) continue;
    const v = toLbs(m.weight, m.unit);
    if (v && (!map[k] || v > map[k])) map[k] = v;
  }
  return map;
};

// ── total working-set volume for a set of sessions (program-agnostic) ─────────
// Unlike compareProgramVsActual (which needs a parsed structured program),
// this is a simple raw-count so EVERY athlete gets a week-over-week volume
// comparison, program or not: total working sets logged across all lifts.
export function totalSetVolume(sessions) {
  let sets = 0;
  for (const group of sessions) {
    for (const w of group) {
      const exercises = getPD(w).exercises || [];
      for (const ex of exercises) sets += workingSets(ex).length;
    }
  }
  return sets;
}

// ── pain-flag trend: is it worsening, steady, or clearing vs last window? ─────
// Compares raw flag COUNTS (not just distinct areas) between this week and last —
// e.g. the same shoulder flagged 3x this week vs 1x last week reads as worsening.
export function painTrend(thisWeekSessions, lastWeekSessions, resolved = []) {
  const thisWk = aggregateInjuries(thisWeekSessions, resolved);
  const lastWk = aggregateInjuries(lastWeekSessions, resolved);
  const thisTotal = Object.values(thisWk.counts).reduce((a, b) => a + b, 0);
  const lastTotal = Object.values(lastWk.counts).reduce((a, b) => a + b, 0);
  let direction = "steady";
  if (thisTotal === 0 && lastTotal > 0) direction = "clearing";
  else if (thisTotal > lastTotal) direction = "worsening";
  else if (thisTotal < lastTotal && thisTotal > 0) direction = "improving";
  return { thisWeekFlags: thisTotal, lastWeekFlags: lastTotal, direction, recurring: thisWk.recurring };
}

// ─── THE BRIEF (§5) ───────────────────────────────────────────────────────────
// Pure-code summary handed to Sonnet (server) or rendered on the coach dashboard
// (client). Compact (a few KB), no raw workout JSON.
export function buildBrief({ athlete, thisWeekSessions, lastWeekSessions, monthSessions, prs, goals, adherence, injuries, windowType, rank, painTrendData }) {
  const thisWeekLifts = buildLiftHistory(thisWeekSessions);
  const lastWeekLifts = buildLiftHistory(lastWeekSessions);

  const lifts = [];
  for (const [lift, entries] of Object.entries(thisWeekLifts)) {
    const best = entries.reduce((a, b) => (b.e1rm > a.e1rm ? b : a));
    const lw = lastWeekLifts[lift];
    let delta = null;
    if (lw) { const lb = lw.reduce((a, b) => (b.e1rm > a.e1rm ? b : a)); delta = best.e1rm - lb.e1rm; }
    lifts.push({ lift, topWeight: best.weight, e1rm: best.e1rm, deltaVsLastWeek: delta });
  }

  const allHist = buildLiftHistory([...lastWeekSessions, ...thisWeekSessions]);
  const plateaus = detectPlateaus(allHist);

  // recent PRs (in the window)
  const windowStart = (windowType === "monthly" ? 28 : 7) * 24 * 3600 * 1000;
  const cutoff = Date.now() - windowStart;
  const recentPRs = (prs || []).filter((p) => p.date && new Date(p.date).getTime() >= cutoff)
    .map((p) => ({ exercise: p.exercise, weight: p.weight, reps: p.reps, e1rm: p.estimated_1rm }));

  const goalLines = (goals || []).slice(0, 4).map((g) => ({
    goal: g.goal_text, target_metric: g.target_metric, target_value: g.target_value, target_date: g.target_date,
  }));

  const thisWeekVolume = totalSetVolume(thisWeekSessions);
  const lastWeekVolume = totalSetVolume(lastWeekSessions);

  return {
    identity: {
      name: athlete.name,
      sport: athlete.sport || null,
      archetype: athleteArchetype(athlete),
      bodyweight: athlete.weight || athlete.weight_lbs || null,
    },
    window: windowType,
    sessions: {
      thisWeek: thisWeekSessions.length,
      lastWeek: lastWeekSessions.length,
      thisMonth: monthSessions.length,
      programDaysPerWeek: athlete.training_days_per_week || null,
    },
    volumeTrend: {
      thisWeekSets: thisWeekVolume,
      lastWeekSets: lastWeekVolume,
      deltaSets: thisWeekVolume - lastWeekVolume,
    },
    lifts,
    plateaus,
    prs: recentPRs,
    goals: goalLines,
    injuries,
    painTrend: painTrendData || null,   // null when there's no window to compare (e.g. never logged pain)
    rank: rank || null,                 // Grit rank movement (null if not computed — e.g. no bodyweight on file)
    volume: adherence,                 // null if no structured program
    onTempProgram: !!athlete.temp_program_text,
  };
}

// Adapt to athlete type from populated fields (spec §1 archetype row).
export function athleteArchetype(a) {
  if (a.afsc || a.pt_scores || a.waist_inches || a.rank) return "military";
  if (a.graduation_year || a.recruiting_intent || a.position_or_event) return "highschool";
  return "strength";
}

// ─── THE COACH'S EDITION — team brief (§ coach-experience-vision Reports) ──────
// The team-level analogue of buildBrief: takes the coach's roster (each athlete's
// per-athlete brief + adherence + Grit snapshot, already computed) and rolls it up
// into ONE team read — grouped signals with the specific names that matter as
// call-outs. Feeds the enriched generateCoach prose AND the coach question bank.
// Pure/deterministic (zero tokens); the AI only turns these numbers into voice.
//
// `perAthlete`: [{ athlete, brief, adherence, snap, score, hasProgram }]
//   • brief      = buildBrief(...) output (sessions, lifts w/ deltaVsLastWeek, prs,
//                  injuries{active,recurring}, volumeTrend)
//   • adherence  = compareProgramVsActual(...) | null
//   • snap       = computeGritSnapshot(...) { rankedLifts:[{name,benchKey,tierIdx}], … }
//   • score      = blended adherence 0-100 | null (no program)
const firstNameLast = (name) => {
  const parts = String(name || "").trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || "Athlete";
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
};

// e1RM of a PR row, best-effort (stored estimate, else Epley on weight×reps).
export const prE1RM = (p) => p.estimated_1rm || epley1RM(toLbs(p.weight, p.unit), p.reps || 1) || 0;

// A "true PR" = an improvement over the athlete's OWN prior best on that exercise —
// never the first-ever log (baseline). Computed on the fly from prs rows so the
// count is honest even before the is_baseline column lands. Shared by the server
// team brief and the client Overview so both agree.
export function trueImprovementPRs(prsRows) {
  const byKey = {};
  const sorted = [...(prsRows || [])].sort((a, b) => new Date(a.created_at || a.date || 0) - new Date(b.created_at || b.date || 0));
  const out = [];
  for (const p of sorted) {
    const k = `${p.athlete_id}|${String(p.exercise || "").toLowerCase().trim()}`;
    const e = prE1RM(p);
    if (byKey[k] == null) { byKey[k] = e; continue; }   // first-ever on this lift = baseline, skip
    if (e > byKey[k] + 0.5) { out.push({ ...p, gain: e - byKey[k] }); byKey[k] = e; }
  }
  return out;
}

// Split ranked benchmarks (each {avgTier 0-7, …}, sorted desc) into strengths &
// weaknesses by TIER THRESHOLD, with fallbacks so a mid team still gets both.
// Shared by the server team brief and the client Overview so they never disagree.
export function classifyTiers(benchAgg) {
  let strengths = benchAgg.filter((x) => x.avgTier >= 4).slice(0, 3);              // Elite+
  let weaknesses = benchAgg.filter((x) => x.avgTier <= 2).sort((a, b) => a.avgTier - b.avgTier).slice(0, 3); // Sharp or below
  if (!strengths.length) strengths = benchAgg.slice(0, Math.min(2, benchAgg.length));
  if (!weaknesses.length) weaknesses = benchAgg.slice().reverse().filter((w) => !strengths.includes(w)).slice(0, 2);
  return { strengths, weaknesses };
}

// Blended adherence score (0-100) or null when there's no program to grade against.
// Half "did they show up" (sessions vs prescribed days), half the proofcore volume
// gap. Shared by the server team brief and the client Overview so both agree.
export function blendAdherenceScore(thisWeekCount, adherence, hasProgram, presDays) {
  const showUp = presDays ? Math.min(1, thisWeekCount / presDays) : (thisWeekCount > 0 ? 1 : 0);
  const vol = adherence ? Math.max(0, 1 - adherence.rolledGapPct / 100) : null;
  if (vol != null) return Math.round(100 * (0.5 * showUp + 0.5 * vol));
  return hasProgram ? Math.round(100 * showUp) : null;
}

export function buildCoachTeamBrief(perAthlete) {
  const rows = perAthlete.filter((r) => r && r.athlete && r.brief);
  const n = rows.length;
  const nm = (a) => firstNameLast(a.name);

  // ── attendance & adherence ──
  const active = rows.filter((r) => r.brief.sessions.thisWeek > 0);
  const totalSessions = rows.reduce((s, r) => s + r.brief.sessions.thisWeek, 0);
  const scored = rows.filter((r) => r.score != null);
  const adherenceAvg = scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : null;
  const noProgram = rows.filter((r) => r.score == null).length;

  // ── strength movement: avg est-1RM delta per lift across the roster ──
  const deltaByLift = {};
  for (const r of rows) {
    for (const l of r.brief.lifts || []) {
      if (l.deltaVsLastWeek != null) (deltaByLift[l.lift] = deltaByLift[l.lift] || []).push(l.deltaVsLastWeek);
    }
  }
  const strengthMovement = Object.entries(deltaByLift)
    .map(([lift, ds]) => ({ lift, avgDelta: +(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(1), n: ds.length }))
    .sort((a, b) => Math.abs(b.avgDelta) - Math.abs(a.avgDelta)).slice(0, 5);

  // ── program strengths & weaknesses: avg Grit tier per benchmark lift ──
  const byBench = {};
  for (const r of rows) {
    for (const l of (r.snap?.rankedLifts || [])) {
      const bk = getBenchKey(l.key) || l.benchKey;
      if (!bk) continue;
      (byBench[bk] = byBench[bk] || { name: l.name, tiers: [] }).tiers.push(l.tierIdx);
    }
  }
  const benchAgg = Object.entries(byBench)
    .map(([bench, v]) => ({ bench, name: v.name, avgTier: v.tiers.reduce((a, b) => a + b, 0) / v.tiers.length, tierName: TIER_NAMES[Math.round(v.tiers.reduce((a, b) => a + b, 0) / v.tiers.length)], n: v.tiers.length }))
    .filter((x) => x.n >= 2)   // only benchmarks the TEAM has (not a lone athlete)
    .sort((a, b) => b.avgTier - a.avgTier);
  // Threshold, not blind top/bottom split: an ELITE-avg lift is a strength, a
  // SHARP-or-below lift is a weakness. With few ranked lifts, a naive top-3 would
  // mislabel the roster's WEAKEST lift as a "strength." Tiers: 0 Rookie … 4 Elite.
  const { strengths, weaknesses } = classifyTiers(benchAgg);

  // ── notable TRUE PRs (improvement over prior best; baselines excluded) ──
  // Prefer r.truePRs (windowed, computed in the enrich step); fall back to computing
  // from r.prs, then to the brief's recent-PR list for older callers.
  const notablePRs = [];
  let newPRs = 0;
  for (const r of rows) {
    const tps = r.truePRs || (r.prs ? trueImprovementPRs(r.prs) : (r.brief.prs || []));
    newPRs += tps.length;
    tps.slice(0, 2).forEach((p) => notablePRs.push({ athlete: nm(r.athlete), exercise: p.exercise, weight: p.weight, reps: p.reps, e1rm: p.e1rm ?? prE1RM(p), gain: p.gain != null ? Math.round(p.gain) : null }));
  }
  notablePRs.sort((a, b) => (b.gain || 0) - (a.gain || 0) || (b.e1rm || 0) - (a.e1rm || 0));

  // ── injury clusters (team pattern) + sharpest individual (named call-out) ──
  const areaCount = {};
  const sharp = []; // athletes with a recurring (2+) active area this window
  for (const r of rows) {
    const rec = r.brief.injuries?.recurring || [];
    for (const area of (r.brief.injuries?.active || [])) areaCount[area] = (areaCount[area] || 0) + 1;
    if (rec.length) sharp.push({ athlete: nm(r.athlete), area: rec[0].area, count: rec[0].count });
  }
  const injuryClusters = Object.entries(areaCount).map(([area, count]) => ({ area, count })).filter((x) => x.count >= 2).sort((a, b) => b.count - a.count);
  sharp.sort((a, b) => b.count - a.count);

  // ── the drift: quiet (no session this week) + adherence strugglers ──
  const quiet = rows.filter((r) => r.brief.sessions.thisWeek === 0)
    .map((r) => ({ athlete: nm(r.athlete), lastWeek: r.brief.sessions.lastWeek }));
  const strugglers = rows.filter((r) => r.score != null && r.score < 55)
    .map((r) => ({ athlete: nm(r.athlete), score: r.score }))
    .sort((a, b) => a.score - b.score);

  // ── team volume trend (raw working-set totals, this week vs last) ──
  const volThis = rows.reduce((s, r) => s + (r.brief.volumeTrend?.thisWeekSets || 0), 0);
  const volLast = rows.reduce((s, r) => s + (r.brief.volumeTrend?.lastWeekSets || 0), 0);

  return {
    n, active: active.length, activePct: n ? Math.round(100 * active.length / n) : 0,
    totalSessions, avgSessions: n ? +(totalSessions / n).toFixed(1) : 0,
    adherenceAvg, noProgram,
    strengthMovement, strengths, weaknesses,
    newPRs, notablePRs: notablePRs.slice(0, 6),
    injuryClusters, sharpInjuries: sharp.slice(0, 4),
    quiet, strugglers: strugglers.slice(0, 5),
    volumeTrend: { thisWeekSets: volThis, lastWeekSets: volLast, deltaSets: volThis - volLast },
  };
}

// ─── COACH QUESTION BANK — the "calls & context" loop (mirror of the athlete's) ─
// Two kinds, in order:
//   • CALLS — decisions the coach taps Apply/Skip/Edit on (or a soft suggestion
//     when there's nothing to send, since the app has no messaging).
//   • CONTEXT — questions that gather the team read the logs can't show (season
//     phase, block goal, fatigue, per-athlete notes) → persisted to coach_context
//     so next week's edition is written against it.
// Deterministic, ranked, hard stop. `kind` tells the client how to act/persist.
export function buildCoachQuestionBank(team) {
  const q = [];

  // 1. Program weakness → offer to draft an emphasis (a "call")
  const weak = (team.weaknesses || []).filter((w) => w.avgTier <= 2); // Rookie/Gritty/Sharp-ish
  if (weak.length) {
    const names = weak.map((w) => w.name);
    q.push({
      id: "program_focus", kind: "program_focus", deeper: false, action: true,
      meta: { lifts: names, benches: weak.map((w) => w.bench) },
      text: `${names.length > 1 ? `${names.slice(0, 2).join(" and ")} are` : `${names[0]} is`} the roster's weak spot (${weak[0].tierName.toLowerCase()} team average). Want to prioritize ${names.length > 1 ? "that work" : names[0].toLowerCase()} in the next block?`,
    });
  }

  // 2. Sharpest injury → offer a protective change for that named athlete (a "call")
  const inj = (team.sharpInjuries || [])[0];
  if (inj) {
    q.push({
      id: "injury_apply", kind: "injury_apply", deeper: false, action: true,
      meta: { athlete: inj.athlete, area: inj.area },
      text: `${inj.athlete}'s ${inj.area} flagged ${inj.count} sessions running. Deload or adjust their work this week?`,
    });
  }

  // 3. The drift → a SUGGESTION to reach out (no messaging; coach's own time)
  const drifting = [...(team.quiet || []).map((x) => x.athlete), ...(team.strugglers || []).map((x) => x.athlete)];
  const uniqDrift = [...new Set(drifting)].slice(0, 3);
  if (uniqDrift.length) {
    q.push({
      id: "reach_out", kind: "reach_out", deeper: false, action: false, // suggestion, not an action
      meta: { names: uniqDrift },
      text: `${uniqDrift.length > 1 ? `${uniqDrift.slice(0, -1).join(", ")} and ${uniqDrift.slice(-1)} are` : `${uniqDrift[0]} is`} slipping off the plan. Might be worth a word when you get the chance — no messages get sent, just a nudge for you.`,
    });
  }

  // ── CONTEXT: help the AI read the room (→ coach_context) ──
  q.push({ id: "season", kind: "season", deeper: false, context: true,
    options: ["Off-season", "Pre-season", "In-season", "Post-season"],
    text: `Where are you in the season right now?` });
  q.push({ id: "block_goal", kind: "context_text", deeper: false, context: true,
    text: `What's the main goal for this block?` });
  q.push({ id: "team_response", kind: "team_response", deeper: false, context: true,
    options: ["Fresh, ready for more", "Holding up well", "Getting tired", "Beat up"],
    text: `How are they responding to the current program — fresh, holding up, or running down?` });
  q.push({ id: "athlete_notes", kind: "context_text", deeper: true, context: true,
    text: `Anything about specific athletes I should keep in mind next week?` });

  return q;
}
