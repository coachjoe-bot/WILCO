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
