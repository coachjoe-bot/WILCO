// ─── T56: the gym-truth suite ─────────────────────────────────────────────────
// Every code-level gate was green on 08-18 while three athlete-visible flows
// were broken on a phone (Will's gym session). These specs assert what the
// athlete actually SEES — the today's-session opener, the zero-tap lock-screen
// pin, and the WORKOUT #N stamp — so "tests pass" and "works in the gym" stop
// being different claims.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete, pushupParse } from "./mocks.js";

const PROGRAM = "Day 1 - Push\nBench Press 3x5 @ 185\nDips 3x8\n\nDay 2 - Pull\nRow 3x8 @ 135";
const DRAFT = "Day 1 - Push\nBench Press 3x5 @ 185\nDips 3x8";

// Route the AI proxy per-feature on top of mockApi (newest route wins).
const aiByFeature = async (page, map) => {
  // Web parity 08-29: chat bills as mastermind_chat everywhere now — a spec
  // keyed on the legacy joebot_chat serves the mastermind feature too.
  await page.route("**/api/claude", (route) => {
    const body = route.request().postDataJSON() || {};
    const key = body.feature === "mastermind_chat" && !("mastermind_chat" in map) && ("joebot_chat" in map) ? "joebot_chat" : body.feature;
    if (!(key in map)) return route.fallback(); // mockApi serves parse/chat correctly
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: map[key] }], usage: {} }) });
  });
};

test("a programmed athlete opens INTO today's session, not a generic greeting", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete });
  await aiByFeature(page, { quick_log_draft: DRAFT });

  await loginAsAthlete(page, athlete);
  await expect(page.getByText(/Here's today/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Bench Press 3x5/)).toBeVisible();
  await expect(page.getByText(/what have you been up to/i)).toHaveCount(0);
});

test("a REST_DAY draft says rest day — never the generic greeting", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete });
  await aiByFeature(page, { quick_log_draft: "REST_DAY" });

  await loginAsAthlete(page, athlete);
  await expect(page.getByText(/Rest day on your block/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/what have you been up to/i)).toHaveCount(0);
});

test("logging a workout stamps WORKOUT #N with the athlete's real number", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 4 }); // no program → plain greeting path
  await mockApi(page, { athlete, parseResult: pushupParse });
  // The stamp's number comes from the session-count view — serve the truth.
  await page.route("**/api/data", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.op === "read" && String(body.table || body.params || "").includes("v_athlete_session_counts")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify([{ session_count: 5 }]) });
    }
    return route.fallback();
  });

  await loginAsAthlete(page, athlete);
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("Push-ups 3x20, felt good");
  await page.getByRole("button", { name: "→", exact: true }).click();

  await expect(page.locator(".stamp", { hasText: "WORKOUT" })).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".stamp")).toContainText("#5");
});

test("web parity (Will 08-29): a lock-screen ask NEVER posts a web notification, even fully granted", async ({ page, context }) => {
  // Notifications are the one deliberate platform difference: native-only.
  // Grant everything and stub a live SW anyway — the point is that web still
  // refuses to touch the notification surface.
  await context.grantPermissions(["notifications"]);
  await page.addInitScript(() => {
    try { Object.defineProperty(Notification, "permission", { get: () => "granted" }); } catch (_) {}
    try {
      Object.defineProperty(navigator.serviceWorker, "ready", {
        get: () => Promise.resolve({ showNotification: async (t, o) => { window.__cardPosted = { t, o }; } }),
      });
    } catch (_) {}
  });
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete });
  await aiByFeature(page, { quick_log_draft: DRAFT, joebot_chat: "You got it." });

  await loginAsAthlete(page, athlete);
  await expect(page.getByText(/Here's today/)).toBeVisible({ timeout: 15000 });

  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("can you put my program on my home screen?");
  await page.getByRole("button", { name: "→", exact: true }).click();

  // Joe still answers; no permission chip, no app pin line, no notification.
  await expect(page.getByText("You got it.")).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: /Put it on my lock screen/ })).toHaveCount(0);
  await expect(page.getByText(/on your lock screen\. It clears itself/)).toHaveCount(0);
  await expect(page.evaluate(() => !!window.__cardPosted)).resolves.toBeFalsy();
});

// ─── Opener answer buttons (Will 08-29: big in-bubble, not floating chips) ───
// The opener ends on the exercise body; the bubble carries three bold buttons.
// YES pins the session card zero-tap (granted), NO opens the door, and
// "different workout" makes the next message pick the session that lands in
// Quick Log AND on the lock screen.

