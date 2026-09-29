// ─── LOG FOCUS BEFORE / AFTER (T64 S5) ───────────────────────────────────────
// Evidence for Will, not a gate. Sibling of scripts/voice-before-after.mjs (S4),
// which showed the voice manner moved one-word replies (41 -> 13 median words)
// but NOT replies to logs. This one measures LOG turns only, with the log-turn
// context assembled the way getJoeBotReply assembles it: the real card static
// (buildMastermindStatic), the real PR CHECK verdicts (prCheckLines), the real
// PERFORMED block, the real pain ledger block and turn, the LAST TIME index,
// known 1RMs, the program and the history. Two variants per call:
//   before = integration as-is (PR CHECK "... then coach", no focus block)
//   after  = this branch (PR CHECK without "then coach" + LOG REPLY FOCUS)
// Five classes: short log, long log, PR log, a log with a question in it, a log
// asking for a full breakdown. N runs each input. Median and max reply words
// per class; invariants checked per reply. No target number.
//
// Runs through local dev (vite proxies /api to prod) as the QA athlete, under
// the fixture lock. Paced to stay inside the /api/claude limiter.
//   npx vite --port 5197 --strictPort &
//   node scripts/log-focus-before-after.mjs --base http://localhost:5197 --runs 5 --out <file.json>
//   node scripts/log-focus-before-after.mjs --out <file.json> --table
// Credentials come from .env.qa; refuses anything but the QA fixture.

import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMastermindStatic } from "../src/ai/card.js";
import { replyGate, hasBannedWord, countWords } from "../src/replyGate.js";
import { prCheckLines, bestE1RMForExercise, resolveLift, getExerciseSets } from "../src/grit.js";
import { toLbs } from "../src/units.js";
import { performedBlock, logHeadline, logFocusBlock, planDayFor, isMainLift, prLinesForReply } from "../src/turnFacts.js";
import { ledgerTurn, ledgerBlock } from "../src/painLedger.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "http://localhost:5197");
const RUNS = +arg("runs", 5);
const PACE_MS = +arg("pace", 9500);
const OUT = arg("out", join(os.tmpdir(), "log-focus-before-after.json"));
const ONLY = arg("only", null);

// ── the fixture athlete (Olympic weightlifter, kg), identical for both variants
const NOW = new Date();
const ago = (d, h = 0) => new Date(NOW.getTime() - d * 864e5 - h * 36e5);
const K = (name, loads, reps, extra = {}) => ({ name, unit: "kg", sets: loads.length, reps, weight: Math.max(...loads), set_details: loads.map((w) => ({ weight: w, reps })), ...extra });
const L = (name, sets, reps, weight, extra = {}) => ({ name, unit: "lbs", sets, reps, weight, ...extra });
const BW = (name, sets, reps) => ({ name, unit: "bodyweight", sets, reps });
const HISTORY = [
  { at: ago(2), exercises: [K("Snatch", [70, 80, 85, 90, 90, 90], 1), K("Clean and Jerk", [100, 110, 115, 115, 115], 1)] },
  { at: ago(5), exercises: [K("Behind the Neck Snatch Grip Push Press", [60, 70, 80, 90, 95], 2), K("Split Jerk from Rack", [100, 105, 110, 110], 1), K("Push Press", [60, 70, 80, 85, 85], 3), L("Lat raises", 3, 12, 35, { load_basis: "each" })] },
  { at: ago(7), exercises: [K("Front Squat", [100, 110, 120, 120, 120], 2), K("Snatch Pull", [110, 120, 120, 120], 2), BW("Back Extensions", 3, 10)] },
  { at: ago(9), exercises: [K("Back Squat", [150, 150, 150, 150, 150], 3), K("Romanian Deadlift", [100, 100, 100], 6)] },
  { at: ago(14), exercises: [K("Front Squat", [100, 110, 115, 115, 115], 2)], pain: [{ area: "knee", description: "knee a little achy", severity: 1 }] },
].map((r, i) => ({ id: `h${i}`, created_at: r.at.toISOString(), raw_message: r.exercises.map((e) => e.name).join(", "), parsed_data: { exercises: r.exercises, pain_flags: r.pain || [] } }));
const MANUAL = [{ exercise: "Back Squat", weight: 180, unit: "kg" }, { exercise: "Snatch", weight: 100, unit: "kg" }, { exercise: "Clean and Jerk", weight: 125, unit: "kg" }, { exercise: "Front Squat", weight: 140, unit: "kg" }];
const PROGRAM = `Block 2 (4 days a week)
Day 1 - Front Squat / Pulls
Front Squat 5x2 @ 75-80%
Snatch Pull 4x2 @ 110-120kg
Back Extensions 3x10
Day 2 - Upper
Behind the Neck Snatch Grip Push Press 5x2
Split Jerk from Rack 4x1 @ 80%
Push Press 5x3
Lat raises 3x8
Day 3 - Classic
Snatch 6x1 @ 80%
Clean and Jerk 5x1 @ 80%
Day 4 - Squat
Back Squat 5x3 @ 80%
Romanian Deadlift 3x6`;

