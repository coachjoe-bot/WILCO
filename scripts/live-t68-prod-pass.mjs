// ─── LIVE T68 PASS — the DEPLOYED client, real model, QA athlete ─────────────
// Sibling of scripts/live-t67-prod-pass.mjs. Four turns T68 changed, each driven
// through the real composer on the deployed app:
//   addcurls  "add barbell curls 3x12 to my program on day 1": ONE owner. Either
//             Joe's rec is staged and the program text is untouched, or the
//             program is appended and no rec exists. Never both.
//   remember  "remember that ...": the note is a row in athlete_memory and the
//             retired athlete_context blob is not touched
//   mixed     a kg athlete logs a lift they keep in lbs: the reply says the
//             number they typed, never a kg conversion
//   bwplus    a kg athlete logs "BW+20": the stored row carries added_unit kg
// Writes ONLY QA rows since session start (plus tagged history); restores the
// QA athlete's fields. Hold the fixture lock; reseed after.
//   node --env-file=.env --env-file=.env.qa scripts/live-t68-prod-pass.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";
import { hasBannedWord, countWords } from "../src/replyGate.js";

const QA = "99999999-9999-4999-8999-999999999999";
const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env.QA_ATHLETE_NAME, PIN = process.env.QA_ATHLETE_PIN;
const BASE = process.env.BASE || "https://app.trainwilco.com";
const OUT = process.env.OUT || "live-t68-prod-pass.json";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { ...H, ...(init.headers || {}) }, ...init }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.text().then((t) => (t ? JSON.parse(t) : null)); };
const SESSION_START = new Date().toISOString();
const since = encodeURIComponent(SESSION_START);
const FIELDS = "program_text,temp_program_text,sport,weight_unit,pain_marks,program_position_override";
const ORIGINAL = (await rest(`athletes?id=eq.${QA}&select=${FIELDS}`))[0];
const PROGRAM = "Day 1 - Pull\nDeadlift 3x5 @ 130 kg\nBarbell Row 3x8 @ 70 kg\nPull-ups 3x8\n\nDay 2 - Squat\nBack Squat 5x3 @ 80%\nFront Squat 3x3 @ 70%\nRomanian Deadlift 3x6\n\nDay 3 - Press\nBench Press 4x5\nPush Press 5x3";

async function cleanup() {
  await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`workouts?athlete_id=eq.${QA}&raw_message=like.*T68-QA*`, { method: "DELETE" });
  await rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`manual_one_rms?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify(ORIGINAL) });
}
const TAG = "[T68-QA]";
const kgRow = (d, name, w, reps) => ({ athlete_id: QA, created_at: new Date(Date.now() - d * 86400000).toISOString(), raw_message: `${TAG} ${name} 3x${reps} @ ${w}kg`, bot_reply: "", parsed_data: { exercises: [{ name, unit: "kg", unit_source: "written", sets: 3, reps, weight: w, set_details: [1, 2, 3].map(() => ({ weight: w, reps })) }], pain_flags: [] } });
const seedKgHistory = () => rest("workouts", { method: "POST", body: JSON.stringify([kgRow(9, "Front Squat", 95, 3), kgRow(6, "Front Squat", 97.5, 3), kgRow(3, "Front Squat", 100, 3)]) });
const setup = (day) => rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ program_text: PROGRAM, temp_program_text: null, sport: "Olympic Weightlifting", weight_unit: "kg", program_position_override: { day, at: new Date().toISOString() } }) });

const lbsRow = (d, name, w, reps) => ({ athlete_id: QA, created_at: new Date(Date.now() - d * 86400000).toISOString(), raw_message: `${TAG} ${name} 4x${reps} @ ${w}lbs`, bot_reply: "", parsed_data: { exercises: [{ name, unit: "lbs", unit_source: "written", sets: 4, reps, weight: w, set_details: [1, 2, 3, 4].map(() => ({ weight: w, reps })) }], pain_flags: [] } });
const seedLbsBench = () => rest("workouts", { method: "POST", body: JSON.stringify([lbsRow(10, "Bench Press", 185, 5), lbsRow(7, "Bench Press", 190, 5), lbsRow(4, "Bench Press", 190, 5)]) });
const blobNow = async () => JSON.stringify(await rest(`athlete_context?athlete_id=eq.${QA}&select=content,updated_at`).catch(() => null));
const BLOB0 = await blobNow();
const SCENARIOS = {
  addcurls: { day: 1, msg: "add barbell curls 3x12 to my program on day 1",
    check: async (reply, sys, tools) => {
      const recs = (await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${since}&status=eq.rec&select=id`).catch(() => [])).length;
      const prog = (await rest(`athletes?id=eq.${QA}&select=program_text`))[0].program_text;
      const appended = prog !== PROGRAM;
      return { oneOwner: (recs > 0) !== appended, recs, appended, toolCalled: tools.includes("propose_program_rec") };
    } },
  remember: { day: 1, msg: "remember that I train at a garage gym on weekends with no cable stack",
    check: async () => {
      const mem = await rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${since}&select=content,kind,source`).catch(() => []);
      return { savedAsFact: mem.length >= 1, oneFact: mem.length === 1, blobUntouched: (await blobNow()) === BLOB0, facts: mem.map((m) => m.content.slice(0, 80)) };
    } },
  mixed: { day: 3, seed: seedLbsBench, msg: "Bench press 4x5 @ 195",
    check: async (reply, sys) => {
      const row = (await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}&raw_message=eq.${encodeURIComponent("Bench press 4x5 @ 195")}&select=parsed_data&order=created_at.desc&limit=1`))[0];
      const ex = row?.parsed_data?.exercises?.[0] || {};
      return { storedLbs: ex.unit === "lbs" && !ex.unit_suspect, unitFactHanded: /LOG UNITS \(app fact/.test(sys), saidAsTyped: /(?<![\d.])195(?!\d)/.test(reply), noKg: !/\bkg\b|kilo/i.test(reply) };
    } },
  bwplus: { day: 1, msg: "Pull-ups 3x5 BW+20",
    check: async (reply) => {
      const row = (await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}&raw_message=eq.${encodeURIComponent("Pull-ups 3x5 BW+20")}&select=parsed_data&order=created_at.desc&limit=1`))[0];
      const ex = row?.parsed_data?.exercises?.[0] || {};
      return { rowSaved: !!row, addedKg: ex.added_unit === "kg", added: ex.added_weight ?? null, source: ex.added_unit_source || null, noLbsSaid: !/\b(20|44)\s*(lbs?|pounds)\b/i.test(reply) };
    } },
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

const order = (process.env.SCEN || "addcurls,remember,mixed,bwplus").split(",");
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
      const reply = (saved && saved[0] && saved[0].bot_reply) || "";
      const sys = chatBodies.map((b) => String(b.system || "")).join("\n");
      const inv = { turnRan: chatBodies.length > 0, replySaved: !!reply, banned: !hasBannedWord(reply), ...(await sc.check(reply, sys, tools)) };
      const recs = 0;
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
