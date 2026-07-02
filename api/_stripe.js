// ─── SHARED STRIPE + SUPABASE HELPERS ────────────────────────────────────────
// Imported by the WILCO subscription endpoints. The leading underscore tells
// Vercel NOT to expose this file as its own serverless route — it's a helper module.
//
// Conventions mirror the existing api/* functions: env via process.env.*, Supabase
// over REST with the SERVICE key (bypasses the project's RLS-less anon scoping so we
// can read/write any athlete from a webhook), all I/O via fetch / the stripe SDK.

import Stripe from "stripe";
import { randomInt } from "node:crypto";
import { verifyPin } from "./_supa.js";

// ── Stripe client (lazy singleton) ───────────────────────────────────────────
let _stripe = null;
export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  if (!_stripe) _stripe = new Stripe(key); // use the SDK's pinned API version
  return _stripe;
}

// ── Price map — server is the SOLE source of truth (client never sends raw IDs) ─
// Live IDs are hardcoded (provided by Will, verified live). Test IDs come from env
// so the test-mode mirrors can be swapped in without touching code. Select with
// STRIPE_MODE=test for local/sandbox testing.
const PRICES_LIVE = {
  pro:    { monthly: "price_1TdXoIRlrDCVlwEBt7EyYqvO", annual: "price_1TdXoJRlrDCVlwEBrBG40L0C" },
  elite:  { monthly: "price_1TdXoKRlrDCVlwEBMhpQgJyf", annual: "price_1TbNnhRlrDCVlwEBpCooElqY" },
  school: { monthly: "price_1TbNnkRlrDCVlwEBUiO5txAx", annual: "price_1TbNnkRlrDCVlwEBUiO5txAx" },
};
const PRICES_TEST = {
  pro:    { monthly: process.env.STRIPE_TEST_PRICE_PRO_MONTHLY,   annual: process.env.STRIPE_TEST_PRICE_PRO_ANNUAL },
  elite:  { monthly: process.env.STRIPE_TEST_PRICE_ELITE_MONTHLY, annual: process.env.STRIPE_TEST_PRICE_ELITE_ANNUAL },
  school: { monthly: process.env.STRIPE_TEST_PRICE_SCHOOL,        annual: process.env.STRIPE_TEST_PRICE_SCHOOL },
};

export const STRIPE_MODE = process.env.STRIPE_MODE === "test" ? "test" : "live";

export function getPriceMap() {
  return STRIPE_MODE === "test" ? PRICES_TEST : PRICES_LIVE;
}

// Resolve a price ID for a tier+billing. Falls back to monthly if billing missing.
export function priceFor(tier, billing) {
  const t = getPriceMap()[tier];
  if (!t) return null;
  return t[billing] || t.monthly || null;
}

// Reverse lookup used by the webhook: price ID → {tier, billing}. Checks both maps
// so a test-mode price still resolves correctly.
export function tierForPrice(priceId) {
  for (const map of [PRICES_LIVE, PRICES_TEST]) {
    for (const [tier, b] of Object.entries(map)) {
      if (!b) continue;
      if (b.monthly === priceId) return { tier, billing: "monthly" };
      if (b.annual === priceId)  return { tier, billing: "annual" };
    }
  }
  return { tier: null, billing: null };
}

// Gift coupon — same ID in live and test (we set the id explicitly when mirroring).
export const GIFT_COUPON_ID = process.env.STRIPE_GIFT_COUPON_ID || "WILCO_GIFT_PRO_MONTH";

// ── In-person event signups (tabling at gyms) ────────────────────────────────
// Server-side source of truth for event offers. A signup that arrives with a
// valid, ENABLED eventSource gets that event's longer trial instead of the
// standard 7 days; the source is stamped on the Stripe subscription metadata and
// the athlete row for per-location attribution. The client mirrors this config
// for the landing pages (src/App.jsx EVENTS) but can never grant itself the
// longer trial — only this map decides.
//
// EVENT DAY: flip `enabled` to true here (and `active` in src/App.jsx EVENTS),
// then deploy. Disabled events reject checkout outright so a leaked/early-scanned
// QR link can't redeem the offer before the event.
export const EVENT_SOURCES = {
  "crunch-aloma": {
    enabled: false, // ← EVENT-DAY SWITCH (server)
    label: "Crunch Fitness — Winter Park (Aloma)",
    trialDays: 30,
    tier: "pro", // the only tier this offer sells
  },
};

// ── Gift code generation ─────────────────────────────────────────────────────
// Branded, human-readable, unambiguous (no 0/O/1/I/L). Caller checks uniqueness
// against Stripe before creating and regenerates on collision.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function randomGiftCode() {
  // CSPRNG (crypto.randomInt) rather than Math.random — gift codes are bearer
  // credentials for a free month, so they shouldn't be predictable.
  let s = "WILCO-";
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

// ── Supabase (service key) ───────────────────────────────────────────────────
const SB_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SB_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_KEY || process.env.SUPABASE_KEY;

function sbHeaders() {
  return {
    "Content-Type": "application/json",
    apikey: SB_SERVICE_KEY,
    Authorization: `Bearer ${SB_SERVICE_KEY}`,
  };
}

