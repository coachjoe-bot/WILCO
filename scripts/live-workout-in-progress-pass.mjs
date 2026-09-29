// ─── LIVE WORKOUT-IN-PROGRESS PASS (T66) — real AI, the BRANCH client, QA athlete ───
// Will's TestFlight report 09-29: start a workout, change the log sheet, close
// the app, the changes are gone. Harness from scripts/live-log-focus-pass.mjs:
// vite proxies /api to PROD, so auth and the model are real and the client is
// this branch. A page reload is the app closing and opening: React state is
// gone, localStorage is what is left.
//
// Scenarios (invariants, never exact words):
//   reopen   Start Workout, edit the sheet, reload: the bar is back with the edit
//   start    edited sheet up, tell real Joe "starting my workout": the edit stands,
//            no fresh draft is generated
//   change   edited sheet up, tell real Joe about a today-only change: the sheet is
//            untouched (chat never rewrites their sheet), no model call touches it
//   garbled  the simulator's mistyped start ("Starting my workoutstar"), which the
//            first build sent through the edit call and lost a lift on
//   cancel   the X, reload: no bar
//   finish   Finish Workout: the log lands, the park is empty, reload: no bar
//   duplicate  the 09-01 report: the same session sent twice, does the sheet stay
//            open after the second Finish? (not in the default run: SCEN=duplicate)
// Writes ONLY QA rows; restores the QA athlete's fields. Hold the fixture lock
// and reseed after.
//   node --env-file=.env --env-file=.env.qa scripts/live-workout-in-progress-pass.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";

const QA = "99999999-9999-4999-8999-999999999999";
const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env.QA_ATHLETE_NAME, PIN = process.env.QA_ATHLETE_PIN;
const BASE = process.env.BASE || "http://localhost:5196";
const OUT = process.env.OUT || "live-workout-in-progress-pass.json";
const SHOTS = process.env.SHOTS || null;
const RUNS = +(process.env.RUNS || 5);
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { ...H, ...(init.headers || {}) }, ...init }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); const t = await r.text(); return t ? JSON.parse(t) : null; };
const SESSION_START = new Date().toISOString();
const FIELDS = "program_text,temp_program_text,program_position_override,weight_unit,pain_marks";
const ORIGINAL = (await rest(`athletes?id=eq.${QA}&select=${FIELDS}`))[0];
const MARK = "Wrist Roller 3x12 @ 25";   // a line no generator would ever write

async function cleanup() {
  const since = encodeURIComponent(SESSION_START);
  await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`athlete_memory?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`program_drafts?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" });
  await rest(`prs?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`manual_one_rms?athlete_id=eq.${QA}&created_at=gte.${since}`, { method: "DELETE" }).catch(() => {});
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify(ORIGINAL) });
}

const results = [];
const note = (name, run, inv, extra = {}) => {
  const ok = Object.values(inv).every(Boolean);
  results.push({ name, run, ok, inv, ...extra });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`${ok ? "PASS" : "FAIL"} ${name} #${run} ${JSON.stringify(inv)}${extra.reply ? `\n  ${JSON.stringify(String(extra.reply).slice(0, 300))}` : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await ctx.newPage();
let ai = [];       // every AI call this turn: {feature, tools:[names]}
let sheetFact = false;
page.on("request", (req) => {
  if (req.method() !== "POST" || !/\/api\/claude/.test(req.url())) return;
  let b = null; try { b = req.postDataJSON(); } catch { return; }
  if (b && /mastermind_chat/.test(b.feature || "") && /LOG SHEET \(fact from the app\)/.test(String(b.system || ""))) sheetFact = true;
});
page.on("response", async (res) => {
  if (!/\/api\/claude/.test(res.url())) return;
  let b = null; try { b = res.request().postDataJSON(); } catch { return; }
  if (!b) return;
  const rec = { feature: b.feature, tools: [] };
  ai.push(rec);
  if (/mastermind_chat/.test(b.feature || "")) {
    try { const t = await res.text(); for (const m of t.matchAll(/"tool_use":\{[^{}]*?"name":"([a-z_]+)"/g)) rec.tools.push(m[1]); } catch {}
  }
});

const park = () => page.evaluate((id) => JSON.parse(localStorage.getItem(`wilco_quicklog_${id}`) || "null"), QA);
const clearLocal = () => page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^wilco_(chat_|quicklog|today_opener_|opener_choice_|sessioncard|workoutstart)/.test(k)) localStorage.removeItem(k); });
async function dismiss() { for (const label of [/Not now/i, /No thanks/i, /^Later$/i, /Keep going/i]) { const b = page.getByRole("button", { name: label }).first(); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); } }
const sheet = () => page.getByRole("textbox", { name: "Today's workout log" });
const finishBtn = () => page.getByRole("button", { name: "Finish Workout" });
const barX = () => page.getByRole("button", { name: "Take it off the screen", exact: true });
const composer = () => page.getByPlaceholder(/Tell Coach Joe about your workout/);
const settle = async (maxMs = 70000) => {
  const t0 = Date.now(); let last = "", stableSince = Date.now();
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(1500);
    const now = await page.evaluate(() => document.body.innerText);
    const dots = await page.locator(".ld-dots").count();
    if (now !== last || dots) { last = now; stableSince = Date.now(); }
    if (Date.now() - stableSince > 8000 && Date.now() - t0 > 10000) break;
  }
};
const reopen = async () => { await page.reload(); await page.getByText("WILCO", { exact: true }).first().waitFor({ timeout: 45000 }); await page.waitForTimeout(7000); };
const openSheet = async () => { if (!(await sheet().isVisible().catch(() => false))) await barX().locator("xpath=..").click(); await sheet().waitFor({ timeout: 15000 }); };
const closeSheet = async () => { if (await sheet().isVisible().catch(() => false)) { await page.keyboard.press("Escape").catch(() => {}); await sheet().locator("xpath=ancestor::div[@aria-hidden][1]/div[1]").click(); await page.waitForTimeout(600); } };

