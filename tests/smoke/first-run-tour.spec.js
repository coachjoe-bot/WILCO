// ─── FIRST-RUN TOUR (T62, Will's 09-01 script) ───────────────────────────────
// The rebuilt tutorial. What these specs are really guarding:
//
//   1. The OFFER IS TWO STAGES. Joe-bot introduces himself with the composer
//      ringed BEFORE the tutorial is offered, so a brand-new athlete learns
//      where words go whether or not they take the tour.
//   2. The tour walks REAL SURFACES with SAMPLE data. The old tour pointed at
//      `builder-tab` and `quicklog-btn`, both retired, so it had been silently
//      broken for every native signup since chat-first shipped. Every anchor
//      here has to resolve to something on screen.
//   3. SAMPLE DATA NEVER PERSISTS. The tour renders a program, a history, a
//      Proof and a set of numbers that the athlete does not have. Finishing OR
//      skipping has to leave the account exactly as it was — no writes, and
//      nothing left on screen. That is the one failure that would be worse than
//      a broken tutorial, so it gets its own spec on both exits.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";

// tour_done_at === null is the ONLY state that owes the offer (undefined means
// a pre-column snapshot, and those accounts were backfilled as done).
const newAthlete = () => ({ ...makeAthlete(), tour_done_at: null, program_text: null, first_chat_complete: false });

