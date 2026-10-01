// ─── SHARED STRIPE + SUPABASE HELPERS ────────────────────────────────────────
// Imported by the WILCO subscription endpoints. The leading underscore tells
// Vercel NOT to expose this file as its own serverless route — it's a helper module.
//
// Conventions mirror the existing api/* functions: env via process.env.*, Supabase
// over REST with the SERVICE key (bypasses the project's RLS-less anon scoping so we
// can read/write any athlete from a webhook), all I/O via fetch / the stripe SDK.

import Stripe from "stripe";
import { randomInt } from "node:crypto";
import { verifyPin, tryTokenAuth } from "./_supa.js";

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
// T44 (08-10): Pro annual cut $150/yr → $99/yr. Stripe prices are immutable on
// amount, so this is a NEW price object, not an edit. `scripts/stripe-t44-pricing.mjs`
// creates it against the live key and writes the id in below.
//
// Deliberately NOT defaulted to the old $150 id: if this is unset, the UI would
// advertise $99 while Stripe charged $150, which is the one failure mode that
// costs a refund conversation instead of a bug report. Unset = annual checkout
// refuses (see priceFor), which is loud and free.
const PRO_ANNUAL_99 = process.env.STRIPE_PRICE_PRO_ANNUAL || "price_1U34g7RlrDCVlwEBiHa8hsb5";

// Pro's monthly list price in cents. Mirrors PRICE_CENTS.pro.monthly in src/App.jsx
// (display) and the live Stripe price (billing). Used here to turn a founding
// coupon's dollar discount back into the price the athlete actually pays.
export const PRO_MONTHLY_CENTS = 1499;

const PRICES_LIVE = {
  pro:    { monthly: "price_1TdXoIRlrDCVlwEBt7EyYqvO", annual: PRO_ANNUAL_99 },
  elite:  { monthly: "price_1TdXoKRlrDCVlwEBMhpQgJyf", annual: "price_1TbNnhRlrDCVlwEBpCooElqY" },
  school: { monthly: "price_1TbNnkRlrDCVlwEBUiO5txAx", annual: "price_1TbNnkRlrDCVlwEBUiO5txAx" },
};

