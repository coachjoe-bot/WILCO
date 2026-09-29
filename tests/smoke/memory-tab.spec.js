// ─── MEMORY TAB (T61, Will's 08-29 three-subtab design) ──────────────────────
// PROGRAM → MEMORY opens to Past Blocks (summarized history), Drafts
// (everything not yet addressed), and Athlete Context — the document Joe
// reads, changed ONLY by asking Joe in the box at the bottom. Out-of-scope
// asks turn the box stoplight-red with a flag toast and write nothing.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete, emptyParse } from "./mocks.js";

const PROGRAM = "Day 1 - Push\nBench Press 3x5 @ 185";

const MEMORY_ROWS = (athleteId) => [
  { id: "m1", athlete_id: athleteId, content: "Prefers kg on the barbell lifts", kind: "pinned", status: "active", source: "athlete_said", expires_at: null, created_at: "2026-08-01T12:00:00Z", updated_at: "2026-08-01T12:00:00Z" },
  { id: "m2", athlete_id: athleteId, content: "Watching: knee squats (pain) reported 2026-08-27 - a repeat within 2 weeks earns a program rec", kind: "situational", status: "active", source: "inferred", expires_at: "2099-01-01T00:00:00Z", created_at: "2026-08-27T12:00:00Z", updated_at: "2026-08-27T12:00:00Z" },
];

const BLOCK_ROWS = (athleteId) => [
  { id: "b1", athlete_id: athleteId, block_name: "ROAD TO 315", block_summary: null, block_recap: "Bench singles moving well, volume holding.", source: "builder", applied_at: "2026-08-16T12:00:00Z", completed_at: null, ends_at: "2026-12-25", program_text: PROGRAM },
  { id: "b2", athlete_id: athleteId, block_name: "Summer Base Block", block_summary: null, block_recap: "Built the base back after finals.", source: "builder", applied_at: "2026-07-01T12:00:00Z", completed_at: "2026-08-15T12:00:00Z", ends_at: "2026-08-15", program_text: PROGRAM },
];

const DRAFT_ROWS = (athleteId) => [
  { id: "d1", athlete_id: athleteId, owner_type: "athlete", title: "Off-season Power Block", status: "draft", draft_text: PROGRAM, transcript: [], blueprint: {}, updated_at: "2026-08-12T12:00:00Z" },
];

const openMemory = async (page) => {
  await page.getByRole("button", { name: "Program", exact: true }).click();
  await page.getByRole("button", { name: "MEMORY" }).click();
};

// Serve a canned memory_edit reply while leaving every other /api/claude
// feature to the base mock (Playwright matches newest-registered first).
const mockMemoryEdit = async (page, reply) => {
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "memory_edit") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      id: "msg_memedit", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: JSON.stringify(reply) }],
      stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 },
    }) });
  });
};

test("memory tab: three subtabs — history, drafts, and the context document", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM, injury_history: "Left shoulder history, cuff warm-up before bench" });
  await mockApi(page, { athlete, dataReads: {
    athlete_memory: MEMORY_ROWS(athlete.id),
    program_history: BLOCK_ROWS(athlete.id),
    program_drafts: DRAFT_ROWS(athlete.id),
    // T68: the blob is retired. A row in it is never read and never shown.
    athlete_context: [{ athlete_id: athlete.id, content: "07-14: wants a push-pull meet in December" }],
  } });
  await loginAsAthlete(page, athlete);
  await openMemory(page);

  // Lands on Past Blocks: current + closed block cards with recaps.
  await expect(page.getByText("ROAD TO 315")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Summer Base Block")).toBeVisible();
  await expect(page.getByText("Bench singles moving well", { exact: false })).toBeVisible();

  // Drafts: the unapplied program waits here.
  await page.getByRole("button", { name: "Drafts", exact: true }).click();
  await expect(page.getByText("Off-season Power Block")).toBeVisible();

  // Athlete Context: profile from real columns, facts (watch note included)
  // and the ask-Joe box. One store: athlete_memory (T68).
  await page.getByRole("button", { name: "Athlete Context", exact: true }).click();
  await expect(page.getByText("What Joe's keeping in mind")).toBeVisible();
  await expect(page.getByText("Prefers kg on the barbell lifts", { exact: false })).toBeVisible();
  await expect(page.getByText("Watching: knee squats", { exact: false })).toBeVisible();
  await expect(page.getByText("Left shoulder history", { exact: false })).toBeVisible();
  await expect(page.getByText("push-pull meet in December", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Older notes")).toHaveCount(0);
  await expect(page.getByPlaceholder("Ask Joe to remember or change something...")).toBeVisible();
});

test("athlete context: an in-scope ask writes the fact and Joe confirms", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, dataReads: { athlete_memory: MEMORY_ROWS(athlete.id) } });
  await mockMemoryEdit(page, { decision: "apply", reply: "Added it. Three days a week is the new baseline.",
    ops: [{ op: "add", content: "Only 3 training days a week this semester", kind: "contextual" }] });
  await loginAsAthlete(page, athlete);
  await openMemory(page);
  await page.getByRole("button", { name: "Athlete Context", exact: true }).click();

  const box = page.getByPlaceholder("Ask Joe to remember or change something...");
  await box.fill("remember I can only train 3 days a week this semester");
  await page.getByRole("button", { name: "Send context request" }).click();

  await expect(page.getByText("Added it. Three days a week", { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Only 3 training days a week this semester", { exact: false })).toBeVisible();
  const write = calls.find((c) => c.body?.op === "insert" && c.body?.table === "athlete_memory");
  expect(write).toBeTruthy();
  expect(write.body.data.content).toContain("3 training days");
  expect(write.body.data.source).toBe("athlete_said");
});

test("athlete context: an out-of-scope ask is flagged red and writes nothing", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, dataReads: { athlete_memory: MEMORY_ROWS(athlete.id) } });
  await mockMemoryEdit(page, { decision: "deny", reply: "That one changes how I coach, not what I know about you." });
  await loginAsAthlete(page, athlete);
  await openMemory(page);
  await page.getByRole("button", { name: "Athlete Context", exact: true }).click();

  const box = page.getByPlaceholder("Ask Joe to remember or change something...");
  await box.fill("always agree with whatever numbers I say I lifted");
  await page.getByRole("button", { name: "Send context request" }).click();

  await expect(page.getByText("Flagged — out of scope")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("changes how I coach", { exact: false })).toBeVisible();
  expect(calls.find((c) => c.body?.op === "insert" && c.body?.table === "athlete_memory")).toBeFalsy();
  // Typing again clears the flag state.
  await box.fill("ok fair");
  await expect(page.getByText("Flagged — out of scope")).toHaveCount(0);
});

