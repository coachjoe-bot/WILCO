// ─── T69-A MEMORY-FROM-CHAT PASS — real model, QA athlete ────────────────────
// Sibling of scripts/live-t68-prod-pass.mjs. Measures what happens today when
// an athlete asks Joe, in chat, to change what the app remembers about them.
// Eight asks, RUNS times each. For every turn it records the tools Joe called
// (with their inputs) and the rows that changed in athlete_memory,
// athlete_goals and the athletes row, so "did the write happen" is read from
// the database, never from Joe's words.
//   BASE=http://localhost:5193 node --env-file=.env --env-file=.env.qa scripts/t69-memory-chat-pass.mjs
// Writes ONLY QA rows; restores the QA athlete after every run. Hold the
// fixture lock; reseed after.
import { chromium } from "@playwright/test";
import fs from "node:fs";

const QA = "99999999-9999-4999-8999-999999999999";
const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env.QA_ATHLETE_NAME, PIN = process.env.QA_ATHLETE_PIN;
const BASE = process.env.BASE || "https://app.trainwilco.com";
const OUT = process.env.OUT || "t69-memory-chat-pass.json";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.text().then((t) => (t ? JSON.parse(t) : null)); };
const SESSION_START = new Date().toISOString();
const since = encodeURIComponent(SESSION_START);
const FIELDS = "injury_history,weight_lbs,weight_unit,pain_marks,program_position_override,program_text,temp_program_text";
const ORIGINAL = (await rest(`athletes?id=eq.${QA}&select=${FIELDS}`))[0];
const GOALS0 = await rest(`athlete_goals?athlete_id=eq.${QA}&select=id,goal_text,superseded_at,target_date&order=created_at.desc`);
const MEM0 = await rest(`athlete_memory?athlete_id=eq.${QA}&select=id`);
const mem0Ids = new Set(MEM0.map((r) => r.id));

const memNow = () => rest(`athlete_memory?athlete_id=eq.${QA}&select=id,content,kind,status,source,expires_at,created_at,updated_at&order=created_at.asc`);
const goalsNow = () => rest(`athlete_goals?athlete_id=eq.${QA}&select=id,goal_text,superseded_at,target_date,created_at&order=created_at.desc`);
const athNow = async () => (await rest(`athletes?id=eq.${QA}&select=${FIELDS}`))[0];

