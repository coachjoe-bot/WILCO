// ─── THE WORKOUT IN PROGRESS (Will, TestFlight, 09-29) ───────────────────────
// His report: start a workout, change the log sheet, close the app, and the
// changes are gone. His rule: a workout that was started and has not been
// finished or cancelled keeps its edits across a close.
//
// A reload is the cold boot here: React state is gone, localStorage is not,
// which is exactly what a closed and reopened app has to work with. liveToken
// keeps the sign-in restorable, so the reload lands in the app like a reopen.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete, emptyParse, liveToken } from "./mocks.js";

const PROGRAM = "Day 1 - Push\nBench Press 3x5 @ 185\nOverhead Press 3x8 @ 95\n\nDay 2 - Pull\nDeadlift 3x5 @ 275\nBarbell Row 3x8 @ 155";
const DRAFT_REPLY = "Week 1, Day 1: Push. Heavy bench day.\n===\nDay 1 - Push\n\nBench Press 3x5 @ 185\nOverhead Press 3x8 @ 95";
const EDITED = "Day 1 - Push\n\nBench Press 3x5 @ 190\nOverhead Press 3x8 @ 100\nDips 3x12";
const SHEET = "Today's workout log";

const parkOf = (page, athlete) => page.evaluate((id) => JSON.parse(localStorage.getItem(`wilco_quicklog_${id}`) || "null"), athlete.id);

// Boot, tap Start Workout, open the sheet, type the edit.
const startAndEdit = async (page, athlete) => {
  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "Start Workout" }).click();
  const bar = page.getByText("Day 1 - Push", { exact: true }).first();
  await expect(bar).toBeVisible({ timeout: 15000 });
  await bar.click();
  const sheet = page.getByRole("textbox", { name: SHEET });
  await expect(sheet).toHaveValue(/Bench Press 3x5 @ 185/);
  await sheet.fill(EDITED);
  await expect.poll(async () => (await parkOf(page, athlete))?.draft).toBe(EDITED);
};

// The app closed and opened again.
const reopen = async (page) => {
  await page.reload();
  await page.getByText("WILCO", { exact: true }).waitFor();
};

test("start, edit, close the app: the bar is back and the edits are on the sheet", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);

  const draftsBefore = calls.filter((c) => c.body?.feature === "quick_log_draft").length;
  await reopen(page);

  // No lock-screen card exists on web, so this is the bar coming back on the
  // park's own word.
  const bar = page.getByText("Day 1 - Push", { exact: true }).first();
  await expect(bar).toBeVisible({ timeout: 15000 });
  await bar.click();
  await expect(page.getByRole("textbox", { name: SHEET })).toHaveValue(EDITED);
  // Nothing regenerated on the way back.
  expect(calls.filter((c) => c.body?.feature === "quick_log_draft").length).toBe(draftsBefore);

  // And it is still a live workout: Finish sends what they typed.
  await page.getByRole("button", { name: "Finish Workout" }).click();
  await expect(page.getByText("Dips 3x12")).toBeVisible({ timeout: 15000 });
  await expect.poll(() => parkOf(page, athlete)).toBeNull();
});

test("a second close keeps them too (the resume itself must not disturb the park)", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  await reopen(page);
  await expect(page.getByText("Day 1 - Push", { exact: true }).first()).toBeVisible({ timeout: 15000 });
  await reopen(page);
  const bar = page.getByText("Day 1 - Push", { exact: true }).first();
  await expect(bar).toBeVisible({ timeout: 15000 });
  await bar.click();
  await expect(page.getByRole("textbox", { name: SHEET })).toHaveValue(EDITED);
});

test("edits made after the reopen survive the next close", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  await reopen(page);
  const bar = page.getByText("Day 1 - Push", { exact: true }).first();
  await expect(bar).toBeVisible({ timeout: 15000 });
  await bar.click();
  const more = EDITED + "\nTricep Pushdown 3x15 @ 50";
  await page.getByRole("textbox", { name: SHEET }).fill(more);
  await expect.poll(async () => (await parkOf(page, athlete))?.draft).toBe(more);
  await reopen(page);
  await page.getByText("Day 1 - Push", { exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: SHEET })).toHaveValue(more);
});

test("the date on the sheet comes back with it", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  const d = new Date(); d.setDate(d.getDate() - 1);
  const yesterday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await page.getByLabel("Logging for date").fill(yesterday);
  await expect.poll(async () => (await parkOf(page, athlete))?.sheetDate).toBe(yesterday);
  await reopen(page);
  await page.getByText("Day 1 - Push", { exact: true }).first().click();
  await expect(page.getByLabel("Logging for date")).toHaveValue(yesterday);
  await expect(page.getByRole("textbox", { name: SHEET })).toHaveValue(EDITED);
});

