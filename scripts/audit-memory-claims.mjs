// ─── AUDIT: memory facts that claim a pain tally or a program action (T64 S2) ─
// DRY RUN ONLY. Lists every ACTIVE athlete_memory row, all athletes, that the
// new memory validation (src/memory.js ledgerRejects) would refuse today:
// a pain count / pattern claim ("flagged three times") or a claim that the
// program changed / a plan is in effect ("front squat pulled from program").
// It changes NO row. What to do with each row is a human call.
//
//   node --env-file=.env scripts/audit-memory-claims.mjs          # table
//   node --env-file=.env scripts/audit-memory-claims.mjs --json   # machine output
//
// The founder's Sep 1 row (f1876cb4) must appear in the output.
import { ledgerRejects } from "../src/memory.js";

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY"); process.exit(1); }
if (process.argv.includes("--apply")) { console.error("This audit is dry-run only. It never writes."); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sb = async (path) => {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

const rows = [];
for (let from = 0; ; from += 1000) {
  const page = await sb(`athlete_memory?status=eq.active&select=id,athlete_id,kind,content,created_at,expires_at&order=created_at.asc&offset=${from}&limit=1000`);
  rows.push(...page);
  if (page.length < 1000) break;
}
const hits = rows.map((r) => ({ ...r, reason: ledgerRejects(r.content) })).filter((r) => r.reason);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(hits, null, 2));
} else {
  console.log(`Active memory rows scanned: ${rows.length}. Would be refused today: ${hits.length}.\n`);
  for (const h of hits) {
    console.log(`${h.id.slice(0, 8)}  athlete ${h.athlete_id.slice(0, 8)}  ${h.kind.padEnd(11)} ${h.created_at.slice(0, 10)}  [${h.reason}]\n    ${h.content.replace(/\s+/g, " ").slice(0, 220)}`);
  }
}
