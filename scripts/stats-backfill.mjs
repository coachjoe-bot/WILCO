// T70 Stats backfill + truth check against prod.
//   node --env-file=.env scripts/stats-backfill.mjs            # truth: recompute every athlete, compare with the stored row, write nothing
//   node --env-file=.env scripts/stats-backfill.mjs --write    # backfill: recompute and upsert every athlete
//   node --env-file=.env scripts/stats-backfill.mjs --athlete <uuid> [--write] [--dump]
//
// "Truth" means: the stored athlete_stats row equals a fresh compute from the raw
// workouts rows, field for field (lifetime block, day count, lift count, and the
// top lift's numbers). Any mismatch is printed; the exit code is non-zero.
// Also prints the lifetime block for every athlete so the before-table in
// outputs/T70-stats can be filled from one run.

import { computeForAthlete, refreshAthleteStats } from "../api/_stats.js";
import { sbSelect } from "../api/_supa.js";
import { statsInRange, tonnageComparison } from "../src/stats.js";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const DUMP = args.includes("--dump");
const ONE = args.includes("--athlete") ? args[args.indexOf("--athlete") + 1] : null;
const enc = encodeURIComponent;

const athletes = ONE
  ? await sbSelect("athletes", `?id=eq.${enc(ONE)}&select=id,name,weight_lbs,proof_timezone`)
  : await sbSelect("athletes", "?select=id,name,weight_lbs,proof_timezone&order=created_at.asc&limit=10000");
const stored = new Map((await sbSelect("athlete_stats", "?select=athlete_id,version,source_rows,stats&limit=10000")).map((r) => [r.athlete_id, r]));

// jsonb stores object keys in its own order, so compare on a key-sorted encoding.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x);
const pick = (s) => ({ ...s.lifetime, days: s.days.length, lifts: s.lifts.length, top: s.lifts[0] ? { name: s.lifts[0].name, sets: s.lifts[0].sets, tonnage: s.lifts[0].tonnage, e1rm: s.lifts[0].e1rm } : null, source_rows: s.source_rows });

let mismatches = 0, written = 0, missing = 0;
console.log(`athlete | rows | sessions | sets | reps | lb moved | PRs | first | streak(longest/current) | top lift | ${WRITE ? "written" : "stored row"}`);
for (const a of athletes) {
  const r = await computeForAthlete(a.id, a);
  if (!r) continue;
  const fresh = r.stats;
  const f = pick(fresh);
  let status;
  if (WRITE) { await refreshAthleteStats(a.id, a); written++; status = "written"; }
  else {
    const cur = stored.get(a.id);
    if (!cur) { missing++; status = "MISSING"; }
    else {
      const c = pick(cur.stats);
      const diff = Object.keys(f).filter((k) => canon(f[k]) !== canon(c[k]));
      if (diff.length) { mismatches++; status = `MISMATCH ${diff.join(",")}`; } else status = "match";
    }
  }
  const L = fresh.lifetime;
  console.log(`${(a.name || a.id).slice(0, 18).padEnd(18)} | ${String(fresh.source_rows).padStart(4)} | ${String(L.sessions).padStart(4)} | ${String(L.sets).padStart(5)} | ${String(L.reps).padStart(6)} | ${String(L.tonnage).padStart(9)} | ${String(L.prs).padStart(3)} | ${L.first_day || "-"} | ${L.longest_streak_weeks}/${L.current_streak_weeks} | ${(f.top ? `${f.top.name} ${f.top.sets}s` : "-").slice(0, 24).padEnd(24)} | ${status}`);
  if (DUMP) {
    console.log(JSON.stringify({ lifetime: L, months: fresh.months, lifts: fresh.lifts.slice(0, 5).map(({ days, ...x }) => x) }, null, 1));
    for (const range of ["1M", "3M", "1Y", "ALL"]) {
      const v = statsInRange(fresh, range);
      console.log(range, { sessions: v.sessions, tonnage: v.tonnage, prs: v.prs, favorite: v.favorite?.name, best: v.best_lift ? `${v.best_lift.name} ${v.best_lift.e1rm}` : null, cmp: tonnageComparison(v.tonnage)?.text });
    }
  }
}
console.log(`\n${athletes.length} athletes · ${WRITE ? `${written} written` : `${mismatches} mismatches · ${missing} missing`}`);
process.exit(WRITE ? 0 : (mismatches || missing ? 1 : 0));
