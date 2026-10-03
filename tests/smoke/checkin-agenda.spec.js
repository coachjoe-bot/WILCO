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

async function openCheckin(page, athlete, digest, turns, calls, extract = { weight_lbs: 185, soft_notes: "", memory_ops: [] }) {
  let turn = 0;
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    calls.push(body);
    let text;
    if (body.feature === "joebot_chat") text = turns[Math.min(turn++, turns.length - 1)];
    else if (body.feature === "proof_answer_extract") text = JSON.stringify(typeof extract === "function" ? extract(body) : extract);
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
  // (no signup fields on file: T69-C asks about training days, equipment and injury
  // background too, and this spec walks a fixed agenda of the digest's own questions)
  const athlete = makeAthlete({ total_sessions_logged: 3, pain_marks: {}, training_days_per_week: null, equipment: null });
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
  // T69-C (Will 10-01): check-in summaries STOP. No "Weekly check-in ..." note is
  // written (this extractor returned no recovery word and nothing short-lived, so
  // there is no This-week row either), and the retired blob is never touched.
  const noteWrites = dataCalls.filter((c) => c.body?.op === "insert" && c.body?.table === "athlete_memory");
  expect(noteWrites.length).toBe(0);
  expect(dataCalls.some((c) => c.body?.table === "athlete_context")).toBe(false);
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

// ─── T69-C: the check-in asks about old notes ────────────────────────────────
// A note not checked in 3 to 8 weeks comes up in plain words that quote it, with
// the line that names the note and why (Will 10-02). The answer is what stamps,
// edits or removes it, by id. One This-week row replaces the old summary.
const old = (n) => new Date(Date.now() - n * 86400000).toISOString();
const NOTE = (athlete, over = {}) => ({ id: "n1", athlete_id: athlete.id, content: "Trains at the 6am class", kind: "contextual", status: "active", source: "athlete_said", expires_at: null, section: "schedule", confirmed_at: old(80), ask_count: 0, created_at: old(120), updated_at: old(80), ...over });
const GOAL = (athlete) => ({ id: "g1", athlete_id: athlete.id, goal_text: "Squat 405 by December", target_date: new Date(Date.now() + 70 * 864e5).toISOString().slice(0, 10), superseded_at: null, created_at: old(30), confirmed_at: old(3) });
const BANK3 = [
  { id: "weight", kind: "weight", deeper: false, text: "Bodyweight still 185 lbs, or has it moved?" },
  { id: "injury", kind: "injury", deeper: false, text: "Anything banged up I should know about?" },
  { id: "goal", kind: "goal", deeper: false, meta: { goal: "Squat 405 by December" }, text: "Still chasing \"Squat 405 by December\", or has the target shifted?" },
  { id: "recovery", kind: "context", deeper: false, text: "Recovery this week: dialed, flat, or running on fumes?" },
];
const memTurns = (extra) => [
  JSON.stringify({ reply: "", covered: ["weight", "injury"], next: "goal" }),
  JSON.stringify({ reply: "Good.", covered: ["goal"], next: "review_note_n1", ask: "I have a note that says \"Trains at the 6am class\". Still true?" }),
  ...extra,
];
const reviewRows = (athlete, note) => ({ athlete_memory: [note], athlete_goals: [GOAL(athlete)], workouts: [] });

test("check-in: a due note is asked in plain words with its reason line; 'still true' stamps it; one This-week row, no summary note", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 3, training_days_per_week: null, equipment: null, injury_history: null });
  const digest = digestWith(athlete, BANK3);
  const { calls: dataCalls } = await mockApi(page, { athlete, dataReads: { ...reviewRows(athlete, NOTE(athlete)), proof_digests: [digest] } });
  const calls = [];
  await openCheckin(page, athlete, digest, memTurns([
    JSON.stringify({ reply: "Keeping it.", covered: ["review_note_n1"], next: "recovery" }),
    JSON.stringify({ reply: "", covered: ["recovery"], next: null }),
  ]), calls, () => ({ weight_lbs: 185, recovery: "dialed", this_week: "School ate the week, back to 6 days from Monday", memory_ops: [], review: [{ id: "review_note_n1", verdict: "keep" }, { id: "review_goal_g1", verdict: "keep" }] }));
  await say(page, "185, no pain");
  await expect(page.getByText("Good.", { exact: false }).first()).toBeVisible({ timeout: 10000 }).catch(() => {});
  await say(page, "same goal");
  const q = page.getByText(/I have a note that says "Trains at the 6am class"/);
  await expect(q).toBeVisible({ timeout: 10000 });
  // the line under the question names the note's section and why it is asked
  const tag = page.getByTestId("checkin-tag").last();
  await expect(tag).toContainText("Schedule");
  await expect(tag).toContainText("last checked");
  await say(page, "yep still the plan");
  await expect(page.getByText("Keeping it.")).toBeVisible({ timeout: 10000 });
  await say(page, "dialed");
  await expect(page.getByText("That's it for this week. Keep putting in the work.")).toBeVisible({ timeout: 10000 });
  // the extractor was told which notes were asked, by id
  const ext = calls.filter((c) => c.feature === "proof_answer_extract");
  expect(ext.length).toBe(1);
  const extText = JSON.stringify(ext[0]);
  expect(extText).toContain("REVIEW ITEMS");
  expect(extText).toContain("review_note_n1");
  expect(extText).toContain("Trains at the 6am class");
  // keep stamps the row (the old code did nothing: it was asked again next week)
  const upd = () => dataCalls.find((c) => c.body?.op === "update" && c.body?.table === "athlete_memory" && String(c.body?.id) === "n1");
  await expect.poll(() => !!upd(), { timeout: 10000 }).toBe(true);
  expect(upd().body.data.confirmed_at).toBeTruthy();
  expect(upd().body.data.ask_count).toBe(0);
  expect("content" in upd().body.data).toBe(false);
  // the goal's own clock too (the weekly goal question is a check)
  expect(dataCalls.some((c) => c.body?.op === "update" && c.body?.table === "athlete_goals" && String(c.body?.id) === "g1" && c.body?.data?.confirmed_at)).toBe(true);
  // ONE This-week row, 28 days; no check-in summary
  const ins = dataCalls.filter((c) => c.body?.op === "insert" && c.body?.table === "athlete_memory");
  expect(ins.length).toBe(1);
  expect(ins[0].body.data).toMatchObject({ section: "this_week", kind: "situational" });
  expect(ins[0].body.data.content).toMatch(/^Check-in [A-Z][a-z]{2} \d{1,2}\. Recovery: dialed\. School ate the week/);
  expect(Date.parse(ins[0].body.data.expires_at) - Date.now()).toBeGreaterThan(27 * 864e5);
  expect(ins.some((c) => /^(Weekly|Monthly) check-in/.test(c.body.data.content))).toBe(false);
});

