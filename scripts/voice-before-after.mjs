// ─── VOICE BEFORE / AFTER (T64 S4, Part 4) ───────────────────────────────────
// Evidence for Will, not a gate: 20 fixed athlete inputs (short log, long log,
// PR log, a why-question, a request for detail, a one-word message, a
// complaint, a check-in answer; Will's real messages from screenshots 2, 5, 7
// and 8 included) run through the REAL model with the OLD voice (TIER1 from
// origin/main's card) and the NEW one (src/ai/voice.js), same context, same
// rest of the card, N runs each. Reports median and max reply words per input
// class and the ratio of reply words to athlete words. There is no target
// number; the table is evidence.
//
// Runs through local dev (vite proxies /api to prod) as the QA athlete, under
// the fixture lock. Paced to stay inside the /api/claude limiter (100 / 15 min).
//   npx vite --port 5194 --strictPort &
//   node scripts/voice-before-after.mjs --base http://localhost:5194 --runs 3 --out <file.json>
// Credentials come from .env.qa (QA_ATHLETE_NAME / QA_ATHLETE_PIN); never a
// real athlete.

import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TIER1_JOE, SYSTEM_CARD_ATHLETE, MECHANICS } from "../src/ai/card.js";
import { replyGate, hasBannedWord, countWords } from "../src/replyGate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "http://localhost:5194");
const RUNS = +arg("runs", 3);
const PACE_MS = +arg("pace", 9500);
const OUT = arg("out", join(os.tmpdir(), "voice-before-after.json"));
const ONLY = arg("only", null);

// ── the two voices, same rest of the card ────────────────────────────────────
function oldTier1() {
  const src = execSync("git show origin/main:src/ai/card.js", { cwd: root, encoding: "utf8" })
    .replace(/from "\.\.\/flags\.js"/, `from "${pathToFileURL(join(root, "src/flags.js")).href}"`);
  const tmp = join(os.tmpdir(), `card-old-${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  return import(pathToFileURL(tmp).href).then((m) => { fs.unlinkSync(tmp); return m.TIER1_JOE; });
}
const staticWith = (tier1) => `${tier1}\n\n${SYSTEM_CARD_ATHLETE}\n\n${MECHANICS}`;

// ── the fixed context (a realistic athlete; identical for both voices) ───────
const CONTEXT = `SESSION CONTEXT (computed by the app for THIS message):
Athlete name: Will. Sport: Olympic Weightlifting. Units: kg for barbell lifts. Bodyweight 185 lbs.
ACCOUNT FACTS: PROGRAM LOCKED: no. Tier: pro.
WHERE THE ATHLETE IS IN THEIR PROGRAM: Block 2, Week 2, Day 1 of 4 (resolved by the app).
CURRENT PROGRAM (excerpt):
Day 1 - Front Squat / Pulls: Front Squat 5x2 @ 75-80%, Snatch Pull 4x2 @ 110-120kg, Back Extensions 3x10
Day 2 - Upper: Behind the Neck Snatch Grip Push Press 5x2, Push Press 5x3, Lat raises 3x8
Day 3 - Classic: Snatch 6x1 @ 80%, Clean and Jerk 5x1 @ 80%
Day 4 - Back Squat 5x3 @ 80%, RDL 3x6
ATHLETE WORKOUT HISTORY (most recent first):
• Friday Sep 25: Snatch 6x1 @ 90kg, Clean and Jerk 5x1 @ 115kg
• Wednesday Sep 23: Behind the Neck Snatch Grip Push Press 5x2 @ 60/70/80/90/95kg, Push Press 5x3 @ 60/70/80/85/85kg
• Monday Sep 21: Front Squat 5x2 @ 100/110/120/120/120kg, Snatch Pull 4x2 @ 110/120/120/120kg
KNOWN 1RMs: Back Squat 180 kg (actual 1RM), Front Squat 140 kg (est.), Snatch 100 kg (actual 1RM), Clean and Jerk 125 kg (actual 1RM), Bench Press 140 kg (est.)
PAIN LEDGER (computed by the app from every logged mention, final): - Knee: came on Aug 17; latest Sep 1 was dull or lingering; no mention in 27 days, 3 clean sessions on it since. Reads quiet, headed the right way. If this message mentions it: acknowledge_once. - Any other area: first mention = acknowledge_once.`;

// ── the 20 inputs ────────────────────────────────────────────────────────────
const INPUTS = [
  ["short_log", "Bench 3x5 @ 185"],
  ["short_log", "Ran 3 miles easy this morning"],
  ["short_log", "Back squat 5x3 at 145kg, moved well"],
  ["long_log", "Day 1 – Front Squat/Pulls\n\nFront Squat 2x1 @ 100/120 (my knees were on fire so I stopped) \nSnatch Pull 4x2 @ 110/120/120/120\nBack Extensions 3x10 @ 90lbs", "screenshot 2"],
  ["long_log", "Behind the Neck Snatch Grip Push Press 5x3 @ 60/80/90/100/100kg\nPush Press 5x3 @ 60/70/80/90/90kg\nLat raises 3x8 @ 40lbs", "screenshot 5"],
  ["long_log", "Snatch 6x1 @ 70/80/85/90/90/92kg, Clean and Jerk 5x1 @ 100/110/115/118/120kg, Front squat 3x2 @ 125kg, pull-ups 3x8, ab wheel 3x12, felt fast today"],
  ["pr_log", "Hit a 102kg snatch today, new PR"],
  ["pr_log", "Clean and jerk 128kg!! first time over 125"],
  ["why", "Why do we pause the front squats at the bottom?"],
  ["why", "why is my clean and jerk stuck at 120"],
  ["detail", "Give me a full breakdown of how to warm up for a heavy snatch day, step by step"],
  ["detail", "Explain exactly how you figure out my weights for this week"],
  ["one_word", "ok"],
  ["one_word", "thanks"],
  ["one_word", "done"],
  ["complaint", "No there is a workout for the day. Read the damn program correctly", "screenshot 7"],
  ["complaint", "This program is killing me, everything feels heavy this week"],
  ["checkin", "Short on timee", "screenshot 8", "Those light set counts on Front Squat: intentional recovery, or short on time/gas?"],
  ["checkin", "Goal is the same", "screenshot 8", "Still chasing \"heal the left pec, build clean and jerk, posterior chain and front squat\", or has the target shifted?"],
  ["checkin", "I was sick all week", "screenshot 8", "Recovery this week: dialed, flat, or running on fumes?"],
];

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
  const VOICES = { old: staticWith(await oldTier1()), new: staticWith(TIER1_JOE) };
  const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
  const done = new Set(results.map((r) => `${r.idx}|${r.voice}|${r.run}`));
  for (let run = 0; run < RUNS; run++) {
    for (let idx = 0; idx < INPUTS.length; idx++) {
      const [cls, msg, src, checkinQ] = INPUTS[idx];
      if (ONLY && cls !== ONLY) continue;
      for (const voice of ["old", "new"]) {
        if (done.has(`${idx}|${voice}|${run}`)) continue;
        const dynamic = `${CONTEXT}${checkinQ ? `\n\nThis message is the athlete's answer in the weekly check-in to your question: "${checkinQ}". React if it warrants it; ask nothing new.` : ""}`;
        let text = "", err = null;
        for (let attempt = 0; attempt < 3 && !text; attempt++) {
          try {
            const r = await post("/api/claude", { auth, model: "claude-sonnet-5", max_tokens: 900, system: dynamic, system_cached: VOICES[voice], messages: [{ role: "user", content: msg }], feature: "mastermind_chat" });
            text = (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
          } catch (e) { err = e.message; if (/429/.test(err)) await sleep(60000); else await sleep(3000); }
        }
        const gated = replyGate("before_after", text).text;
        results.push({ idx, cls, src: src || null, voice, run, athleteWords: countWords(msg), replyWords: countWords(text), rawBanned: hasBannedWord(text), gatedBanned: hasBannedWord(gated), emDash: /—/.test(text), reply: text, err: text ? null : err });
        fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
        console.log(`${run + 1}/${RUNS} #${idx} ${cls} ${voice}: ${countWords(text)} words${text ? "" : ` ERR ${err}`}`);
        await sleep(PACE_MS);
      }
    }
  }
  console.log("\n" + table(results));
}

