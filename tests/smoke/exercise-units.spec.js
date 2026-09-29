// ─── T65: a logged set keeps the unit the athlete meant ──────────────────────
// Before T65 the parser was never told the athlete's unit and its rulebook said an
// unlabelled load is lbs, so a kg athlete's "squat 5x3 at 140" was saved as a
// 140 LB squat. Every load is now resolved in code (src/prAttempts.js
// stampLoadUnits) before the row is written. These specs feed the app the parser
// GUESS that caused the bug and assert what reaches the data gateway.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete, emptyParse } from "./mocks.js";

const inserts = (calls, table) => calls
  .filter((c) => c.url.endsWith("/api/data") && c.body?.op === "insert" && c.body?.table === table)
  .flatMap((c) => (Array.isArray(c.body.data) ? c.body.data : [c.body.data]));

const typeAndSend = async (page, msg) => {
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill(msg);
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect(page.getByText(msg)).toBeVisible();
};

test("kg athlete types an unlabelled load: the set is saved in kg even when the parser guesses lbs", async ({ page }) => {
  const athlete = makeAthlete({ weight_unit: "kg" });
  const parseResult = { ...emptyParse, exercises: [{ name: "Back Squat", sets: 5, reps: 3, weight: 140, unit: "lbs" }] };
  const { calls } = await mockApi(page, { athlete, parseResult, chatReply: "Five triples at 140. Good day." });
  await loginAsAthlete(page, athlete);
  await typeAndSend(page, "squat 5x3 at 140");

  await expect.poll(() => inserts(calls, "workouts").some((r) => r.parsed_data?.exercises?.[0]?.name === "Back Squat")).toBe(true);
  const row = inserts(calls, "workouts").find((r) => r.parsed_data?.exercises?.[0]?.name === "Back Squat");
  expect(row.parsed_data.exercises[0].weight).toBe(140);
  expect(row.parsed_data.exercises[0].unit).toBe("kg");
  // The estimated-max row carries the same pair.
  await expect.poll(() => inserts(calls, "prs").some((r) => r.exercise === "Back Squat")).toBe(true);
  const pr = inserts(calls, "prs").find((r) => r.exercise === "Back Squat");
  expect(pr.unit).toBe("kg");
  expect(Number(pr.weight)).toBe(140);
});

test("a unit never carries to the next lift, either direction (T46)", async ({ page }) => {
  // lbs athlete, parser carried kg onto the bench.
  const athlete = makeAthlete({ weight_unit: "lbs" });
  const parseResult = { ...emptyParse, exercises: [
    { name: "Back Squat", sets: 5, reps: 3, weight: 180, unit: "kg" },
    { name: "Bench Press", sets: 3, reps: 8, weight: 135, unit: "kg" },
  ] };
  const { calls } = await mockApi(page, { athlete, parseResult, chatReply: "Squat moved well." });
  await loginAsAthlete(page, athlete);
  await typeAndSend(page, "squat 5x3 at 180kg, then bench 3x8 at 135");

  await expect.poll(() => inserts(calls, "workouts").some((r) => r.parsed_data?.exercises?.length === 2)).toBe(true);
  const ex = inserts(calls, "workouts").find((r) => r.parsed_data?.exercises?.length === 2).parsed_data.exercises;
  expect(ex.map((e) => e.unit)).toEqual(["kg", "lbs"]);
});

