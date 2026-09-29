// ─── T67 LOG VOICE PASS — "Joe still says more than the one thing" ───────────
// Evidence, not a gate. Six measured slips on shipped code (09-29, loose-ends
// item 1), each a scenario here, run through the REAL model (/api/claude on
// prod, feature mastermind_chat, toolset mastermind_athlete) as the QA athlete:
//   plan   a log that differs from today's plan: no paragraph about the planned
//          lifts "still sitting there" (the designed skipped-lift question on a
//          session-shaped log is the one exception, and is a control here)
//   pain   a repeat pain mention the day after: no count ("second time")
//   unit   a load whose unit the app is asking about: no restated number, no
//          praise of it, no unit question of Joe's own
//   reps   rep words (single/double/triple) only where the logged reps say so
//   dual   a kg athlete's PR CHECK facts: never a lbs number read back as kg
//   swap   a today-only swap said in chat with no workout started: no program rec
// Each turn's context is assembled the way getJoeBotReply assembles it, from the
// src modules of TWO trees: --before <repo root> (default ~/dev/wt-appstore-1.0,
// main) and --after <repo root> (default this tree). The reply then passes each
// tree's own output gate and tool filter, so "after" measures what ships.
//
//   node scripts/t67-log-voice-pass.mjs --runs 5 --out <file.json> [--only plan,pain]
//   node scripts/t67-log-voice-pass.mjs --out <file.json> --table
//   node scripts/t67-log-voice-pass.mjs --dry            (print both contexts, no calls)
// Credentials: .env.qa (QA_ATHLETE_NAME / QA_ATHLETE_PIN). Refuses anything but
// the QA fixture. Writes no rows (usage_costs only). Hold the fixture lock: the
// AI limiter is per athlete (100 calls / 15 min); the default pace stays under it.

import fs from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "https://app.trainwilco.com");
const RUNS = +arg("runs", 5);
const PACE_MS = +arg("pace", 9800);
const OUT = arg("out", join(os.tmpdir(), "t67-log-voice-pass.json"));
const ONLY = arg("only", null)?.split(",");
const TREES = { before: resolve(arg("before", join(os.homedir(), "dev/wt-appstore-1.0"))), after: resolve(arg("after", here)) };
const VARIANTS = (arg("variants", "before,after")).split(",");

async function loadTree(root) {
  const imp = (p) => import(pathToFileURL(join(root, p)).href);
  const [card, grit, units, tf, pl, gate, pos, pra, cs] = await Promise.all([
    imp("src/ai/card.js"), imp("src/grit.js"), imp("src/units.js"), imp("src/turnFacts.js"), imp("src/painLedger.js"),
    imp("src/replyGate.js"), imp("src/programPosition.js"), imp("src/prAttempts.js"), imp("src/changeScope.js"),
  ]);
  return { root, card, grit, units, tf, pl, gate, pos, pra, cs };
}

