// The AI notice is the first section of the Privacy Policy text (Will, 09-29):
// on a 390x844 phone the Privacy step must show it with no scrolling, above the
// one checkbox that grants it. Signup stays 2 steps.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete } from "./mocks.js";

const NOTICE = "Your coach runs on Claude, an AI model made by Anthropic. To write your replies, programs and log entries, WILCO sends Anthropic your messages, workout logs, program, goals, injury notes and form-check video frames.";

test.use({ viewport: { width: 390, height: 844 } });

test("the Privacy step opens on the AI notice with no scrolling", async ({ page }) => {
  const athlete = makeAthlete({ tier: "free" });
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

  const scrollLegalToEnd = async () => {
    await page.waitForFunction(() => {
      const scrollers = [...document.querySelectorAll("div")]
        .filter(d => d.scrollHeight > d.clientHeight + 24 && getComputedStyle(d).overflowY === "auto");
      for (const d of scrollers) { d.scrollTop = d.scrollHeight; d.dispatchEvent(new Event("scroll")); }
      const box = document.querySelector('input[type="checkbox"]');
      return !!box && !box.disabled;
    });
  };
  await scrollLegalToEnd();
  await page.getByText("I have read and agree to the Terms & Conditions.").click();
  await page.getByRole("button", { name: "Continue →", exact: true }).click();

  await expect(page.getByText("STEP 2 OF 2")).toBeVisible();
  await expect(page.getByText("AI and Your Data", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByText(NOTICE, { exact: true })).toBeInViewport({ ratio: 1 });
  // No boxed lead-in block any more: the heading appears once, inside the policy.
  await expect(page.getByText("AI and Your Data", { exact: true })).toHaveCount(1);
  await page.screenshot({ path: process.env.AI_NOTICE_SHOT || "test-results/ai-notice-privacy-step.png" });
});
