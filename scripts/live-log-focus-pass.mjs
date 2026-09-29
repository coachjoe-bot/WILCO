// ─── LIVE LOG FOCUS PASS (T64 S5) — real AI, the BRANCH client, QA athlete ───
// Harness from scripts/live-pain-pass-s2b.mjs: vite (port 5197) proxies /api to
// PROD, so auth and the model are real and the client is this branch. Each run:
// clean QA rows, seed the scenario, send ONE log through the real composer, read
// the rendered reply and the dynamic context Joe received.
// Scenarios:
//   sep2   the founder's Sep 2 log (screenshot 5) on the temp swap that named
//          Split Jerk from Rack; the headline is the snatch-grip push press
//   plain  a log that repeats last week's session exactly (nothing notable)
//   pr     "Hit a 102kg snatch today, new PR" over a 100 kg single
// Writes ONLY QA rows (tagged [S5-QA]); restores the QA athlete's fields. Hold
// the fixture lock and reseed after.
//   node --env-file=.env --env-file=.env.qa scripts/live-log-focus-pass.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";
import { hasBannedWord, countWords } from "../src/replyGate.js";

const QA = "99999999-9999-4999-8999-999999999999";
const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env.QA_ATHLETE_NAME, PIN = process.env.QA_ATHLETE_PIN;
const BASE = process.env.BASE || "http://localhost:5197";
const OUT = process.env.OUT || "live-log-focus-pass.json";
const SHOTS = process.env.SHOTS || null;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { ...H, ...(init.headers || {}) }, ...init }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.text().then((t) => (t ? JSON.parse(t) : null)); };
const SESSION_START = new Date().toISOString();
const ago = (d, h = 0) => new Date(Date.now() - d * 86400000 - h * 3600000).toISOString();
const FIELDS = "program_text,temp_program_text,sport,weight_unit,pain_marks";
const ORIGINAL = (await rest(`athletes?id=eq.${QA}&select=${FIELDS}`))[0];

async function cleanup() {
  const since = encodeURIComponent(SESSION_START);
  await rest(`workouts?athlete_id=eq.${QA}&or=(created_at.gte.${since},raw_message.like.*S5-QA*)`, { method: "DELETE" });
  await rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify(ORIGINAL) });
}
const row = (d, raw, exercises) => ({ athlete_id: QA, created_at: ago(d), raw_message: `[S5-QA] ${raw}`, bot_reply: "", parsed_data: { exercises, pain_flags: [] } });
const K = (name, loads, reps) => ({ name, unit: "kg", sets: loads.length, reps, weight: Math.max(...loads), set_details: loads.map((w) => ({ weight: w, reps })) });
const replay = JSON.parse(fs.readFileSync(new URL("../tests/replay/log-reply-focus.json", import.meta.url), "utf8"));
const bug5 = JSON.parse(fs.readFileSync(new URL("../tests/replay/bug5-clean-double.json", import.meta.url), "utf8"));
const WEEK = "Day 1 - Front Squat / Pulls\nFront Squat 5x2 @ 75-80%\nSnatch Pull 4x2 @ 110-120kg\n\nDay 2 - Classic\nSnatch 6x1 @ 80%\nClean and Jerk 5x1 @ 80%";

const SCENARIOS = {
  sep2: {
    setup: async () => {
      await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ temp_program_text: replay.starting_state.plan_text, sport: "Olympic Weightlifting", weight_unit: "kg" }) });
      await rest("workouts", { method: "POST", body: JSON.stringify(replay.starting_state.history.map((h, i) => row(26 + i * 4, h.parsed_data.exercises.map((e) => e.name).join(", "), h.parsed_data.exercises))) });
    },
    msg: () => bug5.input_message,
    check: (reply) => ({
      headline: /push press/i.test(reply) && /\b100\b/.test(reply), // only the BTN snatch-grip press reached 100 (plain push press topped at 90)
      asksSplitJerk: /split jerk/i.test(reply),
      oneQuestion: (reply.match(/\?/g) || []).length <= 1,
      noLateral: !/lat(eral)? raise/i.test(reply),
      noDouble: !/\bdoubles?\b/i.test(reply),
    }),
  },
  plain: {
    setup: async () => {
      await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ program_text: WEEK, temp_program_text: null, sport: "Olympic Weightlifting", weight_unit: "kg" }) });
      await rest("workouts", { method: "POST", body: JSON.stringify([
        row(7, "Front Squat 5x2, Snatch Pull 4x2", [K("Front Squat", [100, 110, 120, 120, 120], 2), K("Snatch Pull", [110, 120, 120, 120], 2)]),
        row(5, "Snatch 6x1, Clean and Jerk 5x1", [K("Snatch", [70, 80, 85, 90, 90, 90], 1), K("Clean and Jerk", [100, 110, 115, 115, 115], 1)]),
      ]) });
      await rest("manual_one_rms", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ athlete_id: QA, exercise: "Front Squat", normalized_exercise: "front squat", weight: 140, unit: "kg" }]) }).catch(() => {});
    },
    msg: () => "Front squat 5x2 @ 100/110/120/120/120kg, snatch pull 4x2 @ 110/120/120/120kg",
    check: (reply) => ({
      noInvention: !/\b(PR|up from|jump|heavier|progress|climb|stronger|missing|skipp|pain|estimat|max)\b/i.test(reply),
      repsTrue: !/\b(singles?|triples?)\b/i.test(reply), // every set was 2 reps: "double" is true, single/triple are not
    }),
  },
  pr: {
    setup: async () => {
      await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ program_text: WEEK, temp_program_text: null, sport: "Olympic Weightlifting", weight_unit: "kg" }) });
      await rest("workouts", { method: "POST", body: JSON.stringify([row(6, "Snatch 1x1 @ 100kg", [K("Snatch", [80, 90, 100], 1)])]) });
    },
    msg: () => "Hit a 102kg snatch today, new PR",
    check: (reply) => ({ prNamed: /102/.test(reply) && /\b(PR|personal (best|record)|new best|best ever)\b/i.test(reply) }),
  },
};

