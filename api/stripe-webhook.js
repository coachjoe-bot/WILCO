// Vercel serverless function — Stripe webhook. Authoritative writer of subscription
// state, and the trigger for friend gift-code generation.
//
// Body parser MUST be disabled so we can verify the Stripe signature against the
// raw request body (same pattern as api/analyze-video.js).

import {
  getStripe,
  sbAthleteGet,
  sbAthleteGetBy,
  sbAthletePatch,
  claimGiftGeneration,
  releaseGiftGeneration,
  tierForPrice,
  epochToISO,
  subPeriodEnd,
  subEntitlesPaidTier,
  GIFT_COUPON_ID,
  randomGiftCode,
} from "./_stripe.js";

export const config = {
  api: { bodyParser: false },
};

const getRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

// Vercel Pro: cap this function's execution time. Was implicitly the Hobby 10s
// wall; 30s gives external Stripe/email/DB calls room without paying for idle time.
export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const stripe = getStripe();
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whSecret) return res.status(500).json({ error: "Missing STRIPE_WEBHOOK_SECRET" });

  let event;
  try {
    const raw = await getRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers["stripe-signature"], whSecret);
  } catch (e) {
    console.error("[stripe-webhook] signature verification failed:", e.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${e.message}` });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(event.data.object);
        break;
      case "invoice.paid":
        // Only invoice.paid (NOT invoice.payment_succeeded — both fire for one
        // payment, which would double-trigger generation).
        await handleInvoicePaid(stripe, event.data.object);
        break;
      default:
        break;
    }
  } catch (e) {
    // Return 5xx so Stripe retries — these handlers are idempotent.
    console.error(`[stripe-webhook] handler error for ${event.type}:`, e.message);
    return res.status(500).json({ error: e.message });
  }

  return res.status(200).json({ received: true });
}

// Find the athlete a Stripe object belongs to: prefer metadata, fall back to the
// persisted stripe_customer_id.
async function findAthlete(customerId, metadataAthleteId) {
  if (metadataAthleteId) {
    const a = await sbAthleteGet(metadataAthleteId);
    if (a) return a;
  }
  if (customerId) return await sbAthleteGetBy("stripe_customer_id", customerId);
  return null;
}

async function syncSubscription(sub) {
  const athlete = await findAthlete(sub.customer, sub.metadata?.athlete_id);
  if (!athlete) {
    console.warn("[stripe-webhook] no athlete for customer", sub.customer);
    return;
  }
  const priceId = sub.items?.data?.[0]?.price?.id || null;
  const { tier } = tierForPrice(priceId);

  const patch = {
    stripe_subscription_id: sub.id,
    subscription_status: sub.status,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    current_period_end: epochToISO(subPeriodEnd(sub)),
    trial_end: epochToISO(sub.trial_end),
  };
  if (priceId) patch.stripe_price_id = priceId;
  // Grant the paid tier ONLY when checkout is genuinely complete (card on file +
  // live sub). A cardless trial, an abandoned incomplete, or a canceled/lapsed sub
  // must NOT hold Pro — otherwise anyone could start checkout, bail before paying,
  // and keep it. When the plan is known but not entitled, drop to free.
  if (tier) patch.tier = subEntitlesPaidTier(sub) ? tier : "free";
  await sbAthletePatch(athlete.id, patch);
}

// Generate the subscriber's 4 single-use gift codes on their first invoice with a
// real payment (amount_paid > 0). Idempotent: a $0 gift-redeemed first invoice
// won't unlock; the later paid cycle invoice will, exactly once.
async function handleInvoicePaid(stripe, invoice) {
  if (!(invoice.amount_paid > 0)) return;

  const metaAthleteId =
    invoice.subscription_details?.metadata?.athlete_id ||
    invoice.lines?.data?.[0]?.metadata?.athlete_id ||
    null;
  const athlete = await findAthlete(invoice.customer, metaAthleteId);
  if (!athlete) {
    console.warn("[stripe-webhook] invoice.paid: no athlete for customer", invoice.customer);
    return;
  }

  // Atomic idempotency claim — only ONE invocation proceeds even if invoice.paid is
  // delivered twice or concurrently. Sets gift_codes_generated_at iff it was null.
  if (!(await claimGiftGeneration(athlete.id))) return;

  try {
    const codes = [];
    for (let i = 0; i < 4; i++) {
      let created = null;
      for (let attempt = 0; attempt < 6 && !created; attempt++) {
        const code = randomGiftCode();
        try {
          const promo = await stripe.promotionCodes.create({
            coupon: GIFT_COUPON_ID,
            code,
            max_redemptions: 1,
            metadata: { gifter_athlete_id: String(athlete.id) },
          });
          created = {
            code: promo.code,
            promotion_code_id: promo.id,
            status: "available",
            redeemed_by: null,
            redeemed_at: null,
          };
        } catch (e) {
          // Collision on the human-readable code → retry; anything else is fatal.
          if (!/already exists|already been taken|code/i.test(e.message)) throw e;
        }
      }
      if (created) codes.push(created);
    }
    await sbAthletePatch(athlete.id, { gift_codes: codes });
    console.log(`[stripe-webhook] generated ${codes.length} gift codes for athlete ${athlete.id}`);
  } catch (e) {
    // Release the claim so a Stripe retry can regenerate.
    await releaseGiftGeneration(athlete.id);
    throw e;
  }
}
