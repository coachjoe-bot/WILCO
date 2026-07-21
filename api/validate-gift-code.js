// Vercel serverless function — validates a friend gift code before the payment
// confirm, so the UI can show adjusted terms (or a clear inline error). The code
// is re-validated in create-subscription; never trust the client's "valid" claim.

import {
  applyCors, verifyAthlete, getStripe, resolvePromotionCode,
  describeCoupon, couponTerms, codeIsAnnualSafe,
} from "./_stripe.js";

// Vercel Pro: cap this function's execution time. Was implicitly the Hobby 10s
// wall; 15s gives external Stripe/email/DB calls room without paying for idle time.
export const maxDuration = 15;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { athleteId, pin, code, tier, billing } = req.body || {};

  try {
    const athlete = await verifyAthlete({ athleteId, pin });

    const clean = String(code || "").trim().toUpperCase();
    const stripe = getStripe();

    // Codes the athlete's own UNFINISHED checkout attempt already redeemed (Stripe
    // burns the slot at sub creation, never refunds it). Those slots are theirs, so
    // a fully-redeemed code they hold must still validate — mirrors the reuse logic
    // in create-subscription. A completed sub doesn't vouch: that redemption is done.
    let heldPromoIds;
    if (athlete.stripe_subscription_id) {
      try {
        const prev = await stripe.subscriptions.retrieve(athlete.stripe_subscription_id, {
          expand: ["discounts"],
        });
        if (!prev.default_payment_method) {
          heldPromoIds = new Set(
            (prev.discounts || [])
              .map((d) => (typeof d === "string" ? null
                : typeof d.promotion_code === "string" ? d.promotion_code : d.promotion_code?.id))
              .filter(Boolean)
          );
        }
      } catch { /* sub gone — no held slots */ }
    }

    // Resolve first — we can't apply the right guards until we know whether this is
    // a gift code (Pro-only, one-per-athlete) or a tester code (product-scoped, exempt).
    const result = await resolvePromotionCode(stripe, code, { heldPromoIds });
    if (!result.valid) return res.status(200).json({ valid: false, error: result.error });

    // ── Tester code: pairs with its own tier only; exempt from the gift guards ──
    if (result.kind === "tester") {
      const tierLabel = result.tier === "elite" ? "Elite" : "Pro";
      if (tier && tier !== result.tier) {
        return res.status(200).json({ valid: false, error: `This tester code is for the ${tierLabel} plan.` });
      }
      return res.status(200).json({
        valid: true,
        promotionCodeId: result.promotionCodeId,
        kind: "tester",
        tier: result.tier,
        discountLabel: `${tierLabel} unlocked — tester access, always free`,
      });
    }

    // ── Gift code: Pro-only, with self-redeem + one-per-athlete guards ──
    if (tier && tier !== "pro") {
      return res.status(200).json({ valid: false, error: "This gift code is valid for Pro plans only." });
    }
    const owned = Array.isArray(athlete.gift_codes) ? athlete.gift_codes : [];
    if (owned.some((g) => g.code?.toUpperCase() === clean)) {
      return res.status(200).json({ valid: false, error: "You can't redeem your own gift code." });
    }
    // Same code = the athlete retrying their own in-flight redemption (stamped at
    // sub creation, before the card confirms) — matches create-subscription.
    if (athlete.redeemed_gift_code && athlete.redeemed_gift_code !== clean) {
      return res.status(200).json({ valid: false, error: "You've already redeemed a gift code." });
    }
    // Mirrors the same guard in create-subscription — catch it here so the athlete
    // sees it on Apply rather than after filling in a card.
    if (billing === "annual" && !codeIsAnnualSafe(result.coupon)) {
      return res.status(200).json({ valid: false, error: "This code applies to the monthly plan." });
    }

    return res.status(200).json({
      valid: true,
      promotionCodeId: result.promotionCodeId,
      kind: "gift",
      discountLabel: describeCoupon(result.coupon),
      // Terms drive the payment disclosure copy on the client.
      terms: couponTerms(result.coupon),
    });
  } catch (e) {
    // Auth/validation errors carry a status; business "invalid" returns 200 above.
    return res.status(e.status || 500).json({ valid: false, error: e.message });
  }
}
