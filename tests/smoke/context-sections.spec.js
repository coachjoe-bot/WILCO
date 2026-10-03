// ─── ATHLETE CONTEXT, SIX SECTIONS (T69-C, Will 10-01 and 10-02) ─────────────
// Bio, Goal, Schedule, Body, Preferences, This week. Most of the tab is worked
// out on open (pain from the ledger, maxes, this week); only what the athlete
// told Joe is a note, and each note shows when it was last checked and, when it
// is due, why. One text colour; "+ Add a note" per section and once at the
// bottom (Joe files it); Past goals and Recently removed are collapsed rows.
// SHOTS=<dir> writes phone-width pictures in both themes.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";

if (process.env.SHOTS) test.use({ viewport: { width: 430, height: 900 } });
const SHOTS = process.env.SHOTS;
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
const ahead = (n) => new Date(Date.now() + n * 86400000).toISOString();
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); } };

const mockScan = async (page, verdict = { verdict: "allow" }) => {
  const scans = [];
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "memory_edit") return route.fallback();
    scans.push(body);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: JSON.stringify(verdict) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }) });
  });
  return scans;
};
const openContext = async (page, athlete, theme = "light") => {
  if (theme === "dark") await page.addInitScript(() => { try { localStorage.setItem("wilco_theme", "dark"); } catch (_) {} });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");
  await page.getByRole("button", { name: /^\W*(add )?program$/i }).first().click();
  await page.getByRole("button", { name: "MEMORY" }).click();
  await page.getByRole("button", { name: "Athlete Context", exact: true }).click();
  await expect(page.getByTestId("context-card")).toBeVisible({ timeout: 15000 });
};
const writes = (calls, op, table) => calls.filter((c) => c.body?.op === op && c.body?.table === table);
const mem = (athleteId, id, content, over = {}) => ({ id, athlete_id: athleteId, content, kind: "contextual", status: "active", source: "athlete_said", expires_at: null, section: null, confirmed_at: null, ask_count: 0, created_at: day(40), updated_at: day(40), ...over });
// memory reads: the active list and the removed list come from one table
const memReads = (active, removed = []) => (b) => (/status=eq\.deleted/.test(String(b.params || "")) ? removed : active);
const SECTIONS = ["Bio", "Goal", "Schedule", "Body", "Preferences", "This week"];

for (const theme of ["light", "dark"]) {
  test(`a brand-new athlete: every section reads well with nothing stored (${theme})`, async ({ page }) => {
    const athlete = makeAthlete({ training_days_per_week: null, equipment: null, injury_history: null, weight_lbs: null });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await mockApi(page, { athlete, dataReads: { athlete_memory: memReads([]), athlete_goals: [] } });
    await openContext(page, athlete, theme);
    const card = page.getByTestId("context-card");
    for (const s of SECTIONS) await expect(card.getByText(s, { exact: true }).first()).toBeVisible();
    // the sections come in Will's order
    const text = await card.innerText();
    const at = SECTIONS.map((s) => text.indexOf(s.toUpperCase()) >= 0 ? text.indexOf(s.toUpperCase()) : text.indexOf(s));
    expect(at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1]))).toBe(true);
    await expect(card.getByText("Nothing saved yet. How you like to train and be coached goes here")).toBeVisible();
    await expect(page.locator('[data-add="goal"]')).toBeVisible();
    await expect(page.locator('[data-add="any"]')).toBeVisible();
    await expect(card.getByText("Past goals")).toHaveCount(0);
    await expect(page.getByText("Recently removed")).toHaveCount(0);
    expect(errors).toEqual([]);
    await shot(page, `new-athlete-${theme}`);
  });
}

const DEMO_PROGRAM = "Day 1 - Squat\nBack Squat 4x5\nPull-ups 3x8\nDay 2 - Bench\nBench Press 3x5\nRows 3x10\n";
const pecRows = (athlete) => [
  { id: "w1", athlete_id: athlete.id, created_at: day(9), raw_message: "Bench 3x5 @ 200 lbs, left pec hurt", parsed_data: { exercises: [{ name: "Bench Press", sets: 3, reps: 5, weight: 200, unit: "lbs" }], pain_flags: [{ area: "pec", description: "pec hurt on bench", during: "Bench Press" }] } },
  { id: "w2", athlete_id: athlete.id, created_at: day(2), raw_message: "Incline DB 3x8 @ 70", parsed_data: { exercises: [{ name: "Incline Dumbbell Bench Press", sets: 3, reps: 8, weight: 70, unit: "lbs" }, { name: "Back Squat", sets: 3, reps: 5, weight: 225, unit: "lbs" }] } },
];