// ── the fixture athlete: Olympic weightlifter, kg, 4-day program ─────────────
const NOW = new Date();
const ago = (d, h = 0) => new Date(NOW.getTime() - d * 864e5 - h * 36e5);
const K = (name, loads, reps, extra = {}) => ({ name, unit: "kg", sets: loads.length, reps, weight: Math.max(...loads), set_details: loads.map((w) => ({ weight: w, reps })), ...extra });
const L = (name, sets, reps, weight, extra = {}) => ({ name, unit: "lbs", sets, reps, weight, ...extra });
const PROGRAM = `Block 3 (4 days a week)
Day 1 - Squat
Back Squat 5x3 @ 80%
Front Squat 3x3 @ 70%
Romanian Deadlift 3x6
Day 2 - Pull
Deadlift 3x5 @ 130 kg
Barbell Row 3x8 @ 70 kg
Pull-ups 3x8
Day 3 - Classic
Snatch 6x1 @ 80%
Clean and Jerk 5x1 @ 80%
Day 4 - Press
Bench Press 4x5
Push Press 5x3
Lat raises 3x8`;
const DAYS = ["Squat", "Pull", "Classic", "Press"];
const SESSION = { Squat: "Back Squat 5x3 @ 80%\nFront Squat 3x3 @ 70%\nRomanian Deadlift 3x6", Pull: "Deadlift 3x5 @ 130 kg\nBarbell Row 3x8 @ 70 kg\nPull-ups 3x8", Classic: "Snatch 6x1 @ 80%\nClean and Jerk 5x1 @ 80%", Press: "Bench Press 4x5\nPush Press 5x3\nLat raises 3x8" };
const posFor = (label) => ({ dayTemplate: DAYS, day: DAYS.indexOf(label) + 1, label, sessionText: SESSION[label], hasWeeks: false, weekKnown: false, loggedThisWeek: DAYS.indexOf(label), missedLastWeek: 0 });
const HISTORY = [
  { at: ago(2), exercises: [K("Snatch", [70, 80, 85, 90, 90, 90], 1), K("Clean and Jerk", [100, 110, 115, 115, 115], 1)] },
  { at: ago(4), exercises: [K("Deadlift", [120, 125, 125], 5), K("Barbell Row", [65, 65, 65], 8)] },
  { at: ago(6), exercises: [K("Back Squat", [140, 140, 140, 140, 140], 3), K("Front Squat", [100, 100, 100], 3), K("Romanian Deadlift", [100, 100, 100], 6)] },
  { at: ago(9), exercises: [L("Bench Press", 4, 5, 185), K("Push Press", [60, 70, 80, 85, 85], 3), L("Lat raises", 3, 12, 35, { load_basis: "each" })] },
  { at: ago(11), exercises: [K("Power Clean", [80, 85, 90, 90, 90], 2), L("Curls", 3, 10, 35)] },
].map((r, i) => ({ id: `h${i}`, created_at: r.at.toISOString(), raw_message: r.exercises.map((e) => e.name).join(", "), parsed_data: { exercises: r.exercises, pain_flags: r.pain || [] } }));
// Back Squat's actual max was entered in lbs (340 lbs = 154.2 kg): the "dual" scenario.
const MANUAL = [{ exercise: "Back Squat", weight: 340, unit: "lbs" }, { exercise: "Snatch", weight: 100, unit: "kg" }, { exercise: "Clean and Jerk", weight: 125, unit: "kg" }, { exercise: "Front Squat", weight: 140, unit: "kg" }, { exercise: "Deadlift", weight: 190, unit: "kg" }];

// ── the scenarios ────────────────────────────────────────────────────────────
// {id, cls, day, msg, exercises, pain?, hist?, extraRows?, unitSuspect?, tools?}
const S = [
  { id: "plan_zercher", cls: "plan", day: "Pull", msg: "Zercher squat 3x5 @ 100kg", exercises: [K("Zercher Squat", [100, 100, 100], 5)], unlogged: ["deadlift", "row", "pull-up"] },
  { id: "plan_snatch", cls: "plan", day: "Pull", msg: "Snatch worked up to 100kg today, 80/85/90/95/100", exercises: [K("Snatch", [80, 85, 90, 95, 100], 1)], unlogged: ["deadlift", "row", "pull-up"] },
  { id: "plan_partial", cls: "plan", day: "Pull", msg: "Deadlift 3x5 @ 130kg, moved well", exercises: [K("Deadlift", [130, 130, 130], 5)], unlogged: ["row", "pull-up"] },
  { id: "plan_offday", cls: "plan", day: "Pull", msg: "Power clean 5x2 @ 95kg, curls 3x10 @ 40lbs", exercises: [K("Power Clean", [95, 95, 95, 95, 95], 2), L("Curls", 3, 10, 40)], unlogged: ["deadlift", "row", "pull-up"] },
  { id: "plan_gap_control", cls: "plan_control", day: "Squat", msg: "Back squat 5x3 @ 142.5kg, RDL 3x6 @ 100kg", exercises: [K("Back Squat", [142.5, 142.5, 142.5, 142.5, 142.5], 3), K("Romanian Deadlift", [100, 100, 100], 6)] },
  { id: "pain_repeat", cls: "pain", day: "Classic", msg: "Snatch 6x1 @ 70/80/85/90/90/90kg, knee still a little achy", exercises: [K("Snatch", [70, 80, 85, 90, 90, 90], 1)], pain: [{ area: "knee", description: "knee still a little achy", severity: 1 }],
    extraRows: [{ at: ago(1), msg: "Front squat 3x3 @ 100kg, knee was a bit achy on the last set", exercises: [K("Front Squat", [100, 100, 100], 3)], pain: [{ area: "knee", description: "knee a bit achy on the last set", severity: 1 }] }],
    hist: [["user", "Front squat 3x3 @ 100kg, knee was a bit achy on the last set"], ["assistant", "Front squat 3x3 at 100 kg is logged. Keep an eye on that knee and let me know how it feels next session."]] },
  { id: "unit_ask", cls: "unit", day: "Squat", msg: "Front squat 3x3 @ 225", exercises: [{ ...K("Front Squat", [225, 225, 225], 3), unit_suspect: true }], unitSuspect: [225] },
  { id: "reps_classic", cls: "reps", day: "Classic", msg: "Snatch 6x1 @ 70/80/85/90/92/92kg, clean and jerk 5x1 @ 100/110/115/118/120kg", exercises: [K("Snatch", [70, 80, 85, 90, 92, 92], 1), K("Clean and Jerk", [100, 110, 115, 118, 120], 1)] },
  { id: "reps_front", cls: "reps", day: "Squat", msg: "Front squat 5x2 @ 100/110/120/120/120kg", exercises: [K("Front Squat", [100, 110, 120, 120, 120], 2)] },
  { id: "reps_press", cls: "reps", day: "Press", msg: "Push press 5x3 @ 60/80/90/100/100kg, bench 4x5 @ 185lbs", exercises: [K("Push Press", [60, 80, 90, 100, 100], 3), L("Bench Press", 4, 5, 185)] },
  { id: "dual_squat", cls: "dual", day: "Squat", msg: "Back squat 5x3 @ 145kg, front squat 3x3 @ 105kg", exercises: [K("Back Squat", [145, 145, 145, 145, 145], 3), K("Front Squat", [105, 105, 105], 3)] },
  { id: "swap_today", cls: "swap", day: "Squat", msg: "the squat racks are all taken today, swap my first lift for something I can do with dumbbells", exercises: [], tools: true },
];

