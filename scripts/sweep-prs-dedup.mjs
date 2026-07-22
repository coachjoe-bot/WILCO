// ─── ONE-TIME prs DEDUP SWEEP (A1, 2026-07-22) ───────────────────────────────
// The PR-detection bug (prMap keyed by raw name, looked up by normalized name —
// fixed in the same branch as this script) inserted a fresh "first PR" row on
// EVERY workout for any lift whose normalized form differed from its raw
// lowercase. This sweep collapses the bloat: per athlete, per CANONICAL lift
// (resolveLift funnel — same aliasing the app uses), keep only the single best
// row (highest lbs-equivalent e1RM; newest wins ties) and delete the rest.
//
// RUN ONLY AFTER the A1 code fix is live on prod — old clients would just
// recreate junk rows. Safe to re-run (idempotent). Requires .env with
// SUPABASE_URL + SUPABASE_SERVICE_KEY (same as the other scripts here).
//
//   node --env-file=.env scripts/sweep-prs-dedup.mjs           # dry run (default)
//   node --env-file=.env scripts/sweep-prs-dedup.mjs --apply   # actually delete
//
import { resolveLift, epley1RM, toLbs } from "../src/grit.js";

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY"); process.exit(1); }
const APPLY = process.argv.includes("--apply");

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const sb = async (path, init) => {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H, ...init });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};

// Page through the whole table (PostgREST caps at ~1000 rows/request).
const rows = [];
for (let off = 0; ; off += 1000) {
  const page = await sb(`prs?select=id,athlete_id,exercise,weight,reps,unit,estimated_1rm,created_at&order=id.asc&limit=1000&offset=${off}`);
  rows.push(...page);
  if (page.length < 1000) break;
}
console.log(`${rows.length} prs rows total`);

const e1 = (p) => p.estimated_1rm || epley1RM(toLbs(p.weight, p.unit), p.reps || 1);
const best = new Map(); // `${athlete_id}:${liftId}` -> best row
for (const p of rows) {
  const k = `${p.athlete_id}:${resolveLift(p.exercise || "").id}`;
  const cur = best.get(k);
  if (!cur || e1(p) > e1(cur) || (e1(p) === e1(cur) && p.created_at > cur.created_at)) best.set(k, p);
}
const keep = new Set([...best.values()].map((p) => p.id));
const doomed = rows.filter((p) => !keep.has(p.id));
console.log(`${best.size} canonical (athlete, lift) pairs — keeping ${keep.size}, deleting ${doomed.length}`);

if (!APPLY) { console.log("DRY RUN — re-run with --apply to delete."); process.exit(0); }
for (let i = 0; i < doomed.length; i += 100) {
  const ids = doomed.slice(i, i + 100).map((p) => `"${p.id}"`).join(",");
  await sb(`prs?id=in.(${ids})`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
  console.log(`deleted ${Math.min(i + 100, doomed.length)}/${doomed.length}`);
}
console.log("Sweep complete.");