test("cancelled with the X: no bar after a close, and nothing was sent", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  // The X lives on the bar: slide the sheet down first (its header is the handle).
  await page.getByText("Day 1 - Push", { exact: true }).first().click();
  await page.getByRole("button", { name: "Take it off the screen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Finish Workout" })).toHaveCount(0);
  await reopen(page);
  await expect(page.getByText(/Here's today|Bench Press/).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Day 1 - Push", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finish Workout" })).toHaveCount(0);
  expect(calls.some((c) => c.body?.op === "insert" && c.body?.table === "workouts")).toBe(false);
});

test("finished: nothing comes back after a close", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  await page.getByRole("button", { name: "Finish Workout" }).click();
  await expect(page.getByText("Dips 3x12")).toBeVisible({ timeout: 15000 });
  await expect.poll(() => parkOf(page, athlete)).toBeNull();
  await reopen(page);
  await page.waitForTimeout(1500);
  await expect(page.getByRole("button", { name: "Finish Workout" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: SHEET })).toHaveCount(0);
});

// His account holds 233 rows against a 100-row history window. Chat rows sent
// mid-workout push old sessions out of the window the next boot loads, which
// changed the old stamp (a count) and threw the sheet away.
test("history window slides between the edit and the reopen: the edits still come back", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const real = (id, daysAgo) => ({
    id, athlete_id: athlete.id, created_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
    raw_message: "Bench 3x5 @ 185", bot_reply: "Solid.",
    parsed_data: { ...emptyParse, exercises: [{ name: "Bench Press", sets: 3, reps: 5, weight: 185, unit: "lbs", set_details: null }] },
  });
  const chat = (id, daysAgo) => ({
    id, athlete_id: athlete.id, created_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
    raw_message: "how's my bench looking", bot_reply: "Moving.", parsed_data: { ...emptyParse },
  });
  const first = [real("r-new", 1), chat("c-1", 2), real("r-mid", 3), chat("c-2", 4), real("r-old", 5)];
  // Same newest session, but the window has moved: two chat rows in, the two
  // oldest rows (one of them a real session) out.
  const second = [chat("c-new-2", 0), chat("c-new-1", 0), real("r-new", 1), chat("c-1", 2), real("r-mid", 3)];
  let boots = 0;
  await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken(), dataReads: { workouts: (body) => {
    if (!/order=created_at\.desc&limit=100/.test(String(body.params || ""))) return [];
    boots += 1;
    return boots === 1 ? first : second;
  } } });
  await startAndEdit(page, athlete);
  await reopen(page);
  const bar = page.getByText("Day 1 - Push", { exact: true }).first();
  await expect(bar).toBeVisible({ timeout: 15000 });
  await bar.click();
  await expect(page.getByRole("textbox", { name: SHEET })).toHaveValue(EDITED);
  expect(boots).toBeGreaterThanOrEqual(2);
});

// Joe's prefill tool used to build a fresh draft over whatever was parked, so
// "starting my workout" said after a reopen replaced the athlete's typing.
test("Joe's prefill on an edited sheet keeps the athlete's text", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  // Sheet down (the bar stays), so the composer is chat again.
  await page.getByText("Day 1 - Push", { exact: true }).first().click();

  // This turn: Joe answers and calls prefill_log_sheet (SSE, as the proxy relays it).
  let toolTurns = 0;
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "mastermind_chat") return route.fallback();
    if (!body.stream) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: "Let's get it." }], usage: {} }) });
    toolTurns += 1;
    route.fulfill({ contentType: "text/event-stream", body:
      `data: ${JSON.stringify({ text: "Let's get it." })}\n\n` +
      `data: ${JSON.stringify({ tool_use: { id: "t1", name: "prefill_log_sheet", input: {} } })}\n\n` +
      `data: ${JSON.stringify({ stop_reason: "end_turn" })}\n\n` });
  });
  const draftsBefore = calls.filter((c) => c.body?.feature === "quick_log_draft").length;
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("starting my workout");
  await page.getByRole("button", { name: "→", exact: true }).click();
  // The turn really ran, tool call and all.
  await expect.poll(() => toolTurns).toBe(1);
  await expect(page.getByText("starting my workout")).toBeVisible();
  await page.waitForTimeout(2500); // the tool runs after the reply settles

  expect((await parkOf(page, athlete))?.draft).toBe(EDITED);
  expect((await parkOf(page, athlete))?.prebuilt).toBe(false);
  expect(calls.filter((c) => c.body?.feature === "quick_log_draft").length).toBe(draftsBefore);
  await page.getByText("Day 1 - Push", { exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: SHEET })).toHaveValue(EDITED);
});

