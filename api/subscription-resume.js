// Vercel serverless function — undoes a pending cancellation while the
// subscription is still active or trialing (clears cancel_at_period_end).

import { applyCors, verifyAthlete, getStripe, sbAthletePatch, epochToISO, subPeriodEnd } from "./_stripe.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { athleteId, pin } = req.body || {};

  try {
    const athlete = await verifyAthlete({ athleteId, pin });
    if (!athlete.stripe_subscription_id) {
      return res.status(400).json({ error: "No subscription to resume." });
    }

    const stripe = getStripe();
    const sub = await stripe.subscriptions.update(athlete.stripe_subscription_id, {
      cancel_at_period_end: false,
    });

    await sbAthletePatch(athlete.id, {
      cancel_at_period_end: false,
      subscription_status: sub.status,
      current_period_end: epochToISO(subPeriodEnd(sub)),
      trial_end: epochToISO(sub.trial_end),
    });

    return res.status(200).json({
      cancel_at_period_end: false,
      status: sub.status,
      current_period_end: epochToISO(subPeriodEnd(sub)),
      trial_end: epochToISO(sub.trial_end),
    });
  } catch (e) {
    console.error("[subscription-resume] error:", e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