const grantCardStubs = async (page, context) => {
  await context.grantPermissions(["notifications"]);
  await page.addInitScript(() => {
    try { Object.defineProperty(Notification, "permission", { get: () => "granted" }); } catch (_) {}
    try {
      Object.defineProperty(navigator.serviceWorker, "ready", {
        get: () => Promise.resolve({ showNotification: async (t, o) => { window.__cardPosted = { t, o }; } }),
      });
    } catch (_) {}
  });
};

test("the opener bubble carries the three big answer buttons", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete });
  await aiByFeature(page, { quick_log_draft: DRAFT });

  await loginAsAthlete(page, athlete);
  await expect(page.getByRole("button", { name: "Start Workout" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Starting this workout now\?/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Not Now" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Different Workout" })).toBeVisible();
});

test("opener YES on web: the workout bar comes up, no notification ever (parity 08-29)", async ({ page, context }) => {
  await grantCardStubs(page, context);
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete });
  await aiByFeature(page, { quick_log_draft: DRAFT });

  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "Start Workout" }).click();

  // Web has no lock screen to pin: the session lives on the in-chat bar.
  await expect(page.getByText(/Log it here when you're done/)).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: "Start Workout" })).toHaveCount(0);
  await expect(page.getByText("Day 1 - Push", { exact: true }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.evaluate(() => !!window.__cardPosted)).resolves.toBeFalsy();
});

test("opener NO answers with the open door and retires the chips", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete });
  await aiByFeature(page, { quick_log_draft: DRAFT });

  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "Not Now" }).click();
  await expect(page.getByText(/I'm here when you need me/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Not Now" })).toHaveCount(0);
  await expect(page.evaluate(() => !!window.__cardPosted)).resolves.toBeFalsy();
});

test("opener DIFFERENT WORKOUT: the next message picks the session, Quick Log + card follow", async ({ page, context }) => {
  await grantCardStubs(page, context);
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete });
  await aiByFeature(page, { quick_log_draft: DRAFT, joebot_chat: "Day 2 it is." });

  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "Different Workout" }).click();
  await expect(page.getByText(/Which one are you running\?/)).toBeVisible({ timeout: 15000 });

  // The which-one answer regenerates the draft — serve day 2 from here on
  // (newest route wins over the login-time draft mock).
  await aiByFeature(page, { quick_log_draft: "Day 2 - Pull\nRow 3x8 @ 135", joebot_chat: "Day 2 it is." });
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("I'm doing day 2 today");
  await page.getByRole("button", { name: "→", exact: true }).click();

  await expect(page.getByText(/Swapped/)).toBeVisible({ timeout: 20000 });
  // Web parity (08-29): the swapped session lands on the in-chat workout bar,
  // never on a notification.
  await expect(page.getByText("Day 2 - Pull", { exact: true }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.evaluate(() => !!window.__cardPosted)).resolves.toBeFalsy();
});

// ─── T57-B: recovery-email banner for name-only accounts ──────────────────────
// 29 of 53 real athletes signed up before email was required and can never
// PIN-recover. The banner is a slim ask, never a gate: Save writes the address
// (gateway-allowlisted + format-guarded) and fires the welcome email; Later
// snoozes a week.
test("T62: asking what's today mid-chat brings the Start buttons back with the programming", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete });
  await aiByFeature(page, { quick_log_draft: DRAFT, joebot_chat: "Day 1 - Push. Bench Press 3x5 @ 185, then Dips 3x8." });
  await loginAsAthlete(page, athlete);
  // Answer the opener's own buttons away first (Not Now = no bar, no card)...
  await page.getByRole("button", { name: "Not Now" }).click({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Start Workout" })).toHaveCount(0);
  // ...then the mid-chat inquiry re-earns them (Will's standing rule): the
  // programming in Joe's reply, the same three buttons underneath.
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("what am I doing today?");
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start Workout" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Different Workout" })).toBeVisible();
});

test("T62: leaked tool names never render in a chat bubble", async ({ page }) => {
  const athlete = makeAthlete({ program_text: PROGRAM });
  await mockApi(page, { athlete });
  await aiByFeature(page, { quick_log_draft: DRAFT, joebot_chat: "prefill_log_sheet, pin_session_card\nSolid session. Numbers are moving." });
  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "Not Now" }).click({ timeout: 15000 });
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("how are we looking this week?");
  await page.getByRole("button", { name: "→", exact: true }).click();
  await expect(page.getByText("Solid session. Numbers are moving.")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/prefill_log_sheet|pin_session_card/)).toHaveCount(0);
});

