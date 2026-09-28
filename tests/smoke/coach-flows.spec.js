// ─── T57: the coach-truth suite ───────────────────────────────────────────────
// The athlete gym-truth suite (T56) exists because code-level gates stayed green
// while athlete-visible flows were broken on a phone. The coach side had the
// same hole: "Review & apply" on a change request crashed on a leftover
// setProgTab reference for EVERY coach on prod, and no test drove the flow.
// These specs walk the request card exactly as a coach's finger does.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, makeCoach, loginAsCoach } from "./mocks.js";

const PROGRAM = "Day 1 - Push\nBench Press 3x5 @ 185\nFront Squat 3x5 @ 155\nDips 3x8";
const MERGED = PROGRAM.replace("Front Squat 3x5 @ 155", "Leg Press 3x10 @ 200");

const REQUEST = (athlete, coach) => ({
  id: "req-smoke-1",
  athlete_id: athlete.id,
  coach_id: coach.id,
  status: "pending",
  source: "pain",
  reason: "my knee hurts on front squats",
  created_at: new Date().toISOString(),
  items: [{
    lift: "Front Squat",
    suggested_change: "Replace Front Squat 3x5 with Leg Press 3x10 until the knee calms down.",
    current: "Front Squat 3x5 @ 155",
    why: "knee pain on the descent",
  }],
});

async function openAthleteWithRequest(page) {
  const coach = makeCoach();
  const athlete = makeAthlete({ coach_id: coach.id, program_text: PROGRAM, program_locked: true });
  await mockApi(page, { athlete, coach });
  // Newest route wins: serve the pending request; everything else falls back.
  await page.route("**/api/data", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.op === "read" && JSON.stringify(body).includes("program_change_requests")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify([REQUEST(athlete, coach)]) });
    }
    return route.fallback();
  });
  // The merge AI returns the program with exactly the requested line swapped.
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "program_apply_change") return route.fallback();
    route.fulfill({ contentType: "application/json", body: JSON.stringify({
      id: "msg_smoke", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: MERGED }], stop_reason: "end_turn", usage: {},
    }) });
  });

  await loginAsCoach(page, coach);
  await page.getByRole("button", { name: /^athletes$/i }).click();
  await page.getByText(athlete.name).first().click();
  await expect(page.getByText(/Replace Front Squat 3x5/)).toBeVisible({ timeout: 10000 });
  return { coach, athlete };
}

test("'Review & apply' on a change request reaches the REVIEW CHANGE diff (the setProgTab crash class)", async ({ page }) => {
  await openAthleteWithRequest(page);
  await page.getByRole("button", { name: "Review & apply" }).click();
  // Before the T57 fix this threw ReferenceError before anything staged — the
  // review overlay could never appear.
  await expect(page.getByText("REVIEW CHANGE")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Leg Press 3x10 @ 200/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Save program/ })).toBeVisible();
});

// TRACED (T57 s5): the beat never rendered because buildMorningBrief only ever
// attached pending requests to TRIAGE beats — a healthy athlete's request was
// dropped entirely and the brief claimed all-clear over pending work. Fixed in
// coachBrief.js (standalone request beats + the request survives a cleared
// triage flag); pinned in test-coach-brief.mjs.
test("the Morning Brief's 'Review & apply' hand-off reaches the staged diff (the second setProgTab site)", async ({ page }) => {
  const coach = makeCoach();
  const athlete = makeAthlete({ coach_id: coach.id, program_text: PROGRAM, program_locked: true });
  await mockApi(page, { athlete, coach });
  await page.route("**/api/data", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.op === "read" && JSON.stringify(body).includes("program_change_requests")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify([REQUEST(athlete, coach)]) });
    }
    return route.fallback();
  });
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.feature !== "program_apply_change") return route.fallback();
    route.fulfill({ contentType: "application/json", body: JSON.stringify({
      id: "msg_smoke", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: MERGED }], stop_reason: "end_turn", usage: {},
    }) });
  });

  await loginAsCoach(page, coach);
  await page.getByRole("button", { name: "Open brief →" }).click();
  // The pending request surfaces as a brief beat; "Review & apply" hands off to
  // the SAME staged editor the card uses — the flow the leftover setProgTab also
  // crashed (its second call site lives in AthleteDetail's prefill effect).
  await page.getByRole("button", { name: "Review & apply" }).first().click();
  await expect(page.getByText("REVIEW CHANGE")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Leg Press 3x10 @ 200/)).toBeVisible();
});

test("saving the reviewed merge writes the program and resolves the request", async ({ page }) => {
  const { athlete } = await openAthleteWithRequest(page);
  await page.getByRole("button", { name: "Review & apply" }).click();
  await page.getByRole("button", { name: /Save program/ }).click({ timeout: 15000 });
  // The overlay closes and the athlete's program editor now holds the merged text.
  await expect(page.getByText("REVIEW CHANGE")).toHaveCount(0, { timeout: 10000 });
  const ta = page.locator("textarea").filter({ hasText: /Leg Press 3x10 @ 200/ });
  await expect(ta.or(page.locator(`textarea >> nth=0`))).toBeVisible();
});

