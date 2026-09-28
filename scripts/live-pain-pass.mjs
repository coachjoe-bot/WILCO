// ─── LIVE PAIN PASS (T64 S2) — real AI, the BRANCH client, QA athlete only ───
// Drives `npx vite --port 5192 --strictPort` (vite proxies /api to PROD, so auth
// and the model are real and the client code is this checkout) as "Claude QA
// (test)". Scenarios: first report, worsening pattern, the same again next day
// (offered_at seeded), serious language, the Sep 2 5x3-vs-5x2 log. Writes ONLY
// QA rows (priors tagged [S2-QA]; everything the run creates is deleted after).
// Hold the fixture lock (SHARED RULES) and reseed after.
//   node --env-file=.env --env-file=.env.qa scripts/live-pain-pass.mjs
//   SCEN=worsening,double RUNS=5 OUT=/tmp/x.json ... ; then
//   node scripts/live-pain-pass-analyze.mjs /tmp/x.json
import { chromium } from "@playwright/test";
import fs from "node:fs";

const QA = "99999999-9999-4999-8999-999999999999";
const URL = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env.QA_ATHLETE_NAME, PIN = process.env.QA_ATHLETE_PIN;
const BASE = "http://localhost:5192";
const OUT = process.env.OUT || "live-pain-pass-results.json";
const SHOTS = process.env.SHOTS || null;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => { const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...H, ...(init.headers || {}) }, ...init }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.text().then((t) => (t ? JSON.parse(t) : null)); };
const SESSION_START = new Date().toISOString();
const days = (n) => new Date(Date.now() - n * 86400000).toISOString();

async function cleanup() {
  const since = encodeURIComponent(SESSION_START);
  await rest(`workouts?athlete_id=eq.${QA}&or=(created_at.gte.${since},raw_message.like.*S2-QA*)`, { method: "DELETE" });
  await rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ pain_marks: null, temp_program_text: null }) });
}
const sqRow = (daysAgo, desc, weight = 225) => ({ athlete_id: QA, created_at: days(daysAgo), raw_message: `[S2-QA] Back squat 3x5 @ ${weight}. ${desc}`, bot_reply: "",
  parsed_data: { exercises: [{ name: "Back Squat", sets: 3, reps: 5, weight, unit: "lbs" }], pain_flags: [{ area: "knee", description: desc }], coach_flag: "pain" } });

const SCENARIOS = {
  first: { setup: async () => {}, msg: () => `Back squat 3x5 @ ${200 + Math.floor(Math.random() * 4) * 5}, my left knee felt a little achy on the last set`, wait: "reply" },
  worsening: { setup: async () => { await rest("workouts", { method: "POST", body: JSON.stringify([sqRow(5, "knee a little tight during squats"), sqRow(2, "knee flared up during squats")]) }); },
    msg: () => `Back squat 3x5 @ ${210 + Math.floor(Math.random() * 3) * 5}, stopped after set 2, my knee was on fire`, wait: "reply" },
  nextday: { setup: async () => {
      await rest("workouts", { method: "POST", body: JSON.stringify([sqRow(6, "knee a little tight during squats"), sqRow(3, "knee flared up during squats"), sqRow(1, "knee was on fire on squats, stopped after set 2")]) });
      await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ pain_marks: { knee: { noted_at: days(1), offered_at: days(1) } } }) });
    }, msg: () => `Back squat 3x5 @ ${210 + Math.floor(Math.random() * 3) * 5}, stopped after set 2 again, knee was on fire`, wait: "reply" },
  serious: { setup: async () => {}, msg: () => `Back squat 3x3 @ ${225 + Math.floor(Math.random() * 3) * 5}, felt a sharp pop in my right knee on the second set and it gave out`, wait: "rec" },
  double: { setup: async () => {
      await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ temp_program_text: "Day 3 – Overhead Stability (Temp Swap)\n* Behind the Neck Snatch Grip Push Press 5x2 @ 135 lbs\n* Push Press 5x2 @ 155 lbs\n* DB Lateral Raise 3x8 @ 20 lb" }) });
    }, msg: () => `Day 3 – Overhead Stability\n\nBehind the Neck Snatch Grip Push Press 5x3 @ 135/175/195/${215 + Math.floor(Math.random() * 2) * 5}/${215 + Math.floor(Math.random() * 2) * 5}\nPush Press 5x3 @ 135/155/175/195/195\nDB Lateral Raise 3x8 @ 20`, wait: "reply" },
};

