// Log-correction regression suite — guard rail for the AI correction engine
// (parseWorkout's log_correction intent + resolveLogCorrection's edit plans).
//
// Run with:  node scripts/test-log-correction.mjs <athlete-uuid> <pin>
//
// The two system prompts are EXTRACTED FROM src/App.jsx AT RUNTIME (no copies to
// drift), then exercised through the real authenticated /api/claude proxy on prod
// with the same model routing the app uses (Haiku-first parse, Sonnet resolver).
// Calls are attributed to the passed athlete in usage_costs like any app call —
// use a disposable test athlete, never a real one.
//
// PARSE table: messages that MUST (or must NOT) flag log_correction.is_mistake_fix.
// RESOLVE table: correction messages against a fixture history — the plan must
// target the right row + exercise with the right numbers, and refuse (found:false)
// when the target is ambiguous. A wrong edit is worse than no edit.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HOST = process.env.WILCO_HOST || "https://app.trainwilco.com";
const [, , ATHLETE_ID, PIN] = process.argv;
if (!ATHLETE_ID || !PIN) {
  console.error("Usage: node scripts/test-log-correction.mjs <athlete-uuid> <pin>");
  process.exit(1);
}
const AUTH = { role: "athlete", id: ATHLETE_ID, pin: PIN };

// ── Extract the live prompts from App.jsx ────────────────────────────────────
const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/App.jsx"), "utf8");
const grab = (startMarker) => {
  const start = appSrc.indexOf(startMarker);
  if (start === -1) throw new Error(`prompt marker not found: ${startMarker.slice(0, 40)}`);
  const end = appSrc.indexOf("`;", start);
  return appSrc.slice(start + "const sys = `".length, end);
};
const PARSE_SYS = grab("const sys = `Extract workout data");
const RESOLVE_SYS = grab("const sys = `You fix mistakes");
if (!PARSE_SYS.includes("log_correction")) throw new Error("parse prompt missing log_correction — extraction broken?");

const ask = async (system, user, maxTokens, model) => {
  const r = await fetch(`${HOST}/api/claude`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      auth: AUTH, model, max_tokens: maxTokens,
      system: "", system_cached: system,
      messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      feature: "workout_parse",
    }),
  });
  const d = await r.json();
  if (d.error) throw new Error(typeof d.error === "string" ? d.error : d.error.message);
  return d.content?.[0]?.text || "";
};
const parseJson = (t) => JSON.parse(t.replace(/```json|```/g, "").trim());

// Mirrors the app's Haiku-first routing (the advanced-notation regex from parseWorkout).
const advanced = (m) => /superset|super set|drop\s?set|rest[- ]?pause|cluster|myo[- ]?reps?|amrap|to failure|warm[- ]?up|worked up|ramp(?:ed|ing)? up|giant set|triset/i.test(m);

const todayLabel = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const parseCall = async (msg) => {
  const user = `Athlete: Fix Test (Olympic Weightlifting)\nTODAY'S DATE: ${todayLabel} (${new Date().toISOString().slice(0, 10)}). The athlete is logging this right now — only set log_date if they explicitly say the session was on a past day.\nMessage: ${msg}`;
  return parseJson(await ask(PARSE_SYS, user, 3000, advanced(msg) ? "claude-sonnet-5" : "claude-haiku-4-5"));
};

// ── PARSE: correction-intent detection ───────────────────────────────────────
const PARSE_CASES = [
  { msg: "hey that was a misclick on the strict press, the top set was 115 not 155", correction: true },
  { msg: "yesterday's squat should have been 275 not 375, fat fingered it", correction: true },
  { msg: "delete that last entry, it logged twice", correction: true },
  { msg: "Bench 5x5 225, felt good", correction: false, expectExercises: true },
  { msg: "strict press 3x5 @ 95/115/155, felt solid", correction: false, expectExercises: true },
  { msg: "here's my new program: Monday bench 5x5 80%, Wednesday squat 5x3 85%, Friday deadlift 3x3 90%", correction: false },
];

// ── RESOLVE: fixture history mirroring Will's real 07-20 session ─────────────
const ROW_A = {
  id: "aaaa1111-0000-0000-0000-000000000001", logged_at: new Date().toISOString(),
  athlete_message: "Push A — bench 5x3 185/205/225/245/255, strict press 3x5 95/115/155, dips 4x5 +0/45/70/70, cg db bench 2x6 60s, lat raise 2x15 25",
  exercises: [
    { name: "Bench Press", sets: 5, reps: 3, weight: 255, unit: "lbs", set_details: [{ weight: 185, reps: 3 }, { weight: 205, reps: 3 }, { weight: 225, reps: 3 }, { weight: 245, reps: 3 }, { weight: 255, reps: 3 }] },
    { name: "Strict Press", sets: 3, reps: 5, weight: 155, unit: "lbs", set_details: [{ weight: 95, reps: 5 }, { weight: 115, reps: 5 }, { weight: 155, reps: 5 }] },
    { name: "Dip", sets: 4, reps: 5, weight: null, unit: "bodyweight", added_weight: 70 },
    { name: "Close-Grip Dumbbell Bench Press", sets: 2, reps: 6, weight: 60, unit: "lbs" },
    { name: "Dumbbell Lateral Raise", sets: 2, reps: 15, weight: 25, unit: "lbs" },
  ],
};
const ROW_B = {
  id: "bbbb2222-0000-0000-0000-000000000002", logged_at: new Date(Date.now() - 10 * 864e5).toISOString(),
  athlete_message: "snatch 4x1 165/185/205/225, c&j 4x1+1 225/245/265/275, back squat 3x3 275/315/315",
  exercises: [
    { name: "Snatch", sets: 4, reps: 1, weight: 225, unit: "lbs", set_details: [{ weight: 165, reps: 1 }, { weight: 185, reps: 1 }, { weight: 205, reps: 1 }, { weight: 225, reps: 1 }] },
    { name: "Clean & Jerk", sets: 4, reps: 1, weight: 275, unit: "lbs" },
    { name: "Back Squat", sets: 3, reps: 3, weight: 315, unit: "lbs" },
  ],
};
const CANDIDATES = [ROW_A, ROW_B];

