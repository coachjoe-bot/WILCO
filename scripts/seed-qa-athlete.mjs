// ─── CLAUDE QA ATHLETE — the standing live-test account (Will's ask, 08-18) ────
// Seeds (or fully RESEEDS) one clearly-labeled test athlete with realistic data
// so every deploy can be driven end-to-end against the REAL app — real backend,
// real AI — by scripts/qa-live.spec.js, instead of shipping the UX layer on
// faith. Never the sales demo: that's the Eastridge asset buyers see.
//
//   node --env-file=.env scripts/seed-qa-athlete.mjs
//
// Contract:
//   • FIXED id — every write in this script is scoped to it; reseeding wipes and
//     rebuilds ONLY this athlete's rows. It can never touch a real athlete.
//   • Name "Claude QA (test)" so no human report mistakes it; EXCLUDE this id
//     from business metrics (see QA_ATHLETE_ID export).
//   • PIN: generated fresh on every seed, printed once, and written to .env.qa
//     (gitignored) for the live harness. It protects only this fake data.
//   • ~10 weeks of history: bench/squat/deadlift/snatch progressions, mixed
//     lbs/kg rows, set_details ramps, one made + one missed max attempt, a
//     declared 1RM, goals, prefs, and a BLOCK INFO program — every shape the
//     parser contract produces, so the account exercises real code paths.
import bcrypt from "bcryptjs";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { refreshAthleteStats } from "../api/_stats.js"; // T70: direct writes bypass the gateway's refresh

export const QA_ATHLETE_ID = "99999999-9999-4999-8999-999999999999";

const URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) { console.error("Need VITE_SUPABASE_URL + SUPABASE_SERVICE_KEY (run with --env-file=.env)"); process.exit(1); }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" };
const del = async (table, col = "athlete_id") => {
  const r = await fetch(`${URL}/rest/v1/${table}?${col}=eq.${QA_ATHLETE_ID}`, { method: "DELETE", headers: H });
  if (!r.ok && r.status !== 404) throw new Error(`${table} wipe: ${r.status} ${await r.text()}`);
};
const ins = async (table, rows) => {
  const r = await fetch(`${URL}/rest/v1/${table}`, { method: "POST", headers: H, body: JSON.stringify(rows) });
  if (!r.ok) throw new Error(`${table} insert: ${r.status} ${await r.text()}`);
};

const daysAgo = (n, h = 17) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h, 30, 0, 0); return d.toISOString(); };
const ex = (name, sets, reps, weight, unit = "lbs", extra = {}) => ({
  name, sets, reps, weight, unit, added_weight: null, assist_weight: null, resistance: null,
  load_basis: null, rpe: null, rir: null, percent_1rm: null, tempo: null, technique: null,
  to_failure: null, superset_group: null, feel: null, notes: null, set_details: null, ...extra,
});
const workout = (dAgo, exercises, extra = {}) => ({
  athlete_id: QA_ATHLETE_ID, created_at: daysAgo(dAgo),
  raw_message: exercises.map((e) => `${e.name} ${e.sets}x${e.reps}${e.weight ? ` @ ${e.weight}${e.unit === "kg" ? "kg" : ""}` : ""}`).join(", "),
  bot_reply: "Solid session. Numbers are moving.",
  parsed_data: { log_date: null, run_data: null, exercises, coach_flag: null, pain_flags: [], pr_attempts: [], ...extra },
});

const PROGRAM = `=== BLOCK INFO ===
Goal: Bench 245 by Oct 10
Maxes used: Bench Press 225 lb (declared/tested 1RM), Back Squat ~315 lb (est. from logs), Deadlift ~365 lb (est. from logs)
Loading: percentages and RPE mixed
Runs: 2026-08-17 to 2026-09-13
Gate: bench 3x5 @ 205 by week 3

QA BLOCK 1 — Bench Focus
Day 1 - Push
Warm-up: standard
Bench Press 4x5 @ 75% (170 lbs)
Overhead Press 3x8 @ 95
Dips 3x8
Cool-down: stretch

Day 2 - Pull
Warm-up: standard
Deadlift 3x5 @ 285
Barbell Row 3x8 @ 155
Cool-down: stretch

Day 3 - Legs
Warm-up: standard
Back Squat 4x5 @ 245
Front Squat 3x5 @ 185
Cool-down: stretch`;

