// ─── T64 S4: the weekly check-in is an agenda, not a script ──────────────────
// Will (09-28): no "go deeper", respond to what the athlete said, never re-ask
// what they already answered, end when the agenda is covered or they end it,
// never curse. Pain questions follow the pain ledger and record their outcome
// in pain_marks. These drive the real ProofChatModal in a browser with the AI
// turns canned (the real-AI pass covers the model's side).
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";

const day = (n) => new Date(Date.now() - n * 86400000).toISOString();

const digestWith = (athlete, questions) => ({
  id: "digest-s4", athlete_id: athlete.id, digest_type: "weekly", label: "WEEKLY DIGEST: TEST",
  generated_at: day(0), created_at: day(0), is_read: false,
  content_json: {
    intro: "Test, here's your week.",
    sections: [{ label: "THIS WEEK VS LAST", body: "Three sessions logged, squat moved 10 lbs." }, { label: "FOCUS NEXT WEEK", body: "Hit all four days." }],
    questions, flags: {},
  },
});

const BANK = [
  { id: "weight", kind: "weight", deeper: false, text: "Bodyweight still 185 lbs, or has it moved?" },
  { id: "injury", kind: "injury", deeper: false, meta: { area: "knee" }, text: "That knee: cleared, lingering, or still sharp?" },
  { id: "goal", kind: "goal", deeper: false, meta: { goal: "Squat 405" }, text: "Still chasing \"Squat 405\", or has the target shifted?" },
  { id: "recovery", kind: "context", deeper: false, text: "Recovery this week: dialed, flat, or running on fumes?" },
  { id: "niggles", kind: "context", deeper: true, text: "Low back, knees, anything nagging: managing it, or is it behind you?" },
  { id: "delivery", kind: "context", deeper: true, text: "Anything about how I deliver these: more detail, less, different focus?" },
];

// Real logged rows with a recent knee mention so the ledger keeps the knee open.
const kneeRows = (athlete) => [
  { id: "w1", athlete_id: athlete.id, created_at: day(2), raw_message: "Back squat 3x5 @ 225, knee a little achy", parsed_data: { exercises: [{ name: "Back Squat", sets: 3, reps: 5, weight: 225, unit: "lbs" }], pain_flags: [{ area: "knee", description: "a little achy on squats" }] } },
];

async function openCheckin(page, athlete, digest, turns, calls) {
  let turn = 0;
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    calls.push(body);
    let text;
    if (body.feature === "joebot_chat") text = turns[Math.min(turn++, turns.length - 1)];
    else if (body.feature === "proof_answer_extract") text = JSON.stringify({ weight_lbs: 185, soft_notes: "", memory_ops: [] });
    else return route.fallback();
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text }], usage: {} }) });
  });
  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "MY LOG" }).click();
  await page.getByRole("button", { name: /^proof$/i }).click();
  await page.getByText(/OPEN THIS WEEK'S EDITION/).click();
  await expect(page.getByText("Coach Joe wants to check in")).toBeVisible({ timeout: 10000 });
  await page.getByText(/START CHECK-IN/).click();
}

async function say(page, text) {
  const box = page.getByPlaceholder("Type your answer...");
  await box.fill(text);
  // the modal's own send button (the chat composer behind it has one too)
  await box.locator("xpath=following-sibling::button[1]").click();
}