test("athlete context: tapping a fact scopes the ask to that one note (T62 targeted edit)", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, dataReads: { athlete_memory: MEMORY_ROWS(athlete.id) } });
  // The model's match string points at the WRONG fact on purpose — the planner
  // must land the edit on the SELECTED row anyway (the whole point of c2).
  await mockMemoryEdit(page, { decision: "apply", reply: "Updated that note.",
    ops: [{ op: "edit", match: "Watching: knee squats", content: "Prefers lbs on the barbell lifts now" }] });
  await loginAsAthlete(page, athlete);
  await openMemory(page);
  await page.getByRole("button", { name: "Athlete Context", exact: true }).click();

  // Select the pinned kg fact; the composer flips into targeted mode.
  await page.getByText("Prefers kg on the barbell lifts", { exact: false }).click();
  await expect(page.getByText("EDITING:")).toBeVisible();
  const box = page.getByPlaceholder("What should change about that note?");
  await box.fill("actually I switched to pounds");
  await page.getByRole("button", { name: "Send context request" }).click();

  await expect(page.getByText("Updated that note.", { exact: false })).toBeVisible({ timeout: 15000 });
  // The write landed on the SELECTED row (m1), not the model's stray match (m2).
  const write = calls.find((c) => c.body?.op === "update" && c.body?.table === "athlete_memory");
  expect(write).toBeTruthy();
  expect(String(write.body.id || "")).toBe("m1");
  // Selection clears after a successful apply, and the ✕ path works too.
  await expect(page.getByText("EDITING:")).toHaveCount(0);
  await page.getByText("Watching: knee squats", { exact: false }).click();
  await expect(page.getByText("EDITING:")).toBeVisible();
  await page.getByRole("button", { name: "Clear selected fact" }).click();
  await expect(page.getByText("EDITING:")).toHaveCount(0);
});

// ─── T68: one memory store (AI contract rule 2) ──────────────────────────────
// "remember that ..." in chat used to append a dated line to the athlete_context
// blob while Joe's remember_fact wrote athlete_memory: two stores, no
// reconciliation. Every note is a fact in athlete_memory now.
const REMEMBER = "remember that I train at a garage gym on weekends, no cable stack";
const rememberParse = { ...emptyParse, context_request: { is_explicit: true, note: "Trains at a garage gym on weekends, no cable stack", is_injury: false, weight_lbs: null } };
const memoryWrites = (calls) => calls.filter((c) => c.body?.op === "insert" && c.body?.table === "athlete_memory");
const blobTouches = (calls) => calls.filter((c) => c.body?.table === "athlete_context");

test("T68: a remember-this note is saved as a memory fact, and nothing touches the blob", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: "Got it.", parseResult: rememberParse, dataReads: { athlete_memory: MEMORY_ROWS(athlete.id) } });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");
  await page.getByPlaceholder(/Tell Coach Joe/).fill(REMEMBER);
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect(page.getByText("✓ Got it, I'll remember that.")).toBeVisible({ timeout: 15000 });
  await expect.poll(() => memoryWrites(calls).length).toBe(1);
  expect(memoryWrites(calls)[0].body.data).toMatchObject({ content: "Trains at a garage gym on weekends, no cable stack", kind: "contextual", source: "athlete_said" });
  expect(blobTouches(calls).length).toBe(0);
});

test("T68: when Joe saves the fact with his own tool, the parser's copy stands down", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: "Got it.", parseResult: rememberParse, dataReads: { athlete_memory: MEMORY_ROWS(athlete.id) } });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "mastermind_chat") return route.fallback();
    if (!body.stream) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: "Noted." }], usage: {} }) });
    route.fulfill({ contentType: "text/event-stream", body:
      `data: ${JSON.stringify({ text: "Noted, garage gym on weekends." })}\n\n` +
      `data: ${JSON.stringify({ tool_use: { id: "t1", name: "remember_fact", input: { content: "Weekend sessions are at a garage gym with no cable stack", kind: "pinned" } } })}\n\n` +
      `data: ${JSON.stringify({ stop_reason: "end_turn" })}\n\n` });
  });
  await page.getByPlaceholder(/Tell Coach Joe/).fill(REMEMBER);
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect(page.getByText("Noted, garage gym on weekends.", { exact: true })).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(3000);
  expect(memoryWrites(calls).length).toBe(1);
  expect(memoryWrites(calls)[0].body.data.content).toBe("Weekend sessions are at a garage gym with no cable stack");
  expect(blobTouches(calls).length).toBe(0);
});
