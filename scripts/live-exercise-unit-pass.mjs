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

// want: lift-name pattern -> { weight, unit, source (which resolver step), suspect }.
// wrong: text that would only appear if a load were filed in the wrong unit.
// T65 v2 scenarios run against per-lift history seeded below (seedHistory).
const SCENARIOS = [
  { id: "kg-bench-hist", name: "kg athlete, bench history in lbs: 'bench 3x5 at 205'", unit: "kg", msg: "bench 3x5 at 205",
    want: [{ lift: /bench/i, weight: 205, unit: "lbs", source: ["history"] }], wrong: [/205\s?kg/i] },
  { id: "kg-backext-hist", name: "kg athlete, back extension history in lbs: 'back extensions 3x12 at 45'", unit: "kg", msg: "back extensions 3x12 at 45",
    want: [{ lift: /extension/i, weight: 45, unit: "lbs", source: ["history"] }], wrong: [/45\s?kg/i] },
  { id: "lbs-frontsquat-suspect", name: "lbs athlete, front squat history in kg, 'front squat 3x3 at 225' (only fits lbs)", unit: "lbs", msg: "front squat 3x3 at 225",
    want: [{ lift: /front squat/i, weight: 225, unit: "kg", source: ["history"], suspect: true }], wrong: [] },
  { id: "kg-first-lift", name: "kg athlete, first-ever lift: 'zercher squat 3x5 at 100'", unit: "kg", msg: "zercher squat 3x5 at 100",
    want: [{ lift: /zercher/i, weight: 100, unit: "kg", source: ["display"] }], wrong: [/100\s?lbs?\b/i, /45\.4\s?kg/i] },
  { id: "kg-clean-curls", name: "kg athlete, 'clean 100, then curls 40lb'", unit: "kg", msg: "clean 100, then curls 40lb",
    want: [{ lift: /clean/i, weight: 100, unit: "kg", source: ["history", "display"] }, { lift: /curl/i, weight: 40, unit: "lbs", source: ["written"] }], wrong: [/100\s?lbs?\b/i, /\b45(\.4)?\s?kg/i, /40\s?kg/i] },
  { id: "lbs-squat-bench", name: "lbs athlete, 'squat 180kg, then bench 135'", unit: "lbs", msg: "squat 180kg, then bench 135",
    want: [{ lift: /squat/i, weight: 180, unit: "kg", source: ["written"] }, { lift: /bench/i, weight: 135, unit: "lbs", source: ["history", "display"] }], wrong: [/135\s?kg/i, /\b298\b/, /180\s?lbs?\b/i] },
  { id: "kg-sheet", name: "kg athlete sends the pre-filled log sheet unchanged", unit: "kg", sheet: true,
    want: "all-weighted-kg", wrong: [] },
  { id: "lbs-plain", name: "lbs athlete, plain typed log (nothing changes)", unit: "lbs", msg: "bench 3x5 at 185, rows 3x8 at 135",
    want: [{ lift: /bench/i, weight: 185, unit: "lbs", source: ["history", "display"] }, { lift: /row/i, weight: 135, unit: "lbs", source: ["history", "display"] }], wrong: [/185\s?kg/i, /135\s?kg/i] },
  // v3 (orchestrator 09-29): recency ranking, one voice, nothing derived until answered.
  { id: "lbs-frontsquat-answer", name: "lbs athlete, front squat history kg, 'front squat 3x3 at 225' -> one ask, answer lbs", unit: "lbs", msg: "front squat 3x3 at 225",
    want: [{ lift: /front squat/i, weight: 225, unit: "kg", source: ["history"], suspect: true }], wrong: [], answer: "lbs" },
  { id: "kg-snatch-recency", name: "kg athlete, snatch history kg, kg, lbs (none written): 'snatch singles 70/80/90/100'", unit: "kg", msg: "snatch singles 70/80/90/100",
    want: [{ lift: /snatch/i, weight: 100, unit: "kg", source: ["history"] }], wrong: [/100\s?lbs?\b/i] },
  { id: "kg-cj-switchover", name: "kg athlete, first C&J after switching (C&J history all lbs) -> asks, answer kg, next C&J kg with no ask", unit: "kg",
    msg: "clean and jerk 3x1 @ 110,120,125", want: [{ lift: /clean/i, weight: 125, unit: "lbs", source: ["history"], suspect: true }], wrong: [], answer: "kg",
    followUp: { msg: "clean and jerk singles 115, 120", want: { lift: /clean/i, weight: 120, unit: "kg" } } },
].filter((s) => !ONLY || ONLY.has(s.id));

