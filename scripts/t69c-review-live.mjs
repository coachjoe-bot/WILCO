// ─── T69-C REVIEW LIVE PASS: real model, the BRANCH client, QA only ───────────
// Drives `npx vite --port <p> --strictPort` (vite proxies /api to PROD: auth and
// the model are real, the client code is this checkout) as a QA athlete. Every
// assertion is on ROWS (confirmed_at, content, status, ask_count), never on
// wording. Scenarios (RUNS times each, 5 by default):
//   still_true   "still true" to every note asked
//   change       the 6am note changed ("7am now"), the rest still true
//   not_anymore  the 6am note is gone
//   ignore       two check-ins in a row, each reply talks about something else:
//                first counts once (ask_count 1), second removes the note
//   two_in_one   two notes answered in one message
//   end_early    the athlete ends the check-in at the first note question
//   events       chat: a meet, an exam, a trip (dated rows land under Schedule),
//                then 5 neutral training turns: Joe never raises them unprompted
//   tomorrow     chat: "maxing out tomorrow" cannot be stored without a date
//   node --env-file=.env --env-file=.env.qa scripts/t69c-review-live.mjs
//   WHO=ATHLETE|CREW  SCEN=still_true,change  RUNS=5  OUT=...  BASE=http://localhost:5197
// Writes ONLY the QA athlete's rows and restores them after every run. Hold the
// fixture lock. The AI limit is 100 calls per 15 minutes per athlete: the pass
// paces itself against rate_limits.
import { chromium } from "@playwright/test";
import fs from "node:fs";

const WHO = process.env.WHO || "ATHLETE";
const QA = process.env[`QA_${WHO}_ID`] || (WHO === "CREW" ? "99999999-9999-4999-8999-999999999998" : "99999999-9999-4999-8999-999999999999");
const SB = process.env.VITE_SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const NAME = process.env[`QA_${WHO}_NAME`], PIN = process.env[`QA_${WHO}_PIN`];
const BASE = process.env.BASE || "http://localhost:5197";
const OUT = process.env.OUT || `t69c-review-live-${WHO}.json`;
const RUNS = +(process.env.RUNS || 5);
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (path, init = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.status === 204 ? null : r.text().then((t) => (t ? JSON.parse(t) : null)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const days = (n) => new Date(Date.now() - n * 86400000).toISOString();
const START = new Date().toISOString();

const FIELDS = "training_days_per_week,equipment,injury_history,review_stamps,weight_lbs,weight_unit,pain_marks";
const ORIGINAL = (await rest(`athletes?id=eq.${QA}&select=${FIELDS}`))[0];
const GOALS0 = await rest(`athlete_goals?athlete_id=eq.${QA}&select=id,goal_text,superseded_at,confirmed_at,ask_count&order=created_at.desc`);
const MEM0 = new Set((await rest(`athlete_memory?athlete_id=eq.${QA}&select=id`)).map((r) => r.id));

async function cleanup() {
  for (const r of await rest(`athlete_memory?athlete_id=eq.${QA}&select=id`)) if (!MEM0.has(r.id)) await rest(`athlete_memory?id=eq.${r.id}`, { method: "DELETE" });
  await rest(`athlete_goals?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(START)}`, { method: "DELETE" });
  for (const g of GOALS0) await rest(`athlete_goals?id=eq.${g.id}`, { method: "PATCH", body: JSON.stringify({ superseded_at: g.superseded_at, confirmed_at: g.confirmed_at, ask_count: g.ask_count }) });
  await rest(`proof_digests?athlete_id=eq.${QA}&label=like.*T69C-QA*`, { method: "DELETE" });
  await rest(`workouts?athlete_id=eq.${QA}&created_at=gte.${encodeURIComponent(START)}`, { method: "DELETE" });
  await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify(ORIGINAL) });
}
// The seeded notes: written by the athlete long ago and never checked since.
const SEED = [
  { key: "n1", content: "Trains at the 6am class", section: "schedule", confirmed: 80, match: /6\s?am|class/i },
  { key: "n2", content: "No RPE, percentages only", section: "preferences", confirmed: 70, match: /rpe|percent/i },
  { key: "n3", content: "Rehabbing a torn labrum, no overhead pressing past 70 lb", section: "body", confirmed: 65, match: /labrum|overhead/i },
];
async function seedNotes(extra = {}) {
  const rows = await rest("athlete_memory", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(SEED.map((s) => ({ athlete_id: QA, content: s.content, kind: "contextual", source: "athlete_said", status: "active", section: s.section, confirmed_at: days(s.confirmed), ask_count: extra[s.key] || 0, created_at: days(s.confirmed + 40), updated_at: days(s.confirmed) }))) });
  const by = {}; for (const r of rows) by[SEED.find((s) => s.content === r.content).key] = r.id;
  return by;
}
const notesNow = () => rest(`athlete_memory?athlete_id=eq.${QA}&select=id,content,status,section,confirmed_at,ask_count,expires_at,kind,created_at&order=created_at.asc`);
const BANK = [
  { id: "weight", kind: "weight", deeper: false, text: "Bodyweight still 185 lbs, or has it moved?" },
  { id: "injury", kind: "injury", deeper: false, text: "Anything banged up I should know about?" },
  { id: "goal", kind: "goal", deeper: false, meta: { goal: "Squat 315" }, text: "Still chasing \"Squat 315\", or has the target shifted?" },
  { id: "recovery", kind: "context", deeper: false, text: "Recovery this week: dialed, flat, or running on fumes?" },
];
const digestRow = () => ({ athlete_id: QA, digest_type: "weekly", label: "WEEKLY DIGEST: T69C-QA", generated_at: new Date().toISOString(), is_read: false,
  content_json: { intro: "Claude, here's your week.", sections: [{ label: "THIS WEEK VS LAST", body: "Two of your four days logged. Squat held at 225 for 3x5." }, { label: "FOCUS NEXT WEEK", body: "Get all four days in." }], questions: BANK, flags: {} } });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await ctx.newPage();
