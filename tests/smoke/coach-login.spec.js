// Coach login takes a name or email plus the PIN, the same as the athlete screen.
// The old PIN-only screen tried one guess against every coach; the server now
// compares the PIN only against the row the name or email picked.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, makeCoach, loginAsCoach } from "./mocks.js";

const FIELD = "Your name, or the email you signed up with";

async function openCoachLogin(page, coach) {
  await mockApi(page, { athlete: makeAthlete(), coach });
  await page.goto("/");
  await page.getByRole("button", { name: "Coach Login" }).click();
}

test("the coach screen asks for a name or email above the PIN", async ({ page }) => {
  await openCoachLogin(page, makeCoach());
  await expect(page.getByText("NAME OR EMAIL")).toBeVisible();
  await expect(page.getByPlaceholder(FIELD)).toBeVisible();
  await expect(page.getByText("COACH PIN")).toBeVisible();
  await expect(page.getByRole("button", { name: "First time? Enter access code" })).toBeVisible();
  await page.getByRole("button", { name: "Access Dashboard ->" }).click();
  await expect(page.getByText("Enter your name and 4-digit PIN.")).toBeVisible();
});

test("wrong PIN and unknown name each get their own message", async ({ page }) => {
  const coach = makeCoach();
  await openCoachLogin(page, coach);
  await page.getByPlaceholder(FIELD).fill(coach.name);
  await page.getByPlaceholder("----").fill("0000");
  await page.getByRole("button", { name: "Access Dashboard ->" }).click();
  await expect(page.getByText("Wrong PIN. Try again.")).toBeVisible();

  await page.getByPlaceholder(FIELD).fill("Somebody Else");
  await page.getByPlaceholder("----").fill("9999");
  await page.getByRole("button", { name: "Access Dashboard ->" }).click();
  await expect(page.getByText(/couldn't find that coach account/)).toBeVisible();
});

test("email works as the identifier and the request carries name and PIN", async ({ page }) => {
  const coach = makeCoach();
  const { calls } = await mockApi(page, { athlete: makeAthlete(), coach });
  await page.goto("/");
  await page.getByRole("button", { name: "Coach Login" }).click();
  await page.getByPlaceholder(FIELD).fill(coach.email.toUpperCase());
  await page.getByPlaceholder("----").fill("9999");
  await page.getByRole("button", { name: "Access Dashboard ->" }).click();
  await page.getByText("WILCO COACH").waitFor();
  const sent = calls.filter((c) => c.body && c.body.action === "coach-login");
  expect(sent.length).toBe(1);
  expect(sent[0].body.name).toBe(coach.email.toUpperCase());
  expect(sent[0].body.pin).toBe("9999");
  expect(sent[0].body.coachId).toBeUndefined();
});

test("the helper signs a coach in by name", async ({ page }) => {
  const coach = makeCoach();
  await mockApi(page, { athlete: makeAthlete(), coach });
  await loginAsCoach(page, coach);
});
