// ─── T69-C FILING PASS: where Joe's one scan files a note with no section ─────
// The bottom "+ Add a note (Joe files it under the right section)" asks the same
// scan call that already runs on every edit for the section too (src/memoryScan.js,
// kind "file"). Measures, with the real model on the exact prompt, RUNS times
// each: does the verdict stay allow, and does the section land where a person
// would put it. Accepted sections per case are listed; code files by its words
// when the scan names none, so a miss is a wrong shelf, never a lost note.
//   WHO=CREW RUNS=3 node --env-file=.env.qa scripts/t69c-file-pass.mjs
import fs from "node:fs";
import { MEMORY_SCAN_SYS, MEMORY_SCAN_FEATURE, scanUserMessage, readScanVerdict } from "../src/memoryScan.js";
import { resolveSection } from "../src/memorySections.js";
const BASE = process.env.BASE || "https://app.trainwilco.com";
const WHO = process.env.WHO || "CREW";
const NAME = process.env[`QA_${WHO}_NAME`], PIN = process.env[`QA_${WHO}_PIN`];
const RUNS = +(process.env.RUNS || 3), PACE = +(process.env.PACE_MS || 9000);
const OUT = process.env.OUT || "t69c-file-pass.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = (text, ...ok) => ({ text, ok });
const CASES = [
  C("I train at 6am on weekdays", "schedule"), C("Garage gym on weekends, no cable machine", "schedule"), C("Meet Nov 14, 73 kg class", "schedule"),
  C("Exam week Oct 26 to 30", "schedule"), C("I work night shifts Tuesday and Thursday so I lift at noon those days", "schedule"), C("Traveling for work Dec 3 to 8", "schedule"),
  C("My squat rack only goes to 400 lbs", "schedule", "preferences"),
  C("Torn labrum surgery in 2023", "body"), C("Left ankle was surgically repaired in 2024, I always warm it up first", "body"), C("Asthma, I carry an inhaler", "body"),
  C("Low back gets tight if I deadlift too often", "body"), C("Rehabbing inflamed knees", "body"),
  C("Keep it blunt, skip the pep talk", "preferences"), C("No RPE, percentages only", "preferences"), C("I hate burpees", "preferences"),
  C("Kilos on barbell lifts and pounds on dumbbells", "preferences"), C("Sessions capped at 75 minutes", "preferences"), C("Call me Big Mike", "preferences"),
  C("Sick with the flu this week", "this_week"), C("Slept badly all week and feeling flat", "this_week"), C("Short on time this week, quick sessions only", "this_week"),
];
const login = await fetch(`${BASE}/api/identity`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "athlete-login", name: NAME, pin: PIN }) }).then((r) => r.json());
if (!login.token) { console.error("login failed"); process.exit(1); }
const auth = { role: "athlete", id: login.athlete.id, pin: PIN, token: login.token };
const results = [];
for (let run = 1; run <= RUNS; run++) for (const c of CASES) {
  let v = { ok: false }, ms = 0;
  for (let a = 0; a < 5; a++) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE}/api/claude`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auth, model: "claude-haiku-4-5", max_tokens: 160, system: MEMORY_SCAN_SYS, messages: [{ role: "user", content: [{ type: "text", text: scanUserMessage("file", c.text) }] }], feature: MEMORY_SCAN_FEATURE }) });
      if (r.status === 429) { await sleep(90000); continue; }
      const d = await r.json(); ms = Date.now() - t0;
      v = readScanVerdict(d.content && d.content[0] ? d.content[0].text : ""); break;
    } catch { await sleep(15000); }
  }
  const named = v.ok && v.allow ? v.section : null;
  const filed = named || resolveSection({ content: c.text, kind: "contextual" });
  const row = { run, text: c.text, allow: !!(v.ok && v.allow), named, filed, right: c.ok.includes(filed), scanRight: named ? c.ok.includes(named) : null, ms };
  results.push(row);
  console.log(`${row.right ? "  " : "!!"} r${run} ${String(named || "(none)").padEnd(11)} -> ${filed.padEnd(11)} ${JSON.stringify(c.text.slice(0, 60))}`);
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  await sleep(PACE);
}
const n = results.length, allowed = results.filter((r) => r.allow).length, named = results.filter((r) => r.named).length;
console.log(`\nSUMMARY runs=${n} allowed=${allowed} scan named a section=${named} filed right (scan or code fallback)=${results.filter((r) => r.right).length} scan's own section right=${results.filter((r) => r.scanRight).length}/${named}`);
