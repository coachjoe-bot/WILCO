# Stripe Integration — Status & Runbook

**T37 checkout re-order (2026-08-07, `checkout-reorder-0807`): card-first.** The
payment screen used to call `create-subscription` on MOUNT, minting a live
`trialing` subscription before any card existed — every abandoned checkout left
an orphan sub (10 of the first 19 subs ever created), and Stripe/Supabase
permanently disagreed about who was trialing. New invariant: **a subscription
never exists without a payment method.** Flow now: mount → `api/checkout-intent`
(SetupIntent only, plan-agnostic, inert if abandoned) → athlete confirms the card
→ `create-subscription` with `paymentMethodId` → sub is born with
`default_payment_method` set → tier granted in the SAME request (webhook stays
authoritative for renewals/cancels). A real first charge (discounted annual)
returns `needsAction` + a PaymentIntent secret for one `confirmCardPayment`
(3DS-safe). Side effects: plan/gift changes no longer touch Stripe (duplicate-sub
bug gone), and a compatible prior attempt gets the card ATTACHED rather than
cancel+recreate (capped promo slots preserved). The legacy eager-create branch in
`create-subscription` was DELETED (T68, 2026-09-29): a request with no
`paymentMethodId` now gets a 400 ("...refresh the app and try again") and creates
nothing in Stripe or Supabase; `scripts/test-checkout-lifecycle.mjs` pins it.
Nightly `api/reconcile-billing` cron (07:15 UTC) diffs Stripe against Supabase
into `error_events`; pure logic pinned by `scripts/test-checkout-lifecycle.mjs`.

**Test-mode runbook addition (T37):** with `STRIPE_MODE=test`, walk signup to the
card form and (1) abandon it → assert NO subscription exists in test Stripe, only
an unconsumed SetupIntent; (2) complete it with 4242… → assert the sub is created
already carrying `default_payment_method` and the athlete row flips to the paid
tier without waiting for the webhook; (3) apply a gift code then switch plans →
assert no new Stripe objects appear until the final submit.

**T18 iOS external-checkout branch (2026-07-29, `payments-external-0729`, not yet
merged):** adds a standalone, unlinked `/upgrade` page on THIS SAME app so the
Capacitor iOS build never ships the embedded Stripe Elements PaymentStep (App
Review 3.1.1). Zero changes to `create-subscription` / `stripe-webhook` /
`subscription-manage` / `_stripe.js` — the page just mounts the existing
`PaymentStep` after exchanging a short-lived, one-time signed "checkout token"
(minted by `api/identity.js` action `mint-checkout-token`, consumed by
`resolve-checkout-token`, crypto in `api/_supa.js`) for a normal session token.
**Before this branch's preview can complete a real checkout, run the migration**
`supabase/migrations/20260729_checkout_tokens.sql` (two new nullable columns on
`athletes`: `checkout_token_jti`, `checkout_token_exp` — additive, safe on the
live table) — not auto-applied by this agent, same manual-apply convention as
every migration below. See `docs/` / the T18 report for the full design.

**STATUS (updated 2026-06-25): LIVE in production.** Merged to `main` and serving on
`app.trainwilco.com`. `STRIPE_MODE` defaults to **live** (`api/_stripe.js`), and the
subscription endpoints (`create-subscription`, `stripe-webhook`, `subscription-manage`,
`validate-gift-code`) are all on `main`. The checklist below is retained as the
**test/setup runbook** and historical record — not a list of open work.

> Re-verify once if you haven't personally confirmed: the
> `20260619_stripe_subscriptions.sql` migration is applied in Supabase, and a **live**
> webhook endpoint + signing secret are configured in Vercel (`customer.subscription.*`,
> `invoice.paid`).

## What's done (code-complete, build passes)
- **Onboarding restructured** (`src/App.jsx`): plan selection moved to the last data step
  (step 14); a new **payment step** (15) follows for Pro/Elite. School-code athletes skip
  plan + payment (`tier:"school"`). Free → no payment. The athlete row is now created at
  step 13 (before any Stripe call).
- **In-app payment** via Stripe Elements (Payment Element, no redirect): 7-day trial
  subscription (`trial_period_days: 7`), card saved via SetupIntent. Required disclosures
  (price, exact charge date, auto-renewal, cancel instructions, T&C + Privacy links) render
  above the pay button.