const main = async () => {
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  const pinHash = await bcrypt.hash(pin, 10);

  // ── wipe (this athlete's rows only) ──
  for (const t of ["workouts", "prs", "manual_one_rms", "athlete_goals", "athlete_context",
                   "athlete_training_prefs", "program_history", "program_drafts", "proof_digests",
                   "program_modifications", "crew_moments", "push_subscriptions"]) {
    await del(t).catch((e) => console.warn(`(skip) ${e.message}`));
  }
  await del("athletes", "id").catch(() => {});

  // ── athlete ──
  await ins("athletes", [{
    id: QA_ATHLETE_ID, name: "Claude QA (test)", email: "qa+claude@trainwilco.com",
    pin: pinHash, sport: "Football", goal: "strength", tier: "pro",
    first_chat_complete: true, program_text: PROGRAM, program_locked: false,
    weight_lbs: 185, weight_unit: "lbs", gender: "male", age: 19, height_inches: 71,
    training_days_per_week: 3, equipment: ["Full gym"], injury_history: null,
    total_sessions_logged: 31, proof_enabled: false, birthday: "2007-02-11", // = seeded session count (one per distinct day) so the view and the column agree
    tour_done_at: daysAgo(70), // a veteran account — the tour offer overlay must not block the harness
    program_block_span: { weeks: 4, repeating: false }, // block end known — no "when does it end?" prompt
    created_at: daysAgo(75),
  }]);

  // ── ~10 weeks of sessions: 3/week, progressive, mixed shapes ──
  const rows = [];
  for (let w = 9; w >= 0; w--) {
    const base = w * 7 + 3;
    rows.push(workout(base + 2, [
      ex("Bench Press", 4, 5, 175 - w * 2, "lbs", { set_details: [{ weight: 135, reps: 8, warmup: true }, { weight: 175 - w * 2, reps: 5 }, { weight: 175 - w * 2, reps: 5 }, { weight: 175 - w * 2, reps: 5 }, { weight: 175 - w * 2, reps: 5 }] }),
      ex("Overhead Press", 3, 8, 90 - w),
      ex("Dips", 3, 8, null, "bodyweight"),
    ]));
    rows.push(workout(base + 1, [
      ex("Deadlift", 3, 5, 295 - w * 4),
      ex("Barbell Row", 3, 8, 150 - w * 2),
    ]));
    // a kg session every few weeks keeps the unit paths honest
    rows.push(workout(base, w % 3 === 0
      ? [ex("Back Squat", 4, 5, Math.round((250 - w * 3) / 2.20462 / 2.5) * 2.5, "kg"), ex("Front Squat", 3, 5, 185 - w * 2)]
      : [ex("Back Squat", 4, 5, 250 - w * 3), ex("Front Squat", 3, 5, 185 - w * 2)]));
  }
  // a made single + a missed attempt (pr_attempts shapes)
  rows.push(workout(2, [ex("Bench Press", 1, 1, 225, "lbs", { set_details: [{ weight: 185, reps: 3, warmup: true }, { weight: 225, reps: 1 }] })],
    { pr_attempts: [{ exercise: "Bench Press", weight: 225, reps: 1, achieved: true, unit: "lbs" }, { exercise: "Bench Press", weight: 235, reps: 1, achieved: false, unit: "lbs" }] }));
  await ins("workouts", rows);

  await ins("manual_one_rms", [{ athlete_id: QA_ATHLETE_ID, exercise: "Bench Press", normalized_exercise: "bench press", weight: 225, unit: "lbs", source: "workout" }]);
  await ins("athlete_goals", [{ athlete_id: QA_ATHLETE_ID, goal_text: "Bench 245 by Oct 10", created_at: daysAgo(10) }]);
  await ins("athlete_training_prefs", [{ athlete_id: QA_ATHLETE_ID, loading_language: "percent+rpe", source: "settings" }]);
  await ins("program_history", [{ athlete_id: QA_ATHLETE_ID, program_text: PROGRAM, source: "builder", block_name: "QA BLOCK 1", block_summary: "3-day bench-focus block, %1RM loading", applied_at: daysAgo(1), completed_at: null }]);

  writeFileSync(".env.qa", `# generated by scripts/seed-qa-athlete.mjs — machine credential for the QA fixture only\nQA_ATHLETE_NAME=Claude QA (test)\nQA_ATHLETE_PIN=${pin}\nQA_ATHLETE_ID=${QA_ATHLETE_ID}\n`);
  // T70: the rows above went in with the service key, so the per-write refresh in
  // api/data.js never saw them. Recompute the summary row now.
  try { await refreshAthleteStats(QA_ATHLETE_ID); console.log("athlete_stats refreshed"); } catch (e) { console.warn("athlete_stats refresh failed:", e.message); }
  console.log(`Seeded ${rows.length} workouts + program + prefs for "Claude QA (test)" (${QA_ATHLETE_ID}).`);
  console.log(`PIN written to .env.qa — used only by the live QA harness.`);
};
main().catch((e) => { console.error(e); process.exit(1); });
