# Stripe Integration — Status & Morning Checklist

Built on branch **`feature/stripe-integration`** (committed locally, **not pushed, not deployed**).
The production app on `app.trainwilco.com` is untouched.

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

## ⚠️ Not done by me on purpose (needs you / can't be verified without keys)
- **Nothing was tested end-to-end** — no test keys were available. See testing steps below.
- **Migration not applied** — I can't run DDL against Supabase.
- **No live Stripe objects created**, nothing pushed/deployed.

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
