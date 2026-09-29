// ─── CLAUDE QA CREW ATHLETE — the paired-Crew live-test fixture (T57 s3/s4) ───
// Seeds (or fully RESEEDS) a second clearly-labeled athlete paired to the main
// QA athlete with an ACCEPTED crew edge and BOTH compare flags on, so the
// paired Crew surfaces (roster card, head-to-head, benchmark ticks, moments)
// can be driven live from either side.
//
//   node --env-file=.env scripts/seed-qa-crew.mjs
//
// Contract mirrors seed-qa-athlete/seed-qa-coach: fixed id, hard-scoped wipes,
// PIN appended to .env.qa, EXCLUDE from business metrics. NOTE: crew moments
// are tier-crossing-gated — to light the MOMENTS feed, log a jump that crosses
// a Grit boundary (bench ≥1.5×bw for this 170 lb fixture ≈ 255+ e1RM).
import bcrypt from "bcryptjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const QA_CREW_ID = "99999999-9999-4999-8999-999999999998";
const QA_ATHLETE_ID = "99999999-9999-4999-8999-999999999999";

const URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) { console.error("Need VITE_SUPABASE_URL + SUPABASE_SERVICE_KEY (run with --env-file=.env)"); process.exit(1); }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" };
const del = async (table, col) => {
  const r = await fetch(`${URL}/rest/v1/${table}?${col}=eq.${QA_CREW_ID}`, { method: "DELETE", headers: H });
  if (!r.ok && r.status !== 404) throw new Error(`${table} wipe: ${r.status} ${await r.text()}`);
};
const ins = async (table, rows) => {
  const r = await fetch(`${URL}/rest/v1/${table}`, { method: "POST", headers: H, body: JSON.stringify(rows) });
  if (!r.ok) throw new Error(`${table} insert: ${r.status} ${await r.text()}`);
};

const main = async () => {
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  const pinHash = await bcrypt.hash(pin, 10);

  for (const [t, col] of [["workouts", "athlete_id"], ["prs", "athlete_id"], ["crew_edges", "athlete_a"],
                          ["crew_edges", "athlete_b"], ["crew_moments", "athlete_id"],
                          ["athlete_training_prefs", "athlete_id"], ["athlete_context", "athlete_id"], ["legal_acceptances", "athlete_id"]]) {
    await del(t, col).catch((e) => console.warn(`(skip) ${e.message}`));
  }
  await del("athletes", "id");

  await ins("athletes", [{
    id: QA_CREW_ID, name: "Claude QA Crew (test)", email: "qa+crew@trainwilco.com",
    pin: pinHash, sport: "Football", goal: "strength", tier: "pro",
    first_chat_complete: true, weight_lbs: 170, weight_unit: "lbs", gender: "male", age: 18,
    crew_code: "CLAUDE-QA2X", tour_done_at: new Date().toISOString(), total_sessions_logged: 2,
  }]);

  const w = (d, ex) => ({ athlete_id: QA_CREW_ID, created_at: new Date(Date.now() - d * 864e5).toISOString(),
    raw_message: "seed", bot_reply: "Solid.",
    parsed_data: { log_date: null, run_data: null, exercises: ex, pain_flags: [], pr_attempts: [] } });
  const ex = (name, sets, reps, weight) => ({ name, sets, reps, weight, unit: "lbs", added_weight: null,
    assist_weight: null, resistance: null, load_basis: null, rpe: null, rir: null, percent_1rm: null,
    tempo: null, technique: null, to_failure: null, superset_group: null, feel: null, notes: null, set_details: null });
  // Same reason as seed-qa-athlete.mjs: the server skips AI work without this row.
  await ins("legal_acceptances", [{ athlete_id: QA_CREW_ID, document: "ai_processing", version: "2026-09-29" }]);
  await ins("workouts", [w(2, [ex("Bench Press", 3, 5, 205)]), w(1, [ex("Back Squat", 3, 5, 275), ex("Deadlift", 3, 5, 315)])]);

  // Accepted edge, BOTH compare flags on (compare is mutual-opt-in by design —
  // one-sided flags render NO ticks and that is correct behavior, not a bug).
  const [a, b] = [QA_CREW_ID, QA_ATHLETE_ID].sort();
  await ins("crew_edges", [{ athlete_a: a, athlete_b: b, status: "accepted", requested_by: QA_CREW_ID,
    accepted_at: new Date().toISOString(), compare_a: true, compare_b: true }]);

  const envPath = ".env.qa";
  const prev = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n").filter((l) => !l.startsWith("QA_CREW")).join("\n").replace(/\n+$/, "\n") : "";
  writeFileSync(envPath, `${prev}QA_CREW_NAME=Claude QA Crew (test)\nQA_CREW_PIN=${pin}\nQA_CREW_ID=${QA_CREW_ID}\n`);
  console.log(`Seeded crew athlete "Claude QA Crew (test)" (${QA_CREW_ID}) + accepted mutual-compare edge.`);
  console.log(`PIN appended to .env.qa — used only by the live QA harness.`);
};
main().catch((e) => { console.error(e); process.exit(1); });
