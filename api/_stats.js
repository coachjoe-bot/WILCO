// ─── T70 STATS — server refresh of athlete_stats ─────────────────────────────
// Recomputes one athlete's summary row from their raw workouts (src/stats.js,
// the same math the client could run, so there is no second copy) and upserts
// it. Called best-effort after every workouts write in api/data.js and in bulk by
// the nightly rebuild (api/stats-rebuild.js). Never throws into a request: a
// failed refresh logs and the next write or the nightly pass fixes it.
//
// Underscore-prefixed: Vercel does not route this as its own function.

import { sbSelect, sbWrite } from "./_supa.js";
import { computeAthleteStats, STATS_VERSION } from "../src/stats.js";

const enc = encodeURIComponent;
const PAGE = 1000;        // PostgREST server max-rows; unbounded selects truncate here
const MAX_ROWS = 50000;   // same ceiling the coach dashboard pager uses
const WO_COLS = "id,athlete_id,created_at,parsed_data,duration_seconds";

async function allWorkouts(athleteId) {
  const rows = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const page = await sbSelect("workouts", `?athlete_id=eq.${enc(athleteId)}&select=${WO_COLS}&order=created_at.asc,id.asc&limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

// Compute without writing — the truth script compares this against the stored row.
export async function computeForAthlete(athleteId, athleteRow = null) {
  const athlete = athleteRow || (await sbSelect("athletes", `?id=eq.${enc(athleteId)}&select=id,weight_lbs,proof_timezone`))[0];
  if (!athlete) return null;
  const workouts = await allWorkouts(athleteId);
  const stats = computeAthleteStats(workouts, { bodyweightLbs: Number(athlete.weight_lbs) || 0, tz: athlete.proof_timezone || null });
  return { athlete, workouts, stats };
}

export async function refreshAthleteStats(athleteId, athleteRow = null) {
  const r = await computeForAthlete(athleteId, athleteRow);
  if (!r) return null;
  await sbWrite({
    method: "POST", table: "athlete_stats", query: "?on_conflict=athlete_id",
    body: { athlete_id: athleteId, version: STATS_VERSION, source_rows: r.stats.source_rows, stats: r.stats, computed_at: new Date().toISOString() },
    prefer: "resolution=merge-duplicates,return=minimal",
  });
  return r.stats;
}

// Fire-and-forget wrapper for the request path. Dedupes ids, swallows errors.
export async function refreshMany(athleteIds) {
  const ids = [...new Set((athleteIds || []).filter(Boolean).map(String))];
  for (const id of ids) {
    try { await refreshAthleteStats(id); }
    catch (e) { console.error("[stats] refresh failed for", id, e.message); }
  }
  return ids.length;
}

// Nightly: every athlete whose row is missing, stale (older version), or behind
// the workouts table (count or newest row). Time-budgeted so a cron can never
// run past its maxDuration; whatever is left waits for the next night.
export async function rebuildStale({ budgetMs = 240000, force = false } = {}) {
  const started = Date.now();
  const athletes = await sbSelect("athletes", "?select=id,weight_lbs,proof_timezone&order=created_at.asc&limit=10000");
  const existing = await sbSelect("athlete_stats", "?select=athlete_id,version,source_rows,computed_at&limit=10000");
  const byId = new Map(existing.map((r) => [r.athlete_id, r]));
  // One query for the live truth about each athlete's workouts.
  const counts = await sbSelect("v_athlete_workout_counts", "?select=athlete_id,workout_rows,newest_at&limit=10000").catch(() => null);
  const live = counts ? new Map(counts.map((c) => [c.athlete_id, c])) : null;
  let refreshed = 0, skipped = 0, failed = 0, remaining = 0;
  for (const a of athletes) {
    if (Date.now() - started > budgetMs) { remaining++; continue; }
    const cur = byId.get(a.id);
    const l = live ? live.get(a.id) : null;
    const stale = force || !cur || cur.version !== STATS_VERSION
      || (l ? (cur.source_rows !== Number(l.workout_rows) || (l.newest_at && new Date(l.newest_at) > new Date(cur.computed_at))) : true);
    if (!stale) { skipped++; continue; }
    try { await refreshAthleteStats(a.id, a); refreshed++; }
    catch (e) { failed++; console.error("[stats] rebuild failed for", a.id, e.message); }
  }
  return { athletes: athletes.length, refreshed, skipped, failed, remaining, ms: Date.now() - started };
}