export async function sbAthleteGet(id) {
  const r = await fetch(`${SB_URL}/rest/v1/athletes?id=eq.${encodeURIComponent(id)}&select=*`, {
    headers: sbHeaders(),
  });
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Generic single-column lookup (e.g. stripe_customer_id, stripe_subscription_id).
export async function sbAthleteGetBy(column, value) {
  const r = await fetch(
    `${SB_URL}/rest/v1/athletes?${column}=eq.${encodeURIComponent(value)}&select=*`,
    { headers: sbHeaders() }
  );
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Atomically claim gift-code generation for an athlete. Sets gift_codes_generated_at
// only if it is currently NULL (PostgREST filter), and returns true iff THIS call
// won the claim. Prevents duplicate generation when Stripe delivers invoice.paid more
// than once (at-least-once delivery) or near-simultaneously.
export async function claimGiftGeneration(id) {
  const r = await fetch(
    `${SB_URL}/rest/v1/athletes?id=eq.${encodeURIComponent(id)}&gift_codes_generated_at=is.null`,
    {
      method: "PATCH",
      headers: { ...sbHeaders(), Prefer: "return=representation" },
      body: JSON.stringify({ gift_codes_generated_at: new Date().toISOString() }),
    }
  );
  const json = await r.json();
  return Array.isArray(json) && json.length > 0;
}

// Release a gift-generation claim (set the flag back to NULL) so a retry can run —
// used if code creation fails after the claim was taken.
export async function releaseGiftGeneration(id) {
  await sbAthletePatch(id, { gift_codes_generated_at: null });
}

export async function sbAthletePatch(id, patch) {
  const r = await fetch(`${SB_URL}/rest/v1/athletes?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...sbHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json?.message || json?.error || `Supabase update failed (${r.status})`);
  return Array.isArray(json) && json.length ? json[0] : json;
}

// ── Auth: PIN-verify a money-endpoint caller ─────────────────────────────────
// The app has no real auth; matching the existing PIN login is the minimal,
// consistent protection (strictly better than the currently-open endpoints).
// Throws an Error with a `.status` so handlers can map it to an HTTP code.
export async function verifyAthlete({ athleteId, pin }) {
  if (!athleteId || pin === undefined || pin === null || pin === "") {
    const e = new Error("athleteId and pin are required");
    e.status = 400;
    throw e;
  }
  const athlete = await sbAthleteGet(athleteId);
  if (!athlete) {
    const e = new Error("Athlete not found");
    e.status = 404;
    throw e;
  }
  if (!(await verifyPin(pin, athlete.pin))) {
    const e = new Error("Incorrect PIN");
    e.status = 401;
    throw e;
  }
  return athlete;
}

// ── Gift / promotion code validation ─────────────────────────────────────────
// Resolve a typed code to a live, unredeemed WILCO gift promotion code.
// Returns {valid:true, promotionCodeId, promo} or {valid:false, error}.
export async function resolvePromotionCode(stripe, code) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return { valid: false, error: "Enter a gift code." };
  const list = await stripe.promotionCodes.list({ code: clean, limit: 1 });
  const promo = list.data[0];
  if (!promo) return { valid: false, error: "That gift code isn't valid." };
  if (!promo.active) return { valid: false, error: "That gift code is no longer active." };
  // The coupon id can surface as promo.coupon.id (legacy API shape) or nested under
  // promo.promotion.coupon (newer shape, e.g. founder codes minted via the newer API).
  // Accept either so a code links correctly regardless of how it was created.
  const couponId =
    promo.coupon?.id ||
    (typeof promo.promotion?.coupon === "string" ? promo.promotion.coupon : promo.promotion?.coupon?.id) ||
    null;
  if (couponId !== GIFT_COUPON_ID) return { valid: false, error: "That isn't a WILCO gift code." };
  if (promo.max_redemptions != null && promo.times_redeemed >= promo.max_redemptions)
    return { valid: false, error: "That gift code has already been used." };
  return { valid: true, promotionCodeId: promo.id, promo };
}

// Flip the matching entry on the GIFTER's profile to "redeemed" once a friend uses
// their code. The gifter is found via the promotion code's metadata.
export async function markGiftRedeemed(stripe, promotionCodeId, redeemer) {
  const promo = await stripe.promotionCodes.retrieve(promotionCodeId);
  const gifterId = promo.metadata?.gifter_athlete_id;
  if (!gifterId) return;
  const gifter = await sbAthleteGet(gifterId);
  if (!gifter || !Array.isArray(gifter.gift_codes)) return;
  const who = redeemer?.name || (redeemer?.id ? String(redeemer.id) : null);
  const now = new Date().toISOString();
  const updated = gifter.gift_codes.map((g) => {
    const match =
      g.promotion_code_id === promotionCodeId ||
      (g.code && promo.code && g.code.toUpperCase() === promo.code.toUpperCase());
    if (!match) return g;
    // Founder codes are unlimited/reusable — never flip them to "redeemed"; just
    // tally the claim so the founder can see traction. (Stripe never caps them
    // either, since they carry no max_redemptions.)
    if (g.unlimited) {
      return { ...g, redeemed_count: (g.redeemed_count || 0) + 1, last_redeemed_by: who, last_redeemed_at: now };
    }
    return { ...g, status: "redeemed", redeemed_by: who, redeemed_at: now };
  });
  await sbAthletePatch(gifterId, { gift_codes: updated });
}

// ── Misc helpers ─────────────────────────────────────────────────────────────
export const epochToISO = (s) => (s ? new Date(s * 1000).toISOString() : null);

// Period end of a subscription. Newer Stripe API versions (2025+) moved
// current_period_end from the subscription onto each subscription item, so fall
// back to the item when the top-level field is absent.
export const subPeriodEnd = (sub) =>
  sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || null;

// CORS preamble shared by the JSON endpoints. Returns true if the request was a
// preflight (handler should stop).
export function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return true;
  }
  return false;
}