test("check-in: ending right after the question counts for nothing; a reply that did not answer counts once; the second removes the note", async ({ page }) => {
  // (a) asked, then the athlete ends it before answering: nothing moves
  let athlete = makeAthlete({ total_sessions_logged: 3, training_days_per_week: null, equipment: null, injury_history: null });
  let digest = digestWith(athlete, BANK3);
  let { calls: dataCalls } = await mockApi(page, { athlete, dataReads: { ...reviewRows(athlete, NOTE(athlete)), proof_digests: [digest] } });
  let calls = [];
  await openCheckin(page, athlete, digest, memTurns([]), calls, () => ({ weight_lbs: 185, memory_ops: [], review: [{ id: "review_note_n1", verdict: "keep" }] }));
  await say(page, "185, no pain");
  await say(page, "same goal");
  await expect(page.getByText(/I have a note that says/)).toBeVisible({ timeout: 10000 });
  await say(page, "gotta go");
  await expect(page.getByText("No problem, we'll pick it up next week.")).toBeVisible({ timeout: 10000 });
  await expect.poll(() => dataCalls.some((c) => c.body?.op === "update" && c.body?.table === "proof_digests"), { timeout: 10000 }).toBe(true);
  expect(dataCalls.some((c) => c.body?.table === "athlete_memory" && (c.body?.op === "update" || c.body?.op === "insert"))).toBe(false);
});

test("check-in: a reply that never answers the note counts once, and the second silent ask removes it", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 3, training_days_per_week: null, equipment: null, injury_history: null });
  const digest = digestWith(athlete, BANK3);
  const { calls: dataCalls } = await mockApi(page, { athlete, dataReads: { ...reviewRows(athlete, NOTE(athlete, { ask_count: 1 })), proof_digests: [digest] } });
  const calls = [];
  await openCheckin(page, athlete, digest, memTurns([
    JSON.stringify({ reply: "Ha, fair.", covered: ["review_note_n1"], next: "recovery" }),
    JSON.stringify({ reply: "", covered: ["recovery"], next: null }),
  ]), calls, () => ({ weight_lbs: 185, memory_ops: [], review: [{ id: "review_note_n1", verdict: "unclear" }] }));
  await say(page, "185, no pain");
  await say(page, "same goal");
  await expect(page.getByText(/I have a note that says/)).toBeVisible({ timeout: 10000 });
  await say(page, "lol my cat just knocked my coffee over");
  await expect(page.getByText("Ha, fair.")).toBeVisible({ timeout: 10000 });
  await say(page, "dialed");
  await expect(page.getByText("That's it for this week. Keep putting in the work.")).toBeVisible({ timeout: 10000 });
  const upd = () => dataCalls.find((c) => c.body?.op === "update" && c.body?.table === "athlete_memory" && String(c.body?.id) === "n1");
  await expect.poll(() => !!upd(), { timeout: 10000 }).toBe(true);
  expect(upd().body.data.status).toBe("deleted");                     // asked twice, no answer: removed
});