// ── the inputs: [class, message, parsed exercises, pain_flags, source]
const INPUTS = [
  ["short_log", "Back squat 5x3 at 155kg, RDL 3x6 at 100", [K("Back Squat", [155, 155, 155, 155, 155], 3), K("Romanian Deadlift", [100, 100, 100], 6)]],
  ["short_log", "Front squat 5x2 @ 100/110/120/120/120, snatch pull 4x2 @ 110/120/120/120, back extensions 3x10", [K("Front Squat", [100, 110, 120, 120, 120], 2), K("Snatch Pull", [110, 120, 120, 120], 2), BW("Back Extensions", 3, 10)], [], "nothing notable"],
  ["long_log", "Behind the Neck Snatch Grip Push Press 5x3 @ 60/80/90/100/100kg\nPush Press 5x3 @ 60/70/80/90/90kg\nLat raises 3x8 @ 40lbs", [K("Behind the Neck Snatch Grip Push Press", [60, 80, 90, 100, 100], 3), K("Push Press", [60, 70, 80, 90, 90], 3), L("Lat raises", 3, 8, 40, { load_basis: "each" })], [], "screenshot 5"],
  ["long_log", "Day 1 – Front Squat/Pulls\n\nFront Squat 2x1 @ 100/120 (my knees were on fire so I stopped) \nSnatch Pull 4x2 @ 110/120/120/120\nBack Extensions 3x10 @ 90lbs", [K("Front Squat", [100, 120], 1), K("Snatch Pull", [110, 120, 120, 120], 2), L("Back Extensions", 3, 10, 90)], [{ area: "knees", description: "knees on fire, stopped front squats", severity: 3, character: "burning", onset: "gradual", during: "Front Squat" }], "screenshot 2"],
  ["pr_log", "Hit a 102kg snatch today, new PR", [K("Snatch", [102], 1)]],
  ["pr_log", "Clean and jerk 128kg!! first time over 125", [K("Clean and Jerk", [128], 1)]],
  ["question", "Back squat 5x3 @ 155kg, RDL 3x6 @ 100. Should I go up again next week or hold here?", [K("Back Squat", [155, 155, 155, 155, 155], 3), K("Romanian Deadlift", [100, 100, 100], 6)]],
  ["question", "Snatch 6x1 up to 92kg (70/80/85/90/92/92), felt slow off the floor. What should I fix?", [K("Snatch", [70, 80, 85, 90, 92, 92], 1), K("Clean and Jerk", [100, 110, 115, 115, 115], 1)]],
  ["breakdown", "Front squat 5x2 @ 100/110/120/125/125kg. Give me a full breakdown of how this compares to my last few weeks and what it means for my front squat max", [K("Front Squat", [100, 110, 120, 125, 125], 2)]],
  ["breakdown", "Clean and Jerk 5x1 @ 100/110/115/118/120kg. Walk me through everything you see in this session, set by set, in detail", [K("Clean and Jerk", [100, 110, 115, 118, 120], 1), K("Snatch", [70, 80, 85, 90, 90, 90], 1)]],
];