- **Gift codes**: optional field on the payment step (Pro only); 4 single-use codes generated
  per subscriber on their first paid invoice (`invoice.paid`, `amount_paid > 0`), shown in
  Settings. Elite + code rejected; self-redeem blocked.
- **Cancel / resume** (`Settings → Your Plan`): real Stripe `cancel_at_period_end`, PIN-gated.
  Trial cancel = no charge. Status + renewal/trial date shown.
- **Backend** (`api/`): `_stripe.js` (shared), `create-subscription`, `validate-gift-code`,
  `subscription-cancel`, `subscription-resume`, `subscription-change`, `stripe-webhook`.
  Money endpoints are **PIN-verified**. Webhook verifies the Stripe signature and is the
  authoritative writer of subscription state.
- **DB migration**: `supabase/migrations/20260619_stripe_subscriptions.sql`.

## Build-time caveats (historical — resolved by going live)
These were the open items when this was first built on a branch; the integration has
since been deployed live. Re-verify any you haven't personally confirmed:
- **End-to-end testing** — run the test-mode steps below before/after major changes.
- **Migration** `20260619_stripe_subscriptions.sql` — confirm it's applied in Supabase.
- **Live Stripe objects + webhook** — confirm the live webhook endpoint + signing
  secret exist in Vercel.

---

## Morning checklist

### 1. Apply the DB migration
Supabase Dashboard → SQL Editor → paste `supabase/migrations/20260619_stripe_subscriptions.sql` → Run.

### 2. Paste Stripe TEST keys
From dashboard.stripe.com (toggle **Test mode**) → Developers → API keys. Put in `~/dev/WILCO/.env`
(copy `.env.example` first):
- `VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...`
- `STRIPE_SECRET_KEY=sk_test_...`
- plus the existing `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY`, `SUPABASE_SERVICE_KEY`.

### 3. Create the test-mode price/coupon mirrors
```
cd ~/dev/WILCO
STRIPE_SECRET_KEY=sk_test_xxx node scripts/setup-stripe-test.mjs
```
Paste its output (the `STRIPE_TEST_PRICE_*` lines + `STRIPE_MODE=test`) into `.env`.

### 4. Run the full stack locally
```
npm i -g vercel        # if needed
vercel dev             # serves the app AND the /api/* functions on one origin
```
(Plain `vite` will NOT run the API routes.)

### 5. Forward webhooks
```
stripe listen --forward-to localhost:3000/api/stripe-webhook
```
Copy the printed `whsec_...` into `.env` as `STRIPE_WEBHOOK_SECRET`, then restart `vercel dev`.

### 6. Test the paths (cards: 4242 4242 4242 4242 ok · 4000 0000 0000 9995 declined · 4000 0025 0000 3155 3DS)
- **Trial**: sign up → Pro monthly → pay with 4242 → athlete row shows `subscription_status=trialing`,
  `trial_end ≈ +7d`; no charge in the Stripe dashboard.
- **Cancel in trial**: Settings → Cancel → `cancel_at_period_end=true`; advance a Stripe **test clock**
  to confirm no charge; Resume re-enables.
- **Gift redeem**: as a 2nd test athlete, enter a gifter's code on Pro → first invoice **$0**, no trial.
- **Gift unlock**: a gifter's first `amount_paid>0` invoice creates exactly **4** `WILCO-XXXXX` codes
  (re-send the event to confirm no duplicates). Elite+code rejected; self-redeem blocked.
- **School bypass**: sign up with a valid team code → no plan/payment steps; `tier=school`.

### 7. Go live (only after testing passes)
- Set `STRIPE_MODE=live` (or unset) and the `pk_live`/`sk_live` keys in Vercel.
- Create a **live** webhook endpoint in the Stripe Dashboard pointing at
  `https://app.trainwilco.com/api/stripe-webhook` (events: `customer.subscription.*`,
  `invoice.paid`); put its signing secret in Vercel as `STRIPE_WEBHOOK_SECRET`.
- Merge `feature/stripe-integration` → `main` to deploy.

## Known limitations / follow-ups
- PIN auth on money endpoints is the minimal, app-consistent guard (4-digit, plaintext).
  Follow-up: real auth + Supabase RLS.
- Going **back** from the plan step after the athlete is created doesn't re-save edited
  profile fields (the row already exists); it won't duplicate the athlete.
- The hardcoded `SCHOOL_PRICE_ID` in `src/App.jsx` is the live id; harmless in test (school
  never charges), but swap if you want exact test parity.
