// Smoke: checkout surface — the upgrade flow reaches the payment step, shows its
// loading state, and when Stripe.js is blocked (ad-blocker simulation via an
// aborted js.stripe.com route) shows the VISIBLE failure message + Retry button
// instead of a silent dead form. This exercises the fix from b3901c9.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";

test("upgrade payment step renders, and a blocked Stripe.js shows the failure state with Retry", async ({ page }) => {
  const athlete = makeAthlete({ tier: "free", stripe_subscription_id: null });
  const { calls } = await mockApi(page, {
    athlete,
    blockStripeJs: true,
    subscriptionDelayMs: 800, // make "Loading secure checkout…" reliably observable
  });

  await loginAsAthlete(page, athlete);

  // Settings -> pick PRO -> confirm with PIN -> Subscribe.
  await page.getByTitle("Settings").click();
  await expect(page.getByText("SETTINGS", { exact: true })).toBeVisible();
  await page.getByText("PRO", { exact: true }).click();
  await page.getByPlaceholder("Enter PIN to confirm").fill("1234");
  await page.getByRole("button", { name: "Subscribe to PRO →" }).click();

  // Payment step loading state while /api/create-subscription is in flight.
  await expect(page.getByText("Loading secure checkout…").first()).toBeVisible();

  // Stripe.js is blocked -> after the client's 3 load attempts (~2.5s) the new
  // visible failure state must appear — message + Retry, never a dead form.
  const failureMsg = page.getByText(/Payment couldn't load\. An ad blocker may be blocking Stripe/);
  await expect(failureMsg).toBeVisible({ timeout: 15_000 });
  const retryBtn = page.getByRole("button", { name: "Retry", exact: true });
  await expect(retryBtn).toBeVisible();

  // The checkout-blocked error is reported to the ledger with its own error_type
  // (distinct from background load noise) — also part of b3901c9.
  await expect
    .poll(() => calls.some((c) =>
      c.url.endsWith("/api/identity") &&
      c.body?.action === "log-error" &&
      c.body?.event?.error_type === "StripeLoadCheckoutBlocked"
    ))
    .toBe(true);

  // Retry genuinely restarts the load: failure state clears, then (still blocked)
  // comes back after another attempt cycle.
  await retryBtn.click();
  await expect(failureMsg).toBeHidden();
  await expect(failureMsg).toBeVisible({ timeout: 15_000 });
});
