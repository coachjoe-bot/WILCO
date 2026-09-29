// Smoke (T64 S5): a LOG turn carries the LOG REPLY FOCUS block (the one thing
// worth saying, ranked in code) last in Joe's dynamic context; a chat turn does
// not. The ranking itself is unit-tested in scripts/test-turn-facts.mjs.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete, emptyParse } from "./mocks.js";

const PROGRAM = "Day 1 - Squat\nBack Squat 5x3 @ 285\nFront Squat 4x3 @ 225\nPower Clean 5x2 @ 185\n\nDay 2 - Press\nBench Press 3x5 @ 185\nOverhead Press 3x8 @ 95";
const REPLY = "Logged. Squat moved up.";
const chatBodies = (calls) => calls.filter((c) => /api\/claude/.test(c.url) && c.body && /mastermind_chat|joebot_chat/.test(c.body.feature || ""));
const sysOf = (c) => String(c.body.system || ""); // the dynamic tail (the static card is fixed)
const squatRow = { id: "h-1", athlete_id: "x", created_at: new Date(Date.now() - 4 * 86400000).toISOString(), raw_message: "Back squat 5x3 @ 285",
  parsed_data: { exercises: [{ name: "Back Squat", sets: 5, reps: 3, weight: 285, unit: "lbs" }], pain_flags: [] } };
const LB = (name, sets, reps, weight) => ({ name, sets, reps, weight, unit: "lbs", set_details: null });

test("log turn: LOG REPLY FOCUS names the one headline and the one planned lift that is missing", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM, manual_one_rms: null });
  const msg = "Back squat 5x3 @ 285, front squat 4x3 @ 225";
  const { calls } = await mockApi(page, {
    athlete, chatReply: REPLY,
    parseResult: { ...emptyParse, exercises: [LB("Back Squat", 5, 4, 285), LB("Front Squat", 4, 3, 225)] },
    dataReads: { workouts: [squatRow] },
  });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill(msg);
  await page.getByRole("button", { name: "→" }).click();
  await expect(page.getByText(REPLY).last()).toBeVisible({ timeout: 15000 });
  await expect.poll(() => chatBodies(calls).length, { timeout: 10000 }).toBeGreaterThan(0);
  const sys = sysOf(chatBodies(calls).at(-1));
  expect(sys).toContain("LOG REPLY FOCUS");
  expect(sys).toContain("Headline: Back Squat");
  expect(sys).toContain("Question: Power Clean was on today's plan");
  expect(sys).toContain("never limits an answer they asked for");
  expect(sys).not.toMatch(/\b\d+\s+(?:words?|sentences?)\b/i);
  expect(sys).not.toContain("then coach.");
});

test("chat turn: no LOG REPLY FOCUS block", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: "Anytime.", parseResult: emptyParse });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("what should I eat before training?");
  await page.getByRole("button", { name: "→" }).click();
  await expect(page.getByText("Anytime.").last()).toBeVisible({ timeout: 15000 });
  await expect.poll(() => chatBodies(calls).length, { timeout: 10000 }).toBeGreaterThan(0);
  expect(chatBodies(calls).map(sysOf).join("\n")).not.toContain("LOG REPLY FOCUS");
});

// T67 (prod pass 09-29): on a partial log the deployed app still got "rows and
// pull-ups whenever you get to them" 4 of 5. The turn's planRest is handed to
// Joe AND enforced at the output gate: the settled bubble and the stored reply
// carry the acknowledgment and the headline, nothing about the lifts left out.
test("T67 partial log: a sentence about the planned lifts left out never settles", async ({ page }) => {
  const athlete = makeAthlete({ program_text: "Day 1 - Pull\nDeadlift 3x5 @ 275\nBarbell Row 3x8 @ 155\nPull-ups 3x8\n\nDay 2 - Press\nBench Press 3x5 @ 185" });
  const SLIP = "275 for 3x5, clean work. Barbell rows and pull-ups whenever you get to them.";
  const { calls } = await mockApi(page, { athlete, chatReply: SLIP, parseResult: { ...emptyParse, exercises: [LB("Deadlift", 3, 5, 275)] } });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("Deadlift 3x5 @ 275, moved well");
  await page.getByRole("button", { name: "→" }).click();
  // exact: the mock's opener bubble carries the same text inside a longer line
  await expect(page.getByText("275 for 3x5, clean work.", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(() => chatBodies(calls).length, { timeout: 10000 }).toBeGreaterThan(0);
  expect(sysOf(chatBodies(calls).at(-1))).toContain("Also on today's plan and not in this log: Barbell Row, Pull-ups.");
  await expect(page.getByText(SLIP, { exact: true })).toHaveCount(0, { timeout: 10000 });
  await expect.poll(() => calls.filter((c) => c.body?.table === "workouts" && /insert|update/.test(c.body?.op || "") && /whenever you get to them/.test(JSON.stringify(c.body))).length).toBe(0);
  expect(calls.some((c) => c.body?.table === "workouts" && /275 for 3x5, clean work\./.test(JSON.stringify(c.body)))).toBe(true);
});
