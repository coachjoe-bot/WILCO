// ─── Comped accounts: never ask them to pay (Will, 2026-09-29) ────────────────
// "Every account up till now should be free. Never ask to charge them or anyone
// I give a 100% discount to." A comped account keeps exactly the tier and
// features it has; what changes is that the app stops ASKING. These specs run
// the same lapsed-trial free athlete twice, comped and not, and assert the
// locked-feature message, the trial-ended notice and the Settings drawer.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";

const PAST = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
const lapsed = (over = {}) => makeAthlete({ tier: "free", trial_ends_at: PAST, total_sessions_logged: 2, program_text: null, ...over });

const askAboutLog = async (page) => {
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill("show me my log");
  await page.getByRole("button", { name: "→", exact: true }).click();
};

test("comped + free: tapping a locked feature is a plain statement, no upgrade ask", async ({ page }) => {
  const athlete = lapsed({ comped: true });
  await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);
  await expect(page.getByText("WILCO", { exact: true })).toBeVisible({ timeout: 15000 });

  // Still locked: the tier is untouched, the tabs are still gone.
  await expect(page.getByRole("button", { name: "MY LOG" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PROGRESS" })).toHaveCount(0);

  await askAboutLog(page);
  await expect(page.getByText(/isn't part of your current plan/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/upgrade|Pro is one tap|subscribe/i)).toHaveCount(0);
  // No trial-ended notice either (it ends in an ask), and no once-ever stamp burned.
  await expect(page.getByText(/Pro trial just wrapped up/)).toHaveCount(0);
});

test("NOT comped + free: the same tap still gets the upgrade ask (nothing else changed)", async ({ page }) => {
  const athlete = lapsed({ comped: false });
  await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);
  await expect(page.getByText(/Pro trial just wrapped up/)).toBeVisible({ timeout: 15000 });

  await askAboutLog(page);
  await expect(page.getByText(/upgrade in Settings and it's all back/)).toBeVisible({ timeout: 15000 });
});

test("comped: the Your Plan drawer opens and pushes nothing", async ({ page }) => {
  const athlete = lapsed({ comped: true });
  await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);
  await expect(page.getByText("WILCO", { exact: true })).toBeVisible({ timeout: 15000 });

  await page.getByTitle("Settings").click();
  await expect(page.getByText("SETTINGS", { exact: true })).toBeVisible();
  // The coach line and the drawer subtitle carry no ask.
  await expect(page.getByText(/Upgrade to Pro for weekly progress reports/)).toHaveCount(0);
  await page.getByRole("button", { name: /YOUR PLAN/ }).click();

  await expect(page.getByText("Your account is on the house. Nothing is owed, now or later.")).toBeVisible();
  // No prices, no annual-savings hook, no subscribe button, no trial card, no picker.
  await expect(page.getByText(/\$14\.99|\$99|\$1,000|SAVE UP TO/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Subscribe to|Switch to/ })).toHaveCount(0);
  await expect(page.getByText(/Pick a plan below|first payment|first charge/)).toHaveCount(0);
  await expect(page.getByText("MONTHLY", { exact: true })).toHaveCount(0);
});

test("NOT comped: the drawer still shows the plan picker with prices", async ({ page }) => {
  const athlete = lapsed({ comped: false });
  await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);
  await expect(page.getByText("WILCO", { exact: true })).toBeVisible({ timeout: 15000 });

  await page.getByTitle("Settings").click();
  await expect(page.getByText(/Upgrade to Pro for weekly progress reports/)).toBeVisible();
  await page.getByRole("button", { name: /YOUR PLAN/ }).click();
  await expect(page.getByText("$14.99/mo")).toBeVisible();
  await expect(page.getByText("Your account is on the house. Nothing is owed, now or later.")).toHaveCount(0);
});
