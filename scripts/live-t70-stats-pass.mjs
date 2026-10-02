// T70 live pass: does a workouts write through the PROD gateway refresh the
// athlete's athlete_stats row? Uses the standing QA fixture (take
// locks/qa-fixture.lock first). Inserts one workout as the athlete via /api/data,
// waits for computed_at to advance and source_rows to grow by one, then deletes
// the row the same way and waits for the row to fall back. Cleans up after
// itself; exit 1 on any miss.
//   node --env-file=.env --env-file=.env.qa scripts/live-t70-stats-pass.mjs
const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const QA = process.env.QA_ATHLETE_ID, PIN = process.env.QA_ATHLETE_PIN;
const BASE = process.env.BASE || "https://app.trainwilco.com";
if (!SB || !KEY || !QA || !PIN) { console.error("Need .env + .env.qa"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };
const rest = async (path, init = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
};
const gw = async (body) => {
  const r = await fetch(`${BASE}/api/data`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth: { role: "athlete", id: QA, pin: PIN }, ...body }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`gateway ${body.op} ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
};
const statsRow = async () => (await rest(`athlete_stats?athlete_id=eq.${QA}&select=source_rows,computed_at,stats`))[0] || null;
const waitFor = async (pred, label, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const r = await statsRow(); if (pred(r)) return r; await new Promise((res) => setTimeout(res, 1500)); }
  throw new Error(`timeout: ${label}`);
};

let fail = 0;
const before = await statsRow();
console.log("before:", before ? { source_rows: before.source_rows, computed_at: before.computed_at, tonnage: before.stats?.lifetime?.tonnage } : null);
const rowsBefore = before?.source_rows ?? 0;
const tonBefore = before?.stats?.lifetime?.tonnage ?? 0;

const ins = await gw({ op: "insert", table: "workouts", data: { athlete_id: QA, raw_message: "T70 live pass: bench 3x5 at 185", bot_reply: "", parsed_data: { exercises: [{ name: "Bench Press", sets: 3, reps: 5, weight: 185, unit: "lbs" }], pain_flags: [] } } });
const rowId = Array.isArray(ins) ? ins[0]?.id : ins?.id;
console.log("inserted workout", rowId);
try {
  const after = await waitFor((r) => r && r.source_rows === rowsBefore + 1 && (!before || r.computed_at > before.computed_at), "refresh after insert");
  const tonAfter = after.stats?.lifetime?.tonnage ?? 0;
  console.log("after insert:", { source_rows: after.source_rows, computed_at: after.computed_at, tonnage: tonAfter });
  if (tonAfter - tonBefore !== 3 * 5 * 185) { fail++; console.error(`✗ tonnage moved by ${tonAfter - tonBefore}, want 2775`); } else console.log("✓ tonnage +2,775 lb");
} catch (e) { fail++; console.error("✗", e.message); }

await gw({ op: "delete", table: "workouts", id: rowId });
console.log("deleted workout", rowId);
try {
  const back = await waitFor((r) => r && r.source_rows === rowsBefore, "refresh after delete");
  const tonBack = back.stats?.lifetime?.tonnage ?? 0;
  console.log("after delete:", { source_rows: back.source_rows, computed_at: back.computed_at, tonnage: tonBack });
  if (tonBack !== tonBefore) { fail++; console.error(`✗ tonnage ${tonBack} after delete, want ${tonBefore}`); } else console.log("✓ tonnage back to the starting number");
} catch (e) { fail++; console.error("✗", e.message); }

// Belt and braces: the row is gone from workouts.
const left = await rest(`workouts?id=eq.${rowId}&select=id`);
if (left.length) { fail++; console.error("✗ test workout still present, deleting directly"); await rest(`workouts?id=eq.${rowId}`, { method: "DELETE" }); }
console.log(fail ? `\n${fail} FAILED` : "\nlive pass clean");
process.exit(fail ? 1 : 0);
