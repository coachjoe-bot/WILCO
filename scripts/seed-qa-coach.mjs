// ─── CLAUDE QA COACH — the coach-side live-test account (T57 session 3) ───────
// Seeds (or fully RESEEDS) one clearly-labeled test coach and links the standing
// QA athlete ("Claude QA (test)") to their roster, so the coach dashboard can be
// driven end-to-end against prod the same way the athlete side is.
//
//   node --env-file=.env scripts/seed-qa-coach.mjs
//
// Contract:
//   • FIXED id — every write scoped to it; reseeding wipes ONLY this coach's rows.
//   • Name "Claude QA Coach (test)" so no human report mistakes it; exclude BOTH
//     QA ids from business metrics (see the report skills + views-manifest).
//   • PIN: coach login used to be PIN-ONLY and FIRST-MATCH across every coach row,
//     so a QA pin that collides with a real coach's pin would cross-wire accounts.
//     It now takes name (or email) + PIN (api/identity.js coachLogin), but bundles
//     still in the wild can send a bare PIN, so the seed keeps the check. It bcrypt-compares
//     its candidate pin against every existing coach hash and regenerates until
//     it is unique, then verifies by logging in through the real prod endpoint
//     and asserting the returned id is the QA coach.
//   • Appends QA_COACH_* to .env.qa (athlete reseed rewrites that file — rerun
//     this script after rerunning the athlete seed).
import bcrypt from "bcryptjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const QA_COACH_ID = "99999999-9999-4999-8999-999999999997";
const QA_ATHLETE_ID = "99999999-9999-4999-8999-999999999999";

const URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) { console.error("Need VITE_SUPABASE_URL + SUPABASE_SERVICE_KEY (run with --env-file=.env)"); process.exit(1); }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" };
const del = async (table, col) => {
  const r = await fetch(`${URL}/rest/v1/${table}?${col}=eq.${QA_COACH_ID}`, { method: "DELETE", headers: H });
  if (!r.ok && r.status !== 404) throw new Error(`${table} wipe: ${r.status} ${await r.text()}`);
};
const ins = async (table, rows) => {
  const r = await fetch(`${URL}/rest/v1/${table}`, { method: "POST", headers: H, body: JSON.stringify(rows) });
  if (!r.ok) throw new Error(`${table} insert: ${r.status} ${await r.text()}`);
};
const patch = async (table, filter, body) => {
  const r = await fetch(`${URL}/rest/v1/${table}?${filter}`, { method: "PATCH", headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${table} patch: ${r.status} ${await r.text()}`);
};

const main = async () => {
  // ── pick a pin that matches NO existing coach hash (first-match auth) ──
  const existing = await (await fetch(`${URL}/rest/v1/coaches?pin=not.is.null&id=neq.${QA_COACH_ID}&select=pin`, { headers: H })).json();
  let pin;
  for (let tries = 0; tries < 50; tries++) {
    const cand = String(Math.floor(1000 + Math.random() * 9000));
    const clash = (await Promise.all(existing.map((c) => bcrypt.compare(cand, c.pin)))).some(Boolean);
    if (!clash) { pin = cand; break; }
  }
  if (!pin) throw new Error("couldn't find a collision-free pin in 50 tries");
  const pinHash = await bcrypt.hash(pin, 10);

  // ── wipe (this coach's rows only) ──
  for (const [t, col] of [["coach_context", "coach_id"], ["coach_push_subscriptions", "coach_id"],
                          ["coach_programs", "coach_id"], ["program_change_requests", "coach_id"]]) {
    await del(t, col).catch((e) => console.warn(`(skip) ${e.message}`));
  }
  // Unlink any roster rows first — athletes.coach_id references coaches(id), so
  // the coach row can't drop while the QA athlete still points at it.
  await patch("athletes", `coach_id=eq.${QA_COACH_ID}`, { coach_id: null }).catch(() => {});
  await del("coaches", "id");

  // ── coach (independent — no school row, like ICS coaches) ──
  await ins("coaches", [{
    id: QA_COACH_ID, name: "Claude QA Coach (test)", email: "qa+coach@trainwilco.com",
    sports: ["Football"], access_code: "QA-CLAUDE-COACH", pin: pinHash, role: "coach",
    school_id: null, tour_done_at: new Date().toISOString(),
  }]);

  // ── roster: the QA athlete reports to the QA coach ──
  await patch("athletes", `id=eq.${QA_ATHLETE_ID}`, {
    coach_id: QA_COACH_ID, coach_name: "Claude QA Coach (test)", coach_email: "qa+coach@trainwilco.com",
  });

  // ── prove the pin resolves to THIS coach through the real prod endpoint ──
  const login = await (await fetch("https://app.trainwilco.com/api/identity", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "coach-login", name: "Claude QA Coach (test)", pin }),
  })).json();
  if (!login?.coach || login.coach.id !== QA_COACH_ID) {
    throw new Error(`coach-login resolved to ${login?.coach?.id || "null"} — NOT the QA coach; reseed`);
  }

  // ── append creds to .env.qa (strip any stale QA_COACH lines first) ──
  const envPath = ".env.qa";
  const prev = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n").filter((l) => !l.startsWith("QA_COACH")).join("\n").replace(/\n+$/, "\n") : "";
  writeFileSync(envPath, `${prev}QA_COACH_NAME=Claude QA Coach (test)\nQA_COACH_PIN=${pin}\nQA_COACH_ID=${QA_COACH_ID}\n`);
  console.log(`Seeded coach "Claude QA Coach (test)" (${QA_COACH_ID}), athlete linked, prod login verified.`);
  console.log(`PIN appended to .env.qa — used only by the live QA harness.`);
};
main().catch((e) => { console.error(e); process.exit(1); });
