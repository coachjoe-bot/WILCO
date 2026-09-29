// COMPED ACCOUNTS regression suite (Will, 2026-09-29).
//   "Every account up till now should be free. Never ask to charge them or anyone
//    I give a 100% discount to."   /   "Keep everyone at the tier they are at."
//
// The design under test:
//   1. `athletes.comped` is SERVER-ONLY: no athlete, coach or master can write it
//      through the gateway, and signup cannot set it from client input.
//   2. Tiers do not change. comped is never treated as Pro.
//   3. Every in-app money ask goes quiet for a comped account (census below trips
//      the moment a NEW ask appears that this suite has not been told about).
//   4. A 100%-off FOREVER coupon (tester or founding free) comps its holder,
//      one-way, in the webhook and in create-subscription.
//   5. The nightly reconcile never calls a comped account an orphan (the pair
//      classifier itself is pinned in test-checkout-lifecycle.mjs).
//
//   node scripts/test-comped-accounts.mjs
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";

process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-signing-key-not-a-real-secret";
process.env.SUPABASE_URL = "https://test.invalid";
process.env.STRIPE_SECRET_KEY = "sk_test_comped_suite_not_real";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_comped_suite_not_real";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("  ✗ " + msg); } };
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const { isComped, accountFactLine, effectiveTier, trialActive } = await import("../src/tiers.js");
const { moneyAskGuard, asksForMoney } = await import("../src/replyGuards.js");
const { replyGate } = await import("../src/replyGate.js");
const data = await import("../api/data.js");
const stripeLib = await import("../api/_stripe.js");