// Nothing said in chat rewrites a sheet they changed, by model or by code. The
// first build sent the message through the sheet's edit call; on the simulator
// a mistyped start came back as a rebuilt sheet with the added lift gone.
for (const said of ["no barbell for overhead today, use dumbbells", "Starting my workoutstar", "subbed dips for pushdowns"]) {
  test(`Joe's prefill never rewrites their sheet from chat: "${said}"`, async ({ page }) => {
    const athlete = makeAthlete({ program_text: PROGRAM });
    const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
    await startAndEdit(page, athlete);
    await page.getByText("Day 1 - Push", { exact: true }).first().click();

    let toolTurns = 0, sheetFactSent = false;
    await page.route("**/api/claude", (route) => {
      const body = route.request().postDataJSON() || {};
      if (body.feature !== "mastermind_chat") return route.fallback();
      sheetFactSent = sheetFactSent || /LOG SHEET \(fact from the app\)/.test(String(body.system || ""));
      if (!body.stream) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: "Got it." }], usage: {} }) });
      toolTurns += 1;
      route.fulfill({ contentType: "text/event-stream", body:
        `data: ${JSON.stringify({ text: "Got it." })}\n\n` +
        `data: ${JSON.stringify({ tool_use: { id: "t1", name: "prefill_log_sheet", input: {} } })}\n\n` +
        `data: ${JSON.stringify({ tool_use: { id: "t2", name: "pin_session_card", input: {} } })}\n\n` +
        `data: ${JSON.stringify({ stop_reason: "end_turn" })}\n\n` });
    });
    const before = calls.filter((c) => /quick_log_(draft|edit)/.test(c.body?.feature || "")).length;
    await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill(said);
    await page.getByRole("button", { name: "→", exact: true }).click();
    await expect.poll(() => toolTurns).toBe(1);
    await page.waitForTimeout(2500); // the tools run after the reply settles

    const park = await parkOf(page, athlete);
    expect(park.draft).toBe(EDITED);
    expect(park.prebuilt).toBe(false);
    expect(park.dock).toBe(true);
    // No model touched the sheet: not a fresh draft, not an edit.
    expect(calls.filter((c) => /quick_log_(draft|edit)/.test(c.body?.feature || "")).length).toBe(before);
    // Joe was told the sheet is theirs before he spoke.
    expect(sheetFactSent).toBe(true);
    await page.getByText("Day 1 - Push", { exact: true }).first().click();
    await expect(page.getByRole("textbox", { name: SHEET })).toHaveValue(EDITED);
  });
}

// They named a different session after editing: the one time chat replaces it.
test("naming a different day after editing does rebuild the sheet", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  await page.getByText("Day 1 - Push", { exact: true }).first().click();
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "mastermind_chat") return route.fallback();
    if (!body.stream) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: "Day 2 it is." }], usage: {} }) });
    route.fulfill({ contentType: "text/event-stream", body:
      `data: ${JSON.stringify({ text: "Day 2 it is." })}\n\n` +
      `data: ${JSON.stringify({ tool_use: { id: "t1", name: "set_position", input: { day: 2 } } })}\n\n` +
      `data: ${JSON.stringify({ tool_use: { id: "t2", name: "prefill_log_sheet", input: { day_label: "Day 2" } } })}\n\n` +
      `data: ${JSON.stringify({ stop_reason: "end_turn" })}\n\n` });
  });
  const before = calls.filter((c) => c.body?.feature === "quick_log_draft").length;
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("I'm actually doing day 2 today");
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.body?.feature === "quick_log_draft").length, { timeout: 15000 }).toBeGreaterThan(before);
});

// An untouched sheet is the app's own draft: Joe's rebuild replaces it, as before.
test("Joe's prefill on an UNTOUCHED sheet still rebuilds it", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "Start Workout" }).click();
  await expect(page.getByText("Day 1 - Push", { exact: true }).first()).toBeVisible({ timeout: 15000 });
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "mastermind_chat") return route.fallback();
    if (!body.stream) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: "Let's get it." }], usage: {} }) });
    route.fulfill({ contentType: "text/event-stream", body:
      `data: ${JSON.stringify({ text: "Let's get it." })}\n\n` +
      `data: ${JSON.stringify({ tool_use: { id: "t1", name: "prefill_log_sheet", input: {} } })}\n\n` +
      `data: ${JSON.stringify({ stop_reason: "end_turn" })}\n\n` });
  });
  const draftsBefore = calls.filter((c) => c.body?.feature === "quick_log_draft").length;
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("starting my workout");
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.body?.feature === "quick_log_draft").length, { timeout: 15000 }).toBeGreaterThan(draftsBefore);
  await expect.poll(async () => (await parkOf(page, athlete))?.dock).toBe(true);
});

