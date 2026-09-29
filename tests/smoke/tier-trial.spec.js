// ─── W18-3: the 7-day trial + silent revert (Will's 08-20 ruling) ─────────────
// Every signup starts a 7-day trial. The FREE pick has no Stripe object — just a
// server-stamped athletes.trial_ends_at — and src/tiers.js effectiveTier presents
// that athlete as Pro until the clock lapses, then silently answers free again.
// These specs assert what the athlete SEES on each side of that line:
//   • inside the window: the full Pro surface (Quick Log, Program, My Log,
//     Progress) with no countdown anywhere outside the plan drawer
//   • after the window: those surfaces are simply gone, EXCEPT the workout log,
//     which stays visible read-only (free = read-only history, 08-19 ruling)
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";

const FUTURE = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

// Two logged sessions, a day apart, as the gateway returns them. Served to the
// MY LOG modal's self-load pager (the boot batch deliberately skips the workouts
// read for a free athlete, so the modal pages its own history in on open).
const workoutRows = () => {
  const d1 = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const d2 = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
  return [
    { id: "w-1", athlete_id: "11111111-1111-4111-8111-111111111111", created_at: d1, raw_message: "Bench 3x5 185", bot_reply: "Solid.", parsed_data: { exercises: [{ name: "Bench Press", sets: 3, reps: 5, weight: 185, unit: "lbs" }], session_feel: "good" } },
    { id: "w-2", athlete_id: "11111111-1111-4111-8111-111111111111", created_at: d2, raw_message: "Squat 3x5 225", bot_reply: "Strong.", parsed_data: { exercises: [{ name: "Back Squat", sets: 3, reps: 5, weight: 225, unit: "lbs" }], session_feel: "good" } },
  ];
};

const serveWorkouts = async (page, rows) => {
  await page.route("**/api/data", (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.op === "read" && String(body.table || "") === "workouts") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(rows) });
    }
    return route.fallback();
  });
};

test("inside the trial window a free-pick athlete gets the full Pro surface", async ({ page }) => {
  const athlete = makeAthlete({ tier: "free", trial_ends_at: FUTURE, total_sessions_logged: 0, program_text: null });
  await mockApi(page, { athlete });

  await loginAsAthlete(page, athlete);
  // Web parity (08-29): chat-first everywhere — the Pro surface is the three
  // tabs; the LOG button is dissolved into chat by design.
  await expect(page.getByRole("button", { name: "MY LOG" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "LOG", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PROGRESS" })).toBeVisible();
  // No countdown drama anywhere on the main surface (the plan drawer is the one
  // place the trial states itself).
  await expect(page.getByText(/trial ends|days left/i)).toHaveCount(0);
});

test("an expired trial reverts to chat-only: every tab gone, one Joe notice, once", async ({ page }) => {
  // Will 08-24 (supersedes the 08-19 read-only ruling): free after the trial
  // loses ALL tabs — history stays safe in the DB and returns on upgrade — and
  // Joe opens with a one-time line explaining the trial ended.
  const athlete = makeAthlete({ tier: "free", trial_ends_at: PAST, total_sessions_logged: 2, program_text: null });
  await mockApi(page, { athlete });
  await serveWorkouts(page, workoutRows());

  await loginAsAthlete(page, athlete);
  await expect(page.getByText("WILCO", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "LOG", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PROGRESS" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "MY LOG" })).toHaveCount(0);

  // The one-time notice from Joe names the trial and points at Settings.
  await expect(page.getByText(/Pro trial just wrapped up/)).toBeVisible({ timeout: 15000 });

  // Shown exactly once in the transcript, and the once-ever stamp is down so
  // no future boot appends it again (the restored transcript carries the line).
  await expect(page.getByText(/Pro trial just wrapped up/)).toHaveCount(1);
  const stamp = await page.evaluate((id) => localStorage.getItem(`wilco_trial_ended_${id}`), athlete.id);
  expect(stamp).toBe("1");
});

test("an expired trial with nothing logged shows the same chat-only surface", async ({ page }) => {
  const athlete = makeAthlete({ tier: "free", trial_ends_at: PAST, total_sessions_logged: 0, program_text: null });
  await mockApi(page, { athlete });

  await loginAsAthlete(page, athlete);
  await expect(page.getByText("WILCO", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "MY LOG" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "LOG", exact: true })).toHaveCount(0);
});

test("the plan step states the universal trial and the free card is honest about it", async ({ page }) => {
  const athlete = makeAthlete({ tier: "free", trial_ends_at: FUTURE });
  await mockApi(page, { athlete });

  await page.goto("/");
  await page.getByRole("button", { name: "New Athlete Sign Up" }).click();
  await page.getByPlaceholder("Your name").fill(athlete.name);
  await page.getByRole("button", { name: "Next →" }).click();
  await page.getByPlaceholder("----").first().fill("1234");
  await page.getByPlaceholder("----").nth(1).fill("1234");
  await page.getByPlaceholder("you@email.com").fill(athlete.email);
  await page.getByRole("button", { name: "Next →" }).click();
  await page.getByRole("button", { name: "Next →" }).click(); // goal
  await page.locator('input[type="date"]').fill("1995-03-14");
  await page.getByRole("button", { name: "Next →" }).click();
  await page.locator('input[min="3"][max="8"]').fill("5");
  await page.getByPlaceholder("e.g. 185").fill("180");
  await page.getByRole("button", { name: "Next →" }).click();
  await page.getByText("Male", { exact: true }).click();
  await page.getByRole("button", { name: "Next →" }).click();
  await page.getByRole("button", { name: "Next →" }).click(); // training days
  await page.getByText("Full gym", { exact: true }).click();
  await page.getByRole("button", { name: "Next →" }).click();
  await page.getByRole("button", { name: "Next →" }).click(); // injuries (optional)

  // Consent (adult): scroll-gated agree boxes, Terms then Privacy.
  const scrollLegalToEnd = async () => {
    await page.waitForFunction(() => {
      const scrollers = [...document.querySelectorAll("div")]
        .filter(d => d.scrollHeight > d.clientHeight + 24 && getComputedStyle(d).overflowY === "auto");
      for (const d of scrollers) { d.scrollTop = d.scrollHeight; d.dispatchEvent(new Event("scroll")); }
      const box = document.querySelector('input[type="checkbox"]');
      return !!box && !box.disabled;
    });
  };
  await expect(page.getByText("Terms of Service & Liability Waiver")).toBeVisible();
  await scrollLegalToEnd();
  await page.getByText("I have read and agree to the Terms & Conditions.").click();
  await page.getByRole("button", { name: "Continue →", exact: true }).click();
  await expect(page.getByText("I agree to the Privacy Policy and allow WILCO to send my training data to Anthropic to power my coaching.")).toBeVisible();
  await scrollLegalToEnd();
  await page.getByText("I agree to the Privacy Policy and allow WILCO to send my training data to Anthropic to power my coaching.").click();
  await page.getByRole("button", { name: "Create Account", exact: true }).click();

  // ── The plan step: every plan starts with the 7-day trial, stated plainly ──
  await expect(page.getByText("Every plan starts with a 7-day free trial")).toBeVisible();
  await expect(page.getByText("Starts with 7 days of Pro, no card needed")).toBeVisible();
  await expect(page.getByText("First 7 days free").first()).toBeVisible();

  // Free pick lands in the app WITH the Pro surface live (trial from creation).
  await page.getByRole("button", { name: "Start with Free →" }).click();
  await expect(page.getByRole("button", { name: "MY LOG" })).toBeVisible({ timeout: 15000 });
});
