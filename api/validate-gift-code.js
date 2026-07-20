// Vercel serverless function — validates a friend gift code before the payment
// confirm, so the UI can show adjusted terms (or a clear inline error). The code
// is re-validated in create-subscription; never trust the client's "valid" claim.

import { applyCors, verifyAthlete, getStripe, resolvePromotionCode } from "./_stripe.js";

// Vercel Pro: cap this function's execution time. Was implicitly the Hobby 10s
// wall; 15s gives external Stripe/email/DB calls room without paying for idle time.
export const maxDuration = 15;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { athleteId, pin, code, tier } = req.body || {};

  try {
    const athlete = await verifyAthlete({ athleteId, pin });

    const clean = String(code || "").trim().toUpperCase();
    const stripe = getStripe();

    // Resolve first — we can't apply the right guards until we know whether this is
    // a gift code (Pro-only, one-per-athlete) or a tester code (product-scoped, exempt).
    const result = await resolvePromotionCode(stripe, code);
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
    if (athlete.redeemed_gift_code) {
      return res.status(200).json({ valid: false, error: "You've already redeemed a gift code." });
    }

    return res.status(200).json({
      valid: true,
      promotionCodeId: result.promotionCodeId,
      kind: "gift",
      discountLabel: "First month of Pro free",
    });
  } catch (e) {
    // Auth/validation errors carry a status; business "invalid" returns 200 above.
    return res.status(e.status || 500).json({ valid: false, error: e.message });
  }
}