// ─── BOARD BUG (09-01, unverified until 09-29): "the log sheet may stay open
// after Finish". Seen once on a polluted fixture. Two states that fixture
// could have been in, each pinned here: a pending program rec on screen, and
// Joe still writing a reply when Finish is tapped.
const REC_ROW = (athleteId) => ({
  id: "rec-row-1", athlete_id: athleteId, owner_type: "athlete", title: "Row swap", status: "rec",
  draft_text: "", transcript: [], updated_at: new Date().toISOString(),
  blueprint: { rec: { v: 1, title: "Row swap", origin: "ask", duration: "1w", parked: false, why: "Asked.",
    swaps: [{ week: null, day: "Day 2 - Pull", find: "Barbell Row 3x8 @ 155", replace: "Dumbbell Row 3x8 @ 60" }] } },
});

test("Finish with a program rec bar on screen: the log sends and the sheet closes", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken(),
    dataReads: { program_drafts: (body) => String(body.params || "").includes('status=in.("rec"') ? [REC_ROW(athlete.id)] : [] } });
  await startAndEdit(page, athlete);
  // The button itself takes the tap: nothing is lying over it.
  await page.waitForTimeout(600);   // the sheet's slide has finished
  const hit = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /Finish Workout/i.test(x.textContent)); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e === b || b.contains(e); });
  expect(hit).toBe(true);
  await page.getByRole("button", { name: "Finish Workout" }).click();
  await expect(page.getByRole("button", { name: "Finish Workout" })).toHaveCount(0);
  await expect.poll(() => calls.some((c) => c.body?.op === "insert" && c.body?.table === "workouts" && String(c.body?.data?.raw_message || "").includes("Dips 3x12")), { timeout: 15000 }).toBe(true);
  await expect.poll(() => parkOf(page, athlete)).toBeNull();
});

test("Finish while Joe is still replying: the workout is not lost", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  await page.getByText("Day 1 - Push", { exact: true }).first().click();   // sheet down, composer is chat
  // A slow reply: the chat turn hangs for 4 seconds.
  await page.route("**/api/claude", async (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "mastermind_chat") return route.fallback();
    await new Promise((r) => setTimeout(r, 4000));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: "Keep the bar close." }], usage: {} }) });
  });
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("any cue for bench today");
  await page.getByRole("button", { name: "→", exact: true }).click();
  // Joe is mid-reply. Open the sheet and finish.
  await page.getByText("Day 1 - Push", { exact: true }).first().click();
  await page.getByRole("button", { name: "Finish Workout" }).click();
  // The sheet comes down at once, and while the send waits the workout is
  // still parked (an app close here must not lose it).
  await expect(page.getByRole("button", { name: "Finish Workout" })).toHaveCount(0);
  expect((await parkOf(page, athlete))?.draft).toBe(EDITED);
  // The reply settles, the queued log goes out by itself, the park is spent.
  await expect.poll(() => calls.some((c) => c.body?.op === "insert" && c.body?.table === "workouts" && String(c.body?.data?.raw_message || "").includes("Dips 3x12")), { timeout: 20000 }).toBe(true);
  await expect.poll(() => parkOf(page, athlete)).toBeNull();
  await expect(page.getByText("Dips 3x12").first()).toBeVisible();
  // Once, not twice.
  expect(calls.filter((c) => c.body?.op === "insert" && c.body?.table === "workouts" && String(c.body?.data?.raw_message || "").includes("Dips 3x12")).length).toBe(1);
});

test("Finish while Joe is replying, then the app closes before the send: the bar brings the workout back", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  await page.getByText("Day 1 - Push", { exact: true }).first().click();
  await page.route("**/api/claude", async (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "mastermind_chat") return route.fallback();
    await new Promise((r) => setTimeout(r, 6000));
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: "Keep the bar close." }], usage: {} }) }).catch(() => {});
  });
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("any cue for bench today");
  await page.getByRole("button", { name: "→", exact: true }).click();
  await page.getByText("Day 1 - Push", { exact: true }).first().click();
  await page.getByRole("button", { name: "Finish Workout" }).click();
  await expect(page.getByRole("button", { name: "Finish Workout" })).toHaveCount(0);
  await reopen(page);   // closed before Joe finished
  const bar = page.getByText("Day 1 - Push", { exact: true }).first();
  await expect(bar).toBeVisible({ timeout: 15000 });
  await bar.click();
  await expect(page.getByRole("textbox", { name: SHEET })).toHaveValue(EDITED);
  expect(calls.some((c) => c.body?.op === "insert" && c.body?.table === "workouts" && String(c.body?.data?.raw_message || "").includes("Dips 3x12"))).toBe(false);
});

