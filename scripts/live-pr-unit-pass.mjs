// ─── LIVE DECLARED-MAX UNIT PASS — real AI, the BRANCH client, QA athlete ─────
// Proves the 09-28 fix end to end: the real parser's pr_attempts "unit", the
// stamped row saved to workouts, and the (weight, unit) pair that lands in
// manual_one_rms. vite (default port 5188) proxies /api to PROD, so auth and the
// model are real and the client is this branch. Start it first:
//   npx vite --port 5188 --strictPort
//   node --env-file=.env --env-file=.env.qa scripts/live-pr-unit-pass.mjs
// Writes ONLY QA-athlete rows created during the run and restores the athlete's
// fields after. Hold the QA fixture lock and reseed after (MISSION-CONTROL/locks).
// Manual tool, not a CI check: the live- prefix keeps it out of `npm test`.
import { chromium } from "@playwright/test";
import fs from "node:fs";

const QA = "99999999-9999-4999-8999-999999999999";
const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env.QA_ATHLETE_NAME, PIN = process.env.QA_ATHLETE_PIN;
const BASE = process.env.BASE || "http://localhost:5188";
const OUT = process.env.OUT || "live-pr-unit-pass.json";
if (!SB || !KEY || !NAME || !PIN) { console.error("Need .env + .env.qa (see header)"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
};
const SESSION_START = new Date().toISOString();
const since = encodeURIComponent(SESSION_START);
const ORIGINAL = (await rest(`athletes?id=eq.${QA}&select=weight_unit`))[0];

// Only rows this run created. The QA seed's own manual rows are left standing.
async function cleanup() {
  await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`manual_one_rms?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`prs?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify(ORIGINAL) });
}
const setUnit = (u) => rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ weight_unit: u }) });
const standing = (exercise, weight, unit) => rest("manual_one_rms", { method: "POST", headers: { Prefer: "return=minimal" },
  body: JSON.stringify([{ athlete_id: QA, exercise, normalized_exercise: exercise.toLowerCase(), weight, unit, source: "workout" }]) });

// Lifts the QA seed has no manual row for, so "nothing standing" is true.
const SCENARIOS = [
  { name: "kg athlete, kg written, nothing standing (the incident)", unit: "kg", lift: "snatch",
    msg: "Hit a 102kg snatch today, new PR", want: { weight: 102, unit: "kg" } },
  { name: "kg athlete, kg written, 95 kg standing (old default skipped this)", unit: "kg", lift: "snatch",
    setup: () => standing("Snatch", 95, "kg"),
    msg: "Hit a 102kg snatch today, new PR", want: { weight: 102, unit: "kg" } },
  { name: "kg athlete, NO unit written", unit: "kg", lift: "snatch",
    msg: "Hit a 102 snatch single today, new PR", want: { weight: 102, unit: "kg" } },
  { name: "lbs athlete, NO unit written (must not change)", unit: "lbs", lift: "overhead press",
    msg: "New overhead press max today, hit 165 for a single", want: { weight: 165, unit: "lbs" } },
  { name: "lbs athlete who wrote kg", unit: "lbs", lift: "snatch",
    msg: "Hit a 102kg snatch today, new PR", want: { weight: 102, unit: "kg" } },
];

const results = [];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 430, height: 900 } })).newPage();
let parseReplies = [];
page.on("response", async (res) => {
  if (!/\/api\/claude/.test(res.url())) return;
  let b = null; try { b = res.request().postDataJSON(); } catch { return; }
  if (!b || b.feature !== "workout_parse") return;
  try { const j = await res.json(); parseReplies.push((j.content || []).map((c) => c.text || "").join("")); } catch {}
});
const dismiss = async () => { for (const label of [/Not now/i, /No thanks/i, /^Later$/i, /Keep going/i]) { const b = page.getByRole("button", { name: label }).first(); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); } };
const clearLocal = () => page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^wilco_(chat_|quicklog|today_opener_|opener_choice_)/.test(k)) localStorage.removeItem(k); });

let failed = 0;
try {
  await cleanup();
  await page.goto(BASE + "/");
  await page.getByRole("button", { name: /Athlete Login/i }).click();
  await page.getByPlaceholder(/name/i).first().fill(NAME);
  await page.locator('input[type="password"], input[inputmode="numeric"]').first().fill(PIN);
  await page.getByRole("button", { name: /Let's Get to Work/i }).click();
  await page.getByText("WILCO", { exact: true }).first().waitFor({ timeout: 45000 });

  for (const sc of SCENARIOS) {
    await cleanup();
    await setUnit(sc.unit);
    if (sc.setup) await sc.setup();
    await clearLocal();
    await page.goto(BASE + "/"); // reload so the client boots with this scenario's unit
    await page.waitForTimeout(6000);
    await dismiss();
    const composer = page.getByPlaceholder(/Tell Coach Joe about your workout/);
    await composer.waitFor({ timeout: 45000 });
    await page.waitForTimeout(2500);
    await dismiss();
    parseReplies = [];
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

    const rows = await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}&raw_message=eq.${encodeURIComponent(sc.msg)}&select=parsed_data,bot_reply&order=created_at.desc&limit=1`);
    const savedAttempts = rows?.[0]?.parsed_data?.pr_attempts || [];
    const manual = (await rest(`manual_one_rms?athlete_id=eq.${QA}&select=exercise,normalized_exercise,weight,unit,source,created_at,updated_at`))
      .filter((m) => (m.normalized_exercise || m.exercise || "").toLowerCase().includes(sc.lift));
    let parserAttempts = null;
    try { parserAttempts = JSON.parse((parseReplies.slice(-1)[0] || "").replace(/```json|```/g, "").trim()).pr_attempts; } catch {}
    const inv = {
      parserSawAttempt: Array.isArray(parserAttempts) && parserAttempts.length > 0,
      savedRowUnit: savedAttempts.length > 0 && savedAttempts.every((p) => p.unit === sc.want.unit),
      manualRow: manual.length === 1 && Number(manual[0].weight) === sc.want.weight && manual[0].unit === sc.want.unit,
    };
    const okAll = Object.values(inv).every(Boolean);
    if (!okAll) failed++;
    results.push({ name: sc.name, displayUnit: sc.unit, msg: sc.msg, parserAttempts, savedAttempts, manual, reply: rows?.[0]?.bot_reply || null, inv });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`${okAll ? "✓" : "✗"} ${sc.name}\n    parser: ${JSON.stringify(parserAttempts)}\n    saved:  ${JSON.stringify(savedAttempts)}\n    manual: ${JSON.stringify(manual.map((m) => `${m.exercise} ${m.weight} ${m.unit}`))}\n    reply:  ${JSON.stringify((rows?.[0]?.bot_reply || "").slice(0, 300))}`);
    await page.waitForTimeout(4000); // keep the pace slow: the gateway rate-limits bursts
  }
} finally {
  await cleanup();
  await browser.close();
}
console.log(`\n${failed === 0 ? "✓" : "✗"} live pr-unit pass: ${results.length - failed}/${SCENARIOS.length} scenarios held`);
process.exit(failed === 0 && results.length === SCENARIOS.length ? 0 : 1);
