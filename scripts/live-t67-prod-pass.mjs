// ─── LIVE T67 PASS — the DEPLOYED client, real model, QA athlete ─────────────
// Sibling of scripts/live-log-focus-pass.mjs, pointed at prod by default. Three
// turns T67 changed, each driven through the real composer:
//   partial  a log holding one of today's planned lifts: no paragraph about the rest
//   swap     a today-only swap said in chat, no workout started: no program rec
//   flagged  a log whose only load the app asks kg-or-lbs about: no other lift named
// Records what Joe was handed (system blocks) and which tools he called (SSE
// frames), so the path is known to have run. Writes ONLY QA rows since session
// start; restores the QA athlete's fields. Hold the fixture lock; reseed after.
//   node --env-file=.env --env-file=.env.qa scripts/live-t67-prod-pass.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";
import { hasBannedWord, countWords } from "../src/replyGate.js";

const QA = "99999999-9999-4999-8999-999999999999";
const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env.QA_ATHLETE_NAME, PIN = process.env.QA_ATHLETE_PIN;
const BASE = process.env.BASE || "https://app.trainwilco.com";
const OUT = process.env.OUT || "live-t67-prod-pass.json";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { ...H, ...(init.headers || {}) }, ...init }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.text().then((t) => (t ? JSON.parse(t) : null)); };
const SESSION_START = new Date().toISOString();
const since = encodeURIComponent(SESSION_START);
const FIELDS = "program_text,temp_program_text,sport,weight_unit,pain_marks,program_position_override";
const ORIGINAL = (await rest(`athletes?id=eq.${QA}&select=${FIELDS}`))[0];
const PROGRAM = "Day 1 - Pull\nDeadlift 3x5 @ 130 kg\nBarbell Row 3x8 @ 70 kg\nPull-ups 3x8\n\nDay 2 - Squat\nBack Squat 5x3 @ 80%\nFront Squat 3x3 @ 70%\nRomanian Deadlift 3x6\n\nDay 3 - Press\nBench Press 4x5\nPush Press 5x3";

