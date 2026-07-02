// End-to-end test of a 30-day-trial subscription lifecycle using Stripe TEST CLOCKS.
//
// Simulates: customer signs up -> 30-day trial starts -> time is fast-forwarded past
// trial_end -> Stripe auto-charges the saved card -> subscription flips to active with
// a paid invoice. This exercises the same trial shape used by the real app (see
// STRIPE-INTEGRATION.md), but with trial_period_days: 30 and its own metadata so it's
// clearly identifiable as a test run.
//
// Usage (no dotenv dependency needed — Node's built-in --env-file loader reads .env):
//   node --env-file=.env scripts/test-event-trial.mjs
//
// Requires in .env:
//   STRIPE_SECRET_KEY               (must start with sk_test_ — script refuses otherwise)
//   STRIPE_TEST_PRICE_PRO_MONTHLY   (a recurring monthly price in TEST mode)
//
// Cleans up after itself: cancels the subscription and deletes the test clock (which
// cascades and deletes the test customer) in a finally block, even on failure.

import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
const priceId = process.env.STRIPE_TEST_PRICE_PRO_MONTHLY;

// Hard-exit used only for the pre-flight safety gate, before any Stripe objects
// (test clock / customer / subscription) exist — so there is nothing to clean up yet.
function failFast(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── 1. Safety gate ──────────────────────────────────────────────────────────
if (!key) failFast("STRIPE_SECRET_KEY is not set. Run with: node --env-file=.env scripts/test-event-trial.mjs");
if (!key.startsWith("sk_test_")) failFast("STRIPE_SECRET_KEY is not a TEST key (must start with sk_test_). Refusing to run.");
if (!priceId) failFast("STRIPE_TEST_PRICE_PRO_MONTHLY is not set in .env.");
console.log("✓ Safety gate passed — using a Stripe TEST key");

const stripe = new Stripe(key);

const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;

// Assertion failures throw instead of exiting directly, so the outer .catch/.finally
// still runs and cleanup (cancel subscription + delete test clock) always happens.
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`✓ ${msg}`);
}

async function pollClockReady(clockId, { intervalMs = 3000, timeoutMs = 120000 } = {}) {
  const start = Date.now();
  for (;;) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === "ready") return clock;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Test clock did not become "ready" within ${timeoutMs / 1000}s (last status: ${clock.status})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let testClock;
let subscriptionId;

(async () => {
  // ── 2. Create a test clock frozen at the current time ──────────────────
  testClock = await stripe.testHelpers.testClocks.create({
    frozen_time: Math.floor(Date.now() / 1000),
    name: "event-trial-e2e",
  });
  console.log(`✓ Created test clock ${testClock.id} frozen at ${new Date(testClock.frozen_time * 1000).toISOString()}`);

  // ── 3. Create a customer on that test clock ─────────────────────────────
  const customer = await stripe.customers.create({
    email: "event-trial-test@trainwilco.com",
    test_clock: testClock.id,
    metadata: { test: "event-trial-e2e" },
  });
  console.log(`✓ Created customer ${customer.id}`);

  // ── 4. Attach test payment method + set as default for invoices ────────
  // Note: "pm_card_visa" is a reusable Stripe test *token* — attaching it mints a new,
  // customer-specific PaymentMethod object. We must use the ID it returns (not the
  // literal token string) when setting invoice_settings.default_payment_method.
  const paymentMethod = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  });
  console.log(`✓ Attached pm_card_visa (as ${paymentMethod.id}) and set as default payment method for invoices`);

  // ── 5. Create the subscription with a 30-day trial ──────────────────────
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: priceId }],
    trial_period_days: 30,
    metadata: { signup_source: "crunch-aloma" },
    trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    payment_settings: { save_default_payment_method: "on_subscription" },
  });
  subscriptionId = subscription.id;
  console.log(`✓ Created subscription ${subscription.id}`);

  // ── 6. Assert trialing + trial_end ~30 days out ─────────────────────────
  assert(subscription.status === "trialing", `subscription status is "trialing" (got "${subscription.status}")`);

  const now = testClock.frozen_time;
  const daysUntilTrialEnd = (subscription.trial_end - now) / DAY;
  assert(
    daysUntilTrialEnd > 29 && daysUntilTrialEnd < 31,
    `trial_end is ~30 days out (got ${daysUntilTrialEnd.toFixed(2)} days)`
  );

  // ── 7. Advance the test clock to trial_end + 2 hours, poll until ready ──
  const advanceTo = subscription.trial_end + 2 * HOUR;
  await stripe.testHelpers.testClocks.advance(testClock.id, { frozen_time: advanceTo });
  console.log(`✓ Requested clock advance to ${new Date(advanceTo * 1000).toISOString()} (trial_end + 2h)`);

  await pollClockReady(testClock.id);
  console.log("✓ Test clock finished advancing (status: ready)");

  // ── 8. Re-fetch subscription + latest invoice, assert trial ended + paid ─
  const updatedSub = await stripe.subscriptions.retrieve(subscription.id, {
    expand: ["latest_invoice"],
  });

  assert(updatedSub.status === "active", `subscription status is "active" after trial end (got "${updatedSub.status}")`);

  const invoice = updatedSub.latest_invoice;
  assert(!!invoice, "subscription has a latest_invoice");
  assert(invoice.amount_due > 0, `latest invoice amount_due > 0 (got ${invoice.amount_due})`);
  const invoicePaid = invoice.paid === true || invoice.status === "paid";
  assert(invoicePaid, `latest invoice was paid (status="${invoice.status}", paid=${invoice.paid})`);

  // ── 9. Summary ────────────────────────────────────────────────────────
  const dollars = (invoice.amount_paid ?? invoice.amount_due) / 100;
  console.log(
    `\n✓ SUMMARY — subscription ${updatedSub.id} | invoice ${invoice.id} | charged $${dollars.toFixed(2)}\n`
  );
})()
  .catch((err) => {
    console.error(`✗ ${err.message || err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // ── 10. Cleanup — always runs, even on failure ─────────────────────
    if (subscriptionId) {
      try {
        await stripe.subscriptions.cancel(subscriptionId);
        console.log(`✓ Cleanup: canceled subscription ${subscriptionId}`);
      } catch (e) {
        console.error(`(cleanup) failed to cancel subscription (ignored): ${e.message || e}`);
      }
    }
    if (testClock) {
      try {
        await stripe.testHelpers.testClocks.del(testClock.id);
        console.log(`✓ Cleanup: deleted test clock ${testClock.id} (cascades: removes test customer)`);
      } catch (e) {
        console.error(`(cleanup) failed to delete test clock: ${e.message || e}`);
      }
    }
  });