const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await ctx.newPage();
let chatBodies = [], dataWrites = [];
page.on("request", (req) => {
  if (req.method() !== "POST") return;
  const u = req.url();
  let b = null; try { b = req.postDataJSON(); } catch { return; }
  if (/\/api\/claude/.test(u) && b && /mastermind_chat|joebot_chat/.test(b.feature || "")) chatBodies.push(b);
  if (/\/api\/data/.test(u) && b && (b.op === "update" || b.op === "insert")) dataWrites.push({ table: b.table, data: b.data });
});
page.on("response", async (res) => { if (/\/api\/data/.test(res.url()) && res.status() >= 400) { let b = null; try { b = res.request().postDataJSON(); } catch {} dataWrites.push({ status: res.status(), table: b?.table, keys: b?.data ? Object.keys(b.data) : [] }); } });

async function dismiss() { for (const label of [/Not now/i, /No thanks/i, /^Later$/i, /Keep going/i]) { const b = page.getByRole("button", { name: label }).first(); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); } }

await cleanup();
await page.goto(BASE + "/");
await page.getByRole("button", { name: /Athlete Login/i }).click();
await page.getByPlaceholder(/name/i).first().fill(NAME);
await page.locator('input[type="password"], input[inputmode="numeric"]').first().fill(PIN);
await page.getByRole("button", { name: /Let's Get to Work/i }).click();
await page.getByText("WILCO", { exact: true }).first().waitFor({ timeout: 45000 });

const order = (process.env.SCEN || "first,worsening,nextday,serious,double").split(",");
const RUNS = +(process.env.RUNS || 5);
for (const name of order) {
  for (let run = 1; run <= RUNS; run++) {
    const sc = SCENARIOS[name];
    await cleanup();
    await sc.setup();
    // isolate runs: drop today's cached chat transcript so no run sees another's turns
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("wilco_chat_")) localStorage.removeItem(k); });
    await page.goto(BASE + "/");
    await page.waitForTimeout(6000);
    await dismiss();
    const composer = page.getByPlaceholder(/Tell Coach Joe about your workout/);
    await composer.waitFor({ timeout: 45000 });
    await page.waitForTimeout(2500);
    await dismiss();
    const before = await page.evaluate(() => document.body.innerText);
    chatBodies = []; dataWrites = [];
    const msg = sc.msg();
    await composer.fill(msg);
    await page.getByRole("button", { name: "→", exact: true }).click();
    const t0 = Date.now();
    // wait for the reply to settle: typing dots gone and text stable for 6s
    let last = "", stableSince = Date.now();
    while (Date.now() - t0 < (sc.wait === "rec" ? 90000 : 70000)) {
      await page.waitForTimeout(1500);
      const now = await page.evaluate(() => document.body.innerText);
      const dots = await page.locator(".ld-dots").count();
      if (now !== last || dots) { last = now; stableSince = Date.now(); }
      const need = sc.wait === "rec" ? /Drafted a program rec|couldn't draft/i.test(now) : true;
      if (need && Date.now() - stableSince > 9000 && Date.now() - t0 > 12000) break;
    }
    const after = await page.evaluate(() => document.body.innerText);
    const idx = after.lastIndexOf(msg.split("\n").pop().slice(0, 30));
    const tail = idx >= 0 ? after.slice(idx) : after.slice(before.length);
    const sys = chatBodies.map((b) => JSON.stringify(b.system || b.messages || b)).join("\n");
    const ledger = (sys.match(/PAIN LEDGER[\s\S]{0,2500}?The app posts no pain bubbles of its own\./) || [""])[0];
    const recBar = /PROGRAM REC —/.test(after);
    if (SHOTS && run === 1) await page.screenshot({ path: `${SHOTS}/realai-${name}.png`, fullPage: false });
    results.push({ name, run, msg, tail: tail.slice(0, 3000), ledger: ledger.replace(/\\n/g, "\n").replace(/\\"/g, '"'), recBar, dataWrites, hasPerformed: /PERFORMED — THIS MESSAGE/.test(sys), performed: (sys.match(/PERFORMED — THIS MESSAGE[^]*?(?=\\n\\n[A-Z]|$)/) || [""])[0].slice(0, 800) });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`${name} #${run}: recBar=${recBar} tail=${JSON.stringify(tail.slice(0, 400))}`);
    await page.waitForTimeout(4000);
  }
}
await cleanup();
await browser.close();
console.log("DONE", results.length);
