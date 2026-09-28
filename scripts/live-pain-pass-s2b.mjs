// ─── LIVE PAIN PASS S2b — real AI, the BRANCH client, QA athlete only ────────
// Same harness as scripts/live-pain-pass.mjs (vite 5192 proxies /api to PROD).
// Scenarios (T64 S2b):
//   trajfree  the founder's trajectory (sharp 3 weeks ago, lingering, dull today)
//             seeded, then a pain-free squat log: Joe must not bring the pec up
//   trajask   same seed, "how's my pec doing?": answered from the ledger line,
//             direction included, no counts
//   worse2    knee flaring 2 days ago, then "flaring again ... worse": one offer, no rec
//   sheet     a pec flag 5+ weeks old (cleared) + profile injury "pec strain",
//             push-day program: the log-sheet focus note never mentions the pec
// Writes ONLY QA rows (tagged [S2-QA]; runs delete what they create). Hold the
// fixture lock and reseed after.
//   node --env-file=.env --env-file=.env.qa scripts/live-pain-pass-s2b.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";

const QA = "99999999-9999-4999-8999-999999999999";
const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env.QA_ATHLETE_NAME, PIN = process.env.QA_ATHLETE_PIN;
const BASE = "http://localhost:5192";
const OUT = process.env.OUT || "live-pain-pass-s2b.json";
const SHOTS = process.env.SHOTS || null;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { ...H, ...(init.headers || {}) }, ...init }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.text().then((t) => (t ? JSON.parse(t) : null)); };
const SESSION_START = new Date().toISOString();
const ago = (d, h = 0) => new Date(Date.now() - d * 86400000 - h * 3600000).toISOString();
const ORIGINAL = (await rest(`athletes?id=eq.${QA}&select=program_text,injury_history`))[0];

async function cleanup() {
  const since = encodeURIComponent(SESSION_START);
  await rest(`workouts?athlete_id=eq.${QA}&or=(created_at.gte.${since},raw_message.like.*S2-QA*)`, { method: "DELETE" });
  await rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ pain_marks: null, temp_program_text: null, program_text: ORIGINAL.program_text, injury_history: ORIGINAL.injury_history }) });
}
const row = (d, h, raw, exercises, pain_flags = []) => ({ athlete_id: QA, created_at: ago(d, h), raw_message: `[S2-QA] ${raw}`, bot_reply: "", parsed_data: { exercises, pain_flags } });
const ex = (name, weight, sets, reps, unit = "lbs") => ({ name, weight, sets, reps, unit });
const TRAJECTORY = () => [
  row(21, 0, "Bench 3x5 @ 225. Sharp pull in my left pec on bench, had to stop.", [ex("Bench Press", 225, 3, 5)], [{ area: "left pec", description: "sharp pull in pec on bench, had to stop" }]),
  row(16, 0, "Incline DB bench 3x8 @ 60. Pec still lingering on incline.", [ex("Incline DB Bench", 60, 3, 8)], [{ area: "pec", description: "pec still lingering on incline" }]),
  row(11, 0, "Dips 3x8. Lingering, felt it on dips.", [ex("Dips", 0, 3, 8, "bodyweight")], [{ area: "pec", description: "lingering, felt it on dips" }]),
  row(6, 0, "Bench 3x5 @ 185", [ex("Bench Press", 185, 3, 5)]),
  row(0, 2, "Bench 3x5 @ 205. Dull pec on bench today, not bad.", [ex("Bench Press", 205, 3, 5)], [{ area: "pec", description: "dull pec on bench today, not bad" }]),
];
const PUSH_ONLY = "Day 1 - Push\nBench Press 3x5 @ 185\nIncline DB Bench 3x8 @ 60\nDips 3x8\n\nDay 2 - Push B\nBench Press 5x3 @ 205\nDips 3x10";

const SCENARIOS = {
  trajfree: { setup: async () => { await rest("workouts", { method: "POST", body: JSON.stringify(TRAJECTORY()) }); },
    msg: () => `Back squat 3x5 @ ${225 + Math.floor(Math.random() * 3) * 5}, felt strong today`, mode: "chat" },
  trajask: { setup: async () => { await rest("workouts", { method: "POST", body: JSON.stringify(TRAJECTORY()) }); },
    msg: () => ["how's my pec doing?", "How's my pec doing?", "hows my pec doing", "how's my pec doing?", "How is my pec doing?"][Math.floor(Math.random() * 5)], mode: "chat" },
  worse2: { setup: async () => { await rest("workouts", { method: "POST", body: JSON.stringify([row(2, 0, "Front squat 3x3 @ 225. Knees flaring on front squat.", [ex("Front Squat", 225, 3, 3)], [{ area: "knees", description: "knees flaring on front squat" }])]) }); },
    msg: () => `Front squat 3x3 @ ${225 + Math.floor(Math.random() * 2) * 5}, knee flaring again on front squat, worse`, mode: "chat" },
  sheet: { setup: async () => {
      await rest("workouts", { method: "POST", body: JSON.stringify([
        row(40, 0, "Bench 3x5 @ 185. Pec hurt on bench.", [ex("Bench Press", 185, 3, 5)], [{ area: "pec", description: "pec hurt on bench" }]),
        row(35, 0, "Bench 3x5 @ 185. Pec still lingering on bench.", [ex("Bench Press", 185, 3, 5)], [{ area: "pec", description: "pec still lingering on bench" }]),
      ]) });
      await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ program_text: PUSH_ONLY, injury_history: "Pec strain last spring, still careful on bench" }) });
    }, mode: "sheet" },
};

