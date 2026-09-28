// ─── PROGRAM RECS (Will's 08-28 design) ──────────────────────────────────────
// Staged program changes under chat-first: the pattern gate (first mention =
// watched note, repeat/severity = rec), the rec bar + sheet (week-tagged swaps,
// collapsible WHY, hard durations), deterministic apply with instant local
// sync, and boot restore of an un-parked rec.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete, emptyParse } from "./mocks.js";

const PROGRAM = "Day 1 - Push\nBench Press 3x5 @ 185\nOverhead Press 3x8 @ 95\n\nDay 2 - Pull\nDeadlift 3x5 @ 275\nBarbell Row 3x8 @ 155";
const DRAFT_REPLY = "Week 1, Day 1: Push. Heavy bench day.\n===\nDay 1 - Push\n\nBench Press 3x5 @ 185\nOverhead Press 3x8 @ 95";
const painParse = (msg) => ({ ...emptyParse, coach_flag: "pain", general_notes: msg });

const REC_ROW = (athleteId) => ({
  id: "rec-row-1",
  athlete_id: athleteId,
  owner_type: "athlete",
  title: "Pec swap",
  status: "rec",
  draft_text: "",
  transcript: [],
  updated_at: new Date().toISOString(),
  blueprint: { rec: {
    v: 1, title: "Pec swap", origin: "pain", duration: "2w", parked: false,
    why: "Pec pain two weeks running, floor press cuts the stretch.",
    swaps: [{ week: null, day: "Day 1 - Push", find: "Bench Press 3x5 @ 185", replace: "Floor Press 3x5 @ 165" }],
  } },
});

test("rec: boot restores the bar, the sheet shows the tagged swap, Apply lands byte-for-byte", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, {
    athlete, chatReply: DRAFT_REPLY,
    dataReads: { program_drafts: (body) => String(body.params || "").includes('status=in.("rec"') ? [REC_ROW(athlete.id)] : [] },
  });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");

  // The bar survives restarts: it comes back on boot for an un-parked rec.
  const bar = page.getByText("PROGRAM REC — Pec swap").first();
  await expect(bar).toBeVisible({ timeout: 15000 });

  // Open the sheet: WHY strip, the struck original with its day tag, the
  // editable replacement, hard duration chips (no Permanent anywhere).
  await bar.click();
  await expect(page.getByText("Pec pain two weeks running", { exact: false })).toBeVisible();
  await expect(page.getByText("Day 1 - Push — replacing")).toBeVisible();
  await expect(page.getByText("Bench Press 3x5 @ 185").first()).toBeVisible();
  const repl = page.getByRole("textbox", { name: "Replacement 1" });
  await expect(repl).toHaveValue("Floor Press 3x5 @ 165");
  await expect(page.getByRole("button", { name: "2 weeks" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rest of block" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Permanent" })).toHaveCount(0);
  // The composer is the scope tool now — no scope chips.
  await expect(page.getByPlaceholder("I also want to change…")).toBeVisible();

  // Hand edit is verbatim, then Apply: deterministic swap + instant sync.
  await repl.fill("Floor Press 4x5 @ 160");
  await page.getByRole("button", { name: "Apply to Program" }).click();
  await expect(page.getByText(/Applied\./).first()).toBeVisible({ timeout: 15000 });

  const write = calls.find((c) => c.body?.op === "update" && c.body?.table === "athletes" && c.body?.data?.program_text);
  expect(write).toBeTruthy();
  expect(write.body.data.program_text).toContain("Floor Press 4x5 @ 160");
  expect(write.body.data.program_text).not.toContain("Bench Press 3x5 @ 185");
  expect(write.body.data.program_text).toContain("Overhead Press 3x8 @ 95"); // everything else untouched
});

