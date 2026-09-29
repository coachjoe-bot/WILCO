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
      `data: ${JSON.stringify({ tool_use: { name: "prefill_log_sheet", input: {} } })}\n\n` +
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

// A today-only change said in chat lands on THEIR text through the sheet's own
// edit call (quick_log_edit), never through a fresh draft.
test("Joe's prefill with a change in the message edits the athlete's sheet, it does not replace it", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, token: liveToken() });
  await startAndEdit(page, athlete);
  await page.getByText("Day 1 - Push", { exact: true }).first().click();

  const AFTER = EDITED.replace("Overhead Press 3x8 @ 100", "Dumbbell Press 3x8 @ 45");
  let editSawTheirText = false;
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature === "quick_log_edit") {
      const sent = JSON.stringify(body.messages || "");
      editSawTheirText = sent.includes("Bench Press 3x5 @ 190") && sent.includes("no barbell for overhead");
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: AFTER }], usage: {} }) });
    }
    if (body.feature !== "mastermind_chat") return route.fallback();
    if (!body.stream) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: "Dumbbells it is." }], usage: {} }) });
    route.fulfill({ contentType: "text/event-stream", body:
      `data: ${JSON.stringify({ text: "Dumbbells it is." })}\n\n` +
      `data: ${JSON.stringify({ tool_use: { name: "prefill_log_sheet", input: {} } })}\n\n` +
      `data: ${JSON.stringify({ stop_reason: "end_turn" })}\n\n` });
  });
  const draftsBefore = calls.filter((c) => c.body?.feature === "quick_log_draft").length;
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("no barbell for overhead today, use dumbbells");
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect.poll(async () => (await parkOf(page, athlete))?.draft, { timeout: 15000 }).toBe(AFTER);
  expect(editSawTheirText).toBe(true);
  expect(calls.filter((c) => c.body?.feature === "quick_log_draft").length).toBe(draftsBefore);
  // Their other edits are still there, and the park is still theirs and still up.
  const park = await parkOf(page, athlete);
  expect(park.draft).toContain("Bench Press 3x5 @ 190");
  expect(park.draft).toContain("Dips 3x12");
  expect(park.prebuilt).toBe(false);
  expect(park.dock).toBe(true);
  await page.getByText("Day 1 - Push", { exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: SHEET })).toHaveValue(AFTER);
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
      `data: ${JSON.stringify({ tool_use: { name: "prefill_log_sheet", input: {} } })}\n\n` +
      `data: ${JSON.stringify({ stop_reason: "end_turn" })}\n\n` });
  });
  const draftsBefore = calls.filter((c) => c.body?.feature === "quick_log_draft").length;
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("starting my workout");
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.body?.feature === "quick_log_draft").length, { timeout: 15000 }).toBeGreaterThan(draftsBefore);
  await expect.poll(async () => (await parkOf(page, athlete))?.dock).toBe(true);
});
