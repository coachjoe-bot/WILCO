// ─── AUDIT: logged sets a kg athlete may have had filed as lbs (T65) ──────────
// DRY RUN ONLY. Never writes, never repairs. Before T65 the parser was never told
// the athlete's unit and its rulebook said an unlabelled load is lbs, so a kg
// athlete's "squat 5x3 at 140" could be saved as a 140 LB squat. This replays
// every logged exercise of every kg athlete since a cutoff through the T65
// resolver (src/prAttempts.js stampLoadUnits) and prints where the stored unit
// and the resolver disagree, plus the barbell lifts stored as lbs with no unit
// written on their numbers (the candidates the founder decides on).
//
//   node --env-file=.env scripts/audit-exercise-units.mjs [--since=2026-08-17] [--json]
//
import { resolveLoadUnits } from "../src/prAttempts.js";
import { normalizeExName } from "../src/grit.js";

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY"); process.exit(1); }
if (process.argv.some((a) => /^--(apply|fix|repair|write)/.test(a))) {
  console.error("This audit is dry-run only. It never writes or repairs a row.");
  process.exit(2);
}
const since = (process.argv.find((a) => a.startsWith("--since=")) || "--since=2026-08-17").slice(8);
const QA = new Set(["99999999-9999-4999-8999-999999999999", "99999999-9999-4999-8999-999999999998", "99999999-9999-4999-8999-999999999997"]);
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sb = async (path) => {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

// Free-weight barbell lifts (the loads that feed maxes, benchmarks and program %).
const NOT_BARBELL = /dumbbell|\bdb\b|cable|machine|kettlebell|\bkb\b|abduct|adduct|extension|curl|raise|pull-?up|chin|dip|sit-?up|band|lat |pushdown|sled|plank|smith/i;
const BARBELL = /squat|clean|jerk|snatch|deadlift|\brdl\b|bench|press|row|pull|thrust|complex|good morning/i;
const isBarbell = (name) => BARBELL.test(name || "") && !NOT_BARBELL.test(name || "");

const athletes = (await sb("athletes?weight_unit=eq.kg&select=id,name")).filter((a) => !QA.has(a.id));
const out = [];
for (const a of athletes) {
  const rows = await sb(`workouts?athlete_id=eq.${a.id}&created_at=gte.${since}&select=id,created_at,raw_message,parsed_data&order=created_at.asc`);
  for (const r of rows) {
    const pd = typeof r.parsed_data === "string" ? JSON.parse(r.parsed_data) : r.parsed_data;
    const exs = Array.isArray(pd?.exercises) ? pd.exercises : [];
    if (!exs.length) continue;
    const resolved = resolveLoadUnits(pd, { displayUnit: "kg", message: r.raw_message || "", normalizeName: normalizeExName });
    exs.forEach((ex, i) => {
      if (!ex || ex.unit === "bodyweight" || !(Number(ex.weight) > 0)) return;
      const nums = [ex.weight, ...(Array.isArray(ex.set_details) ? ex.set_details.map((s) => s.weight) : [])].filter((n) => Number(n) > 0);
      const v = resolved.exercises[i];
      out.push({
        athlete: a.name, date: r.created_at.slice(0, 10), row: r.id, lift: ex.name, weight: ex.weight,
        set_details: nums.join("/"), stored: ex.unit, t65: v.unit, t65_source: v.source,
        written: v.written,
        barbell: isBarbell(ex.name), raw: (r.raw_message || "").replace(/\s+/g, " ").slice(0, 220),
      });
    });
  }
}

const candidates = out.filter((x) => x.barbell && x.stored === "lbs" && !x.written);
const carriedKg = out.filter((x) => x.barbell && x.stored === "kg" && !x.written);
const disagree = out.filter((x) => x.stored !== x.t65);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ since, exercises: out.length, candidates, carriedKg, disagree }, null, 2));
} else {
  const line = (x) => `  ${x.date} ${x.lift} ${x.set_details} stored:${x.stored} t65:${x.t65} (${x.t65_source}) written:${x.written ?? "none"}  "${x.raw}"`;
  console.log(`kg athletes: ${athletes.length} · weighted exercises since ${since}: ${out.length}`);
  console.log(`\nBarbell lift stored LBS, no unit written on its numbers: ${candidates.length}`);
  candidates.forEach((x) => console.log(line(x)));
  console.log(`\nBarbell lift stored KG, no unit written on its numbers (parser carried kg): ${carriedKg.length}`);
  carriedKg.forEach((x) => console.log(line(x)));
  console.log(`\nStored unit differs from what T65 would store: ${disagree.length}`);
  disagree.forEach((x) => console.log(line(x)));
}
