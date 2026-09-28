// ─── LIVE CHECK-IN + VOICE PASS (T64 S4) — real AI, the BRANCH client, QA only ─
// Drives `npx vite --port 5194 --strictPort` (vite proxies /api to PROD: auth and
// the model are real, the client code is this checkout) as "Claude QA (test)".
// Writes ONLY QA rows: a fresh weekly digest per run (tagged S4-QA), knee rows
// for the pain scenario (tagged [S4-QA]); everything the run creates is deleted
// after. Hold the fixture lock (SHARED RULES) and reseed after.
//   node --env-file=.env --env-file=.env.qa scripts/live-checkin-pass.mjs
//   SCEN=sick,twoinone,curse RUNS=5 OUT=/tmp/x.json SHOTS=<dir> THEME=light|dark
// Invariants are asserted from what the athlete SAW (rendered bubbles) plus the
// raw model JSON (/api/claude responses) and the request bodies (open items).
import { chromium } from "@playwright/test";
import fs from "node:fs";
import { hasBannedWord } from "../src/replyGate.js";

const QA = "99999999-9999-4999-8999-999999999999";
const URL = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env.QA_ATHLETE_NAME, PIN = process.env.QA_ATHLETE_PIN;
const BASE = process.env.BASE || "http://localhost:5194";
const OUT = process.env.OUT || "live-checkin-pass-results.json";
const SHOTS = process.env.SHOTS || null;
const THEME = process.env.THEME || "light";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => { const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...H, ...(init.headers || {}) }, ...init }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.text().then((t) => (t ? JSON.parse(t) : null)); };
const SESSION_START = new Date().toISOString();
const days = (n) => new Date(Date.now() - n * 86400000).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S8 = JSON.parse(fs.readFileSync(new globalThis.URL("../tests/replay/checkin-sick-week-0928.json", import.meta.url), "utf8"));
const BANK_PAIN = [
  { id: "weight", kind: "weight", deeper: false, text: "Bodyweight still 185 lbs, or has it moved?" },
  { id: "injury", kind: "injury", deeper: false, meta: { area: "knee" }, text: "That knee: cleared, lingering, or still sharp?" },
  { id: "goal", kind: "goal", deeper: false, meta: { goal: "Squat 315" }, text: "Still chasing \"Squat 315\", or has the target shifted?" },
  { id: "recovery", kind: "context", deeper: false, text: "Recovery this week: dialed, flat, or running on fumes?" },
  { id: "delivery", kind: "context", deeper: true, text: "Anything about how I deliver these: more detail, less, different focus?" },
];
const kneeRow = (daysAgo, desc) => ({ athlete_id: QA, created_at: days(daysAgo), raw_message: `[S4-QA] Back squat 3x5 @ 225. ${desc}`, bot_reply: "",
  parsed_data: { exercises: [{ name: "Back Squat", sets: 3, reps: 5, weight: 225, unit: "lbs" }], pain_flags: [{ area: "knee", description: desc }] } });

const SCENARIOS = {
  // screenshot 8, verbatim athlete text, then close the rest out plainly
  sick: { bank: S8.agenda, setup: async () => {}, say: ["Short on timee", "Goal is the same", "I was sick all week", "nope, all good", "nah that's it", "no"] },
  // two agenda items in one message, a tangent, then the agenda resumes
  twoinone: { bank: BANK_PAIN, setup: async () => { await rest("workouts", { method: "POST", body: JSON.stringify([kneeRow(3, "knee a little achy on squats")]) }); },
    say: ["still 185, and the knee has been fine honestly", "wait, why do my knees click when I squat?", "ok cool", "same goal", "decent, slept well", "nah all good", "no", "nope"] },
  // chat: the athlete curses first; Joe must not mirror it
  curse: { chat: true, setup: async () => {}, say: ["this damn bar felt heavy as hell today. bench 3x5 @ 185, what the hell is going on"] },
};

async function cleanup() {
  const since = encodeURIComponent(SESSION_START);
  await rest(`workouts?athlete_id=eq.${QA}&or=(created_at.gte.${since},raw_message.like.*S4-QA*)`, { method: "DELETE" });
  await rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`proof_digests?athlete_id=eq.${QA}&label=like.*S4-QA*`, { method: "DELETE" });
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ pain_marks: null }) });
}
const digestRow = (bank) => ({ athlete_id: QA, digest_type: "weekly", label: "WEEKLY DIGEST: S4-QA", generated_at: new Date().toISOString(), is_read: false,
  content_json: { intro: "Claude, here's your week.", sections: [{ label: "THIS WEEK VS LAST", body: "Two of your four days logged. Squat held at 225 for 3x5." }, { label: "FOCUS NEXT WEEK", body: "Get all four days in, squat 230 for 3x5." }], questions: bank, flags: {} } });