let turns = [], tools = [], extractBodies = [], writes = [];
page.on("response", async (res) => {
  if (/\/api\/data/.test(res.url())) {
    let q = null; try { q = res.request().postDataJSON(); } catch {}
    if (q && ["update", "insert", "delete", "upsert"].includes(q.op) && ["athlete_memory", "athlete_goals", "athletes"].includes(q.table)) {
      let t = ""; try { t = await res.text(); } catch {}
      writes.push({ op: q.op, table: q.table, id: q.id, data: q.data && JSON.stringify(q.data).slice(0, 200), status: res.status(), err: res.status() >= 400 ? t.slice(0, 150) : undefined });
    }
    return;
  }
  if (!/\/api\/claude/.test(res.url())) return;
  let b = null; try { b = res.request().postDataJSON(); } catch { return; }
  if (!b) return;
  let text = ""; try { text = await res.text(); } catch {}
  if (b.feature === "proof_answer_extract") { extractBodies.push({ user: JSON.stringify(b.messages || "").slice(0, 6000), out: text.slice(0, 3000) }); return; }
  if (!/joebot_chat|mastermind_chat/.test(b.feature || "")) return;
  let raw = "";
  try { const j = JSON.parse(text); raw = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""); }
  catch { raw = [...text.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return ""; } }).join(""); }
  for (const line of text.split("\n")) { if (line.startsWith("data: ") && line.includes('"tool_use"')) { try { const o = JSON.parse(line.slice(6)); if (o.tool_use) tools.push({ name: o.tool_use.name, input: o.tool_use.input }); } catch {} } }
  turns.push({ feature: b.feature, raw });
});