test("kg athlete sends the log sheet unchanged: the draft carries kg and every set saves in kg", async ({ page }) => {
  const PROGRAM = "Day 1 - Lower\nBack Squat 5x3 @ 315\nRomanian Deadlift 3x8 @ 225\nPlank 3x45s";
  const DRAFT = "Day 1 - Lower\nBack Squat 5x3 @ 315\nRomanian Deadlift 3x8 @ 225\nPlank 3x45s";
  const athlete = makeAthlete({ weight_unit: "kg", program_text: PROGRAM });
  // The parser guesses lbs on both loads (the pre-T65 default).
  const parseResult = { ...emptyParse, exercises: [
    { name: "Back Squat", sets: 5, reps: 3, weight: 142.5, unit: "lbs" },
    { name: "Romanian Deadlift", sets: 3, reps: 8, weight: 102.5, unit: "lbs" },
    { name: "Plank", sets: 3, time_per_set_seconds: 45, weight: null, unit: "bodyweight" },
  ] };
  const { calls } = await mockApi(page, { athlete, parseResult, chatReply: "Session banked." });
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "quick_log_draft") return route.fallback();
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: DRAFT }], usage: {} }) });
  });

  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "Start Workout" }).click();
  await expect(page.getByText(/Log it here when you're done/)).toBeVisible({ timeout: 20000 });
  await page.getByText("Day 1 - Lower", { exact: true }).first().click();
  await page.getByRole("button", { name: "Finish Workout" }).click();

  // What the parser was handed: the converted sheet, kg written on every load.
  await expect.poll(() => calls.some((c) => c.url.endsWith("/api/claude") && c.body?.feature === "workout_parse")).toBe(true);
  const parseCall = calls.find((c) => c.url.endsWith("/api/claude") && c.body?.feature === "workout_parse");
  const sent = JSON.stringify(parseCall.body);
  expect(sent).toContain("Back Squat 5x3 @ 142.5 kg");
  expect(sent).toContain("Romanian Deadlift 3x8 @ 102.5 kg");

  await expect.poll(() => inserts(calls, "workouts").some((r) => r.parsed_data?.exercises?.length === 3)).toBe(true);
  const ex = inserts(calls, "workouts").find((r) => r.parsed_data?.exercises?.length === 3).parsed_data.exercises;
  expect(ex.map((e) => e.unit)).toEqual(["kg", "kg", "bodyweight"]);
});

// Orchestrator 09-29, step 4: the unit this athlete has used for THIS lift.
const histRow = (id, daysAgo, raw, exercises) => ({ id, athlete_id: "11111111-1111-4111-8111-111111111111",
  created_at: new Date(Date.now() - daysAgo * 86400000).toISOString(), raw_message: raw, parsed_data: { exercises } });

test("kg athlete who benches in lbs: an unlabelled bench follows the lift's own history, no hold-up", async ({ page }) => {
  const athlete = makeAthlete({ weight_unit: "kg" });
  const parseResult = { ...emptyParse, exercises: [{ name: "Bench Press", sets: 3, reps: 5, weight: 205, unit: null }] };
  const { calls } = await mockApi(page, { athlete, parseResult, chatReply: "Bench moved well.", dataReads: { workouts: [
    histRow("h1", 4, "Bench 3x5 @ 205lbs", [{ name: "Bench Press", sets: 3, reps: 5, weight: 205, unit: "lbs" }]),
    histRow("h2", 9, "Bench 3x5 @ 200lbs", [{ name: "Bench Press", sets: 3, reps: 5, weight: 200, unit: "lbs" }]),
  ] } });
  await loginAsAthlete(page, athlete);
  await typeAndSend(page, "bench 3x5 at 205");

  await expect.poll(() => inserts(calls, "workouts").some((r) => r.parsed_data?.exercises?.[0]?.name === "Bench Press")).toBe(true);
  const ex = inserts(calls, "workouts").find((r) => r.parsed_data?.exercises?.[0]?.name === "Bench Press").parsed_data.exercises[0];
  expect([ex.unit, ex.unit_source, !!ex.unit_suspect]).toEqual(["lbs", "history", false]);
  await page.waitForTimeout(1500);
  await expect(page.getByText(/Hold up before I bank|Quick check before I bank/)).toHaveCount(0);
});

// Orchestrator 09-29 (changes 2 + 3): lbs athlete, bench history in kg, types
// "bench 3x5 at 225": 225 kg is implausible, 225 lbs fits, so the load is kept as
// resolved (kg), marked unit_suspect, and asked about ONCE. Nothing is derived
// until the answer; the answer banks it once.
const kgBenchHistory = () => ({ workouts: [
  histRow("h1", 5, "Bench 3x5 @ 100kg", [{ name: "Bench Press", sets: 3, reps: 5, weight: 100, unit: "kg" }]),
  histRow("h2", 12, "Bench 3x5 @ 97.5kg", [{ name: "Bench Press", sets: 3, reps: 5, weight: 97.5, unit: "kg" }]),
] });
const unitAsks = async (page) => (await page.getByText(/kg or lbs\?/).count());
const flagged = async (page, chatReply) => {
  const athlete = makeAthlete({ weight_unit: "lbs" });
  const parseResult = { ...emptyParse, exercises: [{ name: "Bench Press", sets: 3, reps: 5, weight: 225, unit: null }] };
  const api = await mockApi(page, { athlete, parseResult, chatReply, dataReads: kgBenchHistory() });
  await loginAsAthlete(page, athlete);
  await typeAndSend(page, "bench 3x5 at 225");
  await expect.poll(() => inserts(api.calls, "workouts").some((r) => r.parsed_data?.exercises?.[0]?.name === "Bench Press")).toBe(true);
  return api;
};