async function cleanup() {
  await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`workouts?athlete_id=eq.${QA}&raw_message=like.*T67-QA*`, { method: "DELETE" });
  await rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`manual_one_rms?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify(ORIGINAL) });
}
const TAG = "[T67-QA]";
const kgRow = (d, name, w, reps) => ({ athlete_id: QA, created_at: new Date(Date.now() - d * 86400000).toISOString(), raw_message: `${TAG} ${name} 3x${reps} @ ${w}kg`, bot_reply: "", parsed_data: { exercises: [{ name, unit: "kg", unit_source: "written", sets: 3, reps, weight: w, set_details: [1, 2, 3].map(() => ({ weight: w, reps })) }], pain_flags: [] } });
const seedKgHistory = () => rest("workouts", { method: "POST", body: JSON.stringify([kgRow(9, "Front Squat", 95, 3), kgRow(6, "Front Squat", 97.5, 3), kgRow(3, "Front Squat", 100, 3)]) });
const setup = (day) => rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ program_text: PROGRAM, temp_program_text: null, sport: "Olympic Weightlifting", weight_unit: "kg", program_position_override: { day, at: new Date().toISOString() } }) });

const SCENARIOS = {
  partial: { day: 1, msg: "Deadlift 3x5 @ 130kg, moved well",
    check: (reply, sys) => ({ restHanded: /Also on today's plan and not in this log/.test(sys), planQuiet: !/\b(rows?|pull-?ups?)\b/i.test(reply) }) },
  swap: { day: 2, msg: "the squat racks are all taken today, swap my first lift for something I can do with dumbbells",
    check: (reply, sys, tools, recs) => ({ scopeHanded: /CHANGE SCOPE \(app fact, this turn\)/.test(sys), noRecStaged: recs === 0, noRecBar: !/PROGRAM REC/.test(reply) }) },
  flagged: { day: 2, seed: seedKgHistory, msg: "Front squat 3x3 @ 225",
    check: (reply, sys) => ({ unitHanded: /UNIT CHECK/.test(sys), noOtherLift: !/\b(back squat|rdl|romanian|deadlift)\b/i.test(reply), noRestate: !/(?<![\d.])225(?!\d)/.test(reply.split(/kg or lbs|in kg|in lbs/i)[0]) }) },
};

const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await ctx.newPage();
let chatBodies = [], tools = [];
page.on("request", (req) => {
  if (req.method() !== "POST" || !/\/api\/claude/.test(req.url())) return;
  let b = null; try { b = req.postDataJSON(); } catch { return; }
  if (b && /mastermind_chat/.test(b.feature || "")) chatBodies.push(b);
});
page.on("response", async (res) => {
  if (!/\/api\/claude/.test(res.url())) return;
  let b = null; try { b = res.request().postDataJSON(); } catch { return; }
  if (!b || b.feature !== "mastermind_chat") return;
  try { const t = await res.text(); for (const m of t.matchAll(/"tool_use":\{"id":"[^"]*","name":"([^"]+)"/g)) tools.push(m[1]); } catch {}
});
async function dismiss() { for (const label of [/Not now/i, /No thanks/i, /^Later$/i, /Keep going/i]) { const b = page.getByRole("button", { name: label }).first(); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); } }
const clearLocal = () => page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^wilco_(chat_|quicklog|today_opener_|opener_choice_)/.test(k)) localStorage.removeItem(k); });

await cleanup();
await page.goto(BASE + "/");
await page.getByRole("button", { name: /Athlete Login/i }).click();
await page.getByPlaceholder(/name/i).first().fill(NAME);
await page.locator('input[type="password"], input[inputmode="numeric"]').first().fill(PIN);
await page.getByRole("button", { name: /Let's Get to Work/i }).click();
await page.getByText("WILCO", { exact: true }).first().waitFor({ timeout: 45000 });
const bundle = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter((s) => /index-/.test(s)).join(","));

const order = (process.env.SCEN || "partial,swap,flagged").split(",");
const RUNS = +(process.env.RUNS || 5);
for (const name of order) {
  for (let run = 1; run <= RUNS; run++) {
    const sc = SCENARIOS[name];
    try {
      await cleanup();
      await setup(sc.day);
      if (sc.seed) await sc.seed();
      await clearLocal();
      await page.goto(BASE + "/");
      await page.waitForTimeout(6000);
      await dismiss();
      const composer = page.getByPlaceholder(/Tell Coach Joe about your workout/);
      await composer.waitFor({ timeout: 45000 });
      await page.waitForTimeout(2500);
      await dismiss();
      chatBodies = []; tools = [];
      await composer.fill(sc.msg);
      await page.getByRole("button", { name: "→", exact: true }).click();
      const t0 = Date.now();
      let last = "", stableSince = Date.now();
      while (Date.now() - t0 < 70000) {
        await page.waitForTimeout(1500);
        const now = await page.evaluate(() => document.body.innerText);
        const dots = await page.locator(".ld-dots").count();
        if (now !== last || dots) { last = now; stableSince = Date.now(); }
        if (Date.now() - stableSince > 9000 && Date.now() - t0 > 12000) break;
      }
      await page.waitForTimeout(4000);
      const saved = await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}&raw_message=eq.${encodeURIComponent(sc.msg)}&select=bot_reply&order=created_at.desc&limit=1`).catch(() => []);
      const recs = (await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${since}&status=eq.rec&select=id`).catch(() => [])).length;
      const body = await page.evaluate(() => document.body.innerText);
      const reply = (saved && saved[0] && saved[0].bot_reply) || "";
      const sys = chatBodies.map((b) => String(b.system || "")).join("\n");
      const inv = { turnRan: chatBodies.length > 0, replySaved: !!reply, banned: !hasBannedWord(reply), ...sc.check(reply, sys, tools, recs) };
      if (name === "swap") inv.noRecBar = !/PROGRAM REC/.test(body);
      results.push({ name, run, bundle, msg: sc.msg, reply, words: countWords(reply), tools: [...tools], recsStaged: recs, inv });
      console.log(`${name} #${run}: ${countWords(reply)}w tools=[${tools.join(",")}] ${JSON.stringify(inv)}\n  ${JSON.stringify(reply.slice(0, 300))}`);
    } catch (e) {
      results.push({ name, run, error: String(e && e.message || e).slice(0, 300) });
      console.log(`${name} #${run}: ERROR ${String(e && e.message || e).slice(0, 200)}`);
    }
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    await page.waitForTimeout(4000);
  }
}
await cleanup();
await browser.close();
console.log("DONE", results.length);