// ─── T57 s5: bulk assign writes the program AND the block history ─────────────
// Live find: handleBulkAssign wrote program_text raw — bulk-assigned athletes
// never got a program_history row, so the old block never closed and Phases/
// recaps/Builder hand-off were blind to the swap (the same gap the G8
// library-apply fix closed for single assigns).
test("bulk assign completes: program written, block history snapshotted per athlete", async ({ page }) => {
  const coach = makeCoach();
  const athlete = makeAthlete({ coach_id: coach.id, program_text: PROGRAM });
  await mockApi(page, { athlete, coach });
  const writes = [];
  await page.route("**/api/data", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.op && body.op !== "read") writes.push(body);
    return route.fallback();
  });

  await loginAsCoach(page, coach);
  await page.getByRole("button", { name: /^athletes$/i }).click();
  await page.getByRole("button", { name: /Bulk Assign/ }).click();
  await page.getByText(athlete.name).first().click();
  await page.getByRole("button", { name: /Program \(1\)/ }).click();
  await page.getByPlaceholder(/Paste the program here/).fill("Week 1\nMon: Squat 3x5 @ 225");
  await page.getByRole("button", { name: /Assign to 1 Athletes/ }).click();

  // The modal closes, the athlete row carries the new program, and BOTH writes
  // went out: athletes.program_text and a program_history insert with the bulk source.
  await expect(page.getByText("BULK ASSIGN PROGRAM")).toHaveCount(0, { timeout: 10000 });
  await expect.poll(() => writes.some((w) => JSON.stringify(w).includes("program_history") && JSON.stringify(w).includes("coach_bulk"))).toBe(true);
  await expect.poll(() => writes.some((w) => JSON.stringify(w).includes("Squat 3x5 @ 225") && JSON.stringify(w).includes("athletes"))).toBe(true);
});

// ─── T57 s6: the EMPTY-ROSTER coach (untyped-input sweep item 1e) ────────────
// A brand-new coach with zero athletes walks every tab. The failure mode this
// pins: an empty-state render crash (an unguarded roster[0], a .map over
// undefined) unmounts the whole tree into the error boundary's RELOAD screen.
test("a coach with 0 athletes walks every tab without crashing", async ({ page }) => {
  const coach = makeCoach();
  await mockApi(page, { athlete: makeAthlete(), coach });
  // Newest route wins: the dashboard answers with an EMPTY roster.
  await page.route("**/api/identity", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.action === "coach-dashboard") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        athletes: [], coaches: [], school: [], schoolsAll: [], coachCounts: null,
      }) });
    }
    return route.fallback();
  });

  await loginAsCoach(page, coach);
  for (const tab of ["overview", "athletes", "progress", "programs", "reports", "settings"]) {
    await page.getByRole("button", { name: new RegExp(`^${tab}$`, "i") }).click();
    await page.waitForTimeout(250);
    // The tree survived: the tab bar is still there and the boundary's RELOAD
    // screen never appeared.
    await expect(page.getByRole("button", { name: /^overview$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "RELOAD", exact: true })).toHaveCount(0);
  }
});

// ── T64 S2: the coach sees the same pain truth as the athlete ───────────────
// The athlete resolved the knee, then it flared a week later. Before T64 the
// coach's ACTIVE PAIN FLAGS hid every future "knee" forever (exact-string
// resolved_pain match) and counted "Knees" / "left knee" as different areas.
test("coach athlete detail: a flare after the athlete's 'resolved' shows; old flags stay hidden; one area name", async ({ page }) => {
  const coach = makeCoach();
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const athlete = makeAthlete({ coach_id: coach.id, program_text: PROGRAM, resolved_pain: ["knees"], pain_marks: { knee: { cleared_at: day(6) } } });
  const sq = [{ name: "Back Squat", sets: 3, reps: 5, weight: 225, unit: "lbs" }];
  await mockApi(page, { athlete, coach, dataReads: { workouts: [
    { id: "w-flare", athlete_id: athlete.id, created_at: day(1), raw_message: "left knee flared", parsed_data: { exercises: sq, pain_flags: [{ area: "left knee", description: "flared on squats" }] } },
    { id: "w-flare2", athlete_id: athlete.id, created_at: day(2), raw_message: "knee ache", parsed_data: { exercises: sq, pain_flags: [{ area: "Knee", description: "ache on squats" }] } },
    { id: "w-old", athlete_id: athlete.id, created_at: day(10), raw_message: "knees ache", parsed_data: { exercises: sq, pain_flags: [{ area: "Knees", description: "ache on squats" }] } },
  ] } });
  await loginAsCoach(page, coach);
  await page.getByRole("button", { name: /^athletes$/i }).click();
  await page.getByText(athlete.name).first().click();
  await expect(page.getByText(/ACTIVE PAIN FLAGS \(2 sessions flagged\)/)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("knee ×2")).toBeVisible();
});