const fmt = (e) => {
  if (e.unit === "bodyweight") return `${e.sets}x${e.reps}`;
  const s = e.set_details || Array.from({ length: e.sets || 1 }, () => ({ weight: e.weight, reps: e.reps }));
  return `${s.length}x${s[0]?.reps} @ ${s.map((x) => x.weight).join("/")}${e.unit === "kg" ? "kg" : "lbs"}${e.load_basis === "each" ? " each" : ""}`;
};

// ── the turn, the way getJoeBotReply builds it, from ONE tree's modules ──────
function buildTurn(T, sc) {
  const { grit, units, tf, pl, pos, pra, cs, card } = T;
  const unit = "kg";
  const extra = (sc.extraRows || []).map((r, i) => ({ id: `x${i}`, created_at: r.at.toISOString(), raw_message: r.msg, parsed_data: { exercises: r.exercises, pain_flags: r.pain || [] } }));
  const rows = [...extra, ...HISTORY].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const parsed = { exercises: sc.exercises, pain_flags: sc.pain || [] };
  const past = rows.map((w) => `• ${new Date(w.created_at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}: ${w.parsed_data.exercises.map((e) => `${e.name} ${fmt(e)}`).join(", ")}`).join("\n");
  const lt = pl.ledgerTurn({ rows, marks: {}, legacyResolved: [], protects: [], now: NOW, message: sc.msg, parsed });
  const byLift = new Map();
  rows.forEach((w) => w.parsed_data.exercises.forEach((e) => {
    const id = grit.resolveLift(e.name).id;
    if (!byLift.has(id)) byLift.set(id, { name: e.name, date: new Date(w.created_at), detail: fmt(e), ex: e });
  }));
  const lastLines = [...byLift.values()].map((r) => `${r.name} — last done ${r.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${r.detail}`);
  const byEx = {};
  rows.forEach((w) => w.parsed_data.exercises.forEach((ex) => { const e1 = grit.bestE1RMForExercise(ex, 185); if (!e1) return; const l = grit.resolveLift(ex.name); if (!byEx[l.id] || e1 > byEx[l.id].e1rm) byEx[l.id] = { name: l.name, e1rm: e1 }; }));
  MANUAL.forEach((m) => { byEx[grit.resolveLift(m.exercise).id] = { name: m.exercise, e1rm: units.toLbs(m.weight, m.unit), actual: true }; });
  // KNOWN 1RMs: the tree's own formatter when it has one, else main's inline lbs lines
  const rmRows = Object.values(byEx).sort((a, b) => b.e1rm - a.e1rm).slice(0, 15);
  const rm = typeof grit.knownMaxLines === "function" ? grit.knownMaxLines(rmRows, unit).join("\n")
    : rmRows.map((r) => `${r.name}: ${r.actual ? `${Math.round(r.e1rm)} lbs (actual 1RM)` : `~${Math.round(r.e1rm)} lbs (est.)`}`).join("\n");
  const logExercises = tf.logTurnExercises(parsed, unit);
  const isLogTurn = logExercises.length > 0;
  let prCheck = "";
  let prLines = [];
  if (isLogTurn) {
    prLines = grit.prCheckLines(logExercises, byEx, unit);
    if (prLines.length) prCheck = `\n\nPR CHECK — THIS MESSAGE'S LOG (computed by the app from their records; these verdicts are FINAL — never re-derive, re-convert, or re-compare the numbers yourself):\n${tf.prLinesForReply(prLines, logExercises).map((l) => `- ${l}`).join("\n")}\nA line marked NEW PR is confirmed above their previous best: when it is the headline, celebrate it genuinely and specifically, scaled to how central that lift is to their sport (a weightlifter's snatch or clean and jerk PR is a headline day, not a footnote). Never describe a NEW PR weight as under, below, or "right under" anything.`;
    const perf = tf.performedBlock(logExercises, { displayUnit: unit, planText: PROGRAM });
    if (perf) prCheck += `\n\n${perf}`;
  }
  const unitCheck = pra.unitCheckFact(parsed);
  const p = posFor(sc.day);
  const posBlock = pos.positionBlock(p);
  const positionContext = `\n\nWHERE THE ATHLETE IS IN THEIR PROGRAM (resolved by the app — treat as authoritative):\n${posBlock}\nWhen giving today's session, use THIS position. Do NOT re-derive the day by counting sessions or reading the program's printed dates. This block is computed FRESH for this message and SUPERSEDES anything earlier in the conversation — including your own previous replies. If you stated a different week or day earlier, that statement is stale: answer from THIS position without mentioning or explaining the correction. Never ask the athlete where they are in the week when this block is present; the app already knows.`;
  // the change-scope fact, in trees that have one
  const messages = [...(sc.hist || []).map(([role, content]) => ({ role, content, at: NOW.getTime() - 20 * 3600e3 })), { role: "user", content: sc.msg, at: NOW.getTime() }];
  const scope = cs.conversationScope({ messages, now: NOW });
  const scopeFact = typeof cs.changeScopeFact === "function" ? cs.changeScopeFact({ scope, message: sc.msg, isLogTurn }) : "";
  const programContext = `\n\nATHLETE'S CURRENT PROGRAM:\n${PROGRAM}\nReference this when giving programming feedback.`;
  let logFocus = "";
  let headline = null;
  if (isLogTurn) {
    const planDay = tf.planDayFor({ programText: PROGRAM, loggedNames: logExercises.map((e) => e.name), resolverLabel: p.label, week: null });
    headline = tf.logHeadline({ exercises: logExercises, prLines, lastDone: byLift, painTurn: lt.turn, planDay, sport: "Olympic Weightlifting", displayUnit: unit, now: NOW, todayPlanText: p.sessionText });
    logFocus = `\n\n${tf.logFocusBlock(headline)}`;
  }
  const sys = `TODAY'S DATE: ${NOW.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}, ${NOW.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
Athlete: Will, Sport: Olympic Weightlifting
GOAL: Get as strong as possible on the competition lifts.
SPORT: Snatch and clean technique, posterior chain, mobility, overhead stability.
ACCOUNT FACTS: coach linked: no · program locked: no · display unit: kg
This athlete works in KG. State every weight you say in kg (logged data below may carry lbs labels — convert exactly, 1 kg = 2.20462 lbs, and round working weights to 2.5 kg).

ATHLETE WORKOUT HISTORY (most recent first):
${past}
When asked what they did on a specific day or recently, reference these exact dates and numbers.

${pl.ledgerBlock(lt.records, { protects: [], turn: lt.turn })}

LAST TIME PER EXERCISE (resolved by the app from their full log — authoritative):
${lastLines.join("\n")}

KNOWN 1RMs (an "actual 1RM" is the athlete's real recorded max and ALWAYS outranks an "est." entry; use ONLY to turn a program percentage or RPE target into a weight):
${rm}${prCheck}${unitCheck ? `\n\n${unitCheck}` : ""}${programContext}${positionContext}${scopeFact ? `\n\n${scopeFact}` : ""}

ATHLETE GOALS: Snatch 105 kg by December | Clean and jerk 130 kg${logFocus}`;
  const hist = (sc.hist || []).map(([r, c]) => `${r === "user" ? "Will" : "Coach Joe"}: ${c}`).join("\n");
  return { system: sys, user: `${hist}\n\nWill: ${sc.msg}`, static: card.buildMastermindStatic(), headline, prLines, scope, lt, logExercises };
}