const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await ctx.newPage();
let chatBodies = [];
page.on("request", (req) => {
  if (req.method() !== "POST" || !/\/api\/claude/.test(req.url())) return;
  let b = null; try { b = req.postDataJSON(); } catch { return; }
  if (b && /mastermind_chat|joebot_chat/.test(b.feature || "")) chatBodies.push(b);
});
let parseReplies = [];
page.on("response", async (res) => {
  if (!/\/api\/claude/.test(res.url())) return;
  let b = null; try { b = res.request().postDataJSON(); } catch { return; }
  if (!b || b.feature !== "workout_parse") return;
  try { const j = await res.json(); parseReplies.push((j.content || []).map((c) => c.text || "").join("")); } catch {}
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

const order = (process.env.SCEN || "sep2,plain,pr").split(",");
const RUNS = +(process.env.RUNS || 5);
for (const name of order) {
  for (let run = 1; run <= RUNS; run++) {
    const sc = SCENARIOS[name];
    await cleanup();
    // finalizeWorkout files a stated PR's 1RM in manual_one_rms (in lbs when the parse carries no unit): clear
    // this pass's rows each run so one run's write never becomes the next run's "actual 1RM"
    await rest(`manual_one_rms?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(SESSION_START)}`, { method: "DELETE" }).catch(() => {});
    await sc.setup();
    await clearLocal();
    if (process.env.THEME) await page.evaluate((t) => localStorage.setItem("wilco_theme", t), process.env.THEME);
    await page.goto(BASE + "/");
    await page.waitForTimeout(6000);
    await dismiss();
    const composer = page.getByPlaceholder(/Tell Coach Joe about your workout/);
    await composer.waitFor({ timeout: 45000 });
    await page.waitForTimeout(2500);
    await dismiss();
    chatBodies = []; parseReplies = [];
    const msg = sc.msg();
    await composer.fill(msg);
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
    await page.waitForTimeout(4000); // the row's bot_reply lands after the settle
    const saved = await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(SESSION_START)}&raw_message=eq.${encodeURIComponent(msg)}&select=bot_reply&order=created_at.desc&limit=1`).catch(() => []);
    const after = await page.evaluate(() => document.body.innerText);
    const idx = after.lastIndexOf(msg.split("\n").pop().slice(0, 25));
    const tail = (idx >= 0 ? after.slice(idx + msg.split("\n").pop().length) : after.slice(-2000)).trim();
    const reply = (saved && saved[0] && saved[0].bot_reply) || tail.split(/\n(?:Tell Coach Joe|Type naturally)/)[0].trim();
    const sys = chatBodies.map((b) => String(b.system || "")).join("\n");
    const userMsgs = chatBodies.map((b) => JSON.stringify(b.messages || "")).join("\n");
    const focus = (sys.match(/LOG REPLY FOCUS[\s\S]*$/) || [""])[0];
    const inv = { focusSent: !!focus, banned: !hasBannedWord(reply), ...sc.check(reply) };
    if (SHOTS && run === 1) await page.screenshot({ path: `${SHOTS}/realai-${name}-${process.env.THEME || "light"}.png` });
    results.push({ name, run, sysLateral: (sys.match(/[^\n]*Lat[^\n]*/gi) || []).slice(0, 8), histTail: userMsgs.slice(-1500), msg, parse: parseReplies.slice(-1)[0] || null, reply, replySource: saved && saved[0] && saved[0].bot_reply ? "stored bot_reply" : "dom", words: countWords(reply), focus, inv, tail: tail.slice(0, 1500) });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`${name} #${run}: ${countWords(reply)} words ${JSON.stringify(inv)}\n  ${JSON.stringify(reply.slice(0, 400))}`);
    await page.waitForTimeout(4000);
  }
}
await cleanup();
await rest(`manual_one_rms?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(SESSION_START)}`, { method: "DELETE" }).catch(() => {});
await browser.close();
console.log("DONE", results.length);
