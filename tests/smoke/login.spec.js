// Smoke: athlete login (mocked /api/identity) lands on the main chat screen.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";

test("athlete login lands on the Coach Joe-Bot main screen", async ({ page }) => {
  const athlete = makeAthlete(); // pro tier
  await mockApi(page, { athlete });

  await loginAsAthlete(page, athlete);

  // Header identity: coach bot title, athlete name, tier badge.
  await expect(page.getByText("COACH JOE-BOT")).toBeVisible();
  await expect(page.getByText(athlete.name, { exact: true })).toBeVisible();
  await expect(page.getByText("PRO", { exact: true })).toBeVisible();

  // Boot finished: greeting bubble for a pro athlete with no logged workouts.
  await expect(page.getByText(/Tell me about your first workout/)).toBeVisible();

  // Chat input is live.
  await expect(page.getByPlaceholder(/Tell Coach Joe about your workout/)).toBeEnabled();

  // Pro-tier nav (would be absent if the tier/session plumbing broke).
  await expect(page.getByRole("button", { name: "MY LOG" })).toBeVisible();
});

test("wrong PIN shows the error and stays on the login form", async ({ page }) => {
  const athlete = makeAthlete();
  await mockApi(page, { athlete });

  await page.goto("/");
  await page.getByRole("button", { name: "Athlete Login" }).click();
  await page.getByPlaceholder("Exact name you signed up with").fill(athlete.name);
  await page.getByPlaceholder("----").fill("9999"); // mock verifies pin === "1234"
  await page.getByRole("button", { name: "Let's Get to Work ->" }).click();

  await expect(page.getByText("Wrong PIN. Try again.")).toBeVisible();
  await expect(page.getByText("ATHLETE LOGIN")).toBeVisible(); // still on the form
});