// ── the log-turn tail, the way getJoeBotReply builds it ──────────────────────
const fmt = (e) => {
  const s = getExerciseSets(e);
  if (e.unit === "bodyweight") return `${e.sets}x${e.reps}`;
  return `${s.length}x${s[0]?.reps} @ ${s.map((x) => x.weight).join("/")}${e.unit === "kg" ? "kg" : "lbs"}${e.load_basis === "each" ? " each" : ""}`;
};
const OLD_PR_TAIL = `A line marked NEW PR is confirmed above their previous best: open the reply with genuine, specific celebration scaled to how central that lift is to their sport (a weightlifter's snatch or clean and jerk PR is a headline day, not a footnote), then coach. Never describe a NEW PR weight as under, below, or "right under" anything.`;
const NEW_PR_TAIL = `A line marked NEW PR is confirmed above their previous best: when it is the headline, celebrate it genuinely and specifically, scaled to how central that lift is to their sport (a weightlifter's snatch or clean and jerk PR is a headline day, not a footnote). Never describe a NEW PR weight as under, below, or "right under" anything.`;

function buildTurn(input) {
  const [, msg, exercises, painFlags = []] = input;
  const unit = "kg";
  const past = HISTORY.map((w) => `• ${new Date(w.created_at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}: ${w.parsed_data.exercises.map((e) => `${e.name} ${fmt(e)}`).join(", ")}`).join("\n");
  const parsed = { exercises, pain_flags: painFlags };
  const lt = ledgerTurn({ rows: HISTORY, marks: {}, legacyResolved: [], protects: [], now: NOW, message: msg, parsed });
  const byLift = new Map();
  [...HISTORY].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).forEach((w) => w.parsed_data.exercises.forEach((e) => {
    const id = resolveLift(e.name).id;
    if (!byLift.has(id)) byLift.set(id, { name: e.name, date: new Date(w.created_at), detail: fmt(e), ex: e });
  }));
  const lastLines = [...byLift.values()].map((r) => `${r.name} — last done ${r.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${r.detail}`);
  const byEx = {};
  HISTORY.forEach((w) => w.parsed_data.exercises.forEach((ex) => { const e1 = bestE1RMForExercise(ex, 185); if (!e1) return; const l = resolveLift(ex.name); if (!byEx[l.id] || e1 > byEx[l.id].e1rm) byEx[l.id] = { name: l.name, e1rm: e1 }; }));
  MANUAL.forEach((m) => { byEx[resolveLift(m.exercise).id] = { name: m.exercise, e1rm: toLbs(m.weight, m.unit), actual: true }; });
  const rm = Object.values(byEx).sort((a, b) => b.e1rm - a.e1rm).slice(0, 15).map((r) => `${r.name}: ${r.actual ? `${Math.round(r.e1rm)} lbs (actual 1RM)` : `~${Math.round(r.e1rm)} lbs (est.)`}`).join("\n");
  const prLines = prCheckLines(exercises, byEx, unit);
  const perf = performedBlock(exercises, { displayUnit: unit, planText: PROGRAM });
  const prBlock = (tail, lines = prLines) => lines.length ? `\n\nPR CHECK — THIS MESSAGE'S LOG (computed by the app from their records; these verdicts are FINAL — never re-derive, re-convert, or re-compare the numbers yourself):\n${lines.map((l) => `- ${l}`).join("\n")}\n${tail}` : "";
  const head = `TODAY'S DATE: ${NOW.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
Athlete: Will, Sport: Olympic Weightlifting
GOAL: Get as strong as possible on the competition lifts.
SPORT: Snatch and clean technique, posterior chain, mobility, overhead stability.
ACCOUNT FACTS: coach linked: no · program locked: no · display unit: kg
This athlete works in KG. State every weight you say in kg (logged data below may carry lbs labels — convert exactly, 1 kg = 2.20462 lbs, and round working weights to 2.5 kg).

ATHLETE WORKOUT HISTORY (most recent first):
${past}
When asked what they did on a specific day or recently, reference these exact dates and numbers.

${ledgerBlock(lt.records, { protects: [], turn: lt.turn })}

LAST TIME PER EXERCISE (resolved by the app from their full log — authoritative):
${lastLines.join("\n")}
When they ask what they did for an exercise, answer from THIS list (or the dated history above): state the date and numbers plainly, one sentence.

KNOWN 1RMs (an "actual 1RM" is the athlete's real recorded max and ALWAYS outranks an "est." entry; use ONLY to turn a program percentage or RPE target into a weight):
${rm}`;
  const tailCommon = `${perf ? `\n\n${perf}` : ""}\n\nATHLETE'S CURRENT PROGRAM:\n${PROGRAM}\nReference this when giving programming feedback.\n\nATHLETE GOALS: Snatch 105 kg by December | Clean and jerk 130 kg`;
  const planDay = planDayFor({ programText: PROGRAM, loggedNames: exercises.map((e) => e.name) });
  const headline = logHeadline({ exercises, prLines, lastDone: byLift, painTurn: lt.turn, planDay, sport: "Olympic Weightlifting", displayUnit: unit, now: NOW });
  return {
    before: `${head}${prBlock(OLD_PR_TAIL)}${tailCommon}`,
    after: `${head}${prBlock(NEW_PR_TAIL, prLinesForReply(prLines, exercises))}${tailCommon}\n\n${logFocusBlock(headline)}`,
    headline, prLines, exercises,
  };
}