// Retired prices. Nothing new can be sold at these, but athletes who bought at the
// old price keep it forever (Stripe never re-prices an existing subscription), and
// their renewal webhooks still carry the old price id. Without this map
// tierForPrice() would return {tier:null} on every legacy renewal and quietly
// demote a paying annual subscriber to free.
const PRICES_LEGACY = {
  pro: { annual: "price_1TdXoJRlrDCVlwEBrBG40L0C" }, // $150/yr, retired 08-10 (T44)
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
// EXCEPT for an explicit annual ask: if the annual price isn't configured we return
// null so checkout fails, rather than silently selling a monthly plan to someone who
// picked (and was quoted) a year.
export function priceFor(tier, billing) {
  const t = getPriceMap()[tier];
  if (!t) return null;
  if (billing === "annual") return t.annual || null;
  return t[billing] || t.monthly || null;
}

// Reverse lookup used by the webhook: price ID → {tier, billing}. Checks both maps
// so a test-mode price still resolves correctly.
export function tierForPrice(priceId) {
  // Bail on a missing price. PRICES_TEST's entries are `undefined` whenever the
  // STRIPE_TEST_PRICE_* env vars aren't set (i.e. on prod), so without this guard
  // `tierForPrice(undefined)` matched `pro.monthly === undefined` and reported
  // PRO — a webhook event that arrived without a price would silently grant a
  // paid tier. Same for a falsy entry inside a map.
  if (!priceId) return { tier: null, billing: null };
  for (const map of [PRICES_LIVE, PRICES_TEST, PRICES_LEGACY]) {
    for (const [tier, b] of Object.entries(map)) {
      if (!b) continue;
      if (b.monthly && b.monthly === priceId) return { tier, billing: "monthly" };
      if (b.annual && b.annual === priceId)  return { tier, billing: "annual" };
    }
  }
  return { tier: null, billing: null };
}

// Gift coupon — same ID in live and test (we set the id explicitly when mirroring).
export const GIFT_COUPON_ID = process.env.STRIPE_GIFT_COUPON_ID || "WILCO_GIFT_PRO_MONTH";

// Other Pro discount coupons that redeem through the SAME path as a friend gift:
// Pro-only, one per athlete, and the holder stays a normal customer in the revenue
// metrics (unlike a tester code) — they just carry a discount for a while. Add a
// coupon here whenever one is minted in Stripe, or the code is rejected in-app as
// "That isn't a WILCO code" no matter how valid Stripe thinks it is.
//   grip-test champ — event prize, 100% off for 3 months, capped at 2 redemptions
//   founding free / $5 / $4.99 — founding cohort, forever discounts, capped in Stripe
export const GIFT_COUPON_IDS = new Set([
  GIFT_COUPON_ID,
  process.env.STRIPE_GRIP_TEST_COUPON_ID || "WILCO_GRIP_TEST_CHAMP_3MO",
  process.env.STRIPE_FOUNDING_FREE_COUPON_ID || "WILCO_FOUNDING_FREE_FOREVER",
  process.env.STRIPE_FOUNDING_5_COUPON_ID || "WILCO_FOUNDING_5_FOREVER",
  process.env.STRIPE_FOUNDING_499_COUPON_ID || "WILCO_FOUNDING_499_FOREVER",
]);

// Founding-cohort coupons are MONTHLY-ONLY, and this set is what enforces it.
//
// They are `amount_off` in dollars, not a percentage, so their discount is only
// meaningful against the monthly list price: WILCO_FOUNDING_499_FOREVER takes
// $10.00 off, which is the intended $4.99/mo against a $14.99 list — but applied
// to the $99 ANNUAL price the very same coupon reads as $89/yr, an offer nobody
// designed and roughly 1.5x what the founding athlete was promised for a year.
// codeIsAnnualSafe() can't catch it: these are `duration:"forever"`, not
// `repeating`, so that gate passes them. Stripe-side `applies_to` can't catch it
// either — monthly and annual Pro are two prices on ONE product.
//
// If a founding tier should ever be sellable annually, it needs its own PRICE
// (e.g. $59.88/yr), not a coupon. Do not "fix" this by widening the gate.
export const FOUNDING_COUPON_IDS = new Set([
  process.env.STRIPE_FOUNDING_FREE_COUPON_ID || "WILCO_FOUNDING_FREE_FOREVER",
  process.env.STRIPE_FOUNDING_5_COUPON_ID || "WILCO_FOUNDING_5_FOREVER",
  process.env.STRIPE_FOUNDING_499_COUPON_ID || "WILCO_FOUNDING_499_FOREVER",
]);

// Tester coupons — 100%-off-FOREVER, product-scoped, capped (25 redemptions each).
// Redeemable in-app through the same code field as gift codes, but they mark the
// subscription as a friend-tester (excluded from all revenue metrics — see
// ~/Documents/WILCO-Finance/engine/report-preferences.md). The map keys the live
// coupon id to the tier it unlocks; a tester code only pairs with its own tier's
// price. Env overrides let the test-mode mirrors swap in without touching code.
export const TESTER_COUPONS = {
  [process.env.STRIPE_TESTER_PRO_COUPON_ID || "WILCO_TESTER_PRO_FOREVER"]: "pro",
  [process.env.STRIPE_TESTER_ELITE_COUPON_ID || "WILCO_TESTER_ELITE_FOREVER"]: "elite",
};

// Comped coupons (Will 09-29: "never ask to charge anyone I give a 100% discount
// to"). A subscription carrying one of these makes its athlete `comped`: the app
// never asks them to pay again, the nightly reconcile never calls them an orphan.
// Deliberately the SAME sets as above, not a new list: every tester coupon plus
// the founding FREE coupon. Not the 3-month grip-test prize and not the 1-month
// friend gift: those are 100% off for a while, then they pay. A comped coupon must
// be 100% off FOREVER on the coupon itself (couponTerms.freeForever), so a coupon
// that is one of these ids but somehow is not free forever grants nothing.
export const COMPED_COUPON_IDS = new Set([
  ...Object.keys(TESTER_COUPONS),
  process.env.STRIPE_FOUNDING_FREE_COUPON_ID || "WILCO_FOUNDING_FREE_FOREVER",
]);

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
    enabled: true, // ← EVENT-DAY SWITCH (server)
    label: "Crunch Fitness, Winter Park (Aloma)",
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
// Service key ONLY — never the anon key. The old chain fell back to
// VITE_SUPABASE_KEY (the PUBLIC anon key shipped in the browser bundle), so if
// SUPABASE_SERVICE_KEY were ever renamed/unset the Stripe webhook's athlete
// reads/patches would silently run as RLS-denied anon and tier grants would stop
// with no error anywhere. Chain now matches _supa.js's service-key candidates
// (prod sets SUPABASE_SERVICE_KEY); a missing key fails LOUDLY per request below.
const SB_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY;

function sbHeaders() {
  // Throw here (per call) rather than at module scope so importing this shared
  // helper for Stripe-only paths still works, but any Supabase read/write on a
  // misconfigured deploy errors visibly instead of silently doing nothing.
  if (!SB_SERVICE_KEY) throw new Error("Missing SUPABASE_SERVICE_KEY (Supabase service key)");
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

// Find-or-create the athlete's Stripe customer, persisting the id immediately so
// a retried call never creates a duplicate. Extracted from create-subscription so
// checkout-intent (SetupIntent-first flow) and the card-first subscribe share
// ONE copy — the metadata mirror (signup_source + ad identity) must never drift
// between them.
export async function ensureStripeCustomer(stripe, athlete, extraMeta = {}) {
  if (athlete.stripe_customer_id) return athlete.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: athlete.email || undefined,
    name: athlete.name || undefined,
    metadata: {
      athlete_id: String(athlete.id),
      // Mirror the attribution already stored on the athlete row (event key or
      // free-form UTM/referrer source) so Stripe and Supabase never disagree.
      ...(athlete.signup_source ? { signup_source: String(athlete.signup_source) } : {}),
      ...extraMeta,
    },
  });
  await sbAthletePatch(athlete.id, { stripe_customer_id: customer.id });
  return customer.id;
}