// ── after the reply: each tree's own tool filter and output gate ─────────────
function settle(T, sc, turn, text, toolCalls) {
  const { pl, cs, gate } = T;
  let calls = toolCalls.slice();
  const dropped = [];
  if (calls.some((c) => c.name === "propose_program_rec")) {
    const painOk = pl.keepPainRec(turn.lt.turn, sc.msg);
    const scopeOk = typeof cs.keepRecOnScope === "function" ? cs.keepRecOnScope(turn.scope, sc.msg) : true;
    if (!painOk || !scopeOk) { calls = calls.filter((c) => c.name !== "propose_program_rec"); dropped.push(!painOk ? "pain" : "scope"); }
  }
  const ctx = { toolCalls: calls, appWrites: { program: false, rec: false }, record: false };
  // gate context the newer tree reads (older trees ignore unknown fields)
  ctx.turn = { painAreas: turn.lt.turn?.areas || [], unitPending: (sc.exercises || []).filter((e) => e.unit_suspect).map((e) => ({ exercise: e.name, weight: e.weight })), performed: turn.logExercises };
  const g = gate.replyGate("chat", text, ctx);
  return { text: g.text, removed: g.removed, calls, dropped };
}

// ── invariants ───────────────────────────────────────────────────────────────
const REP_N = { single: 1, double: 2, triple: 3 };
const PRAISE = /\b(nice|solid|strong|great|big|good (?:work|job|stuff)|well done|love (?:it|that|to see)|moving up|crushed|beast|impressive|awesome|clean work|money)\b/i;
function invariants(sc, turn, reply, calls) {
  const out = {};
  const paras = reply.split(/\n\s*\n/).filter((x) => x.trim()).length;
  out.paragraphs = paras;
  if (sc.unlogged) {
    const named = sc.unlogged.filter((l) => new RegExp(`\\b${l}s?\\b`, "i").test(reply));
    out.planQuiet = !named.length && !/\bstill (?:sitting|there|waiting|on (?:the|today))|whenever you(?:'re| are) ready|knock (?:those|them|that) out|rest of (?:the|today's) (?:session|plan|pull)/i.test(reply);
  }
  if (sc.cls === "plan_control") out.oneQuestion = (reply.match(/\?/g) || []).length <= 1;
  if (sc.cls === "pain") out.noCount = !/\b(?:second|third|fourth|2nd|3rd|4th)\s+(?:time|day|session|mention|straight)|\btwice\b|\b(?:two|three|\d+)\s+(?:times|days|sessions)\s+(?:in a row|straight|running)|\bback[- ]to[- ]back\b/i.test(reply);
  if (sc.unitSuspect) {
    out.noRestate = !sc.unitSuspect.some((n) => new RegExp(`(?<![\\d.])${n}(?![\\d])`).test(reply));
    out.noPraise = !PRAISE.test(reply);
    out.noUnitQ = !(reply.split(/(?<=[.!?])\s+|\n+/).some((s) => /\?\s*$/.test(s) && /\b(kgs?|kilos?|lbs?|pounds?|units?)\b/i.test(s)));
  }
  // rep words only where some logged set has that many reps (every log scenario)
  if (turn.logExercises.length) {
    const reps = new Set(turn.logExercises.flatMap((e) => (e.set_details || [{ reps: e.reps }]).map((s) => s.reps)));
    const words = [...reply.matchAll(/\b(single|double|triple)s?\b(?!-| (?:leg|arm|day|session|rep\b|digit))/gi)].map((m) => REP_N[m[1].toLowerCase()]);
    out.repsTrue = words.every((n) => reps.has(n));
  }
  if (sc.cls === "dual" || turn.prLines.some((l) => / lbs\)/.test(l))) {
    const lbsNums = [...turn.prLines.join(" ").matchAll(/(\d+(?:\.\d+)?) lbs/g)].map((m) => m[1]);
    out.noLbsAsKg = !lbsNums.some((n) => new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}\\s*(?:kg|kilo)`, "i").test(reply));
  }
  if (sc.tools) out.noRec = !calls.some((c) => c.name === "propose_program_rec");
  return out;
}

// ── plumbing ─────────────────────────────────────────────────────────────────
const env = Object.fromEntries(fs.readFileSync(join(here, ".env.qa"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim()]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  if (!r.ok) throw new Error(`${path} ${r.status}: ${t.slice(0, 200)}`);
  return j;
}

async function main() {
  const trees = {};
  for (const v of VARIANTS) trees[v] = await loadTree(TREES[v]);
  const scen = S.filter((s) => !ONLY || ONLY.includes(s.cls) || ONLY.includes(s.id));
  if (process.argv.includes("--dry")) {
    for (const sc of scen) for (const v of VARIANTS) { const t = buildTurn(trees[v], sc); console.log(`\n===== ${sc.id} [${v}] headline=${t.headline?.kind || "-"} scope=${t.scope.signal}/${t.scope.source}\n${t.system.split("\n\nKNOWN 1RMs")[1] || ""}`); }
    return;
  }
  const login = await post("/api/identity", { action: "athlete-login", name: env.QA_ATHLETE_NAME, pin: env.QA_ATHLETE_PIN });
  if (!login?.token || login?.athlete?.id !== "99999999-9999-4999-8999-999999999999") throw new Error("refusing: not the QA fixture");
  const auth = { role: "athlete", id: login.athlete.id, token: login.token };
  const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
  const done = new Set(results.filter((r) => !r.err).map((r) => `${r.id}|${r.variant}|${r.run}`));
  for (let run = 0; run < RUNS; run++) {
    for (const sc of scen) {
      for (const v of VARIANTS) {
        if (done.has(`${sc.id}|${v}|${run}`)) continue;
        const turn = buildTurn(trees[v], sc);
        let text = "", calls = [], err = null;
        for (let attempt = 0; attempt < 3 && !text && !calls.length; attempt++) {
          try {
            const r = await post("/api/claude", { auth, model: "claude-sonnet-5", max_tokens: 900, system: turn.system, system_cached: turn.static, messages: [{ role: "user", content: turn.user }], feature: "mastermind_chat", toolset: "mastermind_athlete" });
            const content = r?.content || [];
            text = content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
            calls = content.filter((c) => c.type === "tool_use").map((c) => ({ name: c.name, input: c.input }));
          } catch (e) { err = e.message; if (/429/.test(err)) await sleep(90000); else await sleep(4000); }
        }
        const st = settle(trees[v], sc, turn, text, calls);
        const i = results.findIndex((r) => r.id === sc.id && r.variant === v && r.run === run);
        const rec = { id: sc.id, cls: sc.cls, variant: v, run, headline: turn.headline?.kind || null, raw: text, reply: st.text, removed: st.removed, rawCalls: calls.map((c) => c.name), calls: st.calls.map((c) => c.name), dropped: st.dropped, words: trees[v].gate.countWords(st.text), inv: (text || calls.length) ? invariants(sc, turn, st.text, st.calls) : null, rawInv: (text || calls.length) ? invariants(sc, turn, text, calls) : null, err: (text || calls.length) ? null : err };
        if (i >= 0) results[i] = rec; else results.push(rec);
        fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
        console.log(`${run + 1}/${RUNS} ${sc.id} ${v}: ${rec.words}w calls=[${rec.rawCalls.join(",")}]${rec.err ? ` ERR ${rec.err}` : ""} ${JSON.stringify(rec.inv)}`);
        await sleep(PACE_MS);
      }
    }
  }
  console.log("\n" + table(results));
}

export function table(results) {
  const rows = ["| Scenario | variant | n | words median / max | paragraphs max | invariant fails (raw model → after gate/filter) |", "|---|---|---|---|---|---|"];
  for (const sc of S) for (const v of VARIANTS) {
    const rs = results.filter((r) => r.id === sc.id && r.variant === v && r.inv);
    if (!rs.length) continue;
    const keys = Object.keys(rs[0].inv).filter((k) => k !== "paragraphs");
    const f = keys.map((k) => `${k} ${rs.filter((r) => r.rawInv && r.rawInv[k] === false).length}→${rs.filter((r) => r.inv[k] === false).length}`).join(", ");
    rows.push(`| ${sc.id} | ${v} | ${rs.length} | ${median(rs.map((r) => r.words))} / ${Math.max(...rs.map((r) => r.words))} | ${Math.max(...rs.map((r) => r.inv.paragraphs))} | ${f} |`);
  }
  rows.push(`Runs: ${results.length}. Errors: ${results.filter((r) => r.err).length}.`);
  return rows.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--table")) console.log(table(JSON.parse(fs.readFileSync(OUT, "utf8"))));
  else main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