// ── 1. comped is server-only ─────────────────────────────────────────────────
console.log("1. comped is server-only:");
{
  const dataSrc = read("../api/data.js");
  const allow = dataSrc.slice(dataSrc.indexOf("const ATHLETE_COL_ALLOW"), dataSrc.indexOf("const ATHLETE_COL_ALLOW") + 6000);
  const athletesCols = allow.slice(allow.indexOf("athletes: {"), allow.indexOf("athletes: {") + 3000);
  ok(!/["']comped["']/.test(athletesCols), "comped is NOT in ATHLETE_COL_ALLOW.athletes (an athlete cannot self-set it)");

  ok(data.SERVER_ONLY_ATHLETE_COLS instanceof Set && data.SERVER_ONLY_ATHLETE_COLS.has("comped"), "SERVER_ONLY_ATHLETE_COLS names comped");
  const refuses = (body) => { try { data.assertNoServerOnlyCols(body.table, body); return false; } catch (e) { return e.status === 403; } };
  for (const op of ["insert", "update", "upsert"]) {
    ok(refuses({ table: "athletes", op, data: { comped: true } }), `athletes ${op} with comped:true is refused (403)`);
    ok(refuses({ table: "athletes", op, data: { comped: false } }), `athletes ${op} with comped:false is refused too (no role writes it at all)`);
    ok(refuses({ table: "athletes", op, data: [{ name: "x" }, { comped: true }] }), `athletes ${op}: a comped key hiding in row 2 of an array is refused`);
  }
  ok(!refuses({ table: "athletes", op: "update", data: { program_text: "Squat 5x5" } }), "a normal coach/athlete athletes update still passes this check");
  ok(!refuses({ table: "workouts", op: "insert", data: { comped: true } }), "the check is scoped to the athletes table");
  ok(!refuses({ table: "athletes", op: "delete" }), "delete carries no payload and is untouched here");
  // Ordering: the refusal must run for EVERY role, before any role branch.
  const callAt = dataSrc.indexOf("assertNoServerOnlyCols(table, body)");
  ok(callAt > 0 && callAt < dataSrc.indexOf("── Phase 1b: athlete ownership scoping") && callAt < dataSrc.indexOf("── Coach write scoping"),
    "the refusal runs before the athlete and the coach (and master) branches");
  ok(/if \(!WRITABLE\.has\(table\)\)[^\n]*\n\s*assertNoServerOnlyCols/.test(dataSrc), "the refusal sits directly after the WRITABLE check");

  const identity = read("../api/identity.js");
  const fields = identity.slice(identity.indexOf("const ATHLETE_FIELDS"), identity.indexOf("];", identity.indexOf("const ATHLETE_FIELDS")));
  ok(!fields.includes("comped"), "signup ATHLETE_FIELDS (client-copyable columns) does not include comped");
  const createFn = identity.slice(identity.indexOf("async function createAthleteAction"), identity.indexOf("// ── set-coach-pin"));
  ok(!/\bcomped\b/.test(createFn), "createAthleteAction never mentions comped: no client value can reach the row");
  ok(/for \(const k of ATHLETE_FIELDS\) if \(a\[k\] !== undefined\) row\[k\] = a\[k\]/.test(createFn), "signup only copies the ATHLETE_FIELDS whitelist");

  const mig = read("../supabase/migrations/20260929_athletes_comped.sql");
  ok(/add column if not exists comped boolean not null default false/.test(mig), "migration adds comped boolean not null default false");
  ok(/update public\.athletes set comped = true where created_at <= now\(\)/.test(mig), "migration carries the one-time backfill");
  ok(/ALREADY RAN ON PROD ON 2026-09-29/.test(mig) && /DO NOT RE-RUN/.test(mig), "migration warns that the backfill already ran and must not re-run");
}

// ── 2. tiers do not change ───────────────────────────────────────────────────
console.log("2. tiers do not change:");
{
  const tiersSrc = read("../src/tiers.js");
  const fnBody = tiersSrc.slice(tiersSrc.indexOf("export function effectiveTier"), tiersSrc.indexOf("export function trialActive"));
  ok(!/comped/.test(fnBody), "effectiveTier never reads comped");
  for (const a of [{ tier: "free", trial_ends_at: null }, { tier: "free", trial_ends_at: "2020-01-01T00:00:00Z" }, { tier: "pro" }, { tier: "elite" }, { tier: "school" }]) {
    eq(effectiveTier({ ...a, comped: true }), effectiveTier({ ...a, comped: false }), `effectiveTier(${JSON.stringify(a)}) is identical with comped on/off`);
  }
  eq(effectiveTier({ tier: "free", trial_ends_at: "2020-01-01T00:00:00Z", comped: true }), "free", "a comped lapsed-trial free athlete stays FREE (comped is not Pro)");
  eq(trialActive({ tier: "free", trial_ends_at: "2020-01-01T00:00:00Z", comped: true }), false, "trialActive unchanged");
  eq([isComped({ comped: true }), isComped({ comped: false }), isComped({}), isComped(null), isComped({ comped: "true" }), isComped({ comped: 1 })], [true, false, false, false, false, false], "isComped is exactly === true");
}

// ── 3. the asks ──────────────────────────────────────────────────────────────
console.log("3. no money ask reaches a comped account:");
{
  const app = read("../src/App.jsx");
  const code = app.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  // a. trial-ended notice
  const notice = app.slice(app.indexOf("const withTrialNotice"), app.indexOf("const withTrialNotice") + 500);
  ok(/if\(isComped\(athlete\)\) return msgs;/.test(notice), "trial-ended notice returns early for a comped athlete");
  // b. chat "show my log" lock
  const lock = app.slice(app.indexOf("Comped (Will 09-29): the log stays locked"), app.indexOf("Comped (Will 09-29): the log stays locked") + 900);
  ok(/isComped\(athlete\)\s*\?\s*`Your log isn't part of your current plan/.test(lock), "locked-log chat line has a comped branch");
  const compedLine = lock.slice(lock.indexOf("`Your log isn't part"), lock.indexOf("`", lock.indexOf("`Your log isn't part") + 1));
  ok(!asksForMoney(compedLine) && !/upgrade|settings|\bpro\b/i.test(compedLine), "the comped locked-log line has no call to action");
  // c. settings coach line
  ok(/isComped\(athlete\) \? "Your coach will receive a welcome email\." :/.test(app), "Settings coach line drops 'Upgrade to Pro' for comped");
  // d. plan drawer
  ok(app.includes("const comped = isComped(athlete);"), "SettingsModal derives comped");
  ok(app.includes("{comped?\"Complimentary account\":\"Billing, upgrade & gift codes\"}"), "drawer subtitle does not say 'upgrade' for comped");
  ok(app.includes("{!comped&&!hasStripeSub&&trialActive(athlete)&&("), "drawer trial card ('Pick a plan below to keep Pro') is hidden for comped");
  ok(app.includes("{!comped&&currentTier!==\"free\"&&("), "annual toggle ('SAVE UP TO 45%') is hidden for comped");
  ok(app.includes("{!comped&&<div style={{display:\"flex\",flexDirection:\"column\",gap:8}}>"), "tier price cards are hidden for comped");
  ok(/useState\(athlete\.tier\|\|"free"\)/.test(app), "selectedTier starts at the CURRENT tier, so no Subscribe button shows by default");
  ok(app.includes("Your account is on the house. Nothing is owed, now or later."), "comped drawer shows the plain statement");
  ok(/comped\s*\?\s*"Your account is complimentary\. Nothing is owed\."/.test(app), "no 'first charge then' line for a comped Stripe sub");
  ok(/!\(comped && codes\.length===0\)/.test(app), "no 'gift codes unlock after your first payment' box for comped");
  // e. AI
  ok(app.includes("+accountFactLine(athlete)};") && (app.match(/accountFactLine\(athlete\)/g) || []).length === 2, "both chat prompt builders (mastermind + legacy) carry the account fact");
  ok((app.match(/isComped\(updatedAthlete\)/g) || []).length >= 4, "every athlete-facing chat gate call passes comped");

  // Census: every ask phrase that exists in App.jsx today. If a NEW ask is added,
  // this count changes and the suite fails until the author gates it for comped.
  const census = {
    "Upgrade to Pro": 2,          // the not-comped locked-log line + the not-comped Settings coach line
    "upgrade in Settings": 1,
    "Pro is one tap away": 1,
    "Pick a plan below": 1,
    "Subscribe to ": 1,
    "SAVE UP TO": 2,              // signup plan step (not reachable by an existing account) + the drawer toggle
    "first payment": 1,
  };
  for (const [phrase, n] of Object.entries(census)) {
    eq(code.split(phrase).length - 1, n, `ask census "${phrase.trim()}"`);
  }
  // Each census ask sits behind a comped gate (looked up within the guarded region).
  const gated = (needle, gateRe, span = 900) => { const i = app.lastIndexOf(needle); return i > 0 && gateRe.test(app.slice(Math.max(0, i - span), i)); };
  ok(gated("Upgrade to Pro to save your history", /isComped\(athlete\)/), "the 'Upgrade to Pro to save your history' line is behind the comped branch");
  ok(gated("upgrade in Settings and it's all back", /isComped\(athlete\)/), "the 'upgrade in Settings' line is behind the comped branch");
  ok(gated("Pro is one tap away", /if\(isComped\(athlete\)\) return msgs;/, 2000), "the 'Pro is one tap away' notice is behind the comped return");
  ok(gated("Upgrade to Pro for weekly progress reports", /isComped\(athlete\)/, 200), "the Settings coach 'Upgrade to Pro' is behind the comped branch");
  ok(gated("Pick a plan below to keep Pro", /!comped&&!hasStripeSub/, 900), "'Pick a plan below' is behind !comped");
  ok(gated("ANNUAL · SAVE UP TO 45%", /!comped&&currentTier/, 1200), "'SAVE UP TO 45%' is behind !comped");
  ok(gated("Subscribe to ${TIERS[selectedTier].label}", /planChanged&&selectedTier!=="free"/, 900), "'Subscribe to' needs a plan change, which the hidden picker cannot make");

  // f. Places the audit checked and found free of asks (pin them so a future ask fails loudly).
  for (const f of ["send-athlete-welcome", "send-coach-welcome", "send-coach-invite", "send-pin-recovery", "send-weekly-report", "notify-program-changes", "push", "_push", "trigger-proof-feed", "_email"]) {
    const src = read(`../api/${f}.js`).replace(/\/\/[^\n]*/g, "");
    ok(!/upgrade|subscribe to|start your trial|trial (?:ends|ended|expires)|add a card|payment method|\$\s?\d+(?:\.\d\d)?\s*\/\s*(?:mo|month|yr)/i.test(src.replace(/List-Unsubscribe|unsubscribe|Unsubscribe|subscription|Subscription/g, "")),
      `api/${f}.js carries no money ask`);
  }
  const tour = read("../src/tour.jsx");
  ok(!/upgrade|subscribe|\$\d|trial/i.test(tour.replace(/\/\/[^\n]*/g, "")), "the tour carries no money ask");

  // g. the AI fact line + the reply gate backstop
  eq(accountFactLine({ comped: false }), "", "non-comped prompts are byte-identical (no account line)");
  eq(accountFactLine(null), "", "no athlete, no line");
  const line = accountFactLine({ comped: true });
  ok(/complimentary/.test(line) && /Nothing is owed/.test(line), "comped athletes are handed the fact that nothing is owed");
  ok(!/—/.test(line), "fact line has no em dash");
  const asks = [
    "Your log is a Pro feature. Upgrade in Settings and it's all back.",
    "Pro is $14.99/mo and gets you the full history.",
    "You could subscribe to unlock the charts.",
    "Want me to walk you through the Pro plan?",
    "Your free trial ends Friday.",
    "Add a card and we're set.",
    "Go Pro and the program tab comes back.",
    "The annual price works out to 8/mo.",
  ];
  for (const a of asks) ok(asksForMoney(a), `guard catches: ${a}`);
  const clean = [
    "Squat 5x5 at 225 is a solid top set.",
    "Nothing is owed, your account is covered.",
    "You hit legs twice a month, let's make it three.",
    "Your subscription-free week starts Monday.".replace("subscription-free ", ""),
    "Bench moved 10 lbs in six weeks.",
    "Push the pace on your last set.",
    "That price of skipping warm-ups is a tweaked shoulder.",
  ];
  for (const c of clean) ok(!asksForMoney(c), `guard leaves alone: ${c}`);
  const mixed = moneyAskGuard("Great session. Upgrade to Pro to see your charts. Squat 5x5 was clean.");
  eq(mixed.text, "Great session. Squat 5x5 was clean.", "the guard removes only the ask sentence");
  eq(moneyAskGuard("Upgrade to Pro today.").text, "Upgrade to Pro today.", "the guard never empties a reply");
  eq(replyGate("chat", "Nice work. Upgrade to Pro for more.", { comped: true, record: false }).text, "Nice work.", "replyGate strips the ask for a comped athlete");
  eq(replyGate("chat", "Nice work. Upgrade to Pro for more.", { record: false }).text, "Nice work. Upgrade to Pro for more.", "replyGate leaves a non-comped athlete's reply alone");
}

// ── 4. 100%-off FOREVER coupon comps its holder ──────────────────────────────
console.log("4. a 100%-off forever coupon comps its holder:");
{
  const { couponComps, subCompingCoupon, subCompsAsync, COMPED_COUPON_IDS, TESTER_COUPONS } = stripeLib;
  const testerPro = { id: "WILCO_TESTER_PRO_FOREVER", percent_off: 100, duration: "forever" };
  const testerElite = { id: "WILCO_TESTER_ELITE_FOREVER", percent_off: 100, duration: "forever" };
  const foundingFree = { id: "WILCO_FOUNDING_FREE_FOREVER", percent_off: 100, duration: "forever" };
  const founding499 = { id: "WILCO_FOUNDING_499_FOREVER", amount_off: 1000, duration: "forever" };
  const founding5 = { id: "WILCO_FOUNDING_5_FOREVER", amount_off: 999, duration: "forever" };
  const gift = { id: "WILCO_GIFT_PRO_MONTH", percent_off: 100, duration: "once" };
  const grip = { id: "WILCO_GRIP_TEST_CHAMP_3MO", percent_off: 100, duration: "repeating", duration_in_months: 3 };
  const halfOff = { id: "WILCO_TESTER_PRO_FOREVER", percent_off: 50, duration: "forever" };

  ok(Object.keys(TESTER_COUPONS).every((id) => COMPED_COUPON_IDS.has(id)), "every tester coupon id is in the comped set (reused, not copied)");
  ok(COMPED_COUPON_IDS.has("WILCO_FOUNDING_FREE_FOREVER"), "the founding FREE coupon is in the comped set");
  ok(!COMPED_COUPON_IDS.has("WILCO_FOUNDING_499_FOREVER") && !COMPED_COUPON_IDS.has("WILCO_FOUNDING_5_FOREVER"), "the paid founding coupons ($4.99 / $5) do not comp: those people pay");
  for (const [n, c] of [["tester pro", testerPro], ["tester elite", testerElite], ["founding free", foundingFree]]) ok(couponComps(c), `${n} comps`);
  for (const [n, c] of [["founding $4.99", founding499], ["founding $5", founding5], ["friend gift (1 month)", gift], ["grip-test prize (3 months)", grip], ["a tester id at 50% off", halfOff], ["null", null]]) ok(!couponComps(c), `${n} does NOT comp`);

  // Discount shapes Stripe sends: legacy `coupon`, newer `source.coupon`, bare ids.
  eq(subCompingCoupon({ discounts: [{ coupon: testerPro }] }).comped, true, "legacy discount.coupon object comps");
  eq(subCompingCoupon({ discounts: [{ source: { type: "coupon", coupon: foundingFree } }] }).comped, true, "newer discount.source.coupon object comps");
  eq(subCompingCoupon({ discount: { coupon: testerElite } }).comped, true, "the singular legacy `discount` field comps");
  eq(subCompingCoupon({ discounts: [{ coupon: founding499 }] }), { comped: false, unresolved: false }, "a paid founding coupon does not comp");
  eq(subCompingCoupon({ discounts: [{ coupon: gift }] }), { comped: false, unresolved: false }, "a one-month gift does not comp");
  eq(subCompingCoupon({ discounts: [] }), { comped: false, unresolved: false }, "no discounts, no comp");
  eq(subCompingCoupon({}), { comped: false, unresolved: false }, "no discount fields, no comp");
  eq(subCompingCoupon({ discounts: ["di_123"] }), { comped: false, unresolved: true }, "a bare discount id is 'unresolved', not comped");
  eq(subCompingCoupon({ discounts: [{ coupon: "WILCO_TESTER_PRO_FOREVER" }] }), { comped: false, unresolved: true }, "a bare listed coupon id needs its terms read");
  eq(subCompingCoupon({ discounts: [{ coupon: "SOME_OTHER" }] }), { comped: false, unresolved: false }, "a bare unlisted coupon id is settled: not comped");

  // Async: only spends Stripe reads when it has to, never throws.
  let reads = 0;
  const fake = (over = {}) => ({
    subscriptions: { retrieve: async () => { reads++; return over.full; } },
    coupons: { retrieve: async () => { reads++; return over.coupon; } },
  });
  reads = 0;
  eq(await subCompsAsync(fake(), { id: "sub_1", discounts: [{ coupon: testerPro }] }), true, "object discount: comped with zero Stripe reads");
  eq(reads, 0, "…and zero reads spent");
  eq(await subCompsAsync(fake(), { id: "sub_1", discounts: [] }), false, "no discount: false with zero reads");
  eq(reads, 0, "…and zero reads spent");
  reads = 0;
  eq(await subCompsAsync(fake({ full: { discounts: [{ coupon: testerPro }] } }), { id: "sub_1", discounts: ["di_1"] }), true, "bare id: expands the subscription and comps");
  reads = 0;
  eq(await subCompsAsync(fake({ full: { discounts: [{ source: { coupon: "WILCO_FOUNDING_FREE_FOREVER" } }] }, coupon: foundingFree }), { id: "sub_1", discounts: ["di_1"] }), true, "bare coupon id: reads the coupon's terms and comps");
  eq(await subCompsAsync(fake({ full: { discounts: [{ coupon: founding499 }] } }), { id: "sub_1", discounts: ["di_1"] }), false, "expanded to a paid founding coupon: not comped");
  eq(await subCompsAsync({ subscriptions: { retrieve: async () => { throw new Error("stripe down"); } } }, { id: "sub_1", discounts: ["di_1"] }), false, "a Stripe error answers false, never throws (the next event retries)");

  // create-subscription: source contract (the Stripe calls are the manual runbook's).
  const cs = read("../api/create-subscription.js");
  ok((cs.match(/\.\.\.\(comps \? \{ comped: true \} : \{\}\)/g) || []).length === 2, "create-subscription writes comped:true in BOTH the card-first and the legacy patch");
  ok(!/comped:\s*false/.test(cs) && !/comped:\s*false/.test(read("../api/stripe-webhook.js")) && !/patch\.comped\s*=\s*false|\{\s*comped:\s*false\s*\}\s*\)/.test(read("../api/_stripe.js")),
    "no server path ever writes comped:false (one-way)");
  ok(/comps: couponComps\(resolved\.coupon\)/.test(cs), "tester and gift code resolution both derive comps from the coupon terms");
  ok(/const \{ promotionCodeId, giftApplied, testerApplied, capExhausted, comps \} = code;/.test(cs), "the handler reads comps from the code resolution");
}

// ── 4b. the webhook, end to end with a signed event and a stubbed Supabase ────
console.log("4b. stripe-webhook syncSubscription (signed event, mocked Supabase):");
{
  const Stripe = (await import("stripe")).default;
  const signer = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { default: handler } = await import("../api/stripe-webhook.js");
  const PRO_PRICE = "price_1U34g7RlrDCVlwEBiHa8hsb5"; // live Pro annual: tierForPrice knows it offline
  const testerPro = { id: "WILCO_TESTER_PRO_FOREVER", percent_off: 100, duration: "forever" };
  const foundingFree = { id: "WILCO_FOUNDING_FREE_FOREVER", percent_off: 100, duration: "forever" };
  const founding499 = { id: "WILCO_FOUNDING_499_FOREVER", amount_off: 1000, duration: "forever" };
  const grip = { id: "WILCO_GRIP_TEST_CHAMP_3MO", percent_off: 100, duration: "repeating", duration_in_months: 3 };

  const realFetch = globalThis.fetch;
  const run = async (athlete, sub, type = "customer.subscription.updated") => {
    const patches = [];
    globalThis.fetch = async (url, init = {}) => {
      const method = init.method || "GET";
      if (method === "PATCH") { patches.push(JSON.parse(init.body)); return new Response(JSON.stringify([{ ...athlete, ...JSON.parse(init.body) }]), { status: 200 }); }
      return new Response(JSON.stringify([athlete]), { status: 200 });
    };
    const payload = JSON.stringify({ id: "evt_1", object: "event", type, data: { object: sub } });
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const req = new EventEmitter(); req.method = "POST"; req.headers = { "stripe-signature": header };
    const res = { code: 0, status(c) { this.code = c; return this; }, json() { return this; } };
    const done = handler(req, res);
    await new Promise((r) => setImmediate(r));
    req.emit("data", Buffer.from(payload)); req.emit("end");
    await done;
    globalThis.fetch = realFetch;
    return { code: res.code, patch: patches[0] || null };
  };
  const sub = (over = {}) => ({ id: "sub_1", customer: "cus_1", status: "active", default_payment_method: "pm_1", metadata: { athlete_id: "a1" }, items: { data: [{ price: { id: PRO_PRICE }, current_period_end: 1900000000 }] }, discounts: [], ...over });
  const ath = (over = {}) => ({ id: "a1", tier: "pro", comped: false, ...over });

  let r = await run(ath({ tier: "free" }), sub({ discounts: [{ coupon: testerPro }] }));
  eq(r.code, 200, "tester-coupon sub event answers 200");
  eq(r.patch.comped, true, "tester coupon: athlete is comped");
  eq(r.patch.tier, "pro", "…and the entitled sub still grants its tier (comped never blocks a raise)");

  r = await run(ath({ tier: "free" }), sub({ discounts: [{ source: { type: "coupon", coupon: foundingFree } }] }));
  eq(r.patch.comped, true, "founding FREE coupon (newer discount shape): comped");

  r = await run(ath({ tier: "free" }), sub({ discounts: [{ coupon: founding499 }] }));
  ok(!("comped" in r.patch), "founding $4.99 coupon: NOT comped (they pay)");

  r = await run(ath({ tier: "free" }), sub({ discounts: [{ coupon: grip }] }));
  ok(!("comped" in r.patch), "3-month 100% prize: NOT comped (it ends)");

  r = await run(ath({ tier: "pro" }), sub());
  ok(!("comped" in r.patch), "an ordinary paying sub does not comp");

  r = await run(ath({ tier: "pro", comped: true }), sub({ discounts: [{ coupon: testerPro }] }));
  ok(!("comped" in r.patch), "an already-comped athlete is not re-written (one-way, no extra reads)");

  // Nothing demotes a comped athlete; everyone else is demoted exactly as before.
  r = await run(ath({ tier: "pro", comped: true }), sub({ status: "canceled" }), "customer.subscription.deleted");
  ok(!("tier" in r.patch), "comped pro + canceled sub: tier is NOT lowered");
  eq(r.patch.subscription_status, "canceled", "…but the subscription status still syncs");
  r = await run(ath({ tier: "elite", comped: true }), sub({ status: "canceled", default_payment_method: null }), "customer.subscription.deleted");
  ok(!("tier" in r.patch), "comped elite + lapsed sub: tier is NOT lowered");
  r = await run(ath({ tier: "pro", comped: false }), sub({ status: "canceled" }), "customer.subscription.deleted");
  eq(r.patch.tier, "free", "NON-comped pro + canceled sub: demoted to free, exactly as before");
  r = await run(ath({ tier: "free", comped: true }), sub());
  eq(r.patch.tier, "pro", "a comped FREE athlete who buys a real sub is raised (comped never blocks a raise)");
  globalThis.fetch = realFetch;

  const wh = read("../api/stripe-webhook.js");
  ok(/await syncSubscription\(stripe, event\.data\.object\)/.test(wh), "syncSubscription receives the stripe client for the coupon read");
}

// ── 5. reconcile ─────────────────────────────────────────────────────────────
console.log("5. reconcile-billing:");
{
  const rb = read("../api/reconcile-billing.js");
  ok(/&select=id,name,tier,comped,/.test(rb), "the athlete query selects comped");
  ok(/isOrphanedEntitlement\(a\) && !\(a\.stripe_subscription_id/.test(rb), "the athlete-side pass uses the shared comped-aware rule");
  ok(/if \(isOrphanedEntitlement\(athlete\)\) return "entitlement_orphaned"/.test(rb), "classifyPair uses the shared rule");
  ok(!/PAID_TIERS\.has\(a\.tier\) &&/.test(rb), "no raw PAID_TIERS orphan test is left in the handler");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