async function login() {
  await page.goto(BASE + "/");
  await page.getByRole("button", { name: /Athlete Login/i }).click();
  await page.getByPlaceholder(/name/i).first().fill(NAME);
  await page.locator('input[type="password"], input[inputmode="numeric"]').first().fill(PIN);
  await page.getByRole("button", { name: /Let's Get to Work/i }).click();
  await page.getByRole("button", { name: "MY LOG" }).waitFor({ timeout: 45000 });
}
async function dismiss() { for (const label of [/Not now/i, /No thanks/i, /^Later$/i, /Keep going/i]) { const b = page.getByRole("button", { name: label }).first(); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); } }
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
const joeBubbles = () => page.evaluate(() => [...document.querySelectorAll(".proof-drop > div:first-child")].map((d) => ({ user: d.style.color === "rgb(255, 255, 255)" || d.style.color === "#fff", text: d.innerText })));
async function limiter() {
  for (;;) {
    const since = encodeURIComponent(new Date(Date.now() - 15 * 60000).toISOString());
    const used = (await rest(`rate_limits?key=eq.claude:athlete:${QA}&created_at=gte.${since}&select=id`).catch(() => [])).length;
    if (used <= 78) return;
    console.log(`limiter: ${used}/100 in window, waiting`); await sleep(60000);
  }
}

// ── one check-in ─────────────────────────────────────────────────────────────
// reply(lastJoeText, ctx) -> what the athlete says next; noteMsg(key) per scenario.
const BASE_ANSWERS = (t) => /bodyweight|weigh/i.test(t) ? "185" : /banged up|pain|hurt|sore/i.test(t) ? "nothing hurting" : /recovery|dialed|fumes/i.test(t) ? "dialed" : /chasing|target|goal/i.test(t) ? "same goal" : "yes";
async function runCheckin(scn) {
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("wilco_chat_")) localStorage.removeItem(k); });
  await page.goto(BASE + "/"); await page.waitForTimeout(6000); await dismiss(); await page.waitForTimeout(1500); await dismiss();
  await page.getByRole("button", { name: "MY LOG" }).click();
  await page.getByRole("button", { name: /^proof$/i }).click();
  await page.getByText(/OPEN THIS WEEK'S EDITION/).click();
  await page.getByText(/START CHECK-IN/).waitFor({ timeout: 25000 });
  await page.getByText(/START CHECK-IN/).click();
  await page.getByPlaceholder("Type your answer...").waitFor({ timeout: 20000 });   // START may wait up to 3.5 s for the review list
  await page.waitForTimeout(800);
  const said = [], asked = new Set();
  let ended = false;
  for (let i = 0; i < 16 && !ended; i++) {
    // what Joe said AFTER the athlete's last message (a reply can be two bubbles)
    let text = "";
    for (let tries = 0; tries < 4; tries++) {
      const bubbles = await joeBubbles();
      const lastUser = bubbles.map((b) => b.user).lastIndexOf(true);
      text = bubbles.slice(lastUser + 1).filter((b) => !b.user).map((b) => b.text).join(" ");
      if (text.trim() || await page.getByText(/Check-in complete for this report/).isVisible().catch(() => false)) break;
      await page.waitForTimeout(2500);
    }
    // the note this turn asks about: the LAST note quoted (a reply can acknowledge one and ask the next)
    const noteHits = SEED.filter((s) => s.match.test(text));
    const hit = noteHits.length ? noteHits.map((s) => ({ s, at: text.search(s.match) })).sort((a, b) => b.at - a.at)[0].s : null;
    let msg;
    if (hit) { asked.add(hit.key); msg = scn.noteMsg(hit.key, asked, text); } else msg = BASE_ANSWERS(text);
    if (await page.getByText(/Check-in complete for this report/).isVisible().catch(() => false)) { ended = true; break; }
    const box = page.getByPlaceholder("Type your answer...");
    if (!(await box.isVisible().catch(() => false))) { if (await page.getByRole("button", { name: /No thanks/ }).isVisible().catch(() => false)) { await page.getByRole("button", { name: /No thanks/ }).click(); continue; } break; }
    await box.fill(msg);
    await box.locator("xpath=following-sibling::button[1]").click();
    said.push(msg);
    await settle(60000);
    if (scn.stopAfter && scn.stopAfter(msg)) break;
  }
  ended = ended || await page.getByText(/Check-in complete for this report|pick it up next week|That's it for this week/).first().waitFor({ timeout: 60000 }).then(() => true).catch(() => false);
  await settle(20000);
  const shown = (await joeBubbles()).map((b) => `${b.user ? "ATHLETE" : "JOE"}: ${b.text}`);
  await page.getByRole("button", { name: /Close/ }).first().click().catch(() => {});
  const dbg = await page.evaluate(() => window.__reviewDbg || null).catch(() => null);
  return { said, asked: [...asked], ended, shown, dbg };
}

const stampedAfter = (row, start) => row && row.confirmed_at && row.confirmed_at > start;
const SCEN = {
  still_true: { noteMsg: () => "yeah that's still true",
    check: (r, ids, rows, start) => { const by = (k) => rows.find((x) => x.id === ids[k]); return [
      ["every note asked is stamped checked today and still active", r.asked.length > 0 && r.asked.every((k) => by(k).status === "active" && stampedAfter(by(k), start) && by(k).ask_count === 0)],
      ["no note was removed or changed", SEED.every((s) => by(s.key) && by(s.key).content === s.content && by(s.key).status === "active")],
      ["a note it never asked is untouched", SEED.filter((s) => !r.asked.includes(s.key)).every((s) => !stampedAfter(by(s.key), start))],
    ]; } },
  change: { noteMsg: (k) => k === "n1" ? "that changed, I train at 7am now at a different gym" : "yeah still true",
    check: (r, ids, rows, start) => { const by = (k) => rows.find((x) => x.id === ids[k]); return [
      ["the 6am note was asked", r.asked.includes("n1")],
      ["it was rewritten in place (same id), now says 7, and is stamped", by("n1") && by("n1").status === "active" && /7/.test(by("n1").content) && !/6am class/i.test(by("n1").content) && stampedAfter(by("n1"), start)],
      ["the others asked were stamped, not changed", r.asked.filter((k) => k !== "n1").every((k) => by(k).content === SEED.find((s) => s.key === k).content && stampedAfter(by(k), start))],
    ]; } },
  not_anymore: { noteMsg: (k) => k === "n1" ? "not anymore, I quit that class" : "yeah still true",
    check: (r, ids, rows) => { const by = (k) => rows.find((x) => x.id === ids[k]); return [
      ["the 6am note was asked", r.asked.includes("n1")],
      ["it is removed (status deleted)", by("n1") && by("n1").status === "deleted"],
      ["the others were not removed", r.asked.filter((k) => k !== "n1").every((k) => by(k).status === "active")],
    ]; } },
  two_in_one: { noteMsg: (k, asked) => asked.size === 1 ? "the 6am class is still true, and yes, no RPE still holds, percentages only" : "yeah still true",
    check: (r, ids, rows, start) => { const by = (k) => rows.find((x) => x.id === ids[k]); return [
      ["the 6am and the RPE notes were both stamped from one message", stampedAfter(by("n1"), start) && stampedAfter(by("n2"), start)],
      ["nothing removed", SEED.every((s) => by(s.key).status === "active")],
    ]; } },
  end_early: { noteMsg: () => "gotta go", stopAfter: (m) => /gotta go/.test(m),
    check: (r, ids, rows, start) => { const by = (k) => rows.find((x) => x.id === ids[k]); return [
      ["a note question was reached", r.asked.length > 0],
      ["ending right after it counts for nothing: no note stamped, counted or removed", SEED.every((s) => by(s.key).status === "active" && !stampedAfter(by(s.key), start) && by(s.key).ask_count === 0 && by(s.key).content === s.content)],
    ]; } },
  ignore: { twice: true, noteMsg: () => "ha random but my cat just knocked my coffee over",
    check: (r, ids, rows, start, r2, rows2) => { const by = (rs, k) => rs.find((x) => x.id === ids[k]); return [
      ["first check-in: every note asked was counted once (ask_count 1), none removed", r.asked.length > 0 && r.asked.every((k) => by(rows, k).status === "active" && by(rows, k).ask_count === 1)],
      ["first check-in: nothing was stamped checked", r.asked.every((k) => !stampedAfter(by(rows, k), start))],
      ["second check-in: the same notes, asked again with no answer, are removed", r2.asked.length > 0 && r2.asked.filter((k) => r.asked.includes(k)).every((k) => by(rows2, k).status === "deleted")],
    ]; } },
};

// RESUME=1: keep what an earlier (killed or dropped) run already wrote to OUT and skip those runs.
const prev = process.env.RESUME && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
const results = prev ? (Array.isArray(prev) ? prev : prev.results || []).filter((r) => !r.error) : [];
const doneRuns = new Set(results.map((r) => `${r.name}:${r.run}`));
const order = (process.env.SCEN || "still_true,change,not_anymore,ignore,two_in_one,end_early,events,tomorrow").split(",");
await cleanup();
await login();
for (const name of order) {
  for (let run = 1; run <= RUNS; run++) {
    if (doneRuns.has(`${name}:${run}`)) continue;
    await limiter();
    await cleanup();
    const rec = { name, run, checks: [], error: null };
    for (let attempt = 1; attempt <= 2; attempt++) {
    rec.error = null; rec.checks = [];
    if (attempt > 1) { await cleanup(); await page.goto(BASE + "/"); await page.waitForTimeout(5000); await dismiss(); }
    try {
      if (name === "events" || name === "tomorrow") {
        await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("wilco_chat_") || /^wilco_(quicklog|today_opener_|opener_choice_)/.test(k)) localStorage.removeItem(k); });
        await page.goto(BASE + "/"); await page.waitForTimeout(6000); await dismiss();
        const composer = page.getByPlaceholder(/Tell Coach Joe about your workout/);
        await composer.waitFor({ timeout: 45000 }); await page.waitForTimeout(1500); await dismiss();
        const send = async (m) => { await composer.fill(m); await page.getByRole("button", { name: "→", exact: true }).click(); await settle(70000); };
        const replies = [];
        const lastReply = async (m) => { const t = await page.evaluate(() => document.body.innerText); const at = t.lastIndexOf(m.slice(0, 30)); return at >= 0 ? t.slice(at + m.length) : t.slice(-1500); };
        turns = []; tools = [];
        if (name === "events") {
          const msgs = ["I have a meet on Nov 14 in the 73 kg class", "exam week for school is Oct 26 to 30", "I'm going on a trip Dec 20 to 27"];
          for (const m of msgs) await send(m);
          const NEUTRAL = ["what should my main lift focus be this week?", "how is my squat trending lately?", "give me a quick warm-up for upper body day", "how many sets of rows should I do after bench?", "is it better to squat before or after pulls?"];
          const raised = [], meetMentions = [];
          for (const m of NEUTRAL) { const before = turns.length; await send(m); const r = turns.slice(before).filter((t) => t.feature === "mastermind_chat").map((t) => t.raw).join(" "); replies.push(r); if (/\b(exam|exams|trip|travel|vacation|finals)\b/i.test(r)) raised.push(m); if (/\bmeet\b/i.test(r)) meetMentions.push(m); }
          await page.waitForTimeout(3000);
          const rows = (await notesNow()).filter((r) => !MEM0.has(r.id));
          const find = (re) => rows.find((r) => re.test(r.content) && r.status === "active");
          const meet = find(/nov(ember)?\s*14/i), exam = find(/oct(ober)?\s*26/i), trip = find(/dec(ember)?\s*20/i);
          rec.checks = [
            ["meet saved with a date", !!meet], ["exam saved with a date", !!exam], ["trip saved with a date", !!trip],
            ["each dated row carries an expiry", [meet, exam, trip].filter(Boolean).every((r) => !!r.expires_at)],
            ["each dated row is filed under Schedule", [meet, exam, trip].filter(Boolean).every((r) => r.section === "schedule")],
            ["no dated row says tomorrow or next week", rows.every((r) => !/\b(tomorrow|next week|this week)\b/i.test(r.content))],
            ["in 5 later training turns Joe never raised the exam or the trip unprompted", raised.length === 0],
          ];
          rec.detail = { rows: rows.map((r) => ({ c: r.content, s: r.section, e: r.expires_at })), tools: tools.map((t) => t.name), raised, meetMentions, replies };
        } else {
          await send("remember that I'm maxing out bench tomorrow");
          await page.waitForTimeout(3000);
          const rows = (await notesNow()).filter((r) => !MEM0.has(r.id));
          const refusedLine = await page.getByText(/Not saved\./).count();
          rec.checks = [
            ["nothing stored says tomorrow without an expiry", rows.every((r) => !/\b(tomorrow|next week)\b/i.test(r.content) || !!r.expires_at)],
            ["either Joe wrote a real date with an expiry, or the app said Not saved", rows.some((r) => r.expires_at) || refusedLine > 0 || rows.length === 0],
          ];
          rec.detail = { rows: rows.map((r) => ({ c: r.content, s: r.section, e: r.expires_at })), tools: tools, refusedLine };
        }
      } else {
        const scn = SCEN[name];
        const ids = await seedNotes();
        // the review should see only these three notes and the goal
        await rest(`athletes?id=eq.${QA}`, { method: "PATCH", body: JSON.stringify({ training_days_per_week: null, equipment: null, injury_history: null, review_stamps: null }) });
        await rest("proof_digests", { method: "POST", body: JSON.stringify(digestRow()) });
        turns = []; extractBodies = []; writes = [];
        const start = new Date().toISOString();
        const r = await runCheckin(scn);
        await page.waitForTimeout(4000);
        const rows = await notesNow();
        let r2 = null, rows2 = null;
        if (scn.twice) {
          await limiter();
          await rest(`proof_digests?athlete_id=eq.${QA}&label=like.*T69C-QA*`, { method: "DELETE" });
          await rest("proof_digests", { method: "POST", body: JSON.stringify(digestRow()) });
          r2 = await runCheckin(scn);
          await page.waitForTimeout(4000);
          rows2 = await notesNow();
        }
        const checks = scn.check(r, ids, rows, start, r2, rows2);
        const weekRows = (rows2 || rows).filter((x) => !MEM0.has(x.id) && x.section === "this_week");
        checks.push(["no 'Weekly check-in' summary note was written", (rows2 || rows).every((x) => !/^(Weekly|Monthly) check-in/.test(x.content) || MEM0.has(x.id) || SEED.some((s) => s.content === x.content))]);
        if (name !== "end_early") checks.push(["one This-week row per check-in at most", weekRows.length <= (scn.twice ? 2 : 1)]);
        checks.push(["the check-in ended", r.ended]);
        rec.checks = checks;
        rec.detail = { writes, said: r.said, asked: r.asked, shown: r.shown, rows: (rows2 || rows).map((x) => ({ id: x.id.slice(0, 6), c: x.content.slice(0, 60), st: x.status, ac: x.ask_count, cf: x.confirmed_at, sec: x.section })), extract: extractBodies.map((e) => e.out.slice(0, 700)) };
        rec.detail.dbg = r.dbg; if (r2) rec.detail.second = { said: r2.said, asked: r2.asked, dbg: r2.dbg };
      }
    } catch (e) { rec.error = String(e && e.message || e).slice(0, 300); }
    if (!rec.error) break;
    }
    results.push(rec);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`${name} #${run}: ${rec.error ? "ERROR " + rec.error : rec.checks.map(([l, ok]) => `${ok ? "✓" : "✗"}`).join("")} ${rec.checks.filter(([, ok]) => !ok).map(([l]) => l).join(" | ")}`);
    await sleep(2000);
  }
}
await cleanup();
await browser.close();
const tally = {};
for (const r of results) for (const [l, ok] of r.checks) { const k = `${r.name}: ${l}`; (tally[k] ||= [0, 0])[ok ? 0 : 1]++; }
console.log("\nCHECKS (pass/total):");
for (const [k, [p, f]] of Object.entries(tally)) console.log(`${f ? "✗" : "✓"} ${k}: ${p}/${p + f}`);
console.log(`errors: ${results.filter((r) => r.error).length}`);
fs.writeFileSync(OUT, JSON.stringify({ results, tally }, null, 2));