// Fresh boot to the opener, tap Start Workout, open the sheet, make the edit.
async function startAndEdit() {
  await clearLocal();
  await page.goto(BASE + "/");
  await page.getByText("WILCO", { exact: true }).first().waitFor({ timeout: 45000 });
  const start = page.getByRole("button", { name: "Start Workout" });
  await start.waitFor({ timeout: 60000 });
  await start.click();
  await barX().waitFor({ timeout: 60000 });
  await openSheet();
  await page.waitForTimeout(1500);
  const generated = await sheet().inputValue();
  // Two edits of the athlete's own: the first load they see moves, and a line
  // of theirs goes on the end.
  const bumped = generated.replace(/@ (\d+(?:\.\d+)?)/, (m, n) => `@ ${Number(n) + 2.5}`);
  const edited = `${bumped.trimEnd()}\n${MARK}`;
  await sheet().fill(edited);
  await page.waitForFunction(({ id, want }) => { try { return JSON.parse(localStorage.getItem(`wilco_quicklog_${id}`) || "null")?.draft === want; } catch { return false; } }, { id: QA, want: edited }, { timeout: 10000 });
  return { generated, edited };
}

await cleanup();
await page.goto(BASE + "/");
await page.getByRole("button", { name: /Athlete Login/i }).click();
await page.getByPlaceholder(/name/i).first().fill(NAME);
await page.locator('input[type="password"], input[inputmode="numeric"]').first().fill(PIN);
await page.getByRole("button", { name: /Let's Get to Work/i }).click();
await page.getByText("WILCO", { exact: true }).first().waitFor({ timeout: 45000 });
await page.waitForTimeout(4000);
await dismiss();

const order = (process.env.SCEN || "reopen,start,change,garbled,cancel,finish").split(",");
for (const name of order) {
  const runs = name === "start" || name === "change" || name === "garbled" ? RUNS : (name === "reopen" ? 2 : 1);
  for (let run = 1; run <= runs; run++) {
    try {
      await cleanup();
      if (process.env.THEME) await page.evaluate((t) => localStorage.setItem("wilco_theme", t), process.env.THEME);
      const { generated, edited } = await startAndEdit();
      const before = await park();

      if (name === "reopen") {
        ai = [];
        await reopen();
        const barBack = await barX().isVisible().catch(() => false);
        if (barBack) await openSheet();
        const shown = barBack ? await sheet().inputValue() : null;
        if (SHOTS && run === 1) await page.screenshot({ path: `${SHOTS}/reopen-sheet-${process.env.THEME || "light"}.png` });
        if (barBack) { await closeSheet(); if (SHOTS && run === 1) await page.screenshot({ path: `${SHOTS}/reopen-bar-${process.env.THEME || "light"}.png` }); }
        // A second close, straight after.
        await reopen();
        const barBack2 = await barX().isVisible().catch(() => false);
        if (barBack2) await openSheet();
        const shown2 = barBack2 ? await sheet().inputValue() : null;
        note(name, run, {
          editDiffersFromGenerated: edited !== generated,
          parkIsTheirs: before && before.prebuilt === false && before.dock === true,
          barBack, editsShown: shown === edited,
          barBackSecondClose: barBack2, editsShownSecondClose: shown2 === edited,
          nothingRegenerated: !ai.some((c) => c.feature === "quick_log_draft"),
        }, { aiOnReopen: ai.map((c) => c.feature) });
      }

      if (name === "start" || name === "change" || name === "garbled") {
        await closeSheet();
        await reopen();                       // the report's order: edit, close the app, come back, talk to Joe
        await composer().waitFor({ timeout: 45000 });
        await dismiss();
        ai = []; sheetFact = false;
        const msg = name === "start" ? "starting my workout" : name === "garbled" ? "Starting my workoutstar" : "the squat racks are all taken today, swap my first lift for something I can do with dumbbells";
        await composer().fill(msg);
        await page.getByRole("button", { name: "→", exact: true }).click();
        await settle();
        await page.waitForTimeout(6000);      // tools run after the reply settles
        const after = await park();
        const tools = ai.flatMap((c) => c.tools);
        const features = ai.map((c) => c.feature);
        const body = await page.evaluate(() => document.body.innerText);
        const reply = body.slice(body.lastIndexOf(msg) + msg.length).split(/\n(?:Tell Coach Joe|Type naturally)/)[0].trim();
        const firstEditedLine = edited.split("\n").find((l) => /@ \d/.test(l)) || "";
        const inv = {
          parkStillThere: !!after && !!after.draft,
          theirLineKept: !!after && after.draft.includes(MARK),
          noFreshDraft: !features.includes("quick_log_draft"),
          stillTheirs: !!after && after.prebuilt === false,
          barUp: await barX().isVisible().catch(() => false) || /PROGRAM REC/.test(body),   // a rec bar sits over the workout bar when Joe stages one
          noStartButtonsMidWorkout: !(await page.getByRole("button", { name: "Start Workout" }).isVisible().catch(() => false)),
        };
        inv.textUntouched = !!after && after.draft === edited;
        inv.noModelTouchedTheSheet = !features.includes("quick_log_edit") && !features.includes("quick_log_draft");
        inv.joeToldTheSheetIsTheirs = sheetFact;
        // A claim about the SHEET only ("reset between reps" is coaching, and tripped the first version of this check).
        inv.joeDidNotClaimARebuild = !/\b(?:rebuilt|re-?built|reset|prefilled|updated|refreshed|swapped|changed)\b[^.!?\n]{0,25}\b(?:your|the)\s+(?:log\s+)?(?:sheet|log)\b|\b(?:sheet|log)\b[^.!?\n]{0,20}\b(?:is|has been|now)\s+(?:rebuilt|reset|updated|prefilled|refreshed)\b/i.test(reply);
        note(name, run, inv, { tools, features, reply, changed: !!after && after.draft !== edited, firstEditedLine, draftAfter: after && after.draft });
      }

      if (name === "cancel") {
        await closeSheet();
        await barX().click();
        await page.waitForTimeout(800);
        const p1 = await park();
        await reopen();
        note(name, run, {
          barGoneAfterX: !(await barX().isVisible().catch(() => false)),
          dockFlagOff: !!p1 && !p1.dock,
          textStillParked: !!p1 && p1.draft === edited,
        });
      }

      if (name === "duplicate") {
        await openSheet();
        await finishBtn().click();
        await settle();
        await page.waitForTimeout(5000);
        const first = await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(SESSION_START)}&select=id,raw_message,parsed_data&order=created_at.desc&limit=5`);
        const row = (first || []).find((r) => String(r.raw_message || "").includes(MARK));
        // The same session again: their sheet, parked against the history as it now stands.
        await page.evaluate(({ id, draft, head }) => localStorage.setItem(`wilco_quicklog_${id}`, JSON.stringify({ draft, notes: "", undoStack: [], savedAt: Date.now(), stamp: `1:${head}`, prebuilt: false, dock: true })), { id: QA, draft: edited, head: row && row.id });
        await reopen();
        const barBack = await barX().isVisible().catch(() => false);
        if (barBack) await openSheet();
        const sameText = barBack ? (await sheet().inputValue()) === edited : false;
        if (barBack) await finishBtn().click();
        await settle();
        await page.waitForTimeout(5000);
        const body = await page.evaluate(() => document.body.innerText);
        const rows = await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(SESSION_START)}&select=id,raw_message&order=created_at.desc&limit=10`);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/duplicate-after-second-finish.png` });
        note(name, run, {
          firstLogLanded: !!row,
          barBackForSecond: barBack, sameText,
          sheetClosedAfterSecondFinish: !(await sheet().isVisible().catch(() => false)),
          finishButtonGone: !(await finishBtn().isVisible().catch(() => false)),
          barGone: !(await barX().isVisible().catch(() => false)),
          parkEmpty: (await park()) === null,
        }, { rowsWithTheLog: (rows || []).filter((r) => String(r.raw_message || "").includes(MARK)).length, tail: body.slice(-600) });
      }

      if (name === "finish") {
        await reopen();
        await openSheet();
        ai = [];
        await finishBtn().click();
        await settle();
        await page.waitForTimeout(5000);
        const p1 = await park();
        const rows = await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(SESSION_START)}&select=raw_message,parsed_data&order=created_at.desc&limit=3`);
        const logged = (rows || []).find((r) => String(r.raw_message || "").includes(MARK));
        await reopen();
        note(name, run, {
          logLanded: !!logged,
          loggedTheirEdit: !!logged && (logged.parsed_data?.exercises || []).some((e) => /wrist roller/i.test(e.name || "")),
          parkEmpty: p1 === null,
          noBarAfterReopen: !(await barX().isVisible().catch(() => false)),
          noSecondDraft: !ai.some((c) => c.feature === "quick_log_draft"),
        }, { features: ai.map((c) => c.feature) });
      }
    } catch (e) {
      note(name, run, { ran: false }, { error: String(e && e.message || e).slice(0, 400) });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/error-${name}-${run}.png` }).catch(() => {});
    }
    await page.waitForTimeout(5000);          // stay under the per-athlete AI limit
  }
}
await cleanup();
await browser.close();
const bad = results.filter((r) => !r.ok);
console.log(`DONE ${results.length} runs, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