// Meta click identifiers for server-side Purchase attribution. Validated to
// their documented shapes so a crafted body can't stuff arbitrary text into
// Stripe metadata. fbc: fb.<n>.<ms>.<fbclid>  fbp: fb.<n>.<ms>.<rand>
// (Moved here from create-subscription so checkout-intent applies the identical
// validation when it stamps the customer.)
export function adIdentityMeta(ad) {
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
  return adMeta;
}

// List athletes matching a raw PostgREST query string (service key — reconcile
// cron + internal reads only, never client-reachable directly).
export async function sbAthletesWhere(queryString) {
  const r = await fetch(`${SB_URL}/rest/v1/athletes?${queryString}`, { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) throw new Error(rows?.message || rows?.error || `Supabase query failed (${r.status})`);
  return Array.isArray(rows) ? rows : [];
}

// ── Auth: verify a money-endpoint caller ─────────────────────────────────────
// Token FIRST, PIN as fallback. These three billing endpoints were the last
// gateways still demanding the plaintext PIN on every call — data/claude/push all
// take the signed session token. Two costs, both real: ~100-250ms of bcrypt on
// every checkout render (create-subscription re-runs on each plan/code change),
// and the client had to keep the plaintext PIN in memory for the whole billing
// flow just to satisfy these.
//
// `auth` is the same {role,id,token} blob every other gateway accepts. A token
// that verifies loads the SAME athlete row verifyAthlete would have returned, so
// nothing downstream changes. An absent/expired/forged token silently degrades to
// the PIN path — tryTokenAuth returns null rather than throwing, exactly as in
// api/data.js — so an old cached client keeps working unchanged.
// Which athlete a session token entitles this call to act as, or null to fall back
// to the PIN. Pure, and separated out because it IS the authorization rule for the
// money endpoints: a coach token must never satisfy it, and a token must never be
// usable to act on a DIFFERENT athleteId than the one it was minted for. Covered
// in scripts/test-auth-logic.mjs.
export function tokenAthleteId(auth, athleteId) {
  const viaToken = tryTokenAuth(auth);
  if (!viaToken || viaToken.role !== "athlete") return null;
  if (athleteId && String(viaToken.id) !== String(athleteId)) return null;
  return viaToken.id;
}

export async function verifyAthlete({ athleteId, pin, auth }) {
  const tokenId = tokenAthleteId(auth, athleteId);
  if (tokenId) {
    const athlete = await sbAthleteGet(tokenId);
    if (athlete) return athlete;
    const e = new Error("Athlete not found");
    e.status = 404;
    throw e;
  }
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
// Resolve a typed code to a live, unredeemed WILCO promotion code. Accepts both
// friend gift + other Pro discount codes (GIFT_COUPON_IDS) and testers (TESTER_COUPONS).
// Returns { valid:true, promotionCodeId, promo, coupon, kind:"gift"|"tester", tier }
// where tier is the tester code's scoped tier (null for gift codes), or
// { valid:false, error }. The coupon is fetched so callers can describe the actual
// terms — a gift code is no longer always "one free month".
// opts.heldPromoIds — promotion-code ids already redeemed by the caller's own
// unfinished subscription attempt. Stripe burns a redemption slot at sub creation
// and never returns it (not on cancel, not on discount removal — verified
// 2026-07-21), so on a capped code the athlete's own retry occupies a slot. A
// held code must keep validating for them or their retry locks them out.
export async function resolvePromotionCode(stripe, code, { heldPromoIds } = {}) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return { valid: false, error: "Enter a code." };
  const list = await stripe.promotionCodes.list({ code: clean, limit: 1 });
  const promo = list.data[0];
  if (!promo) return { valid: false, error: "That code isn't valid." };
  // Stripe flips `active` to false BY ITSELF the moment max_redemptions is hit, so
  // "inactive because the caller's own attempt filled the cap" must fall through to
  // the held-slot carve-out below — only a manual deactivation is a hard stop here.
  const capFull = promo.max_redemptions != null && promo.times_redeemed >= promo.max_redemptions;
  const heldByCaller = !!(heldPromoIds && heldPromoIds.has(promo.id));
  if (!promo.active && !(capFull && heldByCaller)) {
    return { valid: false, error: "That code is no longer active." };
  }
  // The coupon id can surface as promo.coupon.id (legacy API shape) or nested under
  // promo.promotion.coupon (newer shape, e.g. founder codes minted via the newer API).
  // Accept either so a code links correctly regardless of how it was created.
  const couponId =
    promo.coupon?.id ||
    (typeof promo.promotion?.coupon === "string" ? promo.promotion.coupon : promo.promotion?.coupon?.id) ||
    null;

  const testerTier = TESTER_COUPONS[couponId] || null; // "pro" | "elite" | null
  const isGift = GIFT_COUPON_IDS.has(couponId);
  if (!testerTier && !isGift) return { valid: false, error: "That isn't a WILCO code." };

  if (capFull && !heldByCaller)
    return {
      valid: false,
      error: testerTier ? "That tester code has been fully redeemed." : "That gift code has already been used.",
    };

  // Terms live on the coupon, not the promotion code, and the newer API shape
  // returns it as a bare id — retrieve it so the caller can label the offer.
  let coupon = null;
  try { coupon = await stripe.coupons.retrieve(couponId); } catch { /* label falls back */ }

  return {
    valid: true,
    promotionCodeId: promo.id,
    promo,
    coupon,
    kind: testerTier ? "tester" : "gift",
    tier: testerTier,
  };
}

// Machine-readable terms for a coupon. The client needs these to write an accurate
// auto-renew disclosure (what's free, for how long, what gets charged and when) —
// it used to assume every code was the one-month gift, which is now wrong.
//   freeForever  — 100% off with no end (tester-style)
//   freeMonths   — fully-free months at the start (0 when it's only a partial discount)
//   amountOff    — cents off each discounted invoice (0 for percent-based)
//   repeating    — discount spans a fixed number of months (see annual guard below)
export function couponTerms(coupon) {
  if (!coupon) return { freeForever: false, freeMonths: 0, amountOff: 0, percentOff: 0, repeating: false, forever: false };
  const repeating = coupon.duration === "repeating";
  const months = repeating ? coupon.duration_in_months || 1 : 1;
  const full = coupon.percent_off === 100;
  return {
    freeForever: full && coupon.duration === "forever",
    freeMonths: full && coupon.duration !== "forever" ? months : 0,
    amountOff: coupon.amount_off || 0,
    percentOff: coupon.percent_off || 0,
    repeating,
    forever: coupon.duration === "forever",
  };
}

// Does this coupon comp its holder? (100% off forever AND on the comped list.)
export const couponComps = (coupon) =>
  !!coupon && COMPED_COUPON_IDS.has(coupon.id) && couponTerms(coupon).freeForever;

// Does this Stripe subscription carry a comping coupon? Pure over the payload it
// is given. Discounts arrive as objects (coupon under `coupon` on older API
// versions, under `source.coupon` on newer ones) or as bare ids when the event was
// not expanded. Returns { comped, unresolved }: unresolved means "an id or a bare
// coupon id on the comped list is in there and I could not read its terms", which
// subCompsAsync settles with one Stripe read.
export function subCompingCoupon(sub) {
  const entries = [];
  if (sub?.discount) entries.push(sub.discount);
  if (Array.isArray(sub?.discounts)) entries.push(...sub.discounts);
  let unresolved = false;
  for (const d of entries) {
    if (!d) continue;
    if (typeof d === "string") { unresolved = true; continue; }
    const c = d.coupon || d.source?.coupon;
    if (!c) continue;
    if (typeof c === "string") {
      if (COMPED_COUPON_IDS.has(c)) unresolved = true; // on the list, terms unread
      continue;
    }
    if (couponComps(c)) return { comped: true, unresolved: false };
  }
  return { comped: false, unresolved };
}

// Async twin for webhook events: expand bare discount ids, then read a listed
// coupon's terms. Never throws: a Stripe hiccup answers false and the next
// subscription event tries again. Read-only against Stripe.
export async function subCompsAsync(stripe, sub) {
  try {
    let r = subCompingCoupon(sub);
    if (r.comped) return true;
    if (!r.unresolved) return false;
    let full = sub;
    if ((sub.discounts || []).some((d) => typeof d === "string")) {
      full = await stripe.subscriptions.retrieve(sub.id, { expand: ["discounts"] });
      r = subCompingCoupon(full);
      if (r.comped) return true;
      if (!r.unresolved) return false;
    }
    for (const d of [full.discount, ...(full.discounts || [])]) {
      const c = d && typeof d === "object" ? (d.coupon || d.source?.coupon) : null;
      if (typeof c === "string" && COMPED_COUPON_IDS.has(c) && couponComps(await stripe.coupons.retrieve(c))) return true;
    }
    return false;
  } catch (e) {
    console.error("[stripe] comped-coupon check failed:", e.message);
    return false;
  }
}

// Human terms for a coupon, shown at the Apply-code step ("First 3 months of Pro
// free"). Derived from the coupon itself so a new offer never inherits another's
// copy — the 3-month event prize and the founding discounts all read correctly.
export function describeCoupon(coupon, tierLabel = "Pro") {
  const t = couponTerms(coupon);
  if (!coupon) return `${tierLabel} discount applied`;
  const span = coupon.duration === "forever" ? "every month"
    : t.repeating && coupon.duration_in_months > 1 ? `for ${coupon.duration_in_months} months`
    : "your first month";
  if (t.freeForever) return `${tierLabel} free, always`;
  // Founding cohort: say the price they'll actually pay, not the size of the
  // discount. "$10.00 off every month" is true but makes the reader do arithmetic
  // to find out this is the $4.99 offer they clicked on.
  if (FOUNDING_COUPON_IDS.has(coupon.id) && t.amountOff && coupon.duration === "forever") {
    return `${tierLabel} for $${((PRO_MONTHLY_CENTS - t.amountOff) / 100).toFixed(2)}/month, for life`;
  }
  if (t.freeMonths > 1) return `First ${t.freeMonths} months of ${tierLabel} free`;
  if (t.freeMonths === 1) return `First month of ${tierLabel} free`;
  if (t.percentOff) return `${t.percentOff}% off ${span}`;
  if (t.amountOff) return `$${(t.amountOff / 100).toFixed(2)} off ${span}`;
  return `${tierLabel} discount applied`;
}

// A month-scoped discount on the ANNUAL price is a trap: Stripe applies a
// "repeating, 3 months" coupon to the whole yearly invoice, so a 3-months-free
// prize would silently hand over a free YEAR. Month-scoped codes are monthly-only.
// Is this code safe to apply to the ANNUAL price? Two independent traps:
//   • `repeating` — "3 months free" against a yearly invoice discounts the whole
//     year, i.e. hands over a free year.
//   • founding — see FOUNDING_COUPON_IDS: dollar-amount discounts sized for the
//     $14.99 monthly price are meaningless against $99/yr, and `duration:"forever"`
//     sails straight through the repeating check.
export const codeIsAnnualSafe = (coupon) =>
  !couponTerms(coupon).repeating && !FOUNDING_COUPON_IDS.has(coupon?.id);

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

// Does this subscription entitle its athlete to the PAID tier? Only when checkout
// is genuinely complete: a payment method is on file AND the subscription is live.
// A trialing/active sub with NO default_payment_method is an abandoned or not-yet-
// funded checkout — entitling it would hand Pro to anyone who starts signup and
// walks away before adding a card (login has no paywall). Every subscription here
// is created with save_default_payment_method:"on_subscription", so a finished
// checkout — trial, gift/$0, or paid — always populates default_payment_method,
// making this a reliable "checkout done" signal. This is the single source of truth
// for granting `tier`; keep create-subscription and the webhook using it.
export const subEntitlesPaidTier = (sub) =>
  !!sub?.default_payment_method &&
  ["trialing", "active", "past_due"].includes(sub?.status);

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
