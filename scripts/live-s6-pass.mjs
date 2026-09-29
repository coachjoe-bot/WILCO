// ─── LIVE S6 PASS — real AI, the BRANCH client, QA athlete only ───────────────
// Drives `npx vite --port 5199 --strictPort` (vite proxies /api to PROD: real
// auth, real model, THIS checkout's client) as "Claude QA (test)". Scenarios:
//   trip     — the verifier's exact three-turn BUG-3 transcript
//   noshoes  — the founder's 09-02 today-only message (must never write a temp program)
//   blockend — BUG-1: two failing phrasings + three more; the confirm must appear
//              and nothing may be written to athlete_context
// Writes ONLY QA rows; restores them after every run. Hold the fixture lock
// (SHARED RULES) and reseed after.
//   node --env-file=.env --env-file=.env.qa scripts/live-s6-pass.mjs
//   SCEN=trip RUNS=5 OUT=/tmp/s6-live.json ...
import { chromium } from "@playwright/test";
import fs from "node:fs";

const QA = "99999999-9999-4999-8999-999999999999";
const URL = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env.QA_ATHLETE_NAME, PIN = process.env.QA_ATHLETE_PIN;
const BASE = process.env.BASE || "http://localhost:5199";
const OUT = process.env.OUT || "/tmp/s6-live.json";
const SHOTS = process.env.SHOTS || null;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => { const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...H, ...(init.headers || {}) }, ...init }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.text().then((t) => (t ? JSON.parse(t) : null)); };
const SESSION_START = new Date().toISOString();

const athleteRow = async () => (await rest(`athletes?id=eq.${QA}&select=temp_program_text,program_block_span,program_text`))[0];
const ctxRows = async () => rest(`athlete_context?athlete_id=eq.${QA}&select=content,updated_at`);
const memRows = async () => rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(SESSION_START)}&select=content,created_at`).catch(() => []);
const modRows = async () => rest(`program_modifications?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(SESSION_START)}&select=modification_type,created_at`).catch(() => []);

let BASELINE = null;
async function snapshot() { const a = await athleteRow(); BASELINE = { span: a.program_block_span, ctx: await ctxRows() }; }
async function restore() {
  const since = encodeURIComponent(SESSION_START);
  await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`program_modifications?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ temp_program_text: null, program_block_span: BASELINE.span }) });
  // athlete_context back to the seeded state (the seed leaves none, or one row)
  await rest(`athlete_context?athlete_id=eq.${QA}`, { method: "DELETE" }).catch(() => {});
  if (BASELINE.ctx.length) await rest("athlete_context", { method: "POST", body: JSON.stringify(BASELINE.ctx.map((r) => ({ athlete_id: QA, content: r.content }))) }).catch(() => {});
}

const CLAIM = /already (?:built|set|saved|laid|got)|(?:i'?ve|i have|we'?ve)\s+(?:already\s+)?(?:set|built|saved|locked|loaded|put)\b|\b(?:it'?s|that'?s|plan'?s|program'?s)\s+(?:all\s+)?(?:saved|set up|locked in|loaded|live)\b|\bsaved (?:it|that) (?:for you|as)|you'?re all set/i;

const TRIP = [
  "visiting family Wed through next Tuesday, garage gym only",
  "just some dumbbells up to 50lb and an adjustable bench, no barbell",
  "yes set me up with that temporary program for the week",
];
const NOSHOES = "I don't have my weightlifting shoes with me so I can't really do snatch balance. I am thinking of doing behind the neck push press at a snatch grip and push press and then some other shoulder work in place of today's workout.";
const BLOCKEND = [
  "hey just so you know this program actually wraps up Sept 15th, not sooner",
  "it wraps up October 1st",
  "fyi my program ends Oct 5",
  "the block actually runs through October 12th",
  "just so you know this is a 6 week block",
];

const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await ctx.newPage();
let chatBodies = [], dataWrites = [];
page.on("request", (req) => {
  if (req.method() !== "POST") return;
  let b = null; try { b = req.postDataJSON(); } catch { return; }
  if (/\/api\/claude/.test(req.url()) && b && /mastermind_chat|joebot_chat/.test(b.feature || "")) chatBodies.push(b);
  if (/\/api\/data/.test(req.url()) && b && ["update", "insert", "upsert"].includes(b.op)) dataWrites.push({ op: b.op, table: b.table, keys: b.data ? Object.keys(Array.isArray(b.data) ? b.data[0] || {} : b.data) : [] });
});
async function dismiss() { for (const label of [/Not now/i, /No thanks/i, /^Later$/i, /Keep going/i]) { const b = page.getByRole("button", { name: label }).first(); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); } }