test("rec DISMISS (T62): the pair renders (struck old + incoming line), Dismiss DELETES the row", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, {
    athlete, chatReply: DRAFT_REPLY,
    dataReads: { program_drafts: (body) => String(body.params || "").includes('status=in.("rec"') ? [REC_ROW(athlete.id)] : [] },
  });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");
  const bar = page.getByText("PROGRAM REC — Pec swap").first();
  await expect(bar).toBeVisible({ timeout: 15000 });
  await bar.click();
  // Will's 08-31 audit rule: every spot is a PAIR — the struck original and,
  // directly beneath it, the unmissable incoming line.
  await expect(page.getByText("Day 1 - Push — replacing")).toBeVisible();
  await expect(page.getByText("↳ What goes in").first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Replacement 1" })).toHaveValue("Floor Press 3x5 @ 165");
  // The duration picker + all three actions live OUTSIDE the scroll region.
  await expect(page.getByRole("button", { name: "Rest of block" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save for Later" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply to Program" })).toBeVisible();
  // Will 09-01: dismissed = deleted outright, no lingering row anywhere.
  await page.getByRole("button", { name: "Dismiss this rec" }).click();
  await expect(page.getByText(/Deleted\. Program stays as it is/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("PROGRAM REC — Pec swap")).toHaveCount(0);
  const del = calls.find((c) => c.body?.op === "delete" && c.body?.table === "program_drafts" && String(c.body?.params || "").includes("rec-row-1"));
  expect(del).toBeTruthy();
});

test("rec bar ✕ asks (Will 09-01): Save to Drafts parks, Delete removes, backdrop cancels", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, {
    athlete, chatReply: DRAFT_REPLY,
    dataReads: { program_drafts: (body) => String(body.params || "").includes('status=in.("rec"') ? [REC_ROW(athlete.id)] : [] },
  });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");
  const bar = page.getByText("PROGRAM REC — Pec swap").first();
  await expect(bar).toBeVisible({ timeout: 15000 });
  // ✕ opens the ask instead of silently parking.
  await page.getByRole("button", { name: "Close the program rec", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Close this program rec" });
  await expect(dialog).toBeVisible();
  // Backdrop tap cancels — the rec stays live, nothing written. (Click the
  // overlay's own corner: viewport coords can miss the app column entirely.)
  await dialog.locator("..").click({ position: { x: 8, y: 8 } });
  await expect(dialog).toHaveCount(0);
  await expect(bar).toBeVisible();
  expect(calls.find((c) => c.body?.op === "delete" && c.body?.table === "program_drafts")).toBeFalsy();
  // Save to Drafts parks it (the bar comes down, the row survives as parked).
  await page.getByRole("button", { name: "Close the program rec", exact: true }).click();
  await dialog.getByRole("button", { name: "Save to Drafts" }).click();
  await expect(page.getByText(/Parked it\./)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("PROGRAM REC — Pec swap")).toHaveCount(0);
  const park = calls.find((c) => c.body?.op === "update" && c.body?.table === "program_drafts" && c.body?.data?.blueprint?.rec?.parked === true);
  expect(park).toBeTruthy();
  expect(calls.find((c) => c.body?.op === "delete" && c.body?.table === "program_drafts")).toBeFalsy();
});

// ── T64 S2: pain runs on the PAIN LEDGER, one voice per turn ────────────────
const chatSystem = (calls) => calls.filter((c) => /api\/claude/.test(c.url) && c.body && /mastermind_chat|joebot_chat/.test(c.body.feature || "")).map((c) => JSON.stringify(c.body)).join("\n");
const painMarksWrite = (calls) => calls.find((c) => c.body?.op === "update" && c.body?.table === "athletes" && c.body?.data?.pain_marks);
const painRow = (daysAgo, description) => ({ id: `pain-${daysAgo}`, athlete_id: "x", created_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
  raw_message: description, parsed_data: { exercises: [], pain_flags: [{ area: "knee", description }] } });

test("pain ledger: a first pain mention gets Joe's one line and NO app bubble, no rec", async ({ page }) => {
  const msg = "my knee felt a little cranky on squats today";
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, { athlete, chatReply: DRAFT_REPLY, parseResult: { ...painParse(msg), pain_flags: [{ area: "knee", description: "a little cranky on squats" }] } });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");

  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill(msg);
  await page.getByRole("button", { name: "→" }).click();
  await expect(page.getByText("Heavy bench day", { exact: false }).last()).toBeVisible({ timeout: 15000 });
  await expect.poll(() => !!painMarksWrite(calls), { timeout: 10000 }).toBe(true);
  await expect(page.getByText(/one rough day/i)).toHaveCount(0);
  await expect(page.getByText(/twice now/i)).toHaveCount(0);
  await expect(page.getByText(/PROGRAM REC —/)).toHaveCount(0);
  expect(painMarksWrite(calls).body.data.pain_marks.knee.noted_at).toBeTruthy();
  expect(painMarksWrite(calls).body.data.pain_marks.knee.offered_at).toBeFalsy();
  const watch = calls.find((c) => c.body?.op === "insert" && c.body?.table === "athlete_memory" && /\(pain\)/.test(c.body?.data?.content || ""));
  expect(watch).toBeFalsy(); // pain lives in the ledger now, not in watch notes
  const sys = chatSystem(calls);
  expect(sys).toContain("PAIN LEDGER");
  expect(sys).toContain("knee: acknowledge_once");
});

