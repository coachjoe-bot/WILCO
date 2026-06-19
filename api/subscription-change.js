// Vercel serverless function — changes an EXISTING subscription's plan (tier and/or
// billing interval) by swapping the price on the subscription item. Used by the
// Settings upgrade/switch flow for athletes who already have a card on file, so no
// new card entry is needed. New subscribers go through create-subscription instead.

import { applyCors, verifyAthlete, getStripe, priceFor, sbAthletePatch, epochToISO, subPeriodEnd } from "./_stripe.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { athleteId, pin, tier, billing } = req.body || {};

  try {
    const athlete = await verifyAthlete({ athleteId, pin });
    if (tier !== "pro" && tier !== "elite") {
      return res.status(400).json({ error: "Choose a Pro or Elite plan." });
    }
    if (!athlete.stripe_subscription_id) {
      return res.status(400).json({ error: "No active subscription to change. Subscribe first." });
    }
    const interval = billing === "annual" ? "annual" : "monthly";
    const priceId = priceFor(tier, interval);
    if (!priceId) return res.status(500).json({ error: `No price configured for ${tier}/${interval}.` });

    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(athlete.stripe_subscription_id);
    const itemId = sub.items?.data?.[0]?.id;
    if (!itemId) return res.status(400).json({ error: "Subscription has no billable item." });

    const updated = await stripe.subscriptions.update(sub.id, {
      items: [{ id: itemId, price: priceId }],
      proration_behavior: "create_prorations",
      cancel_at_period_end: false,
    });

    await sbAthletePatch(athlete.id, {
      tier,
      billing: interval,
      stripe_price_id: priceId,
      subscription_status: updated.status,
      current_period_end: epochToISO(subPeriodEnd(updated)),
      cancel_at_period_end: !!updated.cancel_at_period_end,
    });

    return res.status(200).json({ ok: true, tier, billing: interval, status: updated.status });
  } catch (e) {
    console.error("[subscription-change] error:", e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
