// Vercel serverless function — schedules a subscription to cancel at period end.
// Default behavior: keep access until the period end, no further charge. If the
// athlete is still in the 7-day trial, the period end IS the trial end, so this
// cancels before any charge ever happens.

import { applyCors, verifyAthlete, getStripe, sbAthletePatch, epochToISO } from "./_stripe.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { athleteId, pin } = req.body || {};

  try {
    const athlete = await verifyAthlete({ athleteId, pin });
    if (!athlete.stripe_subscription_id) {
      return res.status(400).json({ error: "No active subscription to cancel." });
    }

    const stripe = getStripe();
    const sub = await stripe.subscriptions.update(athlete.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    await sbAthletePatch(athlete.id, {
      cancel_at_period_end: true,
      subscription_status: sub.status,
      current_period_end: epochToISO(sub.current_period_end),
      trial_end: epochToISO(sub.trial_end),
    });

    return res.status(200).json({
      cancel_at_period_end: true,
      status: sub.status,
      current_period_end: epochToISO(sub.current_period_end),
      trial_end: epochToISO(sub.trial_end),
    });
  } catch (e) {
    console.error("[subscription-cancel] error:", e.message);
    return res.status(e.status || 500).json({ error: e.message });
  }
}
