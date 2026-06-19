-- ─── STRIPE SUBSCRIPTIONS ────────────────────────────────────────────────────
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query → Run)
-- Idempotent — safe to re-run.

-- 1. Subscription + billing state on athletes.
--    `tier` (free/pro/elite) and `billing` (monthly/annual) already exist; these
--    columns add the Stripe linkage and the authoritative subscription status that
--    the webhook keeps in sync. `tier` is plain TEXT today so the new value
--    "school" needs no schema change.
ALTER TABLE athletes
  ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT,
  ADD COLUMN IF NOT EXISTS stripe_price_id         TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status     TEXT,         -- trialing|active|past_due|canceled|incomplete|incomplete_expired|unpaid
  ADD COLUMN IF NOT EXISTS current_period_end      TIMESTAMPTZ,  -- renewal / charge date
  ADD COLUMN IF NOT EXISTS trial_end               TIMESTAMPTZ,  -- end of 7-day trial (null for gift-code redeemers)
  ADD COLUMN IF NOT EXISTS cancel_at_period_end    BOOLEAN     DEFAULT FALSE,
  -- 2. Friend-gift codes. Exactly 4 per subscriber, always read with the athlete row.
  --    Shape: [{code, promotion_code_id, status:"available"|"redeemed", redeemed_by, redeemed_at}]
  ADD COLUMN IF NOT EXISTS gift_codes              JSONB,
  ADD COLUMN IF NOT EXISTS gift_codes_generated_at TIMESTAMPTZ,  -- idempotency flag: codes generated exactly once
  ADD COLUMN IF NOT EXISTS redeemed_gift_code      TEXT;         -- the code THIS athlete redeemed (self-redeem guard / audit)

-- 3. Lookup indexes — the webhook resolves an athlete by Stripe customer/subscription id.
CREATE INDEX IF NOT EXISTS athletes_stripe_customer_idx     ON athletes (stripe_customer_id);
CREATE INDEX IF NOT EXISTS athletes_stripe_subscription_idx ON athletes (stripe_subscription_id);
