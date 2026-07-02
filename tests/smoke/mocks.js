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
  current_period_end: null,
  proof_enabled: false,
  proof_schedule_dow: 0,
  proof_schedule_hour: 8,
  proof_timezone: "America/New_York",
  resolved_pain: null,
  ...overrides,
});

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
 */
export async function mockApi(page, options = {}) {
  const {
    athlete = makeAthlete(),
    parseResult = emptyParse,
    chatReply = "Solid work. Keep stacking sessions.",
    blockStripeJs = false,
    subscriptionDelayMs = 300,
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
  await page.addInitScript(() => {
    try {
      if (window.PublicKeyCredential) {
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable =
          () => Promise.resolve(false);
      }
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => new Promise(() => {});
      }
    } catch (_) {}
  });

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
          ok ? { athlete, token: "smoketest-session-token" }
             : { athlete: null, reason: body.pin === "1234" ? "not_found" : "wrong_pin" }
        ));
      }
      case "get-athlete": // athlete refreshing THEIR OWN record on boot
        return route.fulfill(json({ athlete, token: "smoketest-session-token" }));
      case "check-athlete-name":
        return route.fulfill(json({ exists: false }));
      case "log-error":
      case "log-events": // fire-and-forget ingestion always answers 200 { ok:true }
        return route.fulfill(json({ ok: true }));
      default:
        return route.fulfill(json({ error: "Unknown action" }, 400));
    }
  });

  // ── /api/data — the authenticated read/write gateway ───────────────────────
  await page.route("**/api/data", (route) => {
    const body = record(route) || {};
    switch (body.op) {
      case "read": // gateway reads return a bare PostgREST-style array
        return route.fulfill(json([]));
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
  await page.route("**/api/create-subscription", async (route) => {
    record(route);
    await new Promise((r) => setTimeout(r, subscriptionDelayMs));
    // Real endpoint returns a Stripe client secret + confirm mode ("setup" during
    // the 7-day-trial path). PaymentStep only needs these two fields to proceed
    // to the Stripe.js mount.
    return route.fulfill(json({ clientSecret: "seti_smoketest_secret_smoketest", mode: "setup" }));
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
export async function loginAsAthlete(page, athlete) {
  await page.goto("/");
  await page.getByRole("button", { name: "Athlete Login" }).click();
  await page.getByPlaceholder("Exact name you signed up with").fill(athlete.name);
  await page.getByPlaceholder("----").fill("1234");
  await page.getByRole("button", { name: "Let's Get to Work ->" }).click();
  // Athlete main surface = the Coach Joe-Bot chat header.
  await page.getByText("COACH JOE-BOT").waitFor();
}
