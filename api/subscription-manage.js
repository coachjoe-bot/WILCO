// Vercel serverless function — manage an existing subscription. Combines cancel,
// resume, and plan-change into one endpoint (one function) to stay within the
// Vercel Hobby 12-function limit. All actions are PIN-verified.
//   action: "cancel" | "resume" | "change"  (change also needs tier + billing)

import {
  applyCors,
  verifyAthlete,
  getStripe,
  priceFor,
  sbAthletePatch,
  epochToISO,
  subPeriodEnd,
} from "./_stripe.js";
import { logError } from "./_supa.js";

// Vercel Pro: cap this function's execution time. Was implicitly the Hobby 10s
// wall; 30s gives external Stripe/email/DB calls room without paying for idle time.
export const maxDuration = 30;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { athleteId, pin, action, tier, billing } = req.body || {};
  let athlete = null; // hoisted so the catch can attribute (only if verified)

  try {
    athlete = await verifyAthlete({ athleteId, pin });
    if (!athlete.stripe_subscription_id) {
      return res.status(400).json({ error: "No active subscription." });
    }
    const stripe = getStripe();

    // ── Cancel / resume ──────────────────────────────────────────────────────
    if (action === "cancel" || action === "resume") {
      const cancelAtPeriodEnd = action === "cancel";
      const sub = await stripe.subscriptions.update(athlete.stripe_subscription_id, {
        cancel_at_period_end: cancelAtPeriodEnd,
      });
      await sbAthletePatch(athlete.id, {
        cancel_at_period_end: cancelAtPeriodEnd,
        subscription_status: sub.status,
        current_period_end: epochToISO(subPeriodEnd(sub)),
        trial_end: epochToISO(sub.trial_end),
      });
      return res.status(200).json({
        cancel_at_period_end: cancelAtPeriodEnd,
        status: sub.status,
        current_period_end: epochToISO(subPeriodEnd(sub)),
        trial_end: epochToISO(sub.trial_end),
      });
    }

    // ── Change plan (swap price on the existing subscription) ─────────────────
    if (action === "change") {
      if (tier !== "pro" && tier !== "elite") {
        return res.status(400).json({ error: "Choose a Pro or Elite plan." });
      }
      const interval = billing === "annual" ? "annual" : "monthly";
      const priceId = priceFor(tier, interval);
      if (!priceId) return res.status(500).json({ error: `No price configured for ${tier}/${interval}.` });

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
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    console.error("[subscription-manage] error:", e.message);
    const status = e.status || e.statusCode || 500;
    // Same convention as api/create-subscription.js: ledger Stripe API errors
    // (e.type) + 5xx into error_events; routine 4xx (bad PIN etc.) stay out.
    if (status >= 500 || e.type) {
      await logError({
        source: "server", severity: "error", area: "billing", route: "api/subscription-manage",
        error_type: e.type || `http_${status}`, message: e.message, status_code: status,
        role: athlete ? "athlete" : null, actor_id: athlete?.id ?? null,
        athlete_id: athlete?.id ?? null,
        meta: { action: action ?? null, tier: tier ?? null, billing: billing ?? null },
      });
    }
    return res.status(e.status || 500).json({ error: e.message });
  }
}