for (const theme of ["light", "dark"]) {
  test(`stored notes sit in their sections, the old check-in summaries stay out of sight, due notes say why (${theme})`, async ({ page }) => {
    const athlete = makeAthlete({ program_text: DEMO_PROGRAM, injury_history: "Rehabbing inflamed knees, weak core and low back", training_days_per_week: 6, review_stamps: null, created_at: day(120) });
    const active = [
      mem(athlete.id, "p1", "Prefers kg on the barbell lifts", { kind: "pinned" }),
      mem(athlete.id, "s1", "Trains 6 to 7am on class days", { section: "schedule", confirmed_at: day(60) }),
      mem(athlete.id, "e1", "Meet Nov 14, 73 kg class", { kind: "situational", expires_at: ahead(40), section: "schedule", confirmed_at: day(1) }),
      mem(athlete.id, "b1", "Torn labrum surgery in 2023", { confirmed_at: day(3) }),        // no section: code files it under Body
      mem(athlete.id, "x1", "Weekly check-in Sep 21: Bodyweight stable at 165 lbs. Short on time.", { kind: "situational", expires_at: ahead(60), source: "inferred" }),
      mem(athlete.id, "t1", "Check-in Sep 28. Recovery: dialed. School ate the week, back to 6 from Monday.", { section: "this_week", kind: "situational", expires_at: ahead(20), created_at: day(5), confirmed_at: day(5) }),
      mem(athlete.id, "t0", "Check-in Sep 21. Recovery: flat.", { section: "this_week", kind: "situational", expires_at: ahead(13), created_at: day(12), confirmed_at: day(12) }),
    ];
    const removed = [mem(athlete.id, "r1", "Hates box jumps", { status: "deleted", updated_at: day(4) })];
    const goals = [
      { id: "g2", athlete_id: athlete.id, goal_text: "Healing left pec, building up clean and jerk", target_date: null, superseded_at: null, created_at: day(27) },
      { id: "g1", athlete_id: athlete.id, goal_text: "Bench 315 goal pushed back past mid-August; will set new bench target after maxing out tomorrow", target_date: null, superseded_at: null, created_at: day(55) },
    ];
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await mockApi(page, { athlete, dataReads: { athlete_memory: memReads(active, removed), athlete_goals: goals, workouts: pecRows(athlete) } });
    await openContext(page, athlete, theme);
    const card = page.getByTestId("context-card");
    await expect(card.getByText("Healing left pec, building up clean and jerk")).toBeVisible();
    // one goal at a time: the older live row is under Past goals, collapsed
    await expect(card.getByText("Bench 315 goal pushed back")).toHaveCount(0);
    await card.getByText(/Past goals \(1\)/).click();
    await expect(card.getByText("Bench 315 goal pushed back", { exact: false })).toBeVisible();
    // sections
    await expect(card.getByText("Trains 6 to 7am on class days")).toBeVisible();
    await expect(card.getByText(/Meet Nov 14, 73 kg class, \d+ days out/)).toBeVisible();
    await expect(card.getByText("Coming up:")).toBeVisible();
    await expect(card.getByText("Torn labrum surgery in 2023")).toBeVisible();
    await expect(card.getByText(/Prefers kg on the barbell lifts/)).toBeVisible();
    // the retired summary never shows
    await expect(page.getByText("Weekly check-in Sep 21")).toHaveCount(0);
    // the recovery strip, last check-ins
    await expect(card.getByText("Sep 28, dialed")).toBeVisible();
    await expect(card.getByText("Sep 21, flat")).toBeVisible();
    // the training days line is due (the logs disagree: no sessions logged, so it is the never-checked jumper)
    await expect(card.locator('[data-signup="training_days_per_week"]')).toContainText("Trains 6 days a week");
    await expect(card.getByText(/It comes up at your next check-in: not checked since signup/).first()).toBeVisible();
    // a note's last-checked chip
    await expect(card.getByText(/^Checked /).first()).toBeVisible();
    // pain lines are the ledger's own records, with the lift that hurt
    await expect(card.getByText(/It hurt on bench press/)).toBeVisible();
    await expect(card.getByText(/pain-free since, up to 70 lbs/)).toBeVisible();
    // recently removed, collapsed, with Restore
    await page.getByText(/Recently removed \(1\)/).click();
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
    // no em dashes anywhere on the tab
    expect(await card.innerText()).not.toMatch(/[—–]/);
    expect(errors).toEqual([]);
    await shot(page, `qa-athlete-top-${theme}`);
    await card.getByText("This week", { exact: true }).first().scrollIntoViewIfNeeded();
    await shot(page, `qa-athlete-bottom-${theme}`);
  });
}

