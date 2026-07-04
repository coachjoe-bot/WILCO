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

    // Coupon is Pro-restricted — fail fast for Elite so Stripe doesn't reject at charge time.
    if (tier && tier !== "pro") {
      return res.status(200).json({ valid: false, error: "This gift code is valid for Pro plans only." });
    }

    const clean = String(code || "").trim().toUpperCase();

    // Self-redeem guard: a gifter can't use one of their own codes.
    const owned = Array.isArray(athlete.gift_codes) ? athlete.gift_codes : [];
    if (owned.some((g) => g.code?.toUpperCase() === clean)) {
      return res.status(200).json({ valid: false, error: "You can't redeem your own gift code." });
    }
    if (athlete.redeemed_gift_code) {
      return res.status(200).json({ valid: false, error: "You've already redeemed a gift code." });
    }

    const stripe = getStripe();
    const result = await resolvePromotionCode(stripe, code);
    if (!result.valid) return res.status(200).json({ valid: false, error: result.error });

    return res.status(200).json({
      valid: true,
      promotionCodeId: result.promotionCodeId,
      discountLabel: "First month of Pro free",
    });
  } catch (e) {
    // Auth/validation errors carry a status; business "invalid" returns 200 above.
    return res.status(e.status || 500).json({ valid: false, error: e.message });
  }
}