const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await ctx.newPage();
let chatBodies = [], dataWrites = [], qlBodies = [], qlReplies = [];
page.on("request", (req) => {
  if (req.method() !== "POST") return;
  const u = req.url();
  let b = null; try { b = req.postDataJSON(); } catch { return; }
  if (/\/api\/claude/.test(u) && b && /mastermind_chat|joebot_chat/.test(b.feature || "")) chatBodies.push(b);
  if (/\/api\/claude/.test(u) && b && b.feature === "quick_log_draft") qlBodies.push(b);
  if (/\/api\/data/.test(u) && b && (b.op === "update" || b.op === "insert")) dataWrites.push({ table: b.table, keys: b.data ? Object.keys(Array.isArray(b.data) ? b.data[0] || {} : b.data) : [] });
});
page.on("response", async (res) => {
  if (!/\/api\/claude/.test(res.url())) return;
  let b = null; try { b = res.request().postDataJSON(); } catch { return; }
  if (!b || b.feature !== "quick_log_draft") return;
  try { qlReplies.push(await res.text()); } catch {}
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

const order = (process.env.SCEN || "trajfree,trajask,worse2,sheet").split(",");
const RUNS = +(process.env.RUNS || 5);
for (const name of order) {
  for (let run = 1; run <= RUNS; run++) {
    const sc = SCENARIOS[name];
    await cleanup();
    await sc.setup();
    await clearLocal();
    if (process.env.THEME) await page.evaluate((t) => localStorage.setItem("wilco_theme", t), process.env.THEME);
    chatBodies = []; dataWrites = []; qlBodies = []; qlReplies = [];
    await page.goto(BASE + "/");
    await page.waitForTimeout(6000);
    if (sc.mode !== "sheet") await dismiss(); // its /Not now/ would answer the opener
    if (sc.mode === "sheet") {
      const start = page.getByRole("button", { name: "Start Workout" });
      let notes = "", err = null;
      try {
        await start.waitFor({ timeout: 60000 });
        await start.click();
        await page.getByText(/Log it here when you're done/).first().waitFor({ timeout: 60000 });
        await page.waitForTimeout(2500);
        // open the sheet from the bar; the note is the first block in the sheet body
        await page.locator('div[role="button"]').filter({ hasText: "▲" }).first().click();
        await page.waitForTimeout(2500);
        notes = await page.evaluate(() => { const el = [...document.querySelectorAll("div")].find((d) => d.style && d.style.whiteSpace === "pre-wrap" && d.style.fontSize === "12px"); return el ? el.innerText : ""; });
      } catch (e) { err = String(e).slice(0, 200); if (SHOTS) await page.screenshot({ path: `${SHOTS}/s2b-sheet-fail-${run}.png` }).catch(() => {}); }
      const prompt = qlBodies.map((b) => JSON.stringify(b)).join("\n");
      // the draft streams as SSE: join every text delta, then take section 1
      const rawAll = qlReplies.map((t) => [...t.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return ""; } }).join("")).join("\n---\n");
      const rawNote = rawAll.split("===")[0].trim();
      if (SHOTS && run === 1) await page.screenshot({ path: `${SHOTS}/s2b-sheet-cleared-${process.env.THEME || "light"}.png` });
      results.push({ name, run, notes, rawNote, err, promptHasCurrentPain: /CURRENT PAIN/.test(prompt), promptCurrentNone: /CURRENT PAIN[^:]*:\\n\(none\)/.test(prompt), promptInjuryBackground: /undated background the athlete entered at signup/.test(prompt) });
      fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
      console.log(`${name} #${run}: notes=${JSON.stringify(notes)} raw=${JSON.stringify(rawNote.slice(0, 200))} err=${err}`);
      await page.waitForTimeout(3000);
      continue;
    }
    const composer = page.getByPlaceholder(/Tell Coach Joe about your workout/);
    await composer.waitFor({ timeout: 45000 });
    await page.waitForTimeout(2500);
    await dismiss();
    chatBodies = []; dataWrites = [];
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
    const after = await page.evaluate(() => document.body.innerText);
    const idx = after.lastIndexOf(msg.slice(0, 25));
    const tail = idx >= 0 ? after.slice(idx + msg.length) : after.slice(-2000);
    const sys = chatBodies.map((b) => JSON.stringify(b.system || b.messages || b)).join("\n");
    const ledger = (sys.match(/PAIN LEDGER[\s\S]{0,3000}?The app posts no pain bubbles of its own\./) || [""])[0].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    const injuryLine = (sys.match(/INJURY HISTORY[^\\]*/) || [""])[0];
    const recRows = await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(SESSION_START)}&select=id,status,title`);
    if (SHOTS && run === 1) await page.screenshot({ path: `${SHOTS}/s2b-${name}-${process.env.THEME || "light"}.png` });
    results.push({ name, run, msg, tail: tail.slice(0, 2500), ledger, injuryLine, recBar: /PROGRAM REC —/.test(after), recRows, dataWrites });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`${name} #${run}: recRows=${recRows.length} tail=${JSON.stringify(tail.slice(0, 500))}`);
    await page.waitForTimeout(4000);
  }
}
await cleanup();
await browser.close();
console.log("DONE", results.length);