test("flagged load: saved as resolved + suspect, ONE unit question, nothing derived", async ({ page }) => {
  const { calls } = await flagged(page, "Solid pressing today. Keep the bar path tight.");
  const ex = inserts(calls, "workouts").find((r) => r.parsed_data?.exercises?.[0]?.name === "Bench Press").parsed_data.exercises[0];
  expect([ex.unit, ex.unit_source, ex.unit_suspect]).toEqual(["kg", "history", true]);
  // Joe was told, as a computed fact, that the app is asking.
  const chatCall = calls.find((c) => c.url.endsWith("/api/claude") && /chat/.test(c.body?.feature || ""));
  expect(JSON.stringify(chatCall?.body || {})).toContain("UNIT CHECK");
  await expect(page.getByText(/Quick check before I bank that/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "It was kg" })).toBeVisible();
  expect(await unitAsks(page)).toBe(1);
  await expect(page.getByText(/Hold up before I bank/)).toHaveCount(0);
  // Nothing derived: no estimated max, no actual 1RM.
  await page.waitForTimeout(1500);
  expect(inserts(calls, "prs").filter((r) => /bench/i.test(r.exercise))).toHaveLength(0);
  expect(inserts(calls, "manual_one_rms").filter((r) => /bench/i.test(r.exercise))).toHaveLength(0);
});

test("flagged load: when Joe already asked, the app does not ask again (chips still answer)", async ({ page }) => {
  await flagged(page, "Solid pressing. Was that 225 in lbs or kg?");
  await expect(page.getByRole("button", { name: "It was lbs" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Quick check before I bank/)).toHaveCount(0);
  expect(await unitAsks(page)).toBe(0); // Joe's question uses "lbs or kg?"; the app adds none
  await expect(page.getByText(/Was that 225 in lbs or kg\?/)).toHaveCount(1);
});

test("answering the unit question writes the confirmed unit and banks the lift once", async ({ page }) => {
  const { calls } = await flagged(page, "Solid pressing today.");
  await page.getByRole("button", { name: "It was lbs" }).click({ timeout: 15000 });
  await expect(page.getByText(/Got it\. Bench Press logged in lbs\./)).toBeVisible();
  // The row is updated with the athlete's answer.
  await expect.poll(() => calls.some((c) => c.url.endsWith("/api/data") && c.body?.op === "update" && c.body?.table === "workouts" &&
    c.body?.data?.parsed_data?.exercises?.[0]?.unit === "lbs" && c.body?.data?.parsed_data?.exercises?.[0]?.unit_source === "athlete_confirmed" &&
    !c.body?.data?.parsed_data?.exercises?.[0]?.unit_suspect)).toBe(true);
  // Derived writes run now, once, in the confirmed unit.
  await expect.poll(() => inserts(calls, "prs").filter((r) => /bench/i.test(r.exercise)).length).toBe(1);
  const pr = inserts(calls, "prs").find((r) => /bench/i.test(r.exercise));
  expect([pr.unit, Number(pr.weight)]).toEqual(["lbs", 225]);
  expect(inserts(calls, "workouts")).toHaveLength(1); // no second workout row
  await expect(page.getByRole("button", { name: "It was kg" })).toHaveCount(0);
});

test("a typed 'kg' answers the unit question too", async ({ page }) => {
  const { calls } = await flagged(page, "Solid pressing today.");
  await expect(page.getByRole("button", { name: "It was kg" })).toBeVisible({ timeout: 15000 });
  const before = calls.filter((c) => c.body?.feature === "workout_parse").length;
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("it was kg");
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect(page.getByText(/Got it\. Bench Press logged in kg\./)).toBeVisible();
  expect(calls.filter((c) => c.body?.feature === "workout_parse").length).toBe(before); // never parsed as a log
  await expect.poll(() => inserts(calls, "prs").filter((r) => /bench/i.test(r.exercise) && r.unit === "kg").length).toBe(1);
});
