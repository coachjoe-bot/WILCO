// Smoke: the app boots — login surface renders, zero console errors.
import { test, expect } from "@playwright/test";
import { mockApi } from "./mocks.js";

test("app boots to the home/login screen with no console errors", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await mockApi(page);
  await page.goto("/");

  // Brand line + all three entry points of the home screen. (Since 188569c the
  // athlete-entry WILCO wordmark lives in the storefront backdrop photo, not a
  // text node — only coach entry renders the text wordmark.)
  await expect(page.getByText("COACH JOE-BOT", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Athlete Login" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Athlete Sign Up" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Coach Login" })).toBeVisible();

  // Let async boot work (tracking install, font/manifest fetches) settle,
  // then assert the console stayed clean.
  await page.waitForLoadState("networkidle");
  expect(consoleErrors, `Console errors on boot:\n${consoleErrors.join("\n")}`).toEqual([]);
});
