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
  codeIsAnnualSafe,
  markGiftRedeemed,
  sbAthletePatch,
  epochToISO,
  subPeriodEnd,
  subEntitlesPaidTier,
  STRIPE_MODE,
  EVENT_SOURCES,
} from "./_stripe.js";
import { logError } from "./_supa.js";

// Vercel Pro: cap this function's execution time. Was implicitly the Hobby 10s
// wall; 30s gives external Stripe/email/DB calls room without paying for idle time.
export const maxDuration = 30;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { athleteId, pin, tier, billing, giftCode, eventSource, ad } = req.body || {};
  let athlete = null; // hoisted so the catch can attribute (only if verified)

  // Meta click identifiers for server-side Purchase attribution. Validated to
  // their documented shapes so a crafted body can't stuff arbitrary text into
  // Stripe metadata. fbc: fb.<n>.<ms>.<fbclid>  fbp: fb.<n>.<ms>.<rand>
  const adMeta = {};
  if (ad && typeof ad === "object") {
    if (ad.optout === true) {
      // Global Privacy Control opt-out — flag it so the webhook skips the Meta
      // Purchase entirely and never forwards any identifier. (Privacy Policy §13.2.)
      adMeta.ad_optout = "1";
    } else {
      if (typeof ad.fbc === "string" && /^fb\.\d\.\d{10,}\.[\w.-]{1,255}$/.test(ad.fbc)) adMeta.fbc = ad.fbc;
      if (typeof ad.fbp === "string" && /^fb\.\d\.\d{10,}\.\d{1,20}$/.test(ad.fbp)) adMeta.fbp = ad.fbp;
    }
  }

  try {
    athlete = await verifyAthlete({ athleteId, pin });

    if (tier !== "pro" && tier !== "elite") {
      return res.status(400).json({ error: "Choose a Pro or Elite plan to continue." });
    }

    // Event signups (QR → landing page): the server decides the trial length from
    // EVENT_SOURCES — the client only names the source. Unknown sources are a hard
    // error; a known-but-disabled one means someone reached checkout before the
    // event went live, so refuse rather than silently downgrading their offer.
    let event = null;
    if (eventSource !== undefined && eventSource !== null && eventSource !== "") {
      // hasOwnProperty guard: a crafted source like "__proto__" must not walk the
      // prototype chain into a truthy non-config object.
      event = Object.prototype.hasOwnProperty.call(EVENT_SOURCES, String(eventSource))
        ? EVENT_SOURCES[String(eventSource)]
        : null;
      if (!event) return res.status(400).json({ error: "Unknown signup source." });
      if (!event.enabled) {
        return res.status(403).json({ error: "This offer isn't live yet. Come see us at the event!" });
      }
      if (tier !== event.tier) {
        return res.status(400).json({ error: "This offer is for the Pro plan." });
      }
      if (giftCode && giftCode.trim()) {
        return res.status(400).json({ error: "Gift codes can't be combined with this offer." });
      }
    }
    const interval = billing === "annual" ? "annual" : "monthly";
    const priceId = priceFor(tier, interval);
    if (!priceId) {
      return res
        .status(500)
        .json({ error: `No price configured for ${tier}/${interval} (mode=${STRIPE_MODE}).` });
    }

    const stripe = getStripe();

    // 0. Guard against double-subscribing — but only against a subscription the
    //    athlete actually COMPLETED. This endpoint is called on every checkout
    //    render: the payment step recreates the subscription whenever the plan,
    //    billing interval, or gift code changes (each needs a fresh client secret).
    //    So an athlete mid-onboarding routinely already has a just-created trial or
    //    promo subscription from a prior render. Treating that stale attempt as a
    //    real subscription is exactly what locked gift-code users out — applying a
    //    code re-ran this endpoint, which saw the trial sub the page had auto-created
    //    a moment earlier and returned "You already have an active subscription",
    //    stranding them on the payment step with no way to add a card.
    //
    //    The reliable signal for "finished checkout" is a saved payment method:
    //    Stripe only sets default_payment_method once the SetupIntent/PaymentIntent
    //    confirms (save_default_payment_method: "on_subscription"). So block only a
    //    live sub that has a card on file.
    //
    //    The stale attempt is NOT canceled here. Whether it can be REUSED is decided
    //    after the code resolves (step 2b): Stripe burns a promotion code's
    //    redemption slot the moment a subscription is created with it and never
    //    returns the slot — not on cancel, not on discount removal (verified
    //    empirically 2026-07-21). Cancel-and-recreate therefore consumes a capped
    //    code (per-friend gifts max 1, event prizes max 2) on the athlete's own
    //    retry. The expands mirror what the create call asks for, so a reused sub
    //    hands back a client secret the same way a fresh one does.
    let prevSub = null;
    if (athlete.stripe_subscription_id) {
      try {
        prevSub = await stripe.subscriptions.retrieve(athlete.stripe_subscription_id, {
          expand: ["discounts", "latest_invoice.payment_intent", "pending_setup_intent"],
        });
      } catch (_) {
        /* subscription not found / already gone — fine, continue */
      }
    }
    if (prevSub) {
      const live = ["trialing", "active", "past_due"].includes(prevSub.status);
      const completed = !!prevSub.default_payment_method; // card saved = checkout done
      if (live && completed) {
        return res
          .status(400)
          .json({ error: "You already have an active subscription. Manage it in Settings." });
      }
    }
    // Promotion codes the athlete's own unfinished attempt already redeemed. A slot
    // counted against one of these is the athlete's own, so a fully-redeemed code
    // must still validate for them — reusing the sub doesn't consume another slot.
    const heldPromoIds = new Set(
      (prevSub?.discounts || [])
        .map((d) => (typeof d === "string" ? null
          : typeof d.promotion_code === "string" ? d.promotion_code : d.promotion_code?.id))
        .filter(Boolean)
    );

    // 1. Customer — reuse if present, else create and persist immediately so a
    //    retried payment step doesn't create a duplicate customer.
    let customerId = athlete.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: athlete.email || undefined,
        name: athlete.name || undefined,
        metadata: {
          athlete_id: String(athlete.id),
          // Mirror the attribution already stored on the athlete row (event key or
          // free-form UTM/referrer source) so Stripe and Supabase never disagree.
          ...(athlete.signup_source ? { signup_source: String(athlete.signup_source) } : {}),
          ...adMeta,
        },
      });
      customerId = customer.id;
      await sbAthletePatch(athlete.id, { stripe_customer_id: customerId });
    }

    // 2. Code path (gift OR tester) vs trial path (mutually exclusive).
    let promotionCodeId = null;
    let giftApplied = false;
    let testerApplied = false;
    let capExhausted = false; // cap full, athlete vouched only by their own held slot
    if (giftCode && giftCode.trim()) {
      const resolved = await resolvePromotionCode(stripe, giftCode, { heldPromoIds });
      if (!resolved.valid) return res.status(400).json({ error: resolved.error });
      capExhausted =
        resolved.promo.max_redemptions != null &&
        resolved.promo.times_redeemed >= resolved.promo.max_redemptions;

      if (resolved.kind === "tester") {
        // Tester codes are product-scoped: the selected tier must match the code's
        // tier (WILCO-TESTER-ELITE only pairs with the Elite price, etc.). Testers
        // are a separate, capped program — exempt from the self-redeem and
        // one-code-per-athlete guards, and redeeming one does NOT consume the
        // athlete's gift-redemption slot (redeemed_gift_code stays untouched).
        if (tier !== resolved.tier) {
          const tierLabel = resolved.tier === "elite" ? "Elite" : "Pro";
          return res.status(400).json({ error: `This tester code is for the ${tierLabel} plan.` });
        }
        promotionCodeId = resolved.promotionCodeId;
        testerApplied = true;
      } else {
        // Gift code path (unchanged): Pro-only + self-redeem + one-per-athlete guards.
        if (tier !== "pro") {
          return res.status(400).json({ error: "This gift code is valid for Pro plans only." });
        }
        const owned = Array.isArray(athlete.gift_codes) ? athlete.gift_codes : [];
        if (owned.some((g) => g.code?.toUpperCase() === giftCode.trim().toUpperCase())) {
          return res.status(400).json({ error: "You can't redeem your own gift code." });
        }
        // Same code = the athlete retrying their OWN in-flight redemption (it's
        // stamped at sub creation, before the card confirms — see step 6), which
        // must not lock them out of finishing checkout. A different code is a real
        // second redemption and stays blocked.
        if (athlete.redeemed_gift_code && athlete.redeemed_gift_code !== giftCode.trim().toUpperCase()) {
          return res.status(400).json({ error: "You've already redeemed a gift code." });
        }
        if (interval === "annual" && !codeIsAnnualSafe(resolved.coupon)) {
          return res.status(400).json({ error: "This code applies to the monthly plan." });
        }
        promotionCodeId = resolved.promotionCodeId;
        giftApplied = true;
      }
    }

    // 2b. Reuse the athlete's own in-flight attempt when it matches this request.
    //     This endpoint re-runs freely (refresh, back-and-forth, Stripe.js retry),
    //     and recreating a code-bearing subscription burns a promo redemption that
    //     Stripe never refunds — on a capped code, the athlete's own retry could
    //     exhaust the cap and lock out the other legitimate holders. Same price +
    //     same promo set + still confirmable → hand back the existing client secret.
    //     (A $0-first-invoice sub sits at status "active" with no card — that's the
    //     normal pre-confirm state for 100%-off codes, so "active" is reusable here;
    //     the completed guard above already screened out real card-on-file subs.)
    let subscription = null;
    let reused = false;
    if (prevSub && ["incomplete", "trialing", "active"].includes(prevSub.status)) {
      const samePrice = prevSub.items?.data?.[0]?.price?.id === priceId;
      const samePromos = promotionCodeId
        ? heldPromoIds.size === 1 && heldPromoIds.has(promotionCodeId)
        : heldPromoIds.size === 0;
      const confirmable = !!(
        prevSub.pending_setup_intent?.client_secret ||
        prevSub.latest_invoice?.payment_intent?.client_secret
      );
      if (samePrice && samePromos && confirmable) {
        subscription = prevSub;
        reused = true;
      }
    }

    if (!reused && promotionCodeId && capExhausted) {
      // The only redemption(s) left on this code belong to the athlete's own prior
      // attempt, but that attempt can't be reused (price changed, or it expired).
      // Creating a new sub would be hard-rejected by Stripe ("used up"), so refuse
      // with the plain truth instead of a 500.
      return res.status(400).json({ error: "That code has already been used." });
    }

    if (!reused) {
      // The stale attempt can't serve this request — retire it, then recreate with
      // the current selection (never orphaning a subscription).
      if (prevSub && prevSub.status !== "canceled" && prevSub.status !== "incomplete_expired") {
        await stripe.subscriptions.cancel(prevSub.id).catch(() => {});
      }

      // 3. Create the subscription as incomplete so the client confirms the card.
      const params = {
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: "default_incomplete",
        payment_settings: { save_default_payment_method: "on_subscription" },
        expand: ["latest_invoice.payment_intent", "pending_setup_intent"],
        metadata: {
          athlete_id: String(athlete.id),
          tier,
          billing: interval,
          ...(athlete.signup_source ? { signup_source: String(athlete.signup_source) } : {}),
          // Tester marker end-to-end: mirrors the coupon's own metadata convention so
          // finance can exclude these subs from revenue metrics off the subscription
          // alone (no need to expand discounts). tier is already stamped above.
          ...(testerApplied ? { tester_code: "true", purpose: "friend_tester" } : {}),
          // Carried onto the subscription so the invoice.paid webhook can fire a
          // server-side Meta Purchase keyed to the ad click.
          ...adMeta,
        },
      };
      if (giftApplied || testerApplied) {
        params.discounts = [{ promotion_code: promotionCodeId }]; // discount replaces the trial
      } else {
        // Event signups get the event's longer trial (e.g. 30 days at a gym table);
        // everyone else keeps the standard 7. Card is saved either way and auto-charges
        // at trial end; no card by then → the subscription cancels itself.
        params.trial_period_days = event ? event.trialDays : 7;
        params.trial_settings = { end_behavior: { missing_payment_method: "cancel" } };
      }

      subscription = await stripe.subscriptions.create(params);
    }

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

    // 5. Optimistic persist; the webhook re-syncs authoritatively. Deliberately do
    //    NOT grant the paid `tier` here unless a card is already on file: the card is
    //    confirmed client-side via the SetupIntent AFTER this call, so a fresh sub has
    //    no default_payment_method yet. Granting pro now would hand Pro to anyone who
    //    reaches checkout and leaves before paying. The webhook flips tier to pro the
    //    moment the card is attached (syncSubscription). The only time we grant here
    //    is a re-subscribe that already carries a saved payment method.
    await sbAthletePatch(athlete.id, {
      stripe_subscription_id: subscription.id,
      stripe_price_id: priceId,
      subscription_status: subscription.status,
      ...(subEntitlesPaidTier(subscription) ? { tier } : {}),
      billing: interval,
      trial_end: epochToISO(subscription.trial_end),
      current_period_end: epochToISO(subPeriodEnd(subscription)),
      cancel_at_period_end: !!subscription.cancel_at_period_end,
    });

    // 6. Mark the gifter's code redeemed (best-effort) and record on the redeemer.
    //    Skipped on reuse — the original creation already ran this, and re-running
    //    would double-count the tally on unlimited founder codes.
    if (!reused && giftApplied && promotionCodeId) {
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
      testerApplied,
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