test("a name-only athlete gets the recovery-email banner; Save writes the address", async ({ page }) => {
  const athlete = makeAthlete({ email: null });
  await mockApi(page, { athlete });
  const writes = [];
  await page.route("**/api/data", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.op && body.op !== "read") writes.push(body);
    return route.fallback();
  });
  await page.route("**/api/send-athlete-welcome", (route) => {
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await loginAsAthlete(page, athlete);
  await expect(page.getByText(/Add a recovery email/)).toBeVisible({ timeout: 15000 });
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled(); // no address typed yet
  await page.getByPlaceholder("you@example.com").fill("marcus@example.com");
  await save.click();
  await expect(page.getByText(/We just sent you a confirmation/)).toBeVisible({ timeout: 10000 });
  await expect.poll(() => writes.some((w) => JSON.stringify(w).includes("marcus@example.com") && JSON.stringify(w).includes("athletes"))).toBe(true);
});

test("Later snoozes the email banner for a week (stamped, not just hidden)", async ({ page }) => {
  const athlete = makeAthlete({ email: null });
  await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);
  await expect(page.getByText(/Add a recovery email/)).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Later" }).click();
  await expect(page.getByText(/Add a recovery email/)).toHaveCount(0);
  // The snooze is a persisted timestamp — the next open inside the week reads it
  // and never re-raises (the show effect gates on this exact key).
  const stamp = await page.evaluate((id) => localStorage.getItem(`wilco_email_prompt_${id}`), athlete.id);
  expect(Number(stamp)).toBeGreaterThan(Date.now() - 60_000);
});

test("an athlete WITH an email never sees the banner", async ({ page }) => {
  const athlete = makeAthlete(); // mocks default carries an email
  await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);
  await expect(page.getByPlaceholder(/Tell Coach Joe/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Add a recovery email/)).toHaveCount(0);
});

// ── T64 S2: MY LOG uses the pain ledger's dated resolve ─────────────────────
// Resolved, then a flare a week later: the old flag stays hidden, the flare
// shows, and "resolved" writes BOTH the legacy array and a dated pain_marks
// stamp (two writes, so a gateway that doesn't know pain_marks can't sink the
// legacy one).
test("MY LOG: a flare after 'resolved' shows again; resolving writes resolved_pain + pain_marks", async ({ page }) => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const athlete = makeAthlete({ total_sessions_logged: 2, resolved_pain: ["knee"], pain_marks: { knee: { cleared_at: day(6) } } });
  const sq = [{ name: "Back Squat", sets: 3, reps: 5, weight: 225, unit: "lbs" }];
  const { calls } = await mockApi(page, { athlete, dataReads: { workouts: [
    { id: "w-flare", athlete_id: athlete.id, created_at: day(1), raw_message: "squats, left knee flared", parsed_data: { exercises: sq, pain_flags: [{ area: "left knee", description: "flared on squats" }] } },
    { id: "w-old", athlete_id: athlete.id, created_at: day(10), raw_message: "squats, knee ache", parsed_data: { exercises: sq, pain_flags: [{ area: "Knees", description: "ache on squats" }] } },
  ] } });
  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "MY LOG" }).click();
  await expect(page.getByText("MY WORKOUT LOG")).toBeVisible();
  await expect(page.getByText("⚠ left knee")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("⚠ Knees")).toHaveCount(0);
  await page.getByRole("button", { name: /resolved/ }).first().click();
  await expect(page.getByText("⚠ left knee")).toHaveCount(0);
  const marksWrite = () => calls.find((c) => c.body?.op === "update" && c.body?.table === "athletes" && c.body?.data?.pain_marks);
  await expect.poll(() => !!marksWrite(), { timeout: 10000 }).toBe(true);
  const legacy = calls.find((c) => c.body?.op === "update" && c.body?.table === "athletes" && Array.isArray(c.body?.data?.resolved_pain));
  expect(legacy).toBeTruthy();
  expect(marksWrite().body.data.pain_marks.knee.cleared_at).toBeTruthy();
  expect(marksWrite().body.data.resolved_pain).toBeUndefined(); // separate write
});
