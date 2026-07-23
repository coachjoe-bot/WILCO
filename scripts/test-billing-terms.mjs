// Billing-terms regression suite — the guard rail for the pure money logic in
// api/_stripe.js (couponTerms, describeCoupon, codeIsAnnualSafe, tierForPrice,
// priceFor, randomGiftCode).
// Run with: node scripts/test-billing-terms.mjs
//
// Two of these can cost real money if they drift:
//   • codeIsAnnualSafe is the ONLY thing stopping a "3 months free" prize code
//     from being applied to the ANNUAL price, where Stripe discounts the whole
//     yearly invoice — i.e. hands over a free year.
//   • describeCoupon is the sentence the athlete reads before entering a card. If
//     it overstates the offer, that's a refund conversation.
// tierForPrice is what the webhook uses to decide which tier a payment bought, so
// a wrong answer grants the wrong plan.

import {
  couponTerms, describeCoupon, codeIsAnnualSafe, tierForPrice, priceFor,
  randomGiftCode, GIFT_COUPON_IDS, TESTER_COUPONS, EVENT_SOURCES,
} from "../api/_stripe.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("  ✗ " + msg); } };
const eq = (got, want, msg) => ok(Object.is(got, want), `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// Coupon shapes exactly as Stripe returns them.
const FREE_FOREVER = { percent_off: 100, duration: "forever" };
const FREE_ONE_MONTH = { percent_off: 100, duration: "once" };
const FREE_THREE_MONTHS = { percent_off: 100, duration: "repeating", duration_in_months: 3 };
const HALF_OFF_FOREVER = { percent_off: 50, duration: "forever" };
const FIVE_DOLLARS_ONCE = { amount_off: 500, duration: "once" };
const TEN_PCT_SIX_MONTHS = { percent_off: 10, duration: "repeating", duration_in_months: 6 };

console.log("couponTerms:");
{
  const t = couponTerms(FREE_FOREVER);
  ok(t.freeForever && t.forever, "100% forever is free-forever");
  eq(t.freeMonths, 0, "free-forever has no month count");
}
{
  const t = couponTerms(FREE_THREE_MONTHS);
  eq(t.freeMonths, 3, "100% repeating x3 is 3 free months");
  ok(t.repeating, "repeating is flagged");
  ok(!t.freeForever, "3 months free is not forever");
}
eq(couponTerms(FREE_ONE_MONTH).freeMonths, 1, "100% once is 1 free month");
eq(couponTerms(HALF_OFF_FOREVER).percentOff, 50, "a partial discount reports its percent");
eq(couponTerms(HALF_OFF_FOREVER).freeMonths, 0, "a partial discount grants no free months");
eq(couponTerms(FIVE_DOLLARS_ONCE).amountOff, 500, "an amount-off coupon reports cents");
{
  const t = couponTerms(null);
  ok(!t.freeForever && t.freeMonths === 0 && !t.repeating, "a null coupon grants nothing");
}
{
  // A repeating coupon with no duration_in_months must not read as zero months.
  const t = couponTerms({ percent_off: 100, duration: "repeating" });
  eq(t.freeMonths, 1, "repeating with no month count falls back to 1, not 0");
}

console.log("describeCoupon:");
eq(describeCoupon(FREE_FOREVER), "Pro free, always", "free forever");
eq(describeCoupon(FREE_FOREVER, "Elite"), "Elite free, always", "tier label is used");
eq(describeCoupon(FREE_THREE_MONTHS), "First 3 months of Pro free", "3 months free");
eq(describeCoupon(FREE_ONE_MONTH), "First month of Pro free", "one month free is singular");
eq(describeCoupon(HALF_OFF_FOREVER), "50% off every month", "percent off forever");
eq(describeCoupon(TEN_PCT_SIX_MONTHS), "10% off for 6 months", "percent off for a span");
eq(describeCoupon(FIVE_DOLLARS_ONCE), "$5.00 off your first month", "amount off once");
eq(describeCoupon(null), "Pro discount applied", "no coupon still says something safe");
eq(describeCoupon({ duration: "once" }), "Pro discount applied", "a coupon with no discount is generic");
// The claim must never be bigger than the coupon.
ok(!describeCoupon(FREE_ONE_MONTH).includes("always"), "one free month never claims forever");
ok(!describeCoupon(HALF_OFF_FOREVER).includes("free"), "a 50% coupon never says free");

console.log("codeIsAnnualSafe:");
// THE money rule: a month-scoped code on the annual price discounts the whole year.
ok(!codeIsAnnualSafe(FREE_THREE_MONTHS), "3-months-free is NOT annual safe (would be a free year)");
ok(!codeIsAnnualSafe(TEN_PCT_SIX_MONTHS), "any repeating coupon is NOT annual safe");
ok(codeIsAnnualSafe(FREE_FOREVER), "forever is annual safe");
ok(codeIsAnnualSafe(FREE_ONE_MONTH), "once is annual safe");
ok(codeIsAnnualSafe(HALF_OFF_FOREVER), "a forever percent is annual safe");
ok(codeIsAnnualSafe(null), "no coupon is trivially annual safe");

console.log("priceFor / tierForPrice:");
for (const tier of ["pro", "elite", "school"]) {
  for (const billing of ["monthly", "annual"]) {
    const id = priceFor(tier, billing);
    ok(!!id, `${tier}/${billing} resolves to a price id`);
    const back = tierForPrice(id);
    eq(back.tier, tier, `${tier}/${billing} round trips to the right tier`);
  }
}
eq(priceFor("free", "monthly"), null, "free has no price id");
eq(priceFor("nonsense", "monthly"), null, "an unknown tier has no price id");
eq(tierForPrice("price_does_not_exist").tier, null, "an unknown price maps to no tier");
// A webhook event that arrives with no price must NOT grant a tier. PRICES_TEST's
// entries are undefined on prod (no STRIPE_TEST_PRICE_* env vars), so an unguarded
// `b.monthly === priceId` matched undefined and reported PRO.
eq(tierForPrice(undefined).tier, null, "undefined maps to no tier");
eq(tierForPrice(null).tier, null, "null maps to no tier");
eq(tierForPrice("").tier, null, "empty string maps to no tier");
eq(tierForPrice(undefined).billing, null, "undefined maps to no billing mode");
// Billing fallback: a missing billing mode must not silently price the wrong plan.
eq(priceFor("pro", undefined), priceFor("pro", "monthly"), "missing billing falls back to monthly");

console.log("randomGiftCode:");
{
  const codes = new Set();
  for (let i = 0; i < 400; i++) codes.add(randomGiftCode());
  ok(codes.size > 395, "codes are effectively unique across 400 draws");
  for (const c of codes) {
    // Ambiguous glyphs are excluded on purpose — these get read aloud and typed
    // from a screenshot, where 0/O and 1/I/L are the same character to a human.
    ok(/^WILCO-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(c), `well-formed, unambiguous code: ${c}`);
    if (!/^WILCO-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(c)) break;
  }
}

console.log("config integrity:");
// A coupon minted in Stripe but missing from GIFT_COUPON_IDS is rejected in-app as
// "That isn't a WILCO code" no matter how valid Stripe thinks it is.
ok(GIFT_COUPON_IDS.size >= 4, "the gift/discount allowlist is populated");
ok([...GIFT_COUPON_IDS].every(Boolean), "no empty entries in the gift allowlist");
ok(Object.values(TESTER_COUPONS).every(t => t === "pro" || t === "elite"), "every tester coupon maps to a real tier");
for (const [key, e] of Object.entries(EVENT_SOURCES)) {
  ok(typeof e.enabled === "boolean", `${key}: enabled is an explicit boolean`);
  ok(e.trialDays > 0 && e.trialDays <= 60, `${key}: trial length is sane (${e.trialDays}d)`);
  ok(!!priceFor(e.tier, "monthly"), `${key}: its tier (${e.tier}) has a real price`);
}

if (fail) { console.error(`\n${fail} FAILURE(S) (${pass} passed)`); process.exit(1); }
console.log(`\nAll ${pass} billing-terms checks pass.`);