// ── invariants per reply ─────────────────────────────────────────────────────
const REP_WORD = /\b(single|double|triple)s?\b/i;
function invariants(input, turn, text) {
  const [cls, msg, exercises] = input;
  const out = {};
  out.banned = !hasBannedWord(text);
  // an accessory's estimated max, unprompted
  const acc = exercises.filter((e) => !isMainLift(e.name)).map((e) => e.name.toLowerCase().split(/\s+/).pop().replace(/s$/, ""));
  out.noAccessoryEstimate = !acc.some((a) => new RegExp(`${a}[^.]*\\b(estimat|e1rm|max)`, "i").test(text) || new RegExp(`\\b(estimat|e1rm)[^.]*${a}`, "i").test(text));
  // PR log names the PR with its number
  if (turn.headline.kind === "pr") {
    const top = exercises[0];
    out.prNamed = /\bPRs?\b|personal (best|record)|new best|all-time|lifetime best|(?:over|past|above|beat) (?:your )?(?:old|previous|last) (?:best|max)/i.test(text) && text.includes(String(top.weight));
  }
  // reps never misstated: no single/double/triple word unless every logged set of that shape agrees
  const repsSet = new Set(exercises.flatMap((e) => getExerciseSets(e).map((s) => s.reps)));
  const m = text.match(REP_WORD);
  out.repsTrue = !m || ({ single: 1, double: 2, triple: 3 }[m[1].toLowerCase()] && repsSet.has({ single: 1, double: 2, triple: 3 }[m[1].toLowerCase()]));
  // nothing-notable: no invented observation (no progress/PR/plan/pain claims)
  if (turn.headline.kind === "none" && !/\?/.test(msg)) out.noInvention = !/\b(PR|up from|jump|more than last|heavier than|progress|climb|stronger|missing|skipp|knee|pain|estimat)\b/i.test(text);
  return out;
}