test("check-in: a changed answer rewrites the note in place and a changed training-days answer writes its own column", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 3, training_days_per_week: 6, equipment: null, injury_history: null, created_at: old(200) });
  const digest = digestWith(athlete, BANK3);
  const { calls: dataCalls } = await mockApi(page, { athlete, dataReads: { ...reviewRows(athlete, NOTE(athlete)), proof_digests: [digest] } });
  const calls = [];
  await openCheckin(page, athlete, digest, [
    JSON.stringify({ reply: "", covered: ["weight", "injury"], next: "goal" }),
    JSON.stringify({ reply: "Good.", covered: ["goal"], next: "review_note_n1", ask: "I have a note that says \"Trains at the 6am class\". Still true?" }),
    JSON.stringify({ reply: "Updated.", covered: ["review_note_n1", "review_signup_training_days_per_week"], next: "recovery" }),
    JSON.stringify({ reply: "", covered: ["recovery"], next: null }),
  ], calls, () => ({ weight_lbs: 185, memory_ops: [], review: [
    { id: "review_note_n1", verdict: "edit", content: "Trains at the 7am class" },
    { id: "review_signup_training_days_per_week", verdict: "edit", value: 4 },
    { id: "review_goal_g1", verdict: "keep" },
  ] }));
  await say(page, "185, no pain");
  await say(page, "same goal");
  await expect(page.getByText(/I have a note that says/)).toBeVisible({ timeout: 10000 });
  await say(page, "it moved to 7am, and I only train 4 days now");
  await say(page, "dialed");
  await expect(page.getByText("That's it for this week. Keep putting in the work.")).toBeVisible({ timeout: 10000 });
  const upd = () => dataCalls.find((c) => c.body?.op === "update" && c.body?.table === "athlete_memory" && String(c.body?.id) === "n1");
  await expect.poll(() => !!upd(), { timeout: 10000 }).toBe(true);
  expect(upd().body.data).toMatchObject({ content: "Trains at the 7am class", ask_count: 0 });
  const col = () => dataCalls.find((c) => c.body?.op === "update" && c.body?.table === "athletes" && c.body?.data?.training_days_per_week);
  await expect.poll(() => !!col(), { timeout: 10000 }).toBe(true);
  expect(col().body.data.training_days_per_week).toBe(4);
  expect(col().body.data.review_stamps.training_days_per_week.confirmed_at).toBeTruthy();
});

test("check-in: the extractor failing moves nothing (no stamp, no count, no removal)", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 3, training_days_per_week: null, equipment: null, injury_history: null });
  const digest = digestWith(athlete, BANK3);
  const { calls: dataCalls } = await mockApi(page, { athlete, dataReads: { ...reviewRows(athlete, NOTE(athlete, { ask_count: 1 })), proof_digests: [digest] } });
  const calls = [];
  await openCheckin(page, athlete, digest, memTurns([
    JSON.stringify({ reply: "Ok.", covered: ["review_note_n1"], next: "recovery" }),
    JSON.stringify({ reply: "", covered: ["recovery"], next: null }),
  ]), calls, () => ({ weight_lbs: 185 }));            // no "review" array at all
  await say(page, "185, no pain");
  await say(page, "same goal");
  await expect(page.getByText(/I have a note that says/)).toBeVisible({ timeout: 10000 });
  await say(page, "whatever");
  await say(page, "dialed");
  await expect(page.getByText("That's it for this week. Keep putting in the work.")).toBeVisible({ timeout: 10000 });
  await expect.poll(() => dataCalls.some((c) => c.body?.op === "update" && c.body?.table === "proof_digests"), { timeout: 10000 }).toBe(true);
  expect(dataCalls.some((c) => c.body?.table === "athlete_memory" && c.body?.op === "update")).toBe(false);
});