const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
await ctx.addInitScript((theme) => { try { localStorage.setItem("wilco_theme", theme); } catch {} }, THEME);
const page = await ctx.newPage();
let turns = [];
page.on("response", async (res) => {
  if (!/\/api\/claude/.test(res.url())) return;
  let b = null; try { b = res.request().postDataJSON(); } catch { return; }
  if (!b || !/joebot_chat|mastermind_chat/.test(b.feature || "")) return;
  let text = ""; try { text = await res.text(); } catch {}
  let raw = "";
  try { const j = JSON.parse(text); raw = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""); }
  catch { raw = [...text.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join(""); } // SSE deltas
  const user = (b.messages && b.messages[0] && b.messages[0].content) || "";
  turns.push({ feature: b.feature, system: String(b.system || "").slice(0, 400), open: (String(user).split("ALREADY COVERED")[0].split("OPEN ITEMS:")[1] || "").split("\n\n")[0].trim(), raw });
});

async function login() {
  await page.goto(BASE + "/");
  await page.getByRole("button", { name: /Athlete Login/i }).click();
  await page.getByPlaceholder(/name/i).first().fill(NAME);
  await page.locator('input[type="password"], input[inputmode="numeric"]').first().fill(PIN);
  await page.getByRole("button", { name: /Let's Get to Work/i }).click();
  await page.getByText("WILCO", { exact: true }).first().waitFor({ timeout: 45000 });
}
async function dismiss() { for (const label of [/Not now/i, /No thanks/i, /^Later$/i, /Keep going/i]) { const b = page.getByRole("button", { name: label }).first(); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); } }
const bubbles = () => page.evaluate(() => [...document.querySelectorAll(".proof-drop > div")].map((d) => ({ user: d.style.color === "rgb(255, 255, 255)" || d.style.color === "#fff", text: d.innerText })));

async function settle(maxMs = 60000) {
  const t0 = Date.now(); let last = "", since = Date.now();
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(1200);
    const now = await page.evaluate(() => document.body.innerText);
    const busy = await page.evaluate(() => !!document.querySelector('[style*="pulse 1.2s"]') || !!document.querySelector(".ld-dots"));
    if (now !== last || busy) { last = now; since = Date.now(); }
    if (Date.now() - since > 5000 && Date.now() - t0 > 4000) break;
  }
}

await cleanup();
await login();
const order = (process.env.SCEN || "sick,twoinone,curse").split(",");
const RUNS = +(process.env.RUNS || 5);
for (const name of order) {
  const sc = SCENARIOS[name];
  for (let run = 1; run <= RUNS; run++) {
    await cleanup();
    await sc.setup();
    if (!sc.chat) await rest("proof_digests", { method: "POST", body: JSON.stringify(digestRow(sc.bank)) });
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("wilco_chat_")) localStorage.removeItem(k); });
    await page.goto(BASE + "/");
    await page.waitForTimeout(6000);
    await dismiss();
    turns = [];
    const rec = { name, run, theme: THEME, said: [], shown: [], turns: [], ended: false };
    if (sc.chat) {
      const composer = page.getByPlaceholder(/Tell Coach Joe about your workout/);
      await composer.waitFor({ timeout: 45000 }); await page.waitForTimeout(2000); await dismiss();
      await composer.fill(sc.say[0]); await page.getByRole("button", { name: "→", exact: true }).click();
      await settle(70000);
      const txt = await page.evaluate(() => document.body.innerText);
      const at = txt.lastIndexOf(sc.say[0].slice(0, 30));
      rec.said.push(sc.say[0]); rec.shown.push(at >= 0 ? txt.slice(at + sc.say[0].length, at + sc.say[0].length + 1500) : txt.slice(-1500));
      if (SHOTS && run === 1) await page.screenshot({ path: `${SHOTS}/realai-chat-curse-${THEME}.png` });
    } else {
      await page.getByRole("button", { name: "MY LOG" }).click();
      await page.getByRole("button", { name: /^proof$/i }).click();
      await page.getByText(/OPEN THIS WEEK'S EDITION/).click();
      await page.getByText(/START CHECK-IN/).click({ timeout: 20000 });
      await page.waitForTimeout(800);
      for (const msg of sc.say) {
        if (await page.getByText(/Check-in complete for this report/).isVisible().catch(() => false)) { rec.ended = true; break; }
        const box = page.getByPlaceholder("Type your answer...");
        if (!(await box.isVisible().catch(() => false))) { if (await page.getByRole("button", { name: /No thanks/ }).isVisible().catch(() => false)) await page.getByRole("button", { name: /No thanks/ }).click(); else break; }
        await box.fill(msg);
        await box.locator("xpath=following-sibling::button[1]").click();
        rec.said.push(msg);
        await settle(60000);
      }
      rec.ended = rec.ended || await page.getByText(/Check-in complete for this report/).isVisible().catch(() => false);
      rec.shown = (await bubbles()).map((b) => `${b.user ? "ATHLETE" : "JOE"}: ${b.text}`);
      if (SHOTS && run === 1) await page.screenshot({ path: `${SHOTS}/realai-checkin-${name}-${THEME}.png`, fullPage: false });
      await page.getByRole("button", { name: /Close/ }).first().click().catch(() => {});
    }
    rec.turns = turns;
    rec.pageText = (await page.evaluate(() => document.body.innerText)).slice(-4000);
    results.push(rec);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`${name} #${run}: ${rec.shown.length} bubbles, ended=${rec.ended}, turns=${turns.length}`);
    await sleep(3000);
  }
}
await cleanup();
await browser.close();

