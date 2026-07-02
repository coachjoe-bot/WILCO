// Smoke: PWA "Add to Home Screen" install prompt (InstallPrompt in App.jsx).
//
// Covers the manual entry point (Settings -> "Install the App on Your Phone")
// on both a plain desktop UA (fallback box) and a real iOS Safari UA (3-step
// instructions), plus the auto-show-after-signup + dismissal-persistence path
// on iOS Safari, which requires walking the full free-tier signup wizard.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";

// A real iPhone Safari UA (not CriOS/FxiOS/a webview) — the only UA shape for
// which App.jsx's isIOSSafari() is true.
const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

test.describe("manual install entry — desktop UA", () => {
  test("Settings -> Install the App shows the desktop fallback, and Close doesn't persist dismissal", async ({ page }) => {
    const athlete = makeAthlete();
    await mockApi(page, { athlete });

    await loginAsAthlete(page, athlete);

    await page.getByTitle("Settings").click();
    await expect(page.getByText("SETTINGS", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Install the App on Your Phone" }).click();

    // Overlay heading + desktop fallback copy (no beforeinstallprompt captured
    // under vite dev / Playwright chromium, and this UA isn't iOS Safari).
    await expect(page.getByText("PUT WILCO ON YOUR HOME SCREEN")).toBeVisible();
    await expect(page.getByText("Open app.trainwilco.com on your phone to install it there.")).toBeVisible();

    // Manual mode -> "Close", not "Maybe later".
    const closeBtn = page.getByRole("button", { name: "Close", exact: true });
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();

    await expect(page.getByText("PUT WILCO ON YOUR HOME SCREEN")).toBeHidden();

    // Manual close never writes the dismissal key — only the auto prompt does.
    const dismissed = await page.evaluate(() => localStorage.getItem("wilco_install_dismissed"));
    expect(dismissed).toBeNull();
  });
});

test.describe("manual install entry — iOS Safari UA", () => {
  test.use({ userAgent: IOS_SAFARI_UA });

  test("Settings -> Install the App shows the 3-step iOS instructions", async ({ page }) => {
    const athlete = makeAthlete();
    await mockApi(page, { athlete });

    await loginAsAthlete(page, athlete);

    await page.getByTitle("Settings").click();
    await expect(page.getByText("SETTINGS", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Install the App on Your Phone" }).click();

    await expect(page.getByText("PUT WILCO ON YOUR HOME SCREEN")).toBeVisible();

    // The 3 numbered steps, including the literal "Add to Home Screen" text
    // (step 2) and the Share/Add steps that bracket it.
    await expect(page.getByText(/Tap the.*Share button/)).toBeVisible();
    await expect(page.getByText("Add to Home Screen", { exact: true })).toBeVisible();
    await expect(page.getByText(/Tap.*Add in the top corner/)).toBeVisible();

    const closeBtn = page.getByRole("button", { name: "Close", exact: true });
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(page.getByText("PUT WILCO ON YOUR HOME SCREEN")).toBeHidden();
  });
});

test.describe("auto-show after signup + dismissal persistence — iOS Safari UA", () => {
  test.use({ userAgent: IOS_SAFARI_UA });

  test("free-tier signup auto-shows the prompt once, Maybe later persists dismissal, and the manual entry still works after", async ({ page }) => {
    const athlete = makeAthlete({ tier: "free" });
    await mockApi(page, { athlete });

    await page.goto("/");
    await page.getByRole("button", { name: "New Athlete Sign Up" }).click();

    // ── Step 1: name / sport / level ("Just training for myself" is default) ──
    await expect(page.getByText("NEW ATHLETE")).toBeVisible();
    await page.getByPlaceholder("Your name").fill(athlete.name);
    await page.getByRole("button", { name: "Next →" }).click();

    // ── Step 2: PIN + confirm PIN + email ──
    await page.getByPlaceholder("----").first().fill("1234");
    await page.getByPlaceholder("----").nth(1).fill("1234");
    await page.getByPlaceholder("you@email.com").fill(athlete.email);
    await page.getByRole("button", { name: "Next →" }).click();

    // ── Step 3: goal (default "Get Stronger" selected) ──
    await page.getByRole("button", { name: "Next →" }).click();

    // "Just training for myself" skips team code (step 4) straight to step 5.

    // ── Step 5: birthday (must be 18+ to skip the parental-consent gate) ──
    await page.locator('input[type="date"]').fill("1995-03-14");
    await page.getByRole("button", { name: "Next →" }).click();

    // ── Step 6: height + weight ──
    await page.getByPlaceholder("5", { exact: true }).fill("5");
    await page.getByPlaceholder("e.g. 185").fill("180");
    await page.getByRole("button", { name: "Next →" }).click();

    // ── Step 7: gender ──
    await page.getByText("Male", { exact: true }).click();
    await page.getByRole("button", { name: "Next →" }).click();

    // ── Step 8: training days/week ──
    await page.getByRole("button", { name: "Next →" }).click();

    // ── Step 9: equipment (must pick at least one) ──
    await page.getByText("Full gym", { exact: true }).click();
    await page.getByRole("button", { name: "Next →" }).click();

    // "Just training for myself" skips position/event (step 10, competitive only).

    // ── Step 11: injury history (optional) -> proceeds straight to consent ──
    await page.getByRole("button", { name: "Save & Continue →" }).click();

    // ── Consent: adult (18+) -> Terms then Privacy, no parental gate ──
    await expect(page.getByText("Terms of Service & Liability Waiver")).toBeVisible();
    await page.getByText("I have read and agree to the Terms & Conditions.").click();
    await page.getByRole("button", { name: "Continue →", exact: true }).click();

    await expect(page.getByText("I have read and agree to the Privacy Policy.")).toBeVisible();
    await page.getByText("I have read and agree to the Privacy Policy.").click();
    await page.getByRole("button", { name: "Create Account", exact: true }).click();

    // ── Plan selection: choose Free -> finishes onboarding straight into the app ──
    await expect(page.getByText("Choose your plan.")).toBeVisible();
    await page.getByRole("button", { name: "Start with Free →" }).click();

    // Landed in the app.
    await page.getByText("COACH JOE-BOT").waitFor();

    // Install prompt auto-shows once, post-signup, on an iOS Safari UA.
    await expect(page.getByText("PUT WILCO ON YOUR HOME SCREEN")).toBeVisible();
    // Auto mode -> "Maybe later", not "Close".
    const maybeLaterBtn = page.getByRole("button", { name: "Maybe later", exact: true });
    await expect(maybeLaterBtn).toBeVisible();
    await maybeLaterBtn.click();
    await expect(page.getByText("PUT WILCO ON YOUR HOME SCREEN")).toBeHidden();

    // Dismissing the AUTO prompt persists the dismissal key.
    const dismissed = await page.evaluate(() => localStorage.getItem("wilco_install_dismissed"));
    expect(dismissed).toBe("1");

    // The manual Settings entry point still works after dismissal (dismissal
    // only suppresses the auto-show, never the persistent manual entry).
    await page.getByTitle("Settings").click();
    await expect(page.getByText("SETTINGS", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Install the App on Your Phone" }).click();
    await expect(page.getByText("PUT WILCO ON YOUR HOME SCREEN")).toBeVisible();
  });
});