test("+ Add a note in a section files it there; the bottom Add asks Joe's one scan for the section", async ({ page }) => {
  const athlete = makeAthlete({});
  const { calls } = await mockApi(page, { athlete, dataReads: { athlete_memory: memReads([]), athlete_goals: [] } });
  const scans = await mockScan(page, { verdict: "allow", section: "preferences" });
  await openContext(page, athlete);
  await page.locator('[data-add="schedule"]').click();
  await page.getByLabel("New note").fill("Lifts at the garage gym on weekends");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10000 });
  let ins = writes(calls, "insert", "athlete_memory");
  expect(ins.length).toBe(1);
  expect(ins[0].body.data).toMatchObject({ content: "Lifts at the garage gym on weekends", section: "schedule", source: "athlete_typed" });
  expect(ins[0].body.data.confirmed_at).toBeTruthy();
  expect(ins[0].body.data.ask_count).toBe(0);
  expect(scans.length).toBe(1);
  expect(JSON.stringify(scans[0].messages)).toContain("a new note");
  // the bottom add: no section is chosen, the scan returns it, one call
  await page.locator('[data-add="any"]').click();
  await page.getByLabel("New note").fill("Keep it blunt, skip the pep talk");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes(calls, "insert", "athlete_memory").length).toBe(2);
  ins = writes(calls, "insert", "athlete_memory");
  expect(ins[1].body.data.section).toBe("preferences");
  expect(scans.length).toBe(2);
  expect(JSON.stringify(scans[1].messages)).toContain("FILE");
});

test("the bottom Add falls back to code's reading of the words when the scan names no section", async ({ page }) => {
  const athlete = makeAthlete({});
  const { calls } = await mockApi(page, { athlete, dataReads: { athlete_memory: memReads([]), athlete_goals: [] } });
  await mockScan(page, { verdict: "allow" });
  await openContext(page, athlete);
  await page.locator('[data-add="any"]').click();
  await page.getByLabel("New note").fill("Rehabbing a torn labrum, no overhead pressing");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes(calls, "insert", "athlete_memory").length).toBe(1);
  expect(writes(calls, "insert", "athlete_memory")[0].body.data.section).toBe("body");
});

test("a dated note expires on its date; 'next week' with no date is refused and nothing is written", async ({ page }) => {
  const athlete = makeAthlete({});
  const { calls } = await mockApi(page, { athlete, dataReads: { athlete_memory: memReads([]), athlete_goals: [] } });
  const scans = await mockScan(page);
  await openContext(page, athlete);
  await page.locator('[data-add="schedule"]').click();
  await page.getByLabel("New note").fill("Maxing out bench tomorrow, new target after that");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/actual date/);
  expect(writes(calls, "insert", "athlete_memory").length).toBe(0);
  expect(scans.length).toBe(0);                                    // code refused it: no AI cost
  const d = new Date(Date.now() + 30 * 86400000);
  const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  await page.getByLabel("New note").fill(`Meet ${label}, 73 kg class`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes(calls, "insert", "athlete_memory").length).toBe(1);
  const row = writes(calls, "insert", "athlete_memory")[0].body.data;
  expect(row.kind).toBe("situational");
  expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now() + 29 * 86400000);
  expect(row.section).toBe("schedule");
});

test("a pain line: 'It's cleared' writes the ledger's own cleared mark; 'Tell Joe about it' opens chat with the area named", async ({ page }) => {
  const athlete = makeAthlete({ program_text: DEMO_PROGRAM, pain_marks: {} });
  const { calls } = await mockApi(page, { athlete, dataReads: { athlete_memory: memReads([]), athlete_goals: [], workouts: pecRows(athlete) } });
  await openContext(page, athlete);
  const line = page.locator('[data-pain="pec"]');
  await expect(line).toContainText(/pec/i);
  await line.click();
  await page.getByRole("button", { name: "It's cleared" }).click();
  await expect.poll(() => writes(calls, "update", "athletes").length).toBeGreaterThan(0);
  const u = writes(calls, "update", "athletes").at(-1).body.data;
  expect(u.pain_marks.pec.cleared_at).toBeTruthy();
  expect(Object.keys(u)).toEqual(["pain_marks"]);                  // its own write, never bundled
  // a second area open: Tell Joe puts the area in the composer
  await page.locator('[data-pain="pec"]').click();
  await page.getByRole("button", { name: "Tell Joe about it" }).click();
  await expect(page.getByPlaceholder(/Tell Coach Joe/)).toHaveValue(/^My pec/i);
});

