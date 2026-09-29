// Shared route fixtures for the smoke suite.
//
// Under `vite dev` the /api/* Vercel serverless functions are NOT served, so every
// spec intercepts them here with responses that mimic the real shapes:
//   /api/identity  (api/identity.js)  athlete-login -> { athlete, token } | { athlete:null, reason }
//                                     get-athlete   -> { athlete, token }
//                                     log-error / log-events -> { ok:true }
//   /api/data      (api/data.js)      op:"read" -> array of rows; insert/update/upsert -> rows; delete -> { ok:true }
//   /api/claude    (api/claude.js)    Anthropic Messages shape: { content:[{ type:"text", text }], usage }
//                                     — the client reads d.content[0].text (App.jsx askClaude)
//   /api/create-subscription          { clientSecret, mode } (PaymentStep reads j.clientSecret / j.mode)
//
// External hosts (Google Fonts, Supabase) are stubbed too so the suite is
// deterministic offline and "no console errors" stays meaningful.

// A realistic athlete row as api/identity returns it (stripPin: no `pin` field).
// The client itself re-attaches the typed pin after login.
export const makeAthlete = (overrides = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-01-05T12:00:00.000Z",
  name: "Test Athlete",
  email: "test.athlete@example.com",
  sport: "Football",
  goal: "strength",
  tier: "pro",
  billing: "monthly",
  first_chat_complete: true,
  program_text: null,
  program_locked: false,
  temp_program_text: null,
  total_sessions_logged: 4,
  certified_badge_earned_at: null,
  birthday: "2008-03-14", // set -> no "complete your profile" banner noise
  age: 18,
  height_inches: 71,
  weight_lbs: 180,
  weight_unit: "lbs",
  gender: "male",
  training_days_per_week: 4,
  equipment: ["Full gym"],
  position_or_event: "Linebacker",
  injury_history: null,
  coach_id: null,
  school_id: null,
  coach_name: null,
  coach_email: null,
  stripe_customer_id: null,
  stripe_subscription_id: null,
  stripe_price_id: null,
  subscription_status: null,
  cancel_at_period_end: false,
  trial_end: null,
  trial_ends_at: null, // W18-3 app-side free-pick trial clock (server-set)
  current_period_end: null,
  proof_enabled: false,
  proof_schedule_dow: 0,
  proof_schedule_hour: 8,
  proof_timezone: "America/New_York",
  resolved_pain: null,
  ...overrides,
});

// A token the app's restoreAuthSession accepts: four dot-separated parts, the
// fourth an expiry in ms (tokenExpMs in App.jsx).
export const liveToken = () => `smoke.test.token.${Date.now() + 24 * 60 * 60 * 1000}`;

