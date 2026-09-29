// ─── EFFECTIVE TIER — the W18-3 trial clock (Will's 08-20 ruling) ─────────────
// Every signup starts a 7-day free trial. Paid picks run theirs through Stripe
// (card at signup, trial_period_days — see api/create-subscription.js), so their
// stored tier is already pro/elite while trialing. The FREE pick has no Stripe
// object at all: the server stamps athletes.trial_ends_at at account creation
// (api/identity.js, service-key write — the column is deliberately NOT in
// ATHLETE_COL_ALLOW), and this helper presents that athlete as "pro" until the
// clock runs out. The revert is purely derived — no cron, no write, no countdown:
// once trial_ends_at passes, effectiveTier simply answers "free" again, which is
// exactly the "silently revert, the features just aren't there anymore" ruling.
//
// Rules for call sites:
//   • FEATURE gating (nav buttons, Quick Log, opener, history persistence,
//     weekly reports) reads effectiveTier.
//   • BILLING truth (plan drawer, checkout, webhook-lag reconciliation) reads
//     the raw athlete.tier — a trial athlete's plan is still Free.
// Shared client + server (same import pattern as src/grit.js).

export const TRIAL_DAYS = 7;

// The tier the app should BEHAVE as. Elevates a stored-free athlete inside an
// unexpired trial window — and GRANDFATHERED free accounts (Will's 08-24 ruling,
// final): a free athlete with NO trial_ends_at predates the W18-3 trial system
// (identity.js stamps every non-school signup at creation), and those accounts
// keep Pro access for free, permanently. Only a LAPSED stamp locks an account
// down to the bare free surface. pro/elite/school pass through unchanged.
export function effectiveTier(a) {
  const t = (a && a.tier) || "free";
  if (t === "free" && a) {
    if (!a.trial_ends_at) return "pro"; // grandfathered pre-trial account
    const ends = Date.parse(a.trial_ends_at);
    if (Number.isFinite(ends) && ends > Date.now()) return "pro";
  }
  return t;
}

// Is this athlete currently riding the card-less free-pick trial? Requires a
// live stamp: a grandfathered account (no stamp, permanent free Pro) is NOT on
// a trial and must never see trial countdown copy.
export function trialActive(a) {
  return ((a && a.tier) || "free") === "free" && !!(a && a.trial_ends_at) && effectiveTier(a) === "pro";
}

// ─── COMPED ACCOUNTS (Will 09-29) ────────────────────────────────────────────
// "Every account up till now should be free. Never ask to charge them or anyone
// I give a 100% discount to." `athletes.comped` is a server-only flag (see
// api/data.js SERVER_ONLY_ATHLETE_COLS): set by the 09-29 migration and by the
// Stripe webhook when a 100%-off FOREVER coupon lands. It changes NOTHING about
// tier or features: effectiveTier is untouched, a comped athlete keeps exactly
// the surface they have today, and comped is never treated as Pro.
//
// What it changes is the ASK. Every surface that would nudge an athlete toward
// paying (upgrade lines, trial-ended notices, plan pickers, "add a card",
// anything Joe might say) reads isComped and goes quiet. A locked feature stays
// locked and is stated as a plain fact with no call to action.
export function isComped(a) {
  return !!a && a.comped === true;
}

// One fact line for the AI's dynamic block (AI contract rule 1: a fact computed
// in code and handed to Joe, not a new persona rule). Empty for everyone else, so
// non-comped prompts stay byte-identical. The reply gate's moneyAskGuard
// (src/replyGuards.js) is the code backstop if he reaches for it anyway.
export function accountFactLine(a) {
  return isComped(a)
    ? "\n\nACCOUNT: this athlete's account is complimentary. Nothing is owed and nothing is for sale to them: there is no plan to buy, no trial to end, no card to add. Do not bring up upgrading, prices, Pro or Elite as something to get, or billing. If they ask, tell them it is covered and move on."
    : "";
}
