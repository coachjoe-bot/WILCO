// Vercel serverless function — creates a Stripe subscription for an athlete and
// returns a client secret for in-app confirmation via Stripe Elements.
//
// Standard path: 7-day trial (card saved, charged after trial) → SetupIntent.
// Gift-code path (Pro only): promo code applied, NO trial → usually a $0 invoice
//   (Pro monthly) so also a SetupIntent; Pro annual = $135 today → PaymentIntent.

import {
  applyCors,
  verifyAthlete,
  getStripe,
  priceFor,
  resolvePromotionCode,
  markGiftRedeemed,
  sbAthletePatch,
  epochToISO,
  subPeriodEnd,
  STRIPE_MODE,
} from "./_stripe.js";
import { logError } from "./_supa.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { athleteId, pin, tier, billing, giftCode } = req.body || {};
  let athlete = null; // hoisted so the catch can attribute (only if verified)

  try {
    athlete = await verifyAthlete({ athleteId, pin });

    if (tier !== "pro" && tier !== "elite") {
      return res.status(400).json({ error: "Choose a Pro or Elite plan to continue." });
    }
    const interval = billing === "annual" ? "annual" : "monthly";
    const priceId = priceFor(tier, interval);
    if (!priceId) {
      return res
        .status(500)
        .json({ error: `No price configured for ${tier}/${interval} (mode=${STRIPE_MODE}).` });
    }

    const stripe = getStripe();

    // 0. Guard against double-subscribing. If a real subscription already exists,
    //    don't create a second one (use Settings → change plan instead). A stale
    //    incomplete attempt (e.g. abandoned card entry, or a gift code re-applied)
    //    is cancelled so we can cleanly start over without orphaning subscriptions.
    if (athlete.stripe_subscription_id) {
      try {
        const prev = await stripe.subscriptions.retrieve(athlete.stripe_subscription_id);
        if (prev && ["trialing", "active", "past_due"].includes(prev.status)) {
          return res
            .status(400)
            .json({ error: "You already have an active subscription. Manage it in Settings." });
        }
        if (prev && prev.status === "incomplete") {
          await stripe.subscriptions.cancel(prev.id).catch(() => {});
        }
      } catch (_) {
        /* subscription not found / already gone — fine, continue */
      }
    }

    // 1. Customer — reuse if present, else create and persist immediately so a
    //    retried payment step doesn't create a duplicate customer.
    let customerId = athlete.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: athlete.email || undefined,
        name: athlete.name || undefined,
        metadata: { athlete_id: String(athlete.id) },
      });
      customerId = customer.id;
      await sbAthletePatch(athlete.id, { stripe_customer_id: customerId });
    }

    // 2. Gift-code path vs trial path (mutually exclusive).
    let promotionCodeId = null;
    let giftApplied = false;
    if (giftCode && giftCode.trim()) {
      if (tier !== "pro") {
        return res.status(400).json({ error: "This gift code is valid for Pro plans only." });
      }
      const owned = Array.isArray(athlete.gift_codes) ? athlete.gift_codes : [];
      if (owned.some((g) => g.code?.toUpperCase() === giftCode.trim().toUpperCase())) {
        return res.status(400).json({ error: "You can't redeem your own gift code." });
      }
      if (athlete.redeemed_gift_code) {
        return res.status(400).json({ error: "You've already redeemed a gift code." });
      }
      const resolved = await resolvePromotionCode(stripe, giftCode);
      if (!resolved.valid) return res.status(400).json({ error: resolved.error });
      promotionCodeId = resolved.promotionCodeId;
      giftApplied = true;
    }

    // 3. Create the subscription as incomplete so the client confirms the card.
    const params = {
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent", "pending_setup_intent"],
      metadata: { athlete_id: String(athlete.id), tier, billing: interval },
    };
    if (giftApplied) {
      params.discounts = [{ promotion_code: promotionCodeId }]; // free month replaces the trial
    } else {
      params.trial_period_days = 7;
      params.trial_settings = { end_behavior: { missing_payment_method: "cancel" } };
    }

    const subscription = await stripe.subscriptions.create(params);

    // 4. What must the client confirm?
    //    Trial / $0 first invoice → SetupIntent. Real first charge → PaymentIntent.
    const setupSecret = subscription.pending_setup_intent?.client_secret;
    const paymentSecret = subscription.latest_invoice?.payment_intent?.client_secret;
    const mode = setupSecret ? "setup" : "payment";
    const clientSecret = setupSecret || paymentSecret || null;

    if (!clientSecret) {
      // Nothing to confirm (e.g. fully-covered $0 with no setup intent) — rare, but
      // surface it rather than handing the client a dead form.
      console.warn("[create-subscription] no client secret on subscription", subscription.id);
    }

    // 5. Optimistic persist; the webhook re-syncs authoritatively.
    await sbAthletePatch(athlete.id, {
      stripe_subscription_id: subscription.id,
      stripe_price_id: priceId,
      subscription_status: subscription.status,
      tier,
      billing: interval,
      trial_end: epochToISO(subscription.trial_end),
      current_period_end: epochToISO(subPeriodEnd(subscription)),
      cancel_at_period_end: !!subscription.cancel_at_period_end,
    });

    // 6. Mark the gifter's code redeemed (best-effort) and record on the redeemer.
    if (giftApplied && promotionCodeId) {
      try {
        await markGiftRedeemed(stripe, promotionCodeId, athlete);
        await sbAthletePatch(athlete.id, { redeemed_gift_code: giftCode.trim().toUpperCase() });
      } catch (e) {
        console.error("[create-subscription] gift redeem bookkeeping failed:", e.message);
      }
    }

    return res.status(200).json({
      clientSecret,
      mode,
      subscriptionId: subscription.id,
      customerId,
      status: subscription.status,
      trialEnd: epochToISO(subscription.trial_end),
      currentPeriodEnd: epochToISO(subPeriodEnd(subscription)),
      giftApplied,
    });
  } catch (e) {
    console.error("[create-subscription] error:", e.message);
    const status = e.status || e.statusCode || 500;
    // Ledger the real failures (any Stripe API error — they carry e.type — plus
    // 5xx like a Supabase patch dying) so checkout breakage shows in error_events,
    // not just function logs. Routine 4xx (bad PIN, own gift code) stay out,
    // matching api/data.js. Attribution only from the already-verified athlete.
    if (status >= 500 || e.type) {
      await logError({
        source: "server", severity: "error", area: "billing", route: "api/create-subscription",
        error_type: e.type || `http_${status}`, message: e.message, status_code: status,
        role: athlete ? "athlete" : null, actor_id: athlete?.id ?? null,
        athlete_id: athlete?.id ?? null,
        meta: { tier: tier ?? null, billing: billing ?? null },
      });
    }
    return res.status(e.status || 500).json({ error: e.message || "Subscription failed" });
  }
}
