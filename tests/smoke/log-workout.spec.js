// Smoke: log a workout — type a workout sentence, submit, coach reply + saved
// confirmation appear, and the workout write actually hits the data gateway.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete, pushupParse, emptyParse } from "./mocks.js";

test("logging a workout replies, confirms the save, and writes to the gateway", async ({ page }) => {
  const athlete = makeAthlete(); // pro: workouts persist (free tier skips the insert)
  const reply = "Push-ups banked. Three sets of twenty is honest work.";
  const { calls } = await mockApi(page, { athlete, parseResult: pushupParse, chatReply: reply });

  await loginAsAthlete(page, athlete);
  await expect(page.getByText(/Tell me about your first workout/)).toBeVisible();

  const workoutMsg = "Push-ups 3x20, felt good";
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill(workoutMsg);
  await page.getByRole("button", { name: "→", exact: true }).click();

  // The user bubble and the coach's reply round-trip through the mocked AI proxy.
  await expect(page.getByText(workoutMsg)).toBeVisible();
  await expect(page.getByText(reply)).toBeVisible();

  // No separate save-badge assertion: the header ✓ was removed on purpose
  // (silent save + haptic), the WORKOUT #N stamp self-clears in ~2.6s, and the
  // header counter reads the server session-count view, which the mock pins at
  // its fixture value. The coach reply above plus the gateway insert below are
  // the save confirmation.

  // And the persistence call itself: an op:"insert" into `workouts` carrying the
  // raw message and the parsed exercises.
  await expect
    .poll(() => calls.some((c) =>
      c.url.endsWith("/api/data") &&
      c.body?.op === "insert" &&
      c.body?.table === "workouts" &&
      c.body?.data?.raw_message === workoutMsg &&
      c.body?.data?.parsed_data?.exercises?.[0]?.name === "Push-Up"
    ))
    .toBe(true);
});

// T64 S7: a declared actual max ("current snatch max is 102, new PR") parses to
// pr_attempts with NO other exercises and — the actual incident shape — no "unit"
// on the attempt (the old schema had no such field, so the model never returned
// one) AND no unit word anywhere in the raw message (so the deterministic
// message-text backstop finds nothing either — this message deliberately avoids
// "kg"/"lbs" so the test isolates the DEEPER fallback: the athlete's weight_unit
// setting). Before the fix, finalizeWorkout defaulted a missing unit to lbs
// unconditionally, so a kg athlete's declared max landed in manual_one_rms as
// 102 LBS (46.3 kg) instead of 102 kg. Mocked at the gateway (no live AI) so the
// regression is caught on every run, not just the live pass.
test("a declared max with NO unit anywhere resolves to the kg athlete's own weight_unit setting, never defaults to lbs", async ({ page }) => {
  const athlete = makeAthlete({ weight_unit: "kg" });
  const reply = "102 for a single, that's a new PR.";
  const parseResult = { ...emptyParse, pr_attempts: [{ exercise: "Snatch", weight: 102, unit: null, reps: 1, achieved: true }] };
  const { calls } = await mockApi(page, { athlete, parseResult, chatReply: reply });

  await loginAsAthlete(page, athlete);
  await expect(page.getByText(/Tell me about your first workout/)).toBeVisible();

  const workoutMsg = "Current snatch max is 102, new PR";
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill(workoutMsg);
  await page.getByRole("button", { name: "→", exact: true }).click();

  await expect(page.getByText(workoutMsg)).toBeVisible();
  await expect(page.getByText(reply)).toBeVisible();

  // manual_one_rms gets the raw pair (102, kg) exactly as stated — never converted,
  // never silently relabeled lbs (the old default).
  await expect
    .poll(() => calls.some((c) =>
      c.url.endsWith("/api/data") &&
      c.body?.op === "insert" &&
      c.body?.table === "manual_one_rms" &&
      c.body?.data?.exercise === "Snatch" &&
      Number(c.body?.data?.weight) === 102 &&
      c.body?.data?.unit === "kg"
    ))
    .toBe(true);
  // And the old-default failure mode never fires: no manual_one_rms write for this
  // exercise ever carries unit "lbs".
  expect(calls.some((c) =>
    c.url.endsWith("/api/data") &&
    c.body?.op === "insert" &&
    c.body?.table === "manual_one_rms" &&
    c.body?.data?.exercise === "Snatch" &&
    c.body?.data?.unit === "lbs"
  )).toBe(false);
});
