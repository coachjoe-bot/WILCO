// ─── CHECKOUT LIFECYCLE REGRESSION SUITE (T37) ────────────────────────────────
// Guards the two pure rules the 2026-08-07 checkout re-order rests on:
//
//   1. subEntitlesPaidTier — the single source of truth for "does this Stripe
//      subscription earn its athlete a paid tier". The Lopez incident was this
//      guard working CORRECTLY against an orphan sub; these cases pin the truth
//      table so nobody "fixes" it into granting cardless trials Pro.
//
//   2. classifyPair — the nightly reconcile cron's divergence classifier. The
//      incident went unnoticed for 7 days because nothing compared Stripe with
//      Supabase; this pins what the comparison calls a problem.
//
//   3. The card-first-only handler (T68, 2026-09-29) — the legacy eager-create
//      branch is deleted; a request without paymentMethodId must 400 and touch
//      NOTHING (no Stripe call, no Supabase write). Stripe and fetch are stubbed.
//
// Live-mode behavior (SetupIntent → confirm → subscribe with card attached) is
// exercised by the manual Stripe test-mode runbook in STRIPE-INTEGRATION.md —
// same policy as the rest of the billing suite.
//
//   node scripts/test-checkout-lifecycle.mjs
//
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-signing-key-not-a-real-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://test.invalid";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_stub_not_real";

const { subEntitlesPaidTier, tierForPrice } = await import("../api/_stripe.js");
const { classifyPair } = await import("../api/reconcile-billing.js");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
};

console.log("subEntitlesPaidTier — card on file AND live, nothing less:");
check("trialing + card → entitled", subEntitlesPaidTier({ status: "trialing", default_payment_method: "pm_1" }), true);
check("active + card → entitled", subEntitlesPaidTier({ status: "active", default_payment_method: "pm_1" }), true);
check("past_due + card → entitled (grace)", subEntitlesPaidTier({ status: "past_due", default_payment_method: "pm_1" }), true);
check("trialing, NO card → NOT entitled (the Lopez orphan)", subEntitlesPaidTier({ status: "trialing", default_payment_method: null }), false);
check("active, NO card → NOT entitled ($0-invoice pre-confirm)", subEntitlesPaidTier({ status: "active", default_payment_method: null }), false);
check("incomplete + card → NOT entitled (charge unconfirmed)", subEntitlesPaidTier({ status: "incomplete", default_payment_method: "pm_1" }), false);
check("canceled + card → NOT entitled", subEntitlesPaidTier({ status: "canceled", default_payment_method: "pm_1" }), false);
check("null sub → NOT entitled", subEntitlesPaidTier(null), false);

console.log("tierForPrice — unknown/missing prices never grant a tier:");
check("undefined price → null tier", tierForPrice(undefined), { tier: null, billing: null });
check("unknown price → null tier", tierForPrice("price_nope"), { tier: null, billing: null });

console.log("classifyPair — nightly reconcile divergence classes:");
const NOW = 1_800_000_000_000; // fixed clock for age math
const sub = (over = {}) => ({ status: "trialing", default_payment_method: "pm_1", created: NOW / 1000 - 7200, ...over });

check("live + card + pro athlete → ok",
  classifyPair({ sub: sub(), athlete: { tier: "pro" }, nowMs: NOW }), "ok");
check("live + card + elite athlete → ok",
  classifyPair({ sub: sub(), athlete: { tier: "elite" }, nowMs: NOW }), "ok");
check("live + card + FREE athlete → entitlement_missing (paid, not getting product)",
  classifyPair({ sub: sub(), athlete: { tier: "free" }, nowMs: NOW }), "entitlement_missing");
check("live + card + no athlete → unlinked_sub",
  classifyPair({ sub: sub(), athlete: null, nowMs: NOW }), "unlinked_sub");
check("live, cardless, 2h old → abandoned_checkout (the Lopez signature)",
  classifyPair({ sub: sub({ default_payment_method: null }), athlete: { tier: "free" }, nowMs: NOW }), "abandoned_checkout");