test("check-in: two answers in one message, nothing re-asked, no go-deeper, no curse, pain outcome stamped", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 3, pain_marks: {} });
  const digest = digestWith(athlete, BANK);
  const { calls: dataCalls } = await mockApi(page, { athlete, dataReads: { workouts: kneeRows(athlete), proof_digests: [digest] } });
  const calls = [];
  await openCheckin(page, athlete, digest, [
    JSON.stringify({ reply: "Damn, good to hear the knee is fine. Still chasing Squat 405?", covered: ["weight", "injury"], next: "goal", done: false }),
    JSON.stringify({ reply: "Good. How was recovery this week?", covered: ["goal"], next: "recovery", done: false }),
    JSON.stringify({ reply: "Sick weeks happen, rest up. Anything about how I deliver these you'd change?", covered: ["recovery"], next: "delivery", done: false }),
    JSON.stringify({ reply: "", covered: ["delivery"], next: null, done: false }),
  ], calls);

  await expect(page.getByText("Bodyweight still 185 lbs, or has it moved?").last()).toBeVisible();
  await say(page, "185, and the knee is all good now");
  await expect(page.getByText(/Good to hear the knee is fine/)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/damn/i)).toHaveCount(0);                   // the gate removed it
  await say(page, "Goal is the same");
  await expect(page.getByText("Good. How was recovery this week?")).toBeVisible({ timeout: 10000 });
  await say(page, "I was sick all week");
  await expect(page.getByText(/Sick weeks happen/)).toBeVisible({ timeout: 10000 });
  await say(page, "nah all good");
  await expect(page.getByText("That's it for this week. Keep putting in the work.")).toBeVisible({ timeout: 10000 });

  // never re-asked, never a go-deeper line or button, anywhere
  await expect(page.getByText("Bodyweight still 185 lbs, or has it moved?")).toHaveCount(1); // asked once, never again
  await expect(page.getByText(/go deeper|wrap it here|short version/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /go deeper/i })).toHaveCount(0);

  // one model call per athlete message, each carrying the voice source
  const turnsCalled = calls.filter((c) => c.feature === "joebot_chat");
  expect(turnsCalled.length).toBe(4);
  expect(String(turnsCalled[0].system || "")).toContain("Never curse");
  // the covered items are gone from the open list on the second turn
  const openList = (c) => (JSON.stringify(c.messages || "").split("ALREADY COVERED")[0].split("OPEN ITEMS")[1] || "");
  expect(openList(turnsCalled[1])).not.toMatch(/weight: Bodyweight/);
  expect(openList(turnsCalled[1])).not.toMatch(/injury:/);

  // the digest locks and the knee's "all good" stamps cleared_at in pain_marks
  await expect.poll(() => dataCalls.some((c) => c.body?.op === "update" && c.body?.table === "proof_digests" && c.body?.data?.content_json?.checkin_done === true), { timeout: 10000 }).toBe(true);
  const marks = () => dataCalls.find((c) => c.body?.op === "update" && c.body?.table === "athletes" && c.body?.data?.pain_marks);
  await expect.poll(() => !!marks(), { timeout: 10000 }).toBe(true);
  expect(marks().body.data.pain_marks.knee.cleared_at).toBeTruthy();
  expect(marks().body.data.pain_marks.knee.asked_at).toBeTruthy();
  expect(Object.keys(marks().body.data)).toEqual(["pain_marks"]);         // its own write
});

test("check-in: the athlete ends it early and a malformed turn shows a plain reply", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 3 });
  const digest = digestWith(athlete, BANK.filter((q) => q.id !== "injury"));
  const { calls: dataCalls } = await mockApi(page, { athlete, dataReads: { proof_digests: [digest] } });
  const calls = [];
  await openCheckin(page, athlete, digest, ["Noted, 185 it is."], calls);

  await say(page, "185");
  await expect(page.getByText("Noted, 185 it is.")).toBeVisible({ timeout: 10000 }); // not JSON: shown as-is
  await say(page, "gotta go");
  await expect(page.getByText("No problem, we'll pick it up next week.")).toBeVisible({ timeout: 10000 });
  expect(calls.filter((c) => c.feature === "joebot_chat").length).toBe(1); // "gotta go" costs no model call
  await expect.poll(() => dataCalls.some((c) => c.body?.op === "update" && c.body?.table === "proof_digests" && c.body?.data?.content_json?.checkin_done === true), { timeout: 10000 }).toBe(true);
});

test("check-in: a dismissed pain area is never asked", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 3, pain_marks: { knee: { dismissed_at: day(1) } } });
  const digest = digestWith(athlete, BANK);
  await mockApi(page, { athlete, dataReads: { workouts: kneeRows(athlete), proof_digests: [digest] } });
  const calls = [];
  await openCheckin(page, athlete, digest, [JSON.stringify({ reply: "Got it.", covered: ["weight"], next: null })], calls);
  await say(page, "185");
  await expect(page.getByText("Got it.")).toBeVisible({ timeout: 10000 });
  const sys = calls.filter((c) => c.feature === "joebot_chat").map((c) => JSON.stringify(c)).join("\n");
  expect(sys).not.toMatch(/knee/i);                                        // not on the agenda at all
  await expect(page.getByText(/knee/i)).toHaveCount(0);
});

// ── the one output gate in chat (AI contract rule 8) ─────────────────────────
test("chat: a curse and an unstaged program claim never reach the bubble or the stored reply", async ({ page }) => {
  const athlete = makeAthlete({ program_text: "Day 1 - Push\nBench Press 3x5 @ 185\nDips 3x8" });
  const { calls } = await mockApi(page, { athlete });
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "mastermind_chat" && body.feature !== "joebot_chat") return route.fallback();
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: "Damn, that's a solid week — squat moved.\n\nI'm swapping Dips for push-ups for the rest of this block." }], usage: {} }) });
  });
  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "Not Now" }).click({ timeout: 15000 });
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("how are we looking this week?");
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect(page.getByText(/That's a solid week, squat moved\./)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/damn/i)).toHaveCount(0);
  await expect(page.getByText(/—/)).toHaveCount(0);
  await expect(page.getByText(/I'm swapping Dips/)).toHaveCount(0);
  await expect(page.getByText("I haven't changed your program. Say the word and I'll draft it.")).toBeVisible();
  const stored = () => calls.find((c) => c.body?.op === "insert" && c.body?.table === "workouts" && c.body?.data?.bot_reply);
  await expect.poll(() => !!stored(), { timeout: 10000 }).toBe(true);
  expect(stored().body.data.bot_reply).not.toMatch(/damn|swapping Dips|—/i);
});