// Per-lift history in mixed units, backdated so each scenario's cleanup (rows
// created during the run) leaves it standing. Reseed after the pass removes it.
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
const hist = (d, raw, exercises) => ({ athlete_id: QA, created_at: ago(d), raw_message: raw, bot_reply: "Logged.", parsed_data: { exercises, pain_flags: [], pr_attempts: [] } });
async function seedHistory() {
  await rest("workouts", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([
    hist(4, "Bench 3x5 @ 205lbs", [{ name: "Bench Press", sets: 3, reps: 5, weight: 205, unit: "lbs" }]),
    hist(11, "Bench 3x5 @ 200lbs", [{ name: "Bench Press", sets: 3, reps: 5, weight: 200, unit: "lbs" }]),
    hist(6, "Back Extensions 3x12 45lbs", [{ name: "Back Extension", sets: 3, reps: 12, weight: 45, unit: "lbs" }]),
    hist(5, "Front Squat 3x3 @ 100kg", [{ name: "Front Squat", sets: 3, reps: 3, weight: 100, unit: "kg" }]),
    hist(12, "Front Squat 3x3 @ 97.5kg", [{ name: "Front Squat", sets: 3, reps: 3, weight: 97.5, unit: "kg" }]),
    hist(7, "Clean 3x2 @ 95kg", [{ name: "Clean", sets: 3, reps: 2, weight: 95, unit: "kg" }]),
    hist(8, "DB curls 3x10 @ 35lbs", [{ name: "Dumbbell Curl", sets: 3, reps: 10, weight: 35, unit: "lbs" }]),
    // v3: snatch = the founder's 09-04 C&J shape (recent kg, older lbs, none written)
    hist(3, "snatch singles 60/70/80/90", [{ name: "Snatch", sets: 4, reps: 1, weight: 90, unit: "kg", set_details: [60, 70, 80, 90].map((w) => ({ weight: w, reps: 1 })) }]),
    hist(9, "snatch singles 60/70/85", [{ name: "Snatch", sets: 3, reps: 1, weight: 85, unit: "kg", set_details: [60, 70, 85].map((w) => ({ weight: w, reps: 1 })) }]),
    hist(16, "snatch singles 135/185/205", [{ name: "Snatch", sets: 3, reps: 1, weight: 205, unit: "lbs", set_details: [135, 185, 205].map((w) => ({ weight: w, reps: 1 })) }]),
    // v3: C&J all lbs (the founder before his first kg C&J on 08-22)
    hist(7, "clean and jerk singles at 135/225/290", [{ name: "Clean & Jerk", sets: 3, reps: 1, weight: 290, unit: "lbs", set_details: [135, 225, 290].map((w) => ({ weight: w, reps: 1 })) }]),
    hist(14, "clean and jerk 2x1 @ 225/275", [{ name: "Clean & Jerk", sets: 2, reps: 1, weight: 275, unit: "lbs", set_details: [225, 275].map((w) => ({ weight: w, reps: 1 })) }]),
    hist(21, "clean and jerk 3x1 @ 225/245/285", [{ name: "Clean & Jerk", sets: 3, reps: 1, weight: 285, unit: "lbs", set_details: [225, 245, 285].map((w) => ({ weight: w, reps: 1 })) }]),
  ]) });
}
// Stay under the claude proxy limiter (100 calls / 15 min per athlete): wait
// until the athlete's recent call count leaves room for one more scenario.
const LIMIT_KEY = `claude:athlete:${QA}`;
async function paceForLimiter(budget = 72) {
  for (;;) {
    const since15 = encodeURIComponent(new Date(Date.now() - 15 * 60000).toISOString());
    const n = (await rest(`rate_limits?key=eq.${encodeURIComponent(LIMIT_KEY)}&created_at=gte.${since15}&select=id`)).length;
    if (n <= budget) return n;
    console.log(`    (pacing: ${n} AI calls in the last 15 min, waiting)`);
    await new Promise((r) => setTimeout(r, 30000));
  }
}

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
// The today-opener cache is kept: regenerating it on every reload costs an AI call.
const clearLocal = () => page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^wilco_(chat_|quicklog)/.test(k)) localStorage.removeItem(k); });
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
  await seedHistory();
  await page.goto(BASE + "/");
  await page.getByRole("button", { name: /Athlete Login/i }).click();
  await page.getByPlaceholder(/name/i).first().fill(NAME);
  await page.locator('input[type="password"], input[inputmode="numeric"]').first().fill(PIN);
  await page.getByRole("button", { name: /Let's Get to Work/i }).click();
  await page.getByText("WILCO", { exact: true }).first().waitFor({ timeout: 45000 });

  for (let run = 1; run <= RUNS; run++) for (const sc of SCENARIOS) {
    total++;
    await paceForLimiter();
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
    const screenRaw = await page.evaluate(() => document.body.innerText);
    // The app's own unit ask names both readings on purpose; judge only the rest.
    const screen = screenRaw.replace(/Quick check before I bank[\s\S]*?the way you say\./g, "[unit ask]");

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
        if (w.suspect) inv[`nothingDerived:${w.weight}`] = !p && (await rest(`manual_one_rms?athlete_id=eq.${QA}&created_at=gte.${since}&select=exercise`)).filter((m) => w.lift.test(m.exercise || "")).length === 0;
        else inv[`est:${w.weight}${w.unit}`] = !!p && p.unit === w.unit && Math.abs(Number(p.estimated_1rm) - epley1RM(toLbs(Number(p.weight), p.unit), p.reps || 1)) <= 2;
        if (w.source) inv[`source:${w.weight}`] = !!e && w.source.includes(e.unit_source);
        inv[`suspect:${w.weight}`] = !!e && !!e.unit_suspect === !!w.suspect;
      }
      const anySuspect = sc.want.some((w) => w.suspect);
      inv.unitAskShownIffSuspect = /Quick check before I bank/.test(screenRaw) === anySuspect;
    }
    const replyText = row?.bot_reply || "";
    // A match inside a QUESTION ("is 140 kg right, or did you mean 140 lbs?") is
    // Joe sanity-checking an implausible jump, which is the designed behavior; a
    // match in a statement ("well past 340 kg territory") is a unit slip.
    const statements = (t) => String(t || "").split(/(?<=[.!?])\s+|\n+/).filter((x) => !/\?\s*$/.test(x.trim()));
    inv.replyAndScreenAgree = sc.wrong.every((re) => !statements(replyText).some((x) => re.test(x)) && !statements(screen).some((x) => re.test(x)));
    const slips = mislabelRes(exs).filter((re) => statements(replyText).some((x) => re.test(x)) || statements(screen).some((x) => re.test(x))).map(String);
    inv.noUnitMislabel = slips.length === 0;
    // One voice: after the athlete's message, exactly one line asks about the unit
    // (the app's ask, or Joe's own question when he asked and the app stayed quiet).
    const tail = screenRaw.slice(screenRaw.lastIndexOf(msg) + msg.length);
    const flaggedNums = (sc.want === "all-weighted-kg" ? [] : sc.want.filter((w) => w.suspect).map((w) => w.weight));
    const unitQuestions = tail.split(/(?<=[.!?])\s+|\n+/).filter((x) => /\?\s*$/.test(x.trim()) && (/\b(kgs?|kilos?|lbs?|pounds?|units?)\b/i.test(x) || flaggedNums.some((n) => new RegExp(`(?<![\\d.])${n}(?!\\d)`).test(x))));
    if (Array.isArray(sc.want)) inv.unitQuestions = unitQuestions.length === (sc.want.some((w) => w.suspect) ? 1 : 0);
    let answer = null, follow = null;
    if (sc.answer && inv.rowSaved) {
      await page.getByRole("button", { name: `It was ${sc.answer}` }).click({ timeout: 20000 }).catch(() => {});
      await settle();
      const r2 = (await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}&raw_message=eq.${encodeURIComponent(msg)}&select=parsed_data`))[0];
      const w = sc.want.find((x) => x.suspect);
      const e2 = (r2?.parsed_data?.exercises || []).find((x) => w.lift.test(x.name || ""));
      const prs2 = (await rest(`prs?athlete_id=eq.${QA}&created_at=gte.${since}&select=exercise,weight,unit,reps,estimated_1rm`)).filter((x) => w.lift.test(x.exercise || ""));
      answer = { saved: e2 && { unit: e2.unit, unit_source: e2.unit_source, unit_suspect: !!e2.unit_suspect }, prs: prs2 };
      inv.answerWritten = !!e2 && e2.unit === sc.answer && e2.unit_source === "athlete_confirmed" && !e2.unit_suspect;
      inv.bankedOnce = prs2.length === 1 && prs2[0].unit === sc.answer;
      inv.noSecondRow = (await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}&raw_message=eq.${encodeURIComponent(msg)}&select=id`)).length === 1;
      if (sc.followUp) {
        await paceForLimiter();
        const composer = page.getByPlaceholder(/Tell Coach Joe about your workout/);
        await composer.fill(sc.followUp.msg);
        await page.getByRole("button", { name: "→", exact: true }).click();
        await settle();
        const r3 = (await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}&raw_message=eq.${encodeURIComponent(sc.followUp.msg)}&select=parsed_data,bot_reply`))[0];
        const e3 = (r3?.parsed_data?.exercises || []).find((x) => sc.followUp.want.lift.test(x.name || ""));
        const s3 = await page.evaluate(() => document.body.innerText);
        follow = { saved: e3 && { unit: e3.unit, unit_source: e3.unit_source, unit_suspect: !!e3.unit_suspect }, reply: r3?.bot_reply };
        inv.followUpKg = !!e3 && Number(e3.weight) === sc.followUp.want.weight && e3.unit === sc.followUp.want.unit && !e3.unit_suspect;
        inv.followUpNoAsk = !/Quick check before I bank/.test(s3.slice(s3.lastIndexOf(sc.followUp.msg)));
      }
    }
    const okAll = Object.values(inv).every(Boolean);
    if (!okAll) failed++;
    if (!inv.rowSaved) {
      await page.screenshot({ path: `${OUT.replace(/\.json$/, "")}-${sc.id}-run${run}.png`, fullPage: true }).catch(() => {});
      fs.writeFileSync(`${OUT.replace(/\.json$/, "")}-${sc.id}-run${run}.txt`, screenRaw);
    }
    results.push({ run, id: sc.id, name: sc.name, displayUnit: sc.unit, msg, parserEx, slips, saved: exs.map((e) => ({ name: e.name, weight: e.weight, unit: e.unit, unit_source: e.unit_source, unit_suspect: !!e.unit_suspect })), unitQuestions, answer, follow, prs, reply: replyText, inv });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`${okAll ? "✓" : "✗"} run ${run} ${sc.name}\n    sent:   ${JSON.stringify(msg.slice(0, 200))}\n    parser: ${JSON.stringify(parserEx)}\n    saved:  ${JSON.stringify(exs.map((e) => `${e.name} ${e.weight} ${e.unit} (${e.unit_source}${e.unit_suspect ? ", suspect" : ""})`))}\n    prs:    ${JSON.stringify(prs.map((p) => `${p.exercise} ${p.weight}${p.unit} x${p.reps} e1rm ${p.estimated_1rm}`))}\n    inv:    ${JSON.stringify(inv)}${slips.length ? `\n    SLIPS:  ${JSON.stringify(slips)}` : ""}\n    reply:  ${JSON.stringify(replyText.slice(0, 260))}`);
    await page.waitForTimeout(5000); // slow pace: the gateway rate-limits bursts
  }
} finally {
  await cleanup();
  await browser.close();
}
console.log(`\n${failed === 0 ? "✓" : "✗"} live exercise-unit pass: ${total - failed}/${total} runs held`);
process.exit(failed === 0 ? 0 : 1);
