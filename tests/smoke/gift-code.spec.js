// Smoke: the Apply-code step describes the ACTUAL offer. The disclosure used to
// hardcode the classic one-free-month gift ("$14.99 off today… $135.01 now"), so
// any other coupon — the 3-month event prize, a founding discount — was disclosed
// wrongly. Copy is now derived from the coupon terms the server returns.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";

// Same format as App.jsx fmtDate, so the asserted charge date is the real one.
const fmtDate = (d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const monthsOut = (n) => { const d = new Date(); d.setMonth(d.getMonth() + n); return fmtDate(d); };

// Drive the upgrade flow to the payment step, then apply `code`.
async function applyCodeAtCheckout(page, code) {
  await page.getByTitle("Settings").click();
  await page.getByRole("button", { name: /YOUR PLAN/ }).click();
  await page.getByText("PRO", { exact: true }).click();
  await page.getByPlaceholder("Enter PIN to confirm").fill("1234");
  await page.getByRole("button", { name: "Subscribe to PRO →" }).click();
  await page.getByPlaceholder("WILCO-XXXXX").fill(code);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
}

test("a 3-month prize code discloses three free months, not one", async ({ page }) => {
  await mockApi(page, {
    athlete: makeAthlete({ tier: "free", stripe_subscription_id: null }),
    giftResult: {
      valid: true,
      promotionCodeId: "promo_smoketest",
      kind: "gift",
      discountLabel: "First 3 months of Pro free",
      terms: { freeForever: false, freeMonths: 3, amountOff: 0, percentOff: 100, repeating: true, forever: false },
    },
  });
  await loginAsAthlete(page, makeAthlete({ tier: "free", stripe_subscription_id: null }));
  await applyCodeAtCheckout(page, "GRIP-TEST-CHAMP");

  await expect(page.getByText("First 3 months of Pro free")).toBeVisible();
  // The disclosure names three free months and charges at the END of them.
  const disclosure = page.getByText(/Your first .*3 months.* of Pro are free/);
  await expect(disclosure).toBeVisible();
  await expect(page.getByText(monthsOut(3), { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Start 3 Months Free →" })).toBeVisible();
});

test("the classic one-month gift code still reads as one free month", async ({ page }) => {
  await mockApi(page, { athlete: makeAthlete({ tier: "free", stripe_subscription_id: null }) });
  await loginAsAthlete(page, makeAthlete({ tier: "free", stripe_subscription_id: null }));
  await applyCodeAtCheckout(page, "WILCO-ABCDE");

  await expect(page.getByText(/Your first month of Pro is free/)).toBeVisible();
  await expect(page.getByText(monthsOut(1), { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Start First Month Free →" })).toBeVisible();
});
