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
// Live-mode behavior (SetupIntent → confirm → subscribe with card attached) is
// exercised by the manual Stripe test-mode runbook in STRIPE-INTEGRATION.md —
// same policy as the rest of the billing suite.
//
//   node scripts/test-checkout-lifecycle.mjs
//
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-signing-key-not-a-real-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://test.invalid";

const { subEntitlesPaidTier, tierForPrice } = await import("../api/_stripe.js");
const { classifyPair, isOrphanedEntitlement } = await import("../api/reconcile-billing.js");

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

console.log("classifyPair — comped accounts are never orphans (Will 09-29):");
check("no sub + comped pro → ok (free on purpose, not a leak)",
  classifyPair({ sub: null, athlete: { tier: "pro", comped: true }, nowMs: NOW }), "ok");
check("no sub + comped elite → ok",
  classifyPair({ sub: null, athlete: { tier: "elite", comped: true }, nowMs: NOW }), "ok");
check("canceled sub + comped pro → ok (a lapsed sub never demotes or alarms a comped account)",
  classifyPair({ sub: sub({ status: "canceled" }), athlete: { tier: "pro", comped: true }, nowMs: NOW }), "ok");
check("no sub + pro with comped false → still entitlement_orphaned",
  classifyPair({ sub: null, athlete: { tier: "pro", comped: false }, nowMs: NOW }), "entitlement_orphaned");
check("no sub + pro with comped missing → still entitlement_orphaned",
  classifyPair({ sub: null, athlete: { tier: "pro" }, nowMs: NOW }), "entitlement_orphaned");
check("comped must be exactly true (a truthy string is not comped)",
  classifyPair({ sub: null, athlete: { tier: "pro", comped: "true" }, nowMs: NOW }), "entitlement_orphaned");
console.log("classifyPair — every other class is unchanged for a comped athlete:");
check("live + card + comped FREE athlete → entitlement_missing (a real sync gap, still reported)",
  classifyPair({ sub: sub(), athlete: { tier: "free", comped: true }, nowMs: NOW }), "entitlement_missing");
check("live + card + comped pro → ok",
  classifyPair({ sub: sub(), athlete: { tier: "pro", comped: true }, nowMs: NOW }), "ok");
check("live sub + no athlete → unlinked_sub",
  classifyPair({ sub: sub(), athlete: null, nowMs: NOW }), "unlinked_sub");
check("live cardless 2h + comped free → abandoned_checkout",
  classifyPair({ sub: sub({ default_payment_method: null }), athlete: { tier: "free", comped: true }, nowMs: NOW }), "abandoned_checkout");
check("live cardless 10min + comped free → in_flight",
  classifyPair({ sub: sub({ default_payment_method: null, created: NOW / 1000 - 600 }), athlete: { tier: "free", comped: true }, nowMs: NOW }), "in_flight");
check("isOrphanedEntitlement: the athlete-side pass shares the rule",
  [isOrphanedEntitlement({ tier: "pro" }), isOrphanedEntitlement({ tier: "pro", comped: true }), isOrphanedEntitlement({ tier: "free" }), isOrphanedEntitlement({ tier: "school" }), isOrphanedEntitlement(null)],
  [true, false, false, false, false]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
