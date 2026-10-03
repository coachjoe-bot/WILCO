// ─── T69-C SERVER HALF, LIVE (ship-dark verification) ────────────────────────
// Server and DB pieces cannot be tested with the real model before they deploy,
// and the smoke suite mocks the gateway. This drives the DEPLOYED gateway as the
// QA athlete and reads every result back from the database ("assert the row
// after writing": a swallowed write is the trap that fired three times):
//   - athlete_memory accepts section / confirmed_at / ask_count / area_key,
//     refuses a section outside the vocabulary and a runaway counter
//   - athlete_goals takes confirmed_at / ask_count
//   - athletes accepts a well-formed review_stamps and refuses a malformed one
//   - /api/claude resolves toolset mastermind_athlete_v3 (remember_fact has section)
// Holds the QA fixture lock (caller); writes only QA rows and restores them.
//   node --env-file=.env --env-file=.env.qa scripts/t69c-server-live.mjs
const QA = process.env.QA_ATHLETE_ID || "99999999-9999-4999-8999-999999999999";
const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const BASE = process.env.BASE || "https://app.trainwilco.com";
const AUTH = { id: QA, role: "athlete", pin: process.env.QA_ATHLETE_PIN };
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.text().then((t) => (t ? JSON.parse(t) : null)); };
const api = async (op, table, extra = {}) => { const r = await fetch(`${BASE}/api/data`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth: AUTH, op, table, ...extra }) }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { ok: r.ok, status: r.status, d }; };
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`); };

const athlete0 = (await rest(`athletes?id=eq.${QA}&select=review_stamps`))[0];
const goal = (await rest(`athlete_goals?athlete_id=eq.${QA}&select=id,confirmed_at,ask_count&order=created_at.desc&limit=1`))[0];
const created = [];
try {
  const now = new Date().toISOString();
  const ins = await api("insert", "athlete_memory", { data: { athlete_id: QA, content: "T69-C probe: garage gym, no rack", kind: "contextual", source: "athlete_said", section: "schedule", confirmed_at: now, ask_count: 0, area_key: "pec" } });
  check("gateway accepts a note with section, confirmed_at, ask_count, area_key", ins.ok, JSON.stringify(ins.d).slice(0, 160));
  const row = (Array.isArray(ins.d) ? ins.d[0] : ins.d) || {};
  if (row.id) created.push(row.id);
  const back = (await rest(`athlete_memory?id=eq.${row.id}&select=section,confirmed_at,ask_count,area_key`))[0] || {};
  check("the ROW has them (not a swallowed write)", back.section === "schedule" && back.ask_count === 0 && back.area_key === "pec" && !!back.confirmed_at, JSON.stringify(back));
  const up = await api("update", "athlete_memory", { id: row.id, data: { ask_count: 1, confirmed_at: now, section: "body" } });
  const back2 = (await rest(`athlete_memory?id=eq.${row.id}&select=section,ask_count`))[0] || {};
  check("update lands: ask_count 1, section body", up.ok && back2.ask_count === 1 && back2.section === "body", JSON.stringify(back2));
  const bad = await api("insert", "athlete_memory", { data: { athlete_id: QA, content: "T69-C probe bad section", kind: "contextual", source: "athlete_said", section: "everything" } });
  check("a section outside the vocabulary is refused (gateway guard)", !bad.ok && bad.status >= 400, `${bad.status} ${JSON.stringify(bad.d).slice(0, 100)}`);
  const bad2 = await api("update", "athlete_memory", { id: row.id, data: { ask_count: 99 } });
  check("a runaway counter is refused", !bad2.ok, `${bad2.status}`);
  // the DB CHECK is the second gate: prove it independently with the service key
  let dbRefused = false; try { await rest(`athlete_memory?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ section: "everything" }) }); } catch { dbRefused = true; }
  check("the DB CHECK refuses the same bad section on its own", dbRefused);
  if (goal) {
    const g = await api("update", "athlete_goals", { id: goal.id, data: { confirmed_at: now, ask_count: 1 } });
    const gb = (await rest(`athlete_goals?id=eq.${goal.id}&select=confirmed_at,ask_count`))[0] || {};
    check("athlete_goals takes confirmed_at and ask_count (row asserted)", g.ok && gb.ask_count === 1 && !!gb.confirmed_at, JSON.stringify(gb));
  } else check("(no goal row on the QA athlete to stamp)", true);
  const rs = { equipment: { confirmed_at: now, ask_count: 0 }, training_days_per_week: { confirmed_at: now, ask_count: 1 } };
  const a = await api("update", "athletes", { id: QA, data: { review_stamps: rs } });
  const ab = (await rest(`athletes?id=eq.${QA}&select=review_stamps`))[0] || {};
  check("athletes.review_stamps lands (row asserted)", a.ok && ab.review_stamps && ab.review_stamps.equipment && ab.review_stamps.training_days_per_week.ask_count === 1, JSON.stringify(ab.review_stamps));
  const a2 = await api("update", "athletes", { id: QA, data: { review_stamps: { pin: { confirmed_at: now } } } });
  check("a malformed review_stamps is refused", !a2.ok, `${a2.status}`);
  // toolset v3 reaches the model with the section field
  const r = await fetch(`${BASE}/api/claude`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth: AUTH, model: "claude-haiku-4-5", max_tokens: 300, feature: "other", toolset: "mastermind_athlete_v3",
    system: "You are Coach Joe. Use remember_fact when the athlete tells you something durable about their training.",
    messages: [{ role: "user", content: [{ type: "text", text: "Remember that I lift in my garage gym on Tuesdays and Thursdays at 6am, long term." }] }] }) });
  const j = await r.json();
  const tu = (j.content || []).find((b) => b.type === "tool_use");
  check("/api/claude accepts toolset mastermind_athlete_v3", r.ok, `status ${r.status}`);
  check("the model called remember_fact on v3 (a tool_use came back)", !!tu && tu.name === "remember_fact", JSON.stringify(tu || j).slice(0, 220));
  if (tu) console.log("  (section chosen by the model:", tu.input.section || "none", ")");
} finally {
  for (const id of created) await rest(`athlete_memory?id=eq.${id}`, { method: "DELETE" }).catch(() => {});
  await rest(`athlete_memory?athlete_id=eq.${QA}&content=ilike.T69-C probe*`, { method: "DELETE" }).catch(() => {});
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ review_stamps: athlete0 ? athlete0.review_stamps : null }) }).catch(() => {});
  if (goal) await rest(`athlete_goals?id=eq.${goal.id}`, { method: "PATCH", body: JSON.stringify({ confirmed_at: goal.confirmed_at, ask_count: goal.ask_count }) }).catch(() => {});
}
console.log(`\n${fail === 0 ? "✓" : "✗"} t69c-server-live: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
