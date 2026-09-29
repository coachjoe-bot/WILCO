// Nightly Stripe <-> Supabase billing reconciliation (T37, 2026-08-07).
//
// Exists because an orphaned checkout sat undetected for 7 days: Stripe said
// "trialing", the athlete row said "free", and nothing compared the two until a
// human cross-referenced three systems by hand. This cron does that comparison
// every night and writes divergences to error_events (area "billing"), where the
// weekly app-health report already looks.
//
// Read-only against Stripe; writes ONLY to error_events. It never patches an
// athlete row or touches a subscription — a divergence is a finding for a human
// (or a bug for a fix), never something to silently "heal" at 3am.
//
// Classes (see classifyPair):
//   entitlement_missing  — live sub WITH card, athlete not on a paid tier.
//                          Someone paid and isn't getting the product. ERROR.
//   entitlement_orphaned — paid-tier athlete with no live sub. We're giving Pro
//                          away (or a cancel never synced). ERROR. NEVER for a
//                          comped athlete (Will 09-29): their free access is the
//                          decision, not a leak. 38 of them made this alarm cry
//                          wolf every night for 30 days.
//   unlinked_sub         — live sub matching no athlete row. ERROR.
//   abandoned_checkout   — live sub, NO card, older than 1h: someone reached the
//                          card form and left. Expected only from stale pre-T37
//                          bundles (card-first can't produce these); each one is
//                          also a lead who bounced off the paywall. WARN.
//
// Cron-only: gated by the CRON_SECRET bearer (same gate as process-deletions —
// never the forgeable x-vercel-cron header).
import { getStripe, sbAthletesWhere } from "./_stripe.js";
import { logError } from "./_supa.js";

export const maxDuration = 60;

const LIVE = new Set(["trialing", "active", "past_due"]);
const PAID_TIERS = new Set(["pro", "elite"]); // school = invoice-billed, never Stripe

// A paid tier with no live sub is an orphan unless the account is comped.
// The ONE test, shared by the per-pair classifier and the athlete-side pass.
export const isOrphanedEntitlement = (athlete) =>
  !!athlete && PAID_TIERS.has(athlete.tier) && athlete.comped !== true;

// Pure classifier — covered by scripts/test-checkout-lifecycle.mjs.
// sub: Stripe subscription (or null) · athlete: matching row (or null) ·
// nowMs: injection point for tests.
export function classifyPair({ sub, athlete, nowMs = Date.now() }) {
  if (sub && LIVE.has(sub.status)) {
    if (!athlete) return "unlinked_sub";
    if (sub.default_payment_method) {
      // Card on file + live: the athlete must hold the paid tier (tester subs
      // and gift-discounted subs both still carry cards, so they pass here).
      return PAID_TIERS.has(athlete.tier) ? "ok" : "entitlement_missing";
    }
    // Live but cardless: an in-flight checkout for the first hour, an abandoned
    // one after that. (Pre-T37 bundles minted these at payment-screen mount.)
    const ageMs = nowMs - (sub.created || 0) * 1000;
    return ageMs > 60 * 60 * 1000 ? "abandoned_checkout" : "in_flight";
  }
  // No live sub: a paid-tier athlete shouldn't exist (schools/free are fine),
  // unless they are comped: free on purpose, never an orphan.
  if (isOrphanedEntitlement(athlete)) return "entitlement_orphaned";
  return "ok";
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: "Missing CRON_SECRET" });
  if ((req.headers.authorization || "") !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const stripe = getStripe();

    // Every non-canceled subscription (auto-paginated; single-digit volume today).
    const subs = [];
    for await (const sub of stripe.subscriptions.list({ status: "all", limit: 100 })) {
      subs.push(sub);
    }
    const liveSubs = subs.filter((s) => LIVE.has(s.status));

    // Every athlete that has ever touched Stripe, plus anyone on a paid tier.
    const athletes = await sbAthletesWhere(
      "or=(stripe_subscription_id.not.is.null,tier.in.(pro,elite))" +
      "&select=id,name,tier,comped,subscription_status,stripe_subscription_id,stripe_customer_id"
    );
    const byId = new Map(athletes.map((a) => [String(a.id), a]));
    const liveSubIds = new Set(liveSubs.map((s) => s.id));

    const findings = { entitlement_missing: [], entitlement_orphaned: [], unlinked_sub: [], abandoned_checkout: [], in_flight: [] };

    for (const sub of liveSubs) {
      const athlete =
        byId.get(String(sub.metadata?.athlete_id || "")) ||
        athletes.find((a) => a.stripe_subscription_id === sub.id) ||
        null;
      const cls = classifyPair({ sub, athlete });
      if (cls !== "ok") findings[cls]?.push({ sub: sub.id, athlete: athlete?.id ?? null, status: sub.status });
    }
    for (const a of athletes) {
      // Athlete-side pass: paid tier whose sub is not in the live set.
      if (isOrphanedEntitlement(a) && !(a.stripe_subscription_id && liveSubIds.has(a.stripe_subscription_id))) {
        findings.entitlement_orphaned.push({ sub: a.stripe_subscription_id ?? null, athlete: a.id, tier: a.tier });
      }
    }

    // One error_events row PER CLASS with findings (never per item — a stuck
    // orphan must not add a row every night per subscription). in_flight is
    // normal churn and only reported in the JSON response.
    const summary = {};
    for (const [cls, items] of Object.entries(findings)) {
      summary[cls] = items.length;
      if (cls === "in_flight" || items.length === 0) continue;
      await logError({
        source: "server",
        severity: cls === "abandoned_checkout" ? "warn" : "error",
        area: "billing",
        route: "api/reconcile-billing",
        error_type: `reconcile_${cls}`,
        message: `${items.length} ${cls} (Stripe vs Supabase nightly reconcile)`,
        meta: { items: items.slice(0, 20) },
      });
    }

    console.log("[reconcile-billing]", JSON.stringify(summary));
    return res.status(200).json({ checked: { stripe_live_subs: liveSubs.length, athletes: athletes.length }, findings: summary });
  } catch (e) {
    console.error("[reconcile-billing] error:", e.message);
    await logError({
      source: "server", severity: "error", area: "billing", route: "api/reconcile-billing",
      error_type: e.type || "reconcile_run_failed", message: e.message,
    }).catch(() => {});
    return res.status(500).json({ error: e.message });
  }
}
