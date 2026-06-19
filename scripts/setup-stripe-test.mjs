// Creates TEST-MODE mirrors of the WILCO prices + the gift coupon, so the payment
// flow can be tested with Stripe test cards (no real money). Idempotent — re-running
// reuses anything that already exists.
//
// Usage:
//   STRIPE_SECRET_KEY=sk_test_xxx node scripts/setup-stripe-test.mjs
//
// It prints the env vars to paste into your local .env (the app reads them when
// STRIPE_MODE=test). It refuses to run against a live key.

import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Set STRIPE_SECRET_KEY (a TEST key, sk_test_...) before running.");
  process.exit(1);
}
if (!key.startsWith("sk_test")) {
  console.error("Refusing to run: STRIPE_SECRET_KEY is not a test key (must start with sk_test_).");
  process.exit(1);
}

const stripe = new Stripe(key);

async function ensureProduct(name) {
  try {
    const found = await stripe.products.search({ query: `name:'${name}' AND active:'true'` });
    if (found.data?.length) return found.data[0];
  } catch (_) { /* search may lag right after creation — fall through to create */ }
  return stripe.products.create({ name });
}

async function ensurePrice(product, nickname, unit_amount, interval) {
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const found = prices.data.find(
    (p) => p.unit_amount === unit_amount && p.recurring?.interval === interval
  );
  if (found) return found;
  return stripe.prices.create({
    product: product.id,
    nickname,
    unit_amount,
    currency: "usd",
    recurring: { interval },
  });
}

(async () => {
  const proProd    = await ensureProduct("Tier 2 Core (TEST)");
  const eliteProd  = await ensureProduct("Tier 3 Premium (TEST)");
  const schoolProd = await ensureProduct("School (TEST)");

  const proM   = await ensurePrice(proProd,   "Pro Monthly",   1499,   "month");
  const proA   = await ensurePrice(proProd,   "Pro Annual",    15000,  "year");
  const eliteM = await ensurePrice(eliteProd, "Elite Monthly", 9999,   "month");
  const eliteA = await ensurePrice(eliteProd, "Elite Annual",  100000, "year");
  const school = await ensurePrice(schoolProd,"School",        0,      "month");

  let coupon;
  try {
    coupon = await stripe.coupons.retrieve("WILCO_GIFT_PRO_MONTH");
  } catch (_) {
    coupon = await stripe.coupons.create({
      id: "WILCO_GIFT_PRO_MONTH",
      amount_off: 1499,
      currency: "usd",
      duration: "once",
      name: "Wilco Gift - Free Month of Pro",
      applies_to: { products: [proProd.id] },
    });
  }

  console.log("\n# ─── Paste into your local .env (TEST mode) ───");
  console.log("STRIPE_MODE=test");
  console.log("STRIPE_TEST_PRICE_PRO_MONTHLY=" + proM.id);
  console.log("STRIPE_TEST_PRICE_PRO_ANNUAL=" + proA.id);
  console.log("STRIPE_TEST_PRICE_ELITE_MONTHLY=" + eliteM.id);
  console.log("STRIPE_TEST_PRICE_ELITE_ANNUAL=" + eliteA.id);
  console.log("STRIPE_TEST_PRICE_SCHOOL=" + school.id);
  console.log("STRIPE_GIFT_COUPON_ID=" + coupon.id);
  console.log("\n✓ Test-mode products, prices, and coupon are ready.");
})().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
