// ─── ONE MEMORY STORE: move the athlete_context blob into athlete_memory ─────
// T68 (09-29), AI contract rule 2. The app no longer reads or writes
// athlete_context; this moves what each blob holds into facts, through the same
// validator a fact Joe saves goes through (src/memory.js contextLinesToFacts).
// Lines memory refuses (pain tallies, program-change claims, block dates,
// behavior instructions), expired check-in notes and lines memory already holds
// stay behind. The blob rows are NOT deleted: they simply have no reader.
// Safe to rerun: a line already moved is a duplicate the second time. Rerun it
// about a week after the deploy to sweep any note an old cached bundle wrote.
//   node --env-file=.env scripts/migrate-context-to-memory.mjs            (dry run, prints the plan)
//   node --env-file=.env scripts/migrate-context-to-memory.mjs --apply
import { contextLinesToFacts } from "../src/memory.js";

const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SB || !KEY) { console.error("VITE_SUPABASE_URL and SUPABASE_SERVICE_KEY are required (--env-file=.env)"); process.exit(1); }
const APPLY = process.argv.includes("--apply");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

const blobs = await rest("athlete_context?select=athlete_id,content,updated_at&order=updated_at.asc&limit=1000");
const now = new Date();
let moved = 0, left = 0;
for (const b of blobs) {
  const existing = await rest(`athlete_memory?athlete_id=eq.${b.athlete_id}&status=eq.active&select=id,content,kind,status,expires_at&limit=1000`);
  const { facts, skipped } = contextLinesToFacts(b.content, { existing, updatedAt: b.updated_at, now });
  console.log(`\n${b.athlete_id}  blob updated ${String(b.updated_at).slice(0, 10)}  memory holds ${existing.length}  ->  move ${facts.length}, leave ${skipped.length}`);
  for (const f of facts) console.log(`  MOVE  [${f.kind}${f.expires_at ? ` until ${f.expires_at.slice(0, 10)}` : ""}] ${f.content.slice(0, 140)}`);
  for (const s of skipped) console.log(`  LEAVE (${s.reason}) ${s.line.slice(0, 140)}`);
  left += skipped.length;
  if (APPLY && facts.length) {
    await rest("athlete_memory", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(facts.map((f) => ({ athlete_id: b.athlete_id, content: f.content, kind: f.kind, expires_at: f.expires_at, source: f.source, status: "active" }))) });
  }
  moved += facts.length;
}
console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: ${blobs.length} blob(s), ${moved} line(s) ${APPLY ? "moved" : "to move"}, ${left} left behind.`);