const json = (body, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

// parseWorkout's fallback shape — a "nothing structured" parse (plain chat message).
export const emptyParse = {
  exercises: [],
  run_data: null,
  practice_data: null,
  pain_flags: [],
  equipment_issues: [],
  questions: [],
  pr_attempts: [],
  session_feel: null,
  context_request: null,
  general_notes: null,
  is_program_update: false,
  is_temp_program_update: false,
  is_program_revert: false,
};

// A bodyweight workout parse. unit:"bodyweight" deliberately skips the PR-detection
// branch (App.jsx finalizeWorkout) so the log spec stays a tight boot->log->saved
// loop instead of also exercising 1RM propagation.
export const pushupParse = {
  ...emptyParse,
  exercises: [
    { name: "Push-Up", sets: 3, reps: 20, weight: null, unit: "bodyweight", set_details: null },
  ],
  session_feel: "good",
};

/**
 * Install all API mocks on a page. Returns { calls } — every /api/* request
 * body, for asserting that e.g. the workout insert actually fired.
 *
 * options:
 *   athlete    — athlete row returned by identity mocks (default: pro makeAthlete())
 *   parseResult— object the workout_parse claude call returns (default: emptyParse)
 *   chatReply  — text the coaching claude call returns
 *   blockStripeJs — abort requests to js.stripe.com (exercises the checkout failure state)
 *   subscriptionDelayMs — latency for /api/create-subscription so "Loading secure
 *                         checkout…" is reliably observable (default 300)
 *   giftResult — response for /api/validate-gift-code (default: the classic
 *                one-free-month gift code). Shape mirrors api/validate-gift-code.js.
 */
export async function mockApi(page, options = {}) {
  const {
    athlete = makeAthlete(),
    coach = null,
    parseResult = emptyParse,
    chatReply = "Solid work. Keep stacking sessions.",
    // The session token the identity mocks hand out. The default has no expiry
    // field, so the app treats a reload as signed out. A spec that needs a cold
    // boot INTO the app (restoreAuthSession) passes liveToken().
    token = "smoketest-session-token",
    // T58/3b Builder-mode-in-chat: per-feature AI responses. The extractor
    // (Haiku, feature program_build) fills EVERY athlete cell in one answer so
    // specs reach the read-back gate in a single turn; the interviewer (Sonnet,
    // same feature) asks with chips; program_draft returns the block text.
    builderExtract = { cells: {
        goal: "Bench 225x1 by Oct 1", schedule: "4 days/week, 60 min", timeline: "2026-09-01 to 2026-10-01",
        equipment: "Full gym", red_flags: "None", non_negotiables: "None", recovery: "Sleep 8h, low stress",
        prep: "Standard warm-up", handoff: "First block",
      }, goal_smart: { ok: true } },
    builderQuestion = "What's the one number and date we're chasing this block?\nCHIPS: Bench 225 by Oct 1 | Squat 315 by Halloween",
    builderDraftText = "=== BLOCK INFO ===\nGoal: Bench 225x1 by Oct 1\nRuns: 2026-09-01 to 2026-10-01\n\nWEEK 1\nDay 1 - Push\nBench Press 3x5 @ 185",
    blockStripeJs = false,
    subscriptionDelayMs = 300,
    // Per-table canned rows for gateway reads: {table: rows | (body)=>rows}.
    // A function sees the whole request body (body.params carries the
    // PostgREST query) so a spec can key on it — program_drafts serves
    // Builder drafts AND Program Recs from one table.
    dataReads = {},
    // Program Recs: canned reply for the rec drafter (feature program_generate).
    recDraftReply = null,
    giftResult = {
      valid: true,
      promotionCodeId: "promo_smoketest",
      kind: "gift",
      discountLabel: "First month of Pro free",
      terms: { freeForever: false, freeMonths: 0, amountOff: 1499, percentOff: 0, repeating: false, forever: false },
    },
  } = options;

  const calls = [];
  const record = (route) => {
    const req = route.request();
    let body = null;
    try { body = req.postDataJSON(); } catch { /* non-JSON */ }
    calls.push({ url: req.url(), body });
    return body;
  };

  // Determinism guards, installed before any page script runs:
  // - never offer the Face ID enrollment interstitial after login
  // - never let the unguarded index.html sw register() reject into the console
  // - pre-seed the AI-processing consent gate (App.jsx AiConsentGate, App Store
  //   5.1.2(i)) as already-granted for these fixture ids, the same way a real
  //   "yes" would have left localStorage. The smoke fixtures represent already-
  //   onboarded accounts, so without this every spec that logs an athlete/coach
  //   straight in (not through signup) would hang behind the new blocking card.
  //   A spec that specifically wants to exercise the gate should clear this key
  //   itself after the fact. Key name must match AI_CONSENT_CACHE_KEY in App.jsx.
  await page.addInitScript((consentIds) => {
    try {
      if (window.PublicKeyCredential) {
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable =
          () => Promise.resolve(false);
      }
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => new Promise(() => {});
      }
      if (consentIds && consentIds.length) {
        const m = {};
        consentIds.forEach((id) => { if (id) m[id] = true; });
        localStorage.setItem("wilco_ai_consent_v1", JSON.stringify(m));
      }
    } catch (_) {}
  }, [athlete.id, coach && coach.id].filter(Boolean));

  // Catch-all for any /api/* endpoint not specifically handled below
  // (send-coach-welcome, trigger-proof-feed, push, ...). Registered FIRST so the
  // specific routes below take precedence (Playwright matches newest-first).
  await page.route("**/api/**", (route) => {
    record(route);
    route.fulfill(json({ ok: true }));
  });

  // ── /api/identity ──────────────────────────────────────────────────────────
  await page.route("**/api/identity", (route) => {
    const body = record(route) || {};
    switch (body.action) {
      case "athlete-login": {
        // Real endpoint: name+pin verified -> { athlete: stripPin(row), token }.
        const ok = body.pin === "1234" && body.name === athlete.name;
        return route.fulfill(json(
          ok ? { athlete, token }
             : { athlete: null, reason: body.pin === "1234" ? "not_found" : "wrong_pin" }
        ));
      }
      case "get-athlete": // athlete refreshing THEIR OWN record on boot
        return route.fulfill(json({ athlete, token }));
      case "check-athlete-name":
        return route.fulfill(json({ exists: false }));
      case "coach-login": // real endpoint: pin-only, first bcrypt match wins
        return route.fulfill(json(coach ? { coach, token: "smoketest-coach-token" } : { coach: null }));
      case "coach-dashboard": // roster + school for the caller (shape of identity.js coachDashboard)
        return route.fulfill(json({ athletes: coach ? [athlete] : [], coaches: [], school: [], schoolsAll: [], coachCounts: null }));
      case "create-athlete": {
        // Real endpoint: hashes the PIN server-side and forces tier; returns the
        // created row (merged over the caller's profile fields) + a session token.
        const created = makeAthlete({
          ...body.athlete,
          tier: body.isSchool ? "school" : "free",
          // Mirrors api/identity.js: every non-school signup gets the W18-3
          // 7-day trial stamp at creation (server-set, never client-writable).
          trial_ends_at: body.isSchool ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
        return route.fulfill(json({ athlete: created, token }));
      }
      case "log-error":
      case "log-events": // fire-and-forget ingestion always answers 200 { ok:true }
        return route.fulfill(json({ ok: true }));
      default:
        return route.fulfill(json({ error: "Unknown action" }, 400));
    }
  });

  // ── /api/data — the authenticated read/write gateway ───────────────────────
  // legal_acceptances defaults to an already-granted ai_processing row (belt-
  // and-suspenders with the localStorage seed above — AiConsentGate checks the
  // cache first and never reaches this read for the fixtures' own ids, but a
  // spec that clears the cache to test the gate itself still needs a sane
  // default here). Pass dataReads:{legal_acceptances:[]} to test the "not yet
  // granted" blocking card.
  const effectiveDataReads = { legal_acceptances: [{ id: "mock-legal-ai", document: "ai_processing" }], ...dataReads };
  await page.route("**/api/data", (route) => {
    const body = record(route) || {};
    switch (body.op) {
      case "read": { // gateway reads return a bare PostgREST-style array
        const canned = effectiveDataReads[body.table];
        if (canned) return route.fulfill(json(typeof canned === "function" ? (canned(body) || []) : canned));
        return route.fulfill(json([]));
      }
      case "insert":
      case "upsert": {
        const rows = Array.isArray(body.data) ? body.data : [body.data];
        return route.fulfill(json(rows.map((r, i) => ({ id: `mock-row-${i}`, created_at: new Date().toISOString(), ...r }))));
      }
      case "update":
        return route.fulfill(json([{ id: body.id || "mock-row-0", ...body.data }]));
      case "delete":
        return route.fulfill(json({ ok: true }));
      default:
        return route.fulfill(json({ error: "Unknown op" }, 400));
    }
  });

  // ── /api/claude — the AI proxy (Anthropic Messages response shape) ─────────
  await page.route("**/api/claude", (route) => {
    const body = record(route) || {};
    const text = body.feature === "workout_parse"
      ? JSON.stringify(parseResult)
      : body.feature === "goal_parse"
        ? JSON.stringify({ goal_text: "get stronger", goal_type: "strength", target_metric: null, target_value: null, target_date: null })
        : body.feature === "program_build" && body.model === "claude-haiku-4-5"
          ? JSON.stringify(builderExtract)
          : body.feature === "program_build"
            ? builderQuestion
            : body.feature === "program_draft"
              ? builderDraftText
              : body.feature === "program_generate" && recDraftReply
                ? recDraftReply
                : chatReply;
    return route.fulfill(json({
      id: "msg_smoketest",
      type: "message",
      role: "assistant",
      model: body.model || "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    }));
  });

  // ── /api/create-subscription — PaymentStep bootstrap ───────────────────────
  // T37 card-first checkout: the payment screen mints a SetupIntent at mount and
  // refuses to render the card form (or its CTA) until this resolves. Without the
  // stub every payment-step spec hangs on "initializing".
  await page.route("**/api/checkout-intent", async (route) => {
    calls.push({ url: route.request().url(), body: route.request().postDataJSON() });
    // subscriptionDelayMs predates T37; the observable "Loading secure checkout…"
    // window it exists to create is now the SetupIntent mint, so it throttles this.
    if (subscriptionDelayMs) await new Promise((r) => setTimeout(r, subscriptionDelayMs));
    route.fulfill({ json: { clientSecret: "seti_mock_secret_smoke" } });
  });

  await page.route("**/api/create-subscription", async (route) => {
    record(route);
    await new Promise((r) => setTimeout(r, subscriptionDelayMs));
    // Real endpoint returns a Stripe client secret + confirm mode ("setup" during
    // the 7-day-trial path). PaymentStep only needs these two fields to proceed
    // to the Stripe.js mount.
    return route.fulfill(json({ clientSecret: "seti_smoketest_secret_smoketest", mode: "setup" }));
  });

  // ── /api/validate-gift-code — the Apply-code step ──────────────────────────
  // Real endpoint resolves the code against Stripe and returns the coupon's terms;
  // the disclosure copy is built from them, so specs can hand it any offer shape.
  await page.route("**/api/validate-gift-code", async (route) => {
    record(route);
    return route.fulfill(json(giftResult));
  });

  // ── External hosts: keep the suite deterministic offline ───────────────────
  await page.route(/fonts\.googleapis\.com/, (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "/* fonts stubbed for smoke tests */" }));
  await page.route(/fonts\.gstatic\.com/, (route) => route.abort());
  await page.route(/\.supabase\.co/, (route) => route.fulfill(json([])));

  if (blockStripeJs) {
    // Simulates an ad blocker killing Stripe.js at checkout — the exact failure
    // mode the visible retry state (fix b3901c9) exists for.
    await page.route(/js\.stripe\.com/, (route) => route.abort());
  }

  return { calls };
}

/** Drive the real login UI to land on the athlete main screen. */
// A coach row as coach-login returns it (stripPin'd server-side; the mock keeps
// pin present because coach.jsx forwards coach.pin on idApi calls it makes).
export const makeCoach = (overrides = {}) => ({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Smoke Coach",
  email: "smoke@coach.test",
  sports: ["Football"],
  role: "coach",
  school_id: null,
  coach_number: 1,
  tour_done_at: new Date().toISOString(),
  crew_allowed: true,
  pin: "9999",
  ...overrides,
});

/** Drive the real coach login UI to land on the dashboard Overview. */
export async function loginAsCoach(page, coach) {
  await page.goto("/");
  await page.getByRole("button", { name: "Coach Login" }).click();
  await page.getByPlaceholder("----").fill(coach.pin || "9999");
  await page.getByRole("button", { name: "Access Dashboard ->" }).click();
  await page.getByText("WILCO COACH").waitFor();
}

export async function loginAsAthlete(page, athlete, path = "/") {
  await page.goto(path);
  await page.getByRole("button", { name: "Athlete Login" }).click();
  // Relight (08-07) reworded the login field; "Exact name you signed up with"
  // now lives on the forgot-PIN form and matched an invisible input here.
  await page.getByPlaceholder("Your name, or the email you signed up with").fill(athlete.name);
  await page.getByPlaceholder("----").fill("1234");
  await page.getByRole("button", { name: "Let's Get to Work ->" }).click();
  // Athlete main surface = the Coach Joe-Bot chat header.
  await page.getByText("WILCO", { exact: true }).waitFor();
}