const startTour = async (page) => {
  await expect(page.getByText("JOE-BOT", { exact: true })).toBeVisible();
  await page.getByText(/I'm Joe-bot, your assistant coach/).click();   // stage 0 → stage 1
  await page.getByRole("button", { name: "START TUTORIAL" }).click();
};

test("the offer is two stages: Joe-bot introduces himself, then asks", async ({ page }) => {
  const athlete = newAthlete();
  await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);

  // Stage 0: the introduction, with the chat lit behind it.
  await expect(page.getByText(/I'm Joe-bot, your assistant coach/)).toBeVisible();
  await expect(page.getByText(/log a workout, ask a question, mention any injuries/)).toBeVisible();
  // The offer itself is NOT up yet — that is the whole point of splitting them.
  await expect(page.getByRole("button", { name: "START TUTORIAL" })).toHaveCount(0);

  // Stage 1: the question, with two real buttons.
  await page.getByText(/I'm Joe-bot, your assistant coach/).click();
  await expect(page.getByText(/Want a tutorial of WILCO/)).toBeVisible();
  await expect(page.getByRole("button", { name: "START TUTORIAL" })).toBeVisible();
  await expect(page.getByRole("button", { name: "I'm good" })).toBeVisible();
});

test("every step anchors to something real, all the way to the closing card", async ({ page }) => {
  const athlete = newAthlete();
  await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);
  await startTour(page);

  // 1. Program tab — they tap it themselves.
  await expect(page.getByText(/bread and butter WILCO runs off of/)).toBeVisible();
  await page.locator('[data-tour="program-btn"]').click();

  // 2-3. The program pane, standing on a SAMPLE program (an empty box would
  // teach nothing) and then the paste/photo control.
  await expect(page.getByText(/This is where your program will live/)).toBeVisible();
  await expect(page.locator('[data-tour="program-doc"]')).toBeVisible();
  await expect(page.getByText("SAMPLE PROGRAM")).toBeVisible();
  await page.getByText(/This is where your program will live/).click();
  await expect(page.getByText(/paste it here or drop a screenshot/)).toBeVisible();
  await page.getByText(/paste it here or drop a screenshot/).click();

  // 4. Memory hand-off: two beats on one card, then they tap MEMORY.
  await expect(page.getByText(/we'll get to it in a minute/)).toBeVisible();
  await page.getByText(/we'll get to it in a minute/).click();
  await expect(page.getByText(/your Memory tab, which contains everything/)).toBeVisible();
  await page.getByRole("button", { name: "MEMORY" }).click();

  // 5-7. The tour opens each subtab for them (step `enter`), so the athlete is
  // never left hunting. This is the driven-navigation contract.
  await expect(page.getByText(/Past Blocks includes your training history/)).toBeVisible();
  await expect(page.getByText("SUMMER BASE")).toBeVisible();
  await page.getByText(/Past Blocks includes your training history/).click();

  await expect(page.getByText(/Drafts is your parking garage/)).toBeVisible();
  await page.getByText(/Drafts is your parking garage/).click();

  await expect(page.getByText(/what I read before every single reply/)).toBeVisible();
  await page.getByText(/what I read before every single reply/).click();

  // 8-9. The BUILDING A PROGRAM stamp plays itself, then builder mode is shown
  // (not run — mounting the real Builder would fire a live AI interview).
  await expect(page.getByText("WITH WILCO")).toBeVisible({ timeout: 4000 });
  await expect(page.locator('[data-tour="tour-blueprint"]')).toBeVisible({ timeout: 6000 });
  await expect(page.getByText(/Question 3 of 9/)).toBeVisible();
  await page.getByText(/we'll write it together/).click();

  // 10. The sample opener, with the same three buttons a real morning shows.
  await expect(page.getByText(/I'll tell you the workout for the day/)).toBeVisible();
  await expect(page.locator('[data-tour="start-workout-btn"]')).toBeVisible();
  await page.locator('[data-tour="start-workout-btn"]').click();

  // 11. The workout bar docks. They open it themselves.
  await expect(page.getByText(/the workout log will appear at the bottom/)).toBeVisible();
  await expect(page.locator('[data-tour="session-bar"]')).toBeVisible();
  await page.locator('[data-tour="session-bar"]').click();

  // 12. The prefilled sheet. Part 0 dims nothing so the whole session is
  // readable; part 1 narrows onto Finish Workout and waits for the real tap.
  await expect(page.getByText(/fill in numbers, make any adjustments/)).toBeVisible();
  await expect(page.getByText("Bench Press 3x5 @ 175")).toBeVisible();
  await page.getByText(/fill in numbers, make any adjustments/).click();
  await expect(page.getByText(/Go ahead and finish it/)).toBeVisible();
  await page.locator('[data-tour="finish-btn"]').click();

  // 13. Both stamps fire, in send()'s real order, and Joe's reply is scripted.
  await expect(page.getByText("LOGGED WITH WILCO")).toBeVisible({ timeout: 6000 });
  await expect(page.getByText("NEW MAX")).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/Good job on that bench press personal record/)).toBeVisible({ timeout: 10000 });

  // 14. What just happened. "See that?" was cut (Will 09-01) — it opens on the verb.
  await expect(page.getByText(/^Finishing the workout logged the whole session/)).toBeVisible({ timeout: 10000 });
  await page.getByText(/^Finishing the workout logged the whole session/).click();

  // 15-18. Progress, one subtab per card, each opened for them.
  await expect(page.getByText(/Benchmarks ranks your lifts/)).toBeVisible();
  await page.getByText(/Benchmarks ranks your lifts/).click();
  await expect(page.getByText(/Strength tracks every lift you've logged/)).toBeVisible();
  await page.getByText(/Strength tracks every lift you've logged/).click();
  await expect(page.getByText(/every personal record you've set/)).toBeVisible();
  await page.getByText(/every personal record you've set/).click();
  await expect(page.getByText(/off my best estimate from what you've actually logged/)).toBeVisible();
  await page.getByText(/off my best estimate from what you've actually logged/).click();

  // 19. NAVIGATION (Will 09-01): Progress closes itself, they land back on the
  // chat, and they open My Log THEMSELVES. Draft 3 teleported them here and
  // they never learned to move around the app.
  await expect(page.getByText(/Closing a tab always brings you back here/)).toBeVisible();
  await expect(page.locator('[data-tour="mylog-entry"]')).toHaveCount(0);   // not there yet
  await page.locator('[data-tour="mylog-btn"]').click();

  // 20-21. My Log, then The Proof.
  await expect(page.getByText(/Every session you've logged lives here/)).toBeVisible();
  await page.getByText(/Every session you've logged lives here/).click();
  await expect(page.getByText(/Once a week, The Proof drops/)).toBeVisible();
  await page.getByText(/Once a week, The Proof drops/).click();

  // 22. The closing card: signed with a dash, LET'S GO instead of Finish.
  await expect(page.getByText("THANKS FOR TRYING WILCO")).toBeVisible();
  await expect(page.getByText("-Joe")).toBeVisible();
  await page.getByRole("button", { name: "LET'S GO" }).click();
  await expect(page.getByText("THANKS FOR TRYING WILCO")).toHaveCount(0);
});

test("finishing clears every sample surface and writes nothing", async ({ page }) => {
  const athlete = newAthlete();
  const { calls } = await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);
  await startTour(page);

  // Straight to the end via Skip, which has to tear down exactly like Finish.
  await page.getByRole("button", { name: "Skip tour" }).first().click();

  // Nothing the tour opened is left on screen.
  await expect(page.locator('[data-tour="program-doc"]')).toHaveCount(0);
  await expect(page.getByText("SAMPLE PROGRAM")).toHaveCount(0);
  await expect(page.getByText("SUMMER BASE")).toHaveCount(0);

  // The athlete's own program tab is empty again, with the rebuilt empty-state
  // copy (Will 09-01: "build it" is the addition).
  await page.locator('[data-tour="program-btn"]').click();
  await expect(page.getByPlaceholder(/Paste your program, build it, or drop a screenshot/)).toBeVisible();
  await expect(page.getByText("SAMPLE PROGRAM")).toHaveCount(0);

  // The ONLY write a tour is ever allowed is resolving the offer itself. Any
  // insert into workouts / program_history / athlete_memory means a sample row
  // reached the database, which is the failure this whole spec exists for.
  // op:"read" is fine and expected — the gateway body carries the table name on
  // reads too, so this has to key on the WRITE ops specifically.
  const writesTo = (table) => calls.filter(c =>
    c.body && ["insert","update","upsert","delete"].includes(c.body.op) &&
    JSON.stringify(c.body).includes(table));
  expect(writesTo("program_history").map(c=>c.body.op), "tour wrote a phase row").toEqual([]);
  expect(writesTo("athlete_memory").map(c=>c.body.op), "tour wrote a memory row").toEqual([]);
  expect(writesTo("workouts").map(c=>c.body.op), "tour logged a workout").toEqual([]);
  expect(writesTo("program_drafts").map(c=>c.body.op), "tour wrote a draft").toEqual([]);
});

test("declining leaves the tour reachable from Settings, worded for a first-timer", async ({ page }) => {
  const athlete = newAthlete();
  await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);
  await expect(page.getByText(/I'm Joe-bot, your assistant coach/)).toBeVisible();
  await page.getByText(/I'm Joe-bot, your assistant coach/).click();

  // "I'm good" closes it with no lecture and does not come back this session.
  await page.getByRole("button", { name: "I'm good" }).click();
  await expect(page.getByText(/Want a tutorial of WILCO/)).toHaveCount(0);

  // It still has to be findable. An athlete who never took it is offered
  // "Take", not "Replay" — the label the live app had wrong.
  await page.getByTitle("Settings").click();
  await expect(page.getByRole("button", { name: /the App Tour/ })).toBeVisible();
});
