// ─── LIVE EXERCISE-UNIT PASS (T65) — real AI, the BRANCH client, QA athlete ───
// Proves end to end that a logged set keeps the unit the athlete meant: the real
// parser's exercise units, the stamped row saved to workouts, the prs (estimated
// max) row, and Joe's reply. vite proxies /api to PROD, so auth and the model are
// real and the client is this branch. Start it first:
//   npx vite --port 5206 --strictPort
//   BASE=http://localhost:5206 RUNS=5 node --env-file=.env --env-file=.env.qa scripts/live-exercise-unit-pass.mjs
// Writes ONLY QA-athlete rows created during the run and restores the athlete's
// fields after. Hold the QA fixture lock and reseed after (MISSION-CONTROL/locks).
// Manual tool, not a CI check: the live- prefix keeps it out of `npm test`.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import { toLbs, epley1RM, bestE1RMForExercise } from "../src/grit.js";

const QA = "99999999-9999-4999-8999-999999999999";
const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env.QA_ATHLETE_NAME, PIN = process.env.QA_ATHLETE_PIN;
const BASE = process.env.BASE || "http://localhost:5206";
const OUT = process.env.OUT || "live-exercise-unit-pass.json";
const RUNS = Number(process.env.RUNS || 5);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
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

async function cleanup() {
  await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`manual_one_rms?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`prs?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify(ORIGINAL) });
}
const setUnit = (u) => rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ weight_unit: u }) });

// want: lift-name pattern -> { weight, unit }. wrong: text that would only appear
// if a load were filed in the wrong unit (the misfiled number shown back).
const SCENARIOS = [
  { id: "kg-squat", name: "kg athlete, 'squat 5x3 at 140'", unit: "kg", msg: "squat 5x3 at 140",
    want: [{ lift: /squat/i, weight: 140, unit: "kg" }], wrong: [/140\s?lbs?\b/i, /63\.5\s?kg/i] },
  { id: "kg-clean-curls", name: "kg athlete, 'clean 100, then curls 40lb'", unit: "kg", msg: "clean 100, then curls 40lb",
    want: [{ lift: /clean/i, weight: 100, unit: "kg" }, { lift: /curl/i, weight: 40, unit: "lbs" }], wrong: [/100\s?lbs?\b/i, /\b45(\.4)?\s?kg/i, /40\s?kg/i] },
  { id: "lbs-squat-bench", name: "lbs athlete, 'squat 180kg, then bench 135'", unit: "lbs", msg: "squat 180kg, then bench 135",
    want: [{ lift: /squat/i, weight: 180, unit: "kg" }, { lift: /bench/i, weight: 135, unit: "lbs" }], wrong: [/135\s?kg/i, /\b298\b/, /180\s?lbs?\b/i] },
  { id: "kg-sheet", name: "kg athlete sends the pre-filled log sheet unchanged", unit: "kg", sheet: true,
    want: "all-weighted-kg", wrong: [] },
  { id: "lbs-plain", name: "lbs athlete, plain typed log (nothing changes)", unit: "lbs", msg: "bench 3x5 at 185, rows 3x8 at 135",
    want: [{ lift: /bench/i, weight: 185, unit: "lbs" }, { lift: /row/i, weight: 135, unit: "lbs" }], wrong: [/185\s?kg/i, /135\s?kg/i] },
].filter((s) => !ONLY || ONLY.has(s.id));

// Text that states a stored load (or its estimated max) under the WRONG unit:
// a kg set's number or e1RM-in-lbs written as kg/lbs the other way round.
const esc = (n) => String(n).replace(".", "\\.");
const mislabelRes = (exs) => exs.filter((e) => (e.unit === "kg" || e.unit === "lbs") && Number(e.weight) > 0).flatMap((e) => {
  const w = Number(e.weight);
  if (e.unit === "kg") {
    const e1 = Math.round(bestE1RMForExercise(e));
    return [new RegExp(`(?<![\\d.])${esc(w)}\\s?(lbs?|pounds)\\b`, "i"), new RegExp(`(?<![\\d.])${esc(Math.round((w / 2.20462) * 10) / 10)}\\s?kg`, "i"), new RegExp(`(?<![\\d.])${e1}\\s?(kg|kilos)`, "i")];
  }
  return [new RegExp(`(?<![\\d.])${esc(w)}\\s?(kg|kilos)\\b`, "i"), new RegExp(`(?<![\\d.])${Math.round(w * 2.20462)}\\s?(lbs?|pounds)\\b`, "i")];
});

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
const settle = async () => {
  const t0 = Date.now();
  let last = "", stableSince = Date.now();
  while (Date.now() - t0 < 90000) {
    await page.waitForTimeout(1500);
    const now = await page.evaluate(() => document.body.innerText);
    const dots = await page.locator(".ld-dots").count();
    if (now !== last || dots) { last = now; stableSince = Date.now(); }
    if (Date.now() - stableSince > 9000 && Date.now() - t0 > 12000) break;
  }
  await page.waitForTimeout(3000);
};