async function freshChat() {
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("wilco_chat_")) localStorage.removeItem(k); });
  await page.goto(BASE + "/");
  await page.waitForTimeout(6000);
  await dismiss();
  const composer = page.getByPlaceholder(/Tell Coach Joe about your workout/);
  await composer.waitFor({ timeout: 45000 });
  await page.waitForTimeout(2500);
  await dismiss();
  return composer;
}
async function sendAndSettle(composer, msg) {
  const before = await page.evaluate(() => document.body.innerText);
  await composer.fill(msg);
  await page.getByRole("button", { name: "→", exact: true }).click();
  const t0 = Date.now();
  let last = "", stableSince = Date.now();
  while (Date.now() - t0 < 90000) {
    await page.waitForTimeout(1500);
    const now = await page.evaluate(() => document.body.innerText);
    const dots = await page.locator(".ld-dots").count();
    if (now !== last || dots) { last = now; stableSince = Date.now(); }
    if (Date.now() - stableSince > 9000 && Date.now() - t0 > 12000) break;
  }
  const after = await page.evaluate(() => document.body.innerText);
  const idx = after.lastIndexOf(msg.slice(0, 30));
  return idx >= 0 ? after.slice(idx + msg.length) : after.slice(before.length);
}
const factOf = (b) => { const s = JSON.stringify(b?.system || ""); const m = s.match(/TEMP PROGRAM \(app fact, this turn\):.{0,400}?(?=\\n|"$|$)/); return m ? m[0] : null; };
const headerText = async () => (await page.locator('button[data-tour="program-btn"]').first().innerText().catch(() => "")).trim();

// ── login once (the limiter 429s bursts) ──
await snapshot();
await restore();
await page.goto(BASE + "/");
await page.getByRole("button", { name: /Athlete Login/i }).click();
await page.getByPlaceholder(/name/i).first().fill(NAME);
await page.locator('input[type="password"], input[inputmode="numeric"]').first().fill(PIN);
await page.getByRole("button", { name: /Let's Get to Work/i }).click();
await page.getByText("WILCO", { exact: true }).first().waitFor({ timeout: 45000 });

const order = (process.env.SCEN || "trip,noshoes,blockend").split(",");
const RUNS = +(process.env.RUNS || 5);
const save = () => fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

for (const name of order) {
  for (let run = 1; run <= RUNS; run++) {
    if (name === "trip") {
      await restore();
      const composer = await freshChat();
      const turns = [];
      for (let i = 0; i < TRIP.length; i++) {
        chatBodies = []; dataWrites = [];
        const tail = await sendAndSettle(composer, TRIP[i]);
        const a = await athleteRow();
        turns.push({
          athlete: TRIP[i], tail: tail.slice(0, 2500), fact: factOf(chatBodies[chatBodies.length - 1]),
          tempAfter: a.temp_program_text ? a.temp_program_text.slice(0, 160) : null,
          confirmShown: /I've set (?:you up with )?a temporary program/.test(tail),
          header: await headerText(),
          claimWhileUnsaved: !a.temp_program_text && CLAIM.test(tail),
          programTextUnchanged: a.program_text === (await athleteRow()).program_text,
          writes: dataWrites,
        });
        if (SHOTS && run === 1) await page.screenshot({ path: `${SHOTS}/realai-trip-turn${i + 1}.png` });
      }
      const mods = await modRows();
      results.push({ name, run, turns, program_modifications: mods.length });
      save();
      console.log(`trip #${run}: temp=[${turns.map((t) => (t.tempAfter ? "Y" : "n")).join(",")}] confirm=[${turns.map((t) => (t.confirmShown ? "Y" : "n")).join(",")}] header=${turns[2].header} claimUnsaved=[${turns.map((t) => (t.claimWhileUnsaved ? "Y" : "n")).join(",")}]`);
    } else if (name === "noshoes") {
      await restore();
      const composer = await freshChat();
      chatBodies = []; dataWrites = [];
      const tail = await sendAndSettle(composer, NOSHOES);
      const a = await athleteRow();
      results.push({ name, run, tail: tail.slice(0, 2000), temp: a.temp_program_text, confirmShown: /temporary program/.test(tail) && /I've set/.test(tail), header: await headerText(), writes: dataWrites });
      save();
      console.log(`noshoes #${run}: temp=${a.temp_program_text ? "WRITTEN" : "null"} header=${await headerText()}`);
    } else if (name === "blockend") {
      for (const msg of BLOCKEND) {
        await restore();
        const ctxBefore = JSON.stringify(await ctxRows());
        const composer = await freshChat();
        chatBodies = []; dataWrites = [];
        const tail = await sendAndSettle(composer, msg);
        const a = await athleteRow();
        const ctxAfter = JSON.stringify(await ctxRows());
        const mem = await memRows();
        const chip = await page.getByRole("button", { name: /^Use / }).first().isVisible().catch(() => false);
        const keep = await page.getByRole("button", { name: /^Keep / }).first().isVisible().catch(() => false);
        results.push({ name, run, msg, tail: tail.slice(0, 1500), confirmLine: (tail.match(/Your program says[^\n]*/) || [null])[0], useChip: chip, keepChip: keep,
          rememberLine: /I'll remember that/.test(tail), athleteContextChanged: ctxBefore !== ctxAfter, contextWrites: dataWrites.filter((w) => w.table === "athlete_context").length,
          spanAfter: a.program_block_span, memoryRows: mem.map((m) => m.content) });
        save();
        console.log(`blockend #${run} "${msg.slice(0, 40)}": confirm=${!!chip && !!keep} line=${JSON.stringify((tail.match(/Your program says[^\n]*/) || [""])[0])} ctxChanged=${ctxBefore !== ctxAfter} remember=${/I'll remember that/.test(tail)} mem=${mem.length}`);
        if (SHOTS && run === 1 && msg === BLOCKEND[1]) await page.screenshot({ path: `${SHOTS}/realai-blockend.png` });
      }
    }
    await page.waitForTimeout(3000);
  }
}
await restore();
await browser.close();
console.log("DONE", results.length);