test("pain ledger: a worsening pattern is Joe's single offer; the app drafts nothing and stamps offered_at", async ({ page }) => {
  const msg = "knee was on fire on squats again, I stopped";
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, {
    athlete, chatReply: DRAFT_REPLY,
    parseResult: { ...painParse(msg), pain_flags: [{ area: "knee", description: "on fire on squats, stopped" }] },
    dataReads: { workouts: [painRow(2, "knee flared during squat"), painRow(4, "knee a little achy during squat")] },
  });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");

  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill(msg);
  await page.getByRole("button", { name: "→" }).click();
  await expect(page.getByText("Heavy bench day", { exact: false }).last()).toBeVisible({ timeout: 15000 });
  await expect.poll(() => !!painMarksWrite(calls), { timeout: 10000 }).toBe(true);
  expect(painMarksWrite(calls).body.data.pain_marks.knee.offered_at).toBeTruthy();
  await expect(page.getByText(/PROGRAM REC —/)).toHaveCount(0);
  await expect(page.getByText(/twice now|one rough day/i)).toHaveCount(0);
  expect(calls.find((c) => c.body?.feature === "program_generate")).toBeFalsy();
  expect(chatSystem(calls)).toContain("knee: offer_change_once");
});

test("pain ledger: serious language drafts the protective rec and the app confirms once", async ({ page }) => {
  const msg = "felt a pop in my knee on squats and it gave out";
  const athlete = makeAthlete({ program_text: PROGRAM });
  const { calls } = await mockApi(page, {
    athlete, chatReply: DRAFT_REPLY,
    parseResult: { ...painParse(msg), pain_flags: [{ area: "knee", description: "felt a pop, knee gave out on squats" }] },
    recDraftReply: JSON.stringify({ title: "Knee protection", why: "A pop and a give-out is a stop sign.", duration: "1w",
      swaps: [{ week: null, day: "Day 2 - Pull", find: "Deadlift 3x5 @ 275", replace: "Hip Thrust 3x8 @ 185" }] }),
  });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");

  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill(msg);
  await page.getByRole("button", { name: "→" }).click();
  await expect(page.getByText("Drafted a program rec for your knee", { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("PROGRAM REC — Knee protection").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/not something to train through blind/i)).toHaveCount(0);
  expect(chatSystem(calls)).toContain("THIS MESSAGE reads as serious");
  const gen = calls.find((c) => c.body?.feature === "program_generate");
  expect(JSON.stringify(gen.body)).toContain("PAIN LEDGER");
});

test("watch rule (plateau): a repeat drafts the rec and the app confirms once", async ({ page }) => {
  const msg = "bench has been stuck at 185 for weeks";
  const athlete = makeAthlete({ program_text: PROGRAM });
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const inTwoWeeks = new Date(Date.now() + 13 * 86400000).toISOString();
  await mockApi(page, {
    athlete, chatReply: DRAFT_REPLY, parseResult: { ...emptyParse, coach_flag: "plateau", general_notes: msg },
    dataReads: { athlete_memory: [{ id: "mem-1", athlete_id: athlete.id, status: "active",
      content: `Watching: bench (plateau) reported ${yesterday} - a repeat within 2 weeks earns a program rec`,
      kind: "situational", expires_at: inTwoWeeks, updated_at: new Date().toISOString() }] },
    recDraftReply: JSON.stringify({ title: "Bench - pause variation", why: "Stuck two weeks.", duration: "2w",
      swaps: [{ week: null, day: "Day 1 - Push", find: "Bench Press 3x5 @ 185", replace: "Paused Bench 3x5 @ 175" }] }),
  });
  await loginAsAthlete(page, athlete, "/?chatfirst=1&mastermind=1");

  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill(msg);
  await page.getByRole("button", { name: "→" }).click();
  await expect(page.getByText("Drafted a program rec for that", { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("PROGRAM REC — Bench - pause variation").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/twice now/i)).toHaveCount(0);
});