test("the rec bar comes back when the log sheet closes", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken(),
    dataReads: { program_drafts: (body) => String(body.params || "").includes('status=in.("rec"') ? [REC_ROW(athlete.id)] : [] } });
  await startAndEdit(page, athlete);                       // sheet is open
  const recX = page.getByRole("button", { name: "Close the program rec", exact: true });
  await expect(recX).toHaveCount(0);
  await page.waitForTimeout(600);                          // the slide up has finished
  await page.getByRole("button", { name: /Day 1 - Push/ }).click();   // the sheet's header: sheet down
  await expect(page.getByRole("textbox", { name: SHEET })).toBeHidden();
  await expect(recX).toBeVisible();
  await expect(page.getByRole("button", { name: "Take it off the screen", exact: true })).toBeVisible();
});

// Will 09-29: "leave it until its dealt with by the athlete." A workout started
// and never finished comes back on any later day, dated to the day it was started.
test("a workout started two days ago and never finished: the bar is back, dated to the day it was started", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  // Two days pass with the app closed.
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
  const startedDay = await page.evaluate(({ id, back }) => {
    const k = `wilco_quicklog_${id}`; const d = JSON.parse(localStorage.getItem(k));
    d.savedAt -= back; d.dockedAt = (d.dockedAt || Date.now()) - back;
    localStorage.setItem(k, JSON.stringify(d));
    for (const key of Object.keys(localStorage)) if (/^wilco_(chat_|today_opener_|opener_choice_|workoutstart)/.test(key)) localStorage.removeItem(key);
    const s = new Date(d.dockedAt);
    return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}`;
  }, { id: athlete.id, back: TWO_DAYS });
  await reopen(page);
  const bar = page.getByText("Day 1 - Push", { exact: true }).first();
  await expect(bar).toBeVisible({ timeout: 15000 });
  // The opener is on screen too, but it does not offer to start a workout that is already up.
  await expect(page.getByRole("button", { name: "Start Workout" })).toHaveCount(0);
  await bar.click();
  await expect(page.getByRole("textbox", { name: SHEET })).toHaveValue(EDITED);
  await expect(page.getByLabel("Logging for date")).toHaveValue(startedDay);
  // Finish files it on that day.
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Finish Workout" }).click();
  await expect.poll(() => (calls.find((c) => c.body?.op === "insert" && c.body?.table === "workouts" && String(c.body?.data?.raw_message || "").includes("Dips 3x12")) || {}).body?.data?.parsed_data?.log_date, { timeout: 15000 }).toBe(startedDay);
  await expect.poll(() => parkOf(page, athlete)).toBeNull();
});

test("text left behind by the X does not come back the next day as a bar", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  await page.getByText("Day 1 - Push", { exact: true }).first().click();
  await page.getByRole("button", { name: "Take it off the screen", exact: true }).click();
  await page.evaluate(({ id }) => { const k = `wilco_quicklog_${id}`; const d = JSON.parse(localStorage.getItem(k)); d.savedAt -= 26 * 60 * 60 * 1000; localStorage.setItem(k, JSON.stringify(d)); }, { id: athlete.id });
  await reopen(page);
  await page.waitForTimeout(1500);
  await expect(page.getByRole("button", { name: "Take it off the screen", exact: true })).toHaveCount(0);
});

// T68 (Will 09-29): every open sheet has the same X its bar has. The workout's
// keeps the text parked exactly as the bar's does.
test("the log sheet's own X takes the workout off the screen, text stays parked", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);                       // sheet is open, no collapsing first
  await page.waitForTimeout(600);
  const x = page.getByRole("button", { name: "Take it off the screen", exact: true });
  await expect(x).toHaveCount(1);
  const box = await x.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(32);
  expect(box.height).toBeGreaterThanOrEqual(32);
  await x.click();
  await expect(page.getByRole("textbox", { name: SHEET })).toBeHidden();
  await expect(page.getByRole("button", { name: "Finish Workout" })).toHaveCount(0);
  await expect(page.getByText("Day 1 - Push", { exact: true })).toHaveCount(0);   // bar gone too
  const park = await parkOf(page, athlete);
  expect(park.draft).toBe(EDITED);
  expect(park.dock).toBeFalsy();
  expect(calls.some((c) => c.body?.op === "insert" && c.body?.table === "workouts")).toBe(false);
});