check("live, cardless, 10min old → in_flight (someone is at the card form now)",
  classifyPair({ sub: sub({ default_payment_method: null, created: NOW / 1000 - 600 }), athlete: { tier: "free" }, nowMs: NOW }), "in_flight");
check("canceled sub + pro athlete → entitlement_orphaned (giving Pro away)",
  classifyPair({ sub: sub({ status: "canceled" }), athlete: { tier: "pro" }, nowMs: NOW }), "entitlement_orphaned");
check("no sub + pro athlete → entitlement_orphaned",
  classifyPair({ sub: null, athlete: { tier: "pro" }, nowMs: NOW }), "entitlement_orphaned");
check("no sub + school athlete → ok (schools bill by invoice, never Stripe)",
  classifyPair({ sub: null, athlete: { tier: "school" }, nowMs: NOW }), "ok");
check("no sub + free athlete → ok",
  classifyPair({ sub: null, athlete: { tier: "free" }, nowMs: NOW }), "ok");
check("canceled sub + free athlete → ok (normal churn)",
  classifyPair({ sub: sub({ status: "canceled" }), athlete: { tier: "free" }, nowMs: NOW }), "ok");

console.log("create-subscription handler — legacy (no paymentMethodId) request is refused and creates NOTHING:");
{
  const { getStripe } = await import("../api/_stripe.js");
  const { mintSessionToken } = await import("../api/_supa.js");
  const { default: handler } = await import("../api/create-subscription.js");

  // Any Stripe method call trips the flag. getStripe() is a singleton, so the
  // handler sees the same instance we stub here.
  const stripe = getStripe();
  let stripeCalls = 0;
  for (const res of ["customers", "subscriptions", "paymentMethods", "setupIntents", "coupons", "promotionCodes"]) {
    for (const fn of ["create", "update", "retrieve", "cancel", "list"]) {
      if (typeof stripe[res]?.[fn] === "function") stripe[res][fn] = async () => { stripeCalls++; throw new Error(`stripe.${res}.${fn} must not be called`); };
    }
  }
  // Only the athlete GET (auth) may hit the network; any other fetch is a write.
  const realFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), method: init.method || "GET" });
    return new Response(JSON.stringify([{ id: "ath-1", name: "Test", tier: "free", stripe_customer_id: null, stripe_subscription_id: null }]),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  const call = async (body) => {
    let status = 200, payload = null;
    const res = { setHeader() {}, status(c) { status = c; return res; }, json(p) { payload = p; return res; }, end() { return res; } };
    await handler({ method: "POST", body }, res);
    return { status, payload };
  };
  const auth = { role: "athlete", id: "ath-1", token: mintSessionToken("athlete", "ath-1") };

  try {
    for (const [label, body] of [
      ["trial checkout, no paymentMethodId", { athleteId: "ath-1", auth, tier: "pro", billing: "monthly" }],
      ["annual + gift code, no paymentMethodId", { athleteId: "ath-1", auth, tier: "pro", billing: "annual", giftCode: "WILCO-FRIEND" }],
      ["event source, no paymentMethodId", { athleteId: "ath-1", auth, tier: "pro", billing: "monthly", eventSource: "aloma" }],
      ["empty-string paymentMethodId", { athleteId: "ath-1", auth, tier: "pro", billing: "monthly", paymentMethodId: "" }],
    ]) {
      fetchCalls.length = 0; stripeCalls = 0;
      const r = await call(body);
      check(`${label} → 400 with a refresh message`, [r.status, /refresh the app/i.test(r.payload?.error || "")], [400, true]);
      check(`${label} → zero Stripe calls`, stripeCalls, 0);
      check(`${label} → no Supabase write (GET athlete only)`, fetchCalls.every((c) => c.method === "GET"), true);
    }
    fetchCalls.length = 0; stripeCalls = 0;
    const bad = await call({ athleteId: "ath-1", tier: "pro", billing: "monthly" });
    check("no paymentMethodId AND no credentials → still an auth error, not the refresh message", bad.status === 400 && /refresh the app/i.test(bad.payload?.error || ""), false);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