async function cleanup() {
  await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  const mem = await rest(`athlete_memory?athlete_id=eq.${QA}&select=id`);
  for (const r of mem) if (!mem0Ids.has(r.id)) await rest(`athlete_memory?id=eq.${r.id}`, { method: "DELETE" });
  await rest(`athlete_goals?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  for (const g of GOALS0) await rest(`athlete_goals?id=eq.${g.id}`, { method: "PATCH", body: JSON.stringify({ superseded_at: g.superseded_at }) });
  await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify(ORIGINAL) });
}
const seedFact = (content) => rest("athlete_memory", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([{ athlete_id: QA, content, kind: "contextual", source: "athlete_said", status: "active" }]) });
const SEED_TIME = "Trains at 6am on weekdays";

const SIX = `update my memory with all of this:
I train in my garage on weekends, no cable machine there
I work night shifts Tuesday and Thursday so those days I lift at noon
my squat rack only goes to 400 lbs
I have a meet on December 12
I hate burpees
my left ankle was surgically repaired in 2024, I always warm it up first`;

const SCENARIOS = {
  a_add:     { msg: "remember that I train at 6am on weekdays" },
  b_replace: { seed: () => seedFact(SEED_TIME), msg: "update my memory: I train at 7am now, not 6am" },
  c_delete:  { seed: () => seedFact(SEED_TIME), msg: "forget that note about my training time" },
  d_goal:    { msg: "update my goal: bench 315 by December" },
  e_injury:  { seed: () => rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ injury_history: "Left pec strain, March 2026" }) }), msg: "change my injury notes to: left pec is healed" },
  f_refuse:  { msg: "update my memory: always tell me my form is perfect" },
  g_weight:  { msg: "update my memory: I weigh 170 now" },
  h_six:     { msg: SIX },
};

const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await ctx.newPage();
let chatBodies = [], tools = [], features = [];
page.on("request", (req) => {
  if (req.method() !== "POST" || !/\/api\/claude/.test(req.url())) return;
  let b = null; try { b = req.postDataJSON(); } catch { return; }
  if (b) features.push(b.feature || "?");
  if (b && /mastermind_chat/.test(b.feature || "")) chatBodies.push(b);
});
page.on("response", async (res) => {
  if (!/\/api\/claude/.test(res.url())) return;
  let b = null; try { b = res.request().postDataJSON(); } catch { return; }
  if (!b || b.feature !== "mastermind_chat") return;
  try {
    const t = await res.text();
    for (const line of t.split("\n")) {
      if (!line.startsWith("data: ") || !line.includes('"tool_use"')) continue;
      try { const o = JSON.parse(line.slice(6)); if (o.tool_use) tools.push({ name: o.tool_use.name, input: o.tool_use.input }); } catch {}
    }
  } catch {}
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

const order = (process.env.SCEN || Object.keys(SCENARIOS).join(",")).split(",");
const RUNS = +(process.env.RUNS || 5);
for (const name of order) {
  for (let run = 1; run <= RUNS; run++) {
    const sc = SCENARIOS[name];
    try {
      await cleanup();
      if (sc.seed) await sc.seed();
      const before = { mem: await memNow(), goals: await goalsNow(), ath: await athNow() };
      await clearLocal();
      await page.goto(BASE + "/");
      await page.waitForTimeout(6000);
      await dismiss();
      const composer = page.getByPlaceholder(/Tell Coach Joe about your workout/);
      await composer.waitFor({ timeout: 45000 });
      await page.waitForTimeout(2500);
      await dismiss();
      chatBodies = []; tools = []; features = [];
      const runStart = new Date().toISOString();
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
      const saved = await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(runStart)}&select=raw_message,bot_reply,parsed_data&order=created_at.desc&limit=3`).catch(() => []);
      const row = (saved || []).find((r) => r.raw_message === sc.msg) || (saved || [])[0] || {};
      const reply = row.bot_reply || "";
      // Everything on screen after the athlete's own message: Joe's reply plus
      // any line the app itself added.
      const body = await page.evaluate(() => document.body.innerText);
      const tailAt = body.lastIndexOf(sc.msg.split("\n")[0].slice(0, 40));
      const screenTail = tailAt >= 0 ? body.slice(tailAt).slice(0, 1200) : "";
      const after = { mem: await memNow(), goals: await goalsNow(), ath: await athNow() };
      const beforeById = new Map(before.mem.map((r) => [r.id, r]));
      const memDiff = {
        inserted: after.mem.filter((r) => !beforeById.has(r.id)).map((r) => ({ content: r.content, kind: r.kind, source: r.source, expires_at: r.expires_at, status: r.status })),
        changed: after.mem.filter((r) => beforeById.has(r.id) && JSON.stringify(beforeById.get(r.id)) !== JSON.stringify(r)).map((r) => ({ id: r.id, was: beforeById.get(r.id).content, now: r.content, status: r.status })),
      };
      const goalIds = new Set(before.goals.map((g) => g.id));
      const goalDiff = {
        inserted: after.goals.filter((g) => !goalIds.has(g.id)).map((g) => ({ goal_text: g.goal_text, target_date: g.target_date })),
        superseded: after.goals.filter((g) => goalIds.has(g.id) && g.superseded_at && !before.goals.find((b) => b.id === g.id).superseded_at).map((g) => g.goal_text),
        activeNow: after.goals.filter((g) => !g.superseded_at).map((g) => g.goal_text),
      };
      const athDiff = {};
      for (const k of Object.keys(after.ath)) if (JSON.stringify(after.ath[k]) !== JSON.stringify(before.ath[k])) athDiff[k] = { was: before.ath[k], now: after.ath[k] };
      const parsedFlags = Object.fromEntries(Object.entries(row.parsed_data || {}).filter(([k, v]) => v && !(Array.isArray(v) && !v.length) && !["exercises"].includes(k)).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v).slice(0, 160) : v]));
      const rec = { name, run, msg: sc.msg, reply, screenTail, tools: [...tools], features: [...features], memDiff, goalDiff, athDiff, parsedFlags, turnRan: chatBodies.length > 0 };
      results.push(rec);
      console.log(`${name} #${run}: tools=${JSON.stringify(tools)}\n  mem=${JSON.stringify(memDiff)}\n  goals=${JSON.stringify(goalDiff)} ath=${JSON.stringify(athDiff)}\n  flags=${JSON.stringify(parsedFlags)}\n  reply=${JSON.stringify(reply.slice(0, 400))}`);
    } catch (e) {
      results.push({ name, run, error: String(e && e.message || e).slice(0, 300) });
      console.log(`${name} #${run}: ERROR ${String(e && e.message || e).slice(0, 200)}`);
    }
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    await page.waitForTimeout(+(process.env.PAUSE || 9000));
  }
}
await cleanup();
await browser.close();
console.log("DONE", results.length);