test("a work-around note is tied to its pain area", async ({ page }) => {
  const athlete = makeAthlete({ program_text: DEMO_PROGRAM, pain_marks: {} });
  const { calls } = await mockApi(page, { athlete, dataReads: { athlete_memory: memReads([]), athlete_goals: [], workouts: pecRows(athlete) } });
  await mockScan(page);
  await openContext(page, athlete);
  await page.locator('[data-add="work-pec"]').click();
  await page.getByLabel("New note").fill("Incline DB press in place of bench");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes(calls, "insert", "athlete_memory").length).toBe(1);
  expect(writes(calls, "insert", "athlete_memory")[0].body.data).toMatchObject({ area_key: "pec", section: "body" });
});

test("training days: tap, pick, Save writes the column and its stamp, no scan", async ({ page }) => {
  const athlete = makeAthlete({ training_days_per_week: 6, review_stamps: null });
  const { calls } = await mockApi(page, { athlete, dataReads: { athlete_memory: memReads([]), athlete_goals: [] } });
  const scans = await mockScan(page);
  await openContext(page, athlete);
  await page.locator('[data-signup="training_days_per_week"]').click();
  await page.getByRole("button", { name: "5 days" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes(calls, "update", "athletes").length).toBeGreaterThan(0);
  const u = writes(calls, "update", "athletes").at(-1).body.data;
  expect(u.training_days_per_week).toBe(5);
  expect(u.review_stamps.training_days_per_week.confirmed_at).toBeTruthy();
  expect(scans.length).toBe(0);
  await expect(page.getByText("Trains 5 days a week")).toBeVisible();
});

test("Recently removed: Restore brings a note back through the same validator", async ({ page }) => {
  const athlete = makeAthlete({});
  const removed = [mem(athlete.id, "r1", "Hates box jumps", { status: "deleted", updated_at: day(4) })];
  const { calls } = await mockApi(page, { athlete, dataReads: { athlete_memory: memReads([], removed), athlete_goals: [] } });
  await openContext(page, athlete);
  await page.getByText(/Recently removed \(1\)/).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => writes(calls, "update", "athlete_memory").length).toBe(1);
  expect(writes(calls, "update", "athlete_memory")[0].body.data).toMatchObject({ status: "active", ask_count: 0 });
  await expect(page.getByText("Hates box jumps")).toBeVisible();
});

// A read-only copy of Will's real rows (pulled 10-02 from prod, kept outside the
// repo). Only runs when SHOTS is set and the copy exists on this machine.
const WILL = path.join(os.homedir(), "Documents/Claude/MISSION-CONTROL/outputs/t69-c");
const haveWill = !!SHOTS && fs.existsSync(path.join(WILL, "will-memory.json"));
for (const theme of ["light", "dark"]) {
  test(`pictures: the tab on a copy of Will's rows (${theme})`, async ({ page }) => {
    test.skip(!haveWill, "needs the local read-only copy of his rows and SHOTS");
    const rd = (f) => JSON.parse(fs.readFileSync(path.join(WILL, f), "utf8"));
    const athlete = { ...makeAthlete({}), ...rd("will-athlete.json"), tier: "pro", proof_timezone: "America/New_York" };
    const memory = rd("will-memory.json");
    const goals = rd("will-goals.json");
    await mockApi(page, { athlete, dataReads: { athlete_memory: (b) => (/status=eq\.deleted/.test(String(b.params || "")) ? memory.filter((m) => m.status === "deleted") : memory.filter((m) => m.status === "active")), athlete_goals: goals, workouts: rd("will-workouts.json") } });
    await openContext(page, athlete, theme);
    await shot(page, `will-top-${theme}`);
    await page.getByTestId("context-card").getByText("Preferences", { exact: true }).first().scrollIntoViewIfNeeded();
    await shot(page, `will-middle-${theme}`);
    await page.getByTestId("context-card").getByText("This week", { exact: true }).first().scrollIntoViewIfNeeded();
    await shot(page, `will-bottom-${theme}`);
  });
}