const env = Object.fromEntries(fs.readFileSync(join(root, ".env.qa"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim()]));
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
  const login = await post("/api/identity", { action: "athlete-login", name: env.QA_ATHLETE_NAME, pin: env.QA_ATHLETE_PIN });
  if (!login?.token || !login?.athlete?.id) throw new Error("QA login failed");
  if (login.athlete.id !== "99999999-9999-4999-8999-999999999999") throw new Error("refusing: not the QA fixture");
  const auth = { role: "athlete", id: login.athlete.id, token: login.token };
  const STATIC = buildMastermindStatic();
  const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
  const done = new Set(results.map((r) => `${r.idx}|${r.variant}|${r.run}`));
  for (let run = 0; run < RUNS; run++) {
    for (let idx = 0; idx < INPUTS.length; idx++) {
      const input = INPUTS[idx];
      if (ONLY && input[0] !== ONLY) continue;
      const turn = buildTurn(input);
      for (const variant of ["before", "after"]) {
        if (done.has(`${idx}|${variant}|${run}`)) continue;
        let text = "", err = null;
        for (let attempt = 0; attempt < 3 && !text; attempt++) {
          try {
            const r = await post("/api/claude", { auth, model: "claude-sonnet-5", max_tokens: 900, system: turn[variant], system_cached: STATIC, messages: [{ role: "user", content: `\n\nWill: ${input[1]}` }], feature: "mastermind_chat" });
            text = (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
          } catch (e) { err = e.message; if (/429/.test(err)) await sleep(60000); else await sleep(3000); }
        }
        const gated = replyGate("chat", text).text;
        results.push({ idx, cls: input[0], src: input[4] || null, variant, run, headline: turn.headline, athleteWords: countWords(input[1]), replyWords: countWords(gated), reply: gated, inv: text ? invariants(input, turn, gated) : null, err: text ? null : err });
        fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
        console.log(`${run + 1}/${RUNS} #${idx} ${input[0]} ${variant}: ${countWords(gated)} words${text ? "" : ` ERR ${err}`}`);
        await sleep(PACE_MS);
      }
    }
  }
  console.log("\n" + table(results));
}

export function table(results) {
  const classes = [...new Set(INPUTS.map((i) => i[0]))];
  const rows = ["| Class | inputs x runs | athlete words (median) | BEFORE median / max | AFTER median / max |", "|---|---|---|---|---|"];
  const st = (rs) => `${median(rs.map((r) => r.replyWords))} / ${Math.max(0, ...rs.map((r) => r.replyWords))}`;
  for (const c of [...classes, "ALL"]) {
    const rs = results.filter((r) => (c === "ALL" || r.cls === c) && r.replyWords > 0);
    const b = rs.filter((r) => r.variant === "before"), a = rs.filter((r) => r.variant === "after");
    const aw = median(INPUTS.filter((i) => c === "ALL" || i[0] === c).map((i) => countWords(i[1])));
    rows.push(`| ${c} | ${new Set(rs.map((r) => r.idx)).size} x ${Math.max(0, ...rs.map((r) => r.run)) + 1} | ${aw} | ${st(b)} | ${st(a)} |`);
  }
  // invariants recomputed from the stored replies (so a checker fix applies to old runs)
  const turns = INPUTS.map((inp) => buildTurn(inp));
  for (const r of results) if (r.reply) r.inv = invariants(INPUTS[r.idx], turns[r.idx], r.reply);
  rows.push("", "Invariants (fails / checked):");
  for (const v of ["before", "after"]) {
    const rs = results.filter((r) => r.variant === v && r.inv);
    const keys = [...new Set(rs.flatMap((r) => Object.keys(r.inv)))];
    rows.push(`- ${v}: ${keys.map((k) => { const c = rs.filter((r) => k in r.inv); return `${k} ${c.filter((r) => !r.inv[k]).length}/${c.length}`; }).join(", ")}`);
  }
  rows.push(`Runs: ${results.length}. Errors: ${results.filter((r) => r.err).length}.`);
  return rows.join("\n");
}

export { buildTurn, INPUTS };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--table")) console.log(table(JSON.parse(fs.readFileSync(OUT, "utf8"))));
  else if (process.argv.includes("--dry")) INPUTS.forEach((inp, i) => { const t = buildTurn(inp); console.log(`#${i} ${inp[0]} -> ${t.headline.kind}: ${t.headline.line}${t.headline.alsoAsk ? ` | ASK ${t.headline.alsoAsk}` : ""}`); });
  else main().catch((e) => { console.error(e.message); process.exit(1); });
}