let failed = 0, total = 0;
try {
  await cleanup();
  await page.goto(BASE + "/");
  await page.getByRole("button", { name: /Athlete Login/i }).click();
  await page.getByPlaceholder(/name/i).first().fill(NAME);
  await page.locator('input[type="password"], input[inputmode="numeric"]').first().fill(PIN);
  await page.getByRole("button", { name: /Let's Get to Work/i }).click();
  await page.getByText("WILCO", { exact: true }).first().waitFor({ timeout: 45000 });

  for (let run = 1; run <= RUNS; run++) for (const sc of SCENARIOS) {
    total++;
    await cleanup();
    await setUnit(sc.unit);
    await clearLocal();
    let msg = sc.msg;
    parseReplies = [];
    try {
    if (sc.sheet) {
      await page.goto(BASE + "/?n=quicklog");
      const box = page.getByRole("textbox", { name: "Today's workout log" });
      await box.waitFor({ timeout: 60000 });
      await page.waitForFunction(() => { const t = document.querySelector('textarea[aria-label="Today\'s workout log"]'); return t && /\d/.test(t.value) && !document.querySelector(".ld-dots"); }, null, { timeout: 90000 });
      await page.waitForTimeout(1500);
      msg = (await box.inputValue()).trim();
      await page.getByRole("button", { name: "Finish Workout" }).click();
    } else {
      await page.goto(BASE + "/");
      await page.waitForTimeout(6000);
      await dismiss();
      const composer = page.getByPlaceholder(/Tell Coach Joe about your workout/);
      await composer.waitFor({ timeout: 45000 });
      await page.waitForTimeout(2500);
      await dismiss();
      await composer.fill(msg);
      await page.getByRole("button", { name: "→", exact: true }).click();
    }
    } catch (err) {
      failed++;
      results.push({ run, id: sc.id, name: sc.name, error: String(err).slice(0, 300) });
      fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
      console.log(`✗ run ${run} ${sc.name}: DRIVER ERROR ${String(err).slice(0, 200)}`);
      continue;
    }
    await settle();
    const screen = await page.evaluate(() => document.body.innerText);

    const rows = await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}&select=raw_message,parsed_data,bot_reply&order=created_at.desc&limit=3`);
    const row = rows.find((r) => (r.raw_message || "").trim() === msg) || rows[0];
    const exs = row?.parsed_data?.exercises || [];
    const prs = await rest(`prs?athlete_id=eq.${QA}&created_at=gte.${since}&select=exercise,weight,unit,reps,estimated_1rm`);
    let parserEx = null;
    try { parserEx = JSON.parse((parseReplies.slice(-1)[0] || "").replace(/```json|```/g, "").trim()).exercises?.map((e) => ({ name: e.name, weight: e.weight, unit: e.unit })); } catch {}

    const inv = { rowSaved: !!row && exs.length > 0 };
    if (sc.want === "all-weighted-kg") {
      const weighted = exs.filter((e) => e.unit !== "bodyweight" && Number(e.weight) > 0);
      inv.sheetCarriesKg = /\d\s?kg/.test(msg) && !/\d\s?lbs?\b/i.test(msg);
      inv.everyWeightedSetKg = weighted.length > 0 && weighted.every((e) => e.unit === "kg");
      inv.prsKg = prs.length > 0 && prs.every((p) => p.unit === "kg" || p.unit === "bodyweight");
    } else {
      for (const w of sc.want) {
        const e = exs.find((x) => w.lift.test(x.name || ""));
        inv[`set:${w.weight}${w.unit}`] = !!e && Number(e.weight) === w.weight && e.unit === w.unit;
        const p = prs.find((x) => w.lift.test(x.exercise || ""));
        // Estimated max agrees with the stored pair (Epley on the lbs value).
        inv[`est:${w.weight}${w.unit}`] = !!p && p.unit === w.unit && Math.abs(Number(p.estimated_1rm) - epley1RM(toLbs(Number(p.weight), p.unit), p.reps || 1)) <= 2;
      }
    }
    const replyText = row?.bot_reply || "";
    // A match inside a QUESTION ("is 140 kg right, or did you mean 140 lbs?") is
    // Joe sanity-checking an implausible jump, which is the designed behavior; a
    // match in a statement ("well past 340 kg territory") is a unit slip.
    const statements = (t) => String(t || "").split(/(?<=[.!?])\s+|\n+/).filter((x) => !/\?\s*$/.test(x.trim()));
    inv.replyAndScreenAgree = sc.wrong.every((re) => !statements(replyText).some((x) => re.test(x)) && !statements(screen).some((x) => re.test(x)));
    const slips = mislabelRes(exs).filter((re) => statements(replyText).some((x) => re.test(x)) || statements(screen).some((x) => re.test(x))).map(String);
    inv.noUnitMislabel = slips.length === 0;
    const okAll = Object.values(inv).every(Boolean);
    if (!okAll) failed++;
    results.push({ run, id: sc.id, name: sc.name, displayUnit: sc.unit, msg, parserEx, slips, saved: exs.map((e) => ({ name: e.name, weight: e.weight, unit: e.unit })), prs, reply: replyText, inv });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`${okAll ? "✓" : "✗"} run ${run} ${sc.name}\n    sent:   ${JSON.stringify(msg.slice(0, 200))}\n    parser: ${JSON.stringify(parserEx)}\n    saved:  ${JSON.stringify(exs.map((e) => `${e.name} ${e.weight} ${e.unit}`))}\n    prs:    ${JSON.stringify(prs.map((p) => `${p.exercise} ${p.weight}${p.unit} x${p.reps} e1rm ${p.estimated_1rm}`))}\n    inv:    ${JSON.stringify(inv)}${slips.length ? `\n    SLIPS:  ${JSON.stringify(slips)}` : ""}\n    reply:  ${JSON.stringify(replyText.slice(0, 260))}`);
    await page.waitForTimeout(5000); // slow pace: the gateway rate-limits bursts
  }
} finally {
  await cleanup();
  await browser.close();
}
console.log(`\n${failed === 0 ? "✓" : "✗"} live exercise-unit pass: ${total - failed}/${total} runs held`);
process.exit(failed === 0 ? 0 : 1);