export function table(results) {
  const classes = [...new Set(INPUTS.map((i) => i[0]))];
  const rows = ["| Input class | n inputs | athlete words (median) | OLD median / max | NEW median / max | OLD ratio | NEW ratio |", "|---|---|---|---|---|---|---|"];
  const stat = (rs) => ({ med: median(rs.map((r) => r.replyWords)), max: Math.max(0, ...rs.map((r) => r.replyWords)), ratio: median(rs.map((r) => r.replyWords / Math.max(1, r.athleteWords))) });
  for (const c of [...classes, "ALL"]) {
    const rs = results.filter((r) => (c === "ALL" || r.cls === c) && r.replyWords > 0);
    const o = stat(rs.filter((r) => r.voice === "old")), n = stat(rs.filter((r) => r.voice === "new"));
    const aw = median(INPUTS.filter((i) => c === "ALL" || i[0] === c).map((i) => countWords(i[1])));
    const nIn = INPUTS.filter((i) => c === "ALL" || i[0] === c).length;
    rows.push(`| ${c} | ${nIn} | ${aw} | ${o.med} / ${o.max} | ${n.med} / ${n.max} | ${o.ratio.toFixed(1)}x | ${n.ratio.toFixed(1)}x |`);
  }
  const banned = (v) => results.filter((r) => r.voice === v && r.rawBanned).length;
  rows.push("", `Raw banned words (before the gate): OLD ${banned("old")}, NEW ${banned("new")}. After the gate: ${results.filter((r) => r.gatedBanned).length}. Em dashes raw: OLD ${results.filter((r) => r.voice === "old" && r.emDash).length}, NEW ${results.filter((r) => r.voice === "new" && r.emDash).length}. Runs: ${results.length}.`);
  return rows.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--table")) console.log(table(JSON.parse(fs.readFileSync(OUT, "utf8"))));
  else main().catch((e) => { console.error(e.message); process.exit(1); });
}
