// ─── T64 S6: the verifier's BUG-3 and BUG-1, as the athlete sees them ─────────
// BUG-3: a trip that arrives over three messages (span, equipment, Joe's plan,
// "yes set me up with that") never became a temp program, and Joe said
// "Already built that for you above." Scope is now judged over the
// conversation, Joe's plan is saved when he lays it out, an explicit ask saves
// the most recent plan, and Joe's context says what is and is not saved.
// BUG-1: "it wraps up October 1st" / "just so you know this program actually
// wraps up Sept 15th" skipped the two-tap confirm and landed in athlete_context.
//
// Model replies are mocked per turn. The parser returns NOTHING useful on every
// turn (emptyParse), the worst case the real parser produced: every write here
// is the code's own read of the conversation.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { mockApi, makeAthlete, loginAsAthlete, emptyParse } from "./mocks.js";

const rp = JSON.parse(fs.readFileSync(new URL("../replay/temp-program-three-turns.json", import.meta.url), "utf8"));
const PROGRAM = rp.athlete.program_text;
const EXTRACTED = "Wednesday - Push (DB)\nDB Bench Press 4x8 @ 50\nThursday - Pull (DB)\nOne-arm DB Row 4x10 @ 50\nFriday - Legs (DB)\nGoblet Squat 4x12 @ 50";

// Serve chat turns in order (SSE for the streaming call, so one call = one
// turn), the parser's per-turn answer, and the plan extractor.
async function scriptAi(page, { replies, parse = () => emptyParse, extract = EXTRACTED }) {
  const chatBodies = [];
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature === "mastermind_chat" || body.feature === "joebot_chat") {
      chatBodies.push(body);
      const text = replies[Math.min(chatBodies.length - 1, replies.length - 1)];
      if (body.stream) {
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ text })}\n\ndata: ${JSON.stringify({ stop_reason: "end_turn" })}\n\n` });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text }], usage: {} }) });
    }
    if (body.feature === "workout_parse") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(parse(chatBodies.length)) }], usage: {} }) });
    }
    if (body.feature === "program_extract") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: extract }], usage: {} }) });
    }
    return route.fallback();
  });
  return { chatBodies };
}

const say = async (page, text) => {
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill(text);
  await page.getByRole("button", { name: "→" }).click();
};
const tempWrites = (calls) => calls.filter((c) => c.body?.op === "update" && c.body?.table === "athletes" && c.body?.data && "temp_program_text" in c.body.data && c.body.data.temp_program_text);
const sysOf = (body) => JSON.stringify(body?.system || "") + JSON.stringify(body?.system_cached || "");

test("BUG-3: the exact three-turn trip writes the temp program when Joe lays out the plan, and the ask never double-writes", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM, temp_program_text: null });
  const { calls } = await mockApi(page, { athlete });
  const { chatBodies } = await scriptAi(page, { replies: [rp.turns[0].joe, rp.turns[1].joe, "Done. Wednesday's push with the dumbbells to start."] });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");

  // Turn 1: span only. Joe asks. Nothing written; his context says nothing is saved.
  await say(page, rp.turns[0].athlete);
  await expect(page.getByText(/What's in the garage/)).toBeVisible({ timeout: 15000 });
  expect(tempWrites(calls)).toHaveLength(0);
  expect(sysOf(chatBodies[0])).toContain("NO temporary program is saved");

  // Turn 2: equipment only (no span in THIS message). Joe lays out the plan → saved.
  await say(page, rp.turns[1].athlete);
  await expect(page.getByText(/I've set a temporary program/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: /Temp Program/i }).first()).toBeVisible();
  expect(tempWrites(calls)).toHaveLength(1);
  expect(tempWrites(calls)[0].body.data.temp_program_text).toContain("DB Bench Press");

  // Turn 3: the explicit ask. Already saved → Joe is told so, no second write.
  await say(page, rp.turns[2].athlete);
  await expect(page.getByText(/Wednesday's push with the dumbbells/)).toBeVisible({ timeout: 15000 });
  expect(sysOf(chatBodies[2])).toContain("a temporary program IS saved and active");
  expect(tempWrites(calls)).toHaveLength(1);
  // The real program is never touched.
  expect(calls.find((c) => c.body?.op === "update" && c.body?.table === "athletes" && c.body?.data && "program_text" in c.body.data)).toBeFalsy();
});

test("BUG-3: an explicit ask saves the most recent plan Joe laid out when nothing wrote it yet", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM, temp_program_text: null });
  const { calls } = await mockApi(page, { athlete });
  const { chatBodies } = await scriptAi(page, { replies: ["What's in the garage?", rp.turns[1].joe, "Locked. Push day Wednesday."] });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");

  await say(page, "heading to my in-laws, garage gym only"); // no span anywhere
  await expect(page.getByText(/What's in the garage/)).toBeVisible({ timeout: 15000 });
  await say(page, rp.turns[1].athlete);
  await expect(page.getByText(/Real bench progression/)).toBeVisible({ timeout: 15000 });
  expect(tempWrites(calls)).toHaveLength(0); // no span stated → Joe's plan alone is not saved
  await expect(page.getByText(/I've set a temporary program/)).toHaveCount(0);

  await say(page, "lock that in for the week");
  await expect(page.getByText(/I've set a temporary program/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: /Temp Program/i }).first()).toBeVisible();
  expect(sysOf(chatBodies[2])).toContain("the app is saving the day-by-day plan");
  expect(tempWrites(calls)).toHaveLength(1);
});

test("BUG-3: an explicit ask with no plan in the conversation writes nothing and Joe is told no plan exists", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM, temp_program_text: null });
  const { calls } = await mockApi(page, { athlete });
  const { chatBodies } = await scriptAi(page, { replies: ["Tell me what gear you've got and how many days, and I'll lay it out."] });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");

  await say(page, "set me up with that temporary program");
  await expect(page.getByText(/I'll lay it out/)).toBeVisible({ timeout: 15000 });
  expect(sysOf(chatBodies[0])).toContain("you have not laid out a day-by-day plan");
  expect(tempWrites(calls)).toHaveLength(0);
  await expect(page.getByText(/I've set a temporary program/)).toHaveCount(0);
});

test("BUG-3: coach-locked athlete gets the temp program, the coach wording and the audit row", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM, temp_program_text: null, program_locked: true, coach_id: "coach-smoke-1" });
  const { calls } = await mockApi(page, { athlete });
  await scriptAi(page, { replies: [rp.turns[0].joe, rp.turns[1].joe] });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");

  await say(page, rp.turns[0].athlete);
  await expect(page.getByText(/What's in the garage/)).toBeVisible({ timeout: 15000 });
  await say(page, rp.turns[1].athlete);
  await expect(page.getByText(/Your coach's program is untouched/)).toBeVisible({ timeout: 15000 });
  expect(tempWrites(calls)).toHaveLength(1);
  expect(calls.find((c) => c.body?.op === "insert" && c.body?.table === "program_modifications")).toBeTruthy();
});