const resolveCall = async (msg, chat = []) => {
  const chatStr = chat.map((m) => `${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}`).join("\n");
  const user = `LOGGED ENTRIES (most recent first):\n${JSON.stringify(CANDIDATES)}\n\nRECENT CHAT:\n${chatStr}\n\nAthlete's correction message: ${msg}`;
  return parseJson(await ask(RESOLVE_SYS, user, 1200, "claude-sonnet-5"));
};

const RESOLVE_CASES = [
  {
    name: "Will's real case: strict press 155 → 115",
    msg: "that was a misclick — the strict press top set was 115 not 155",
    check: (p) => {
      if (!p.found) return "expected found:true";
      if (String(p.workout_id) !== ROW_A.id) return `wrong row: ${p.workout_id}`;
      const ed = (p.edits || []).find((e) => /strict press/i.test(e.exercise));
      if (!ed) return "no Strict Press edit";
      if (ed.action !== "update") return `wrong action: ${ed.action}`;
      const sd = ed.new_set_details;
      if (!Array.isArray(sd) || sd.length !== 3) return `bad set_details: ${JSON.stringify(sd)}`;
      const weights = sd.map((s) => s.weight).join("/");
      if (weights !== "95/115/115") return `wrong corrected sets: ${weights}`;
      if (ed.new_weight !== 115) return `wrong top-set weight: ${ed.new_weight}`;
      if ((p.edits || []).length !== 1) return `over-edited: ${JSON.stringify(p.edits)}`;
      return null;
    },
  },
  {
    name: "remove an exercise never done",
    msg: "actually I never did the dips today, take those off",
    check: (p) => {
      if (!p.found) return "expected found:true";
      if (String(p.workout_id) !== ROW_A.id) return `wrong row: ${p.workout_id}`;
      const ed = (p.edits || []).find((e) => /dip/i.test(e.exercise));
      if (!ed || ed.action !== "remove") return `expected remove Dip, got ${JSON.stringify(p.edits)}`;
      if ((p.edits || []).length !== 1) return `over-edited: ${JSON.stringify(p.edits)}`;
      return null;
    },
  },
  {
    name: "cross-row: last week's snatch top single",
    msg: "on that snatch day last week the top single was actually 215 not 225",
    check: (p) => {
      if (!p.found) return "expected found:true";
      if (String(p.workout_id) !== ROW_B.id) return `wrong row: ${p.workout_id}`;
      const ed = (p.edits || []).find((e) => /snatch/i.test(e.exercise));
      if (!ed || ed.action !== "update") return `expected update Snatch, got ${JSON.stringify(p.edits)}`;
      if (ed.new_weight !== 215) return `wrong weight: ${ed.new_weight}`;
      const sd = ed.new_set_details;
      if (Array.isArray(sd) && sd.map((s) => s.weight).join("/") !== "165/185/205/215") return `wrong sets: ${JSON.stringify(sd)}`;
      return null;
    },
  },
  {
    name: "ambiguous target must refuse",
    msg: "the weight I put in on monday was wrong",
    check: (p) => (p.found ? `guessed instead of refusing: ${JSON.stringify(p)}` : null),
  },
  {
    name: "non-log correction (program) must refuse",
    msg: "my program has the wrong bench percentages, should be 75% not 85%",
    check: (p) => (p.found ? `edited the log for a PROGRAM complaint: ${JSON.stringify(p)}` : null),
  },
];

// ── Run ──────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const report = (ok, name, detail) => {
  console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

console.log("── PARSE: correction-intent detection ──");
for (const c of PARSE_CASES) {
  try {
    const p = await parseCall(c.msg);
    const flagged = !!p.log_correction?.is_mistake_fix;
    let err = null;
    if (flagged !== c.correction) err = `is_mistake_fix=${flagged}, expected ${c.correction}`;
    else if (c.correction && (p.exercises || []).length > 0) err = `correction still extracted exercises: ${JSON.stringify(p.exercises.map((e) => e.name))}`;
    else if (c.expectExercises && (p.exercises || []).length === 0) err = "normal log extracted no exercises";
    report(!err, JSON.stringify(c.msg.slice(0, 60)), err);
  } catch (e) { report(false, JSON.stringify(c.msg.slice(0, 60)), e.message); }
}

console.log("── RESOLVE: edit-plan precision ──");
for (const c of RESOLVE_CASES) {
  try {
    const p = await resolveCall(c.msg);
    const err = c.check(p);
    report(!err, c.name, err);
  } catch (e) { report(false, c.name, e.message); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