// ── invariants ───────────────────────────────────────────────────────────────
const inv = {};
const add = (k, v) => { (inv[k] ||= [0, 0]); inv[k][v ? 0 : 1]++; };
for (const r of results) {
  const joe = r.shown.filter((s) => !s.startsWith("ATHLETE:")).join("\n");
  add(`${r.name}: no banned word shown`, !hasBannedWord(joe) && !hasBannedWord(r.pageText.replace(new RegExp(r.said.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "$^", "g"), "")));
  add(`${r.name}: no go-deeper text`, !/go deeper|wrap it here|short version/i.test(r.pageText));
  if (r.name === "curse") continue;
  // never asks a covered item: parse each raw turn; its next must not be in the covered set so far
  let covered = new Set(), repeat = false, respondedFirst = true;
  r.turns.filter((t) => t.feature === "joebot_chat").forEach((t, i) => {
    let j = null; try { j = JSON.parse(String(t.raw).replace(/```json|```/g, "").trim()); } catch {}
    if (!j) return;
    if (j.next && covered.has(j.next)) repeat = true;
    (j.covered || []).forEach((id) => covered.add(id));
    const said = r.said[i] || "";
    const warrants = /sick|why|click|fine honestly/i.test(said);
    if (warrants && j.reply) { const firstQ = j.reply.indexOf("?"); const before = firstQ < 0 ? j.reply : j.reply.slice(0, firstQ); if (before.split(/[.!]/).filter((x) => x.trim().length > 3).length < 1 && firstQ >= 0 && before.trim().length < 15) respondedFirst = false; }
  });
  add(`${r.name}: never asks a covered item`, !repeat);
  add(`${r.name}: responds before asking the next item`, respondedFirst);
  if (r.name === "sick") add("sick: no 'knee's clear' / 'goal's locked in' parroting", !/knee'?s clear|goal'?s locked/i.test(r.shown.join("\n")));
  if (r.name === "twoinone") {
    const t2 = r.turns.filter((t) => t.feature === "joebot_chat")[1];
    add("twoinone: weight + knee covered by message 1 (gone from open items on turn 2)", t2 && !/weight:/.test(t2.open) && !/injury:/.test(t2.open));
    const t2raw = t2 ? t2.raw : "";
    add("twoinone: the tangent ('why do my knees click') gets answered", /click|gas|noise|pop|cavitation|pain/i.test(t2raw));
  }
  add(`${r.name}: check-in ends (covered or athlete ended)`, r.ended);
}
console.log("\nINVARIANTS (pass/fail):");
for (const [k, [p, f]] of Object.entries(inv)) console.log(`${f ? "✗" : "✓"} ${k}: ${p}/${p + f}`);
fs.writeFileSync(OUT, JSON.stringify({ results, invariants: inv }, null, 2));
