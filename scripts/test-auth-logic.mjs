// ─── AUTH LOGIC REGRESSION SUITE ─────────────────────────────────────────────
// Pure security-boundary helpers in api/_supa.js, which had zero coverage. These
// are the pieces a mistake in is silently exploitable rather than merely broken:
// session-token forgery/expiry, the ilike-wildcard escape that stops one login
// attempt from bcrypt-sweeping every account, PIN shape, and PIN stripping.
//
// Needs a signing key. SUPABASE_SERVICE_KEY is read at import time, so this suite
// sets a dummy one when the env doesn't provide it — the tests only check that
// sign/verify are self-consistent, never a specific signature value.
//
//   node scripts/test-auth-logic.mjs
//
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "test-signing-key-not-a-real-secret";
const { mintSessionToken, tryTokenAuth, escapeLike, str, pin4, stripPin } = await import("../api/_supa.js");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
};
const throws = (name, fn) => {
  try { fn(); check(name, "did not throw", "throws"); }
  catch { pass++; console.log(`  ✓ ${name}`); }
};

console.log("session tokens — a valid one round-trips:");
const tok = mintSessionToken("athlete", "ath-1");
check("a freshly minted token verifies", tryTokenAuth({ role: "athlete", id: "ath-1", token: tok }), { role: "athlete", id: "ath-1" });
check("a coach token verifies as coach", (() => {
  const t = mintSessionToken("coach", "co-1");
  return tryTokenAuth({ role: "coach", id: "co-1", token: t });
})(), { role: "coach", id: "co-1" });

console.log("\nsession tokens — every rejection path returns null, never throws:");
check("a token cannot be replayed as another ATHLETE", tryTokenAuth({ role: "athlete", id: "ath-2", token: tok }), null);
check("a token cannot be replayed under another ROLE", tryTokenAuth({ role: "coach", id: "ath-1", token: tok }), null);
check("a tampered signature is rejected", tryTokenAuth({ role: "athlete", id: "ath-1", token: tok.slice(0, -3) + "aaa" }), null);
check("a tampered id in the payload is rejected", (() => {
  const [v, role, , exp, sig] = tok.split(".");
  return tryTokenAuth({ role: "athlete", id: "ath-9", token: [v, role, "ath-9", exp, sig].join(".") });
})(), null);
check("an extended expiry is rejected (signature covers exp)", (() => {
  const [v, role, id, , sig] = tok.split(".");
  const far = String(Date.now() + 999 * 864e5);
  return tryTokenAuth({ role: "athlete", id, token: [v, role, id, far, sig].join(".") });
})(), null);
check("an expired token is rejected", (() => {
  const t = mintSessionToken("athlete", "ath-1").split(".");
  t[3] = String(Date.now() - 1000);
  return tryTokenAuth({ role: "athlete", id: "ath-1", token: t.join(".") });
})(), null);
check("an unknown version prefix is rejected", tryTokenAuth({ role: "athlete", id: "ath-1", token: tok.replace(/^v1\./, "v2.") }), null);
check("a malformed token is rejected", tryTokenAuth({ role: "athlete", id: "ath-1", token: "garbage" }), null);
check("a missing token is rejected", tryTokenAuth({ role: "athlete", id: "ath-1" }), null);
check("a null auth object is rejected", tryTokenAuth(null), null);
check("a non-athlete/coach role is rejected", (() => {
  const t = mintSessionToken("admin", "x");
  return tryTokenAuth({ role: "admin", id: "x", token: t });
})(), null);

console.log("\nescapeLike — the one-PIN-against-every-account amplifier:");
check("% is escaped", escapeLike("%"), "\\%");
check("_ is escaped", escapeLike("_"), "\\_");
check("* is escaped (PostgREST rewrites it to %)", escapeLike("*"), "\\*");
check("a backslash is escaped first, not doubled wrong", escapeLike("\\"), "\\\\");
check("a bare wildcard name cannot match every row", escapeLike("%%"), "\\%\\%");
check("an ordinary name passes through untouched", escapeLike("Marcus Ellison"), "Marcus Ellison");
check("names with apostrophes/hyphens/periods are untouched", escapeLike("Sean O'Neill-Smith Jr."), "Sean O'Neill-Smith Jr.");
check("a mixed injection attempt is fully escaped", escapeLike("a%b_c*d"), "a\\%b\\_c\\*d");

console.log("\nstr / pin4 input validation:");
check("a normal string is trimmed", str("  hello  "), "hello");
throws("a non-string is rejected", () => str(123));
throws("an empty string is rejected", () => str("   "));
throws("an over-long string is rejected", () => str("x".repeat(300), { max: 200 }));
check("a 4-digit PIN passes", pin4("1234"), "1234");
throws("a 3-digit PIN is rejected", () => pin4("123"));
throws("a 5-digit PIN is rejected", () => pin4("12345"));
throws("a non-numeric PIN is rejected", () => pin4("12a4"));
throws("an empty PIN is rejected", () => pin4(""));

console.log("\nstripPin — secrets never reach the browser:");
check("the pin column is removed", stripPin({ id: "a1", name: "Marcus", pin: "$2b$hash" }), { id: "a1", name: "Marcus" });
check("a row without a pin is unchanged", stripPin({ id: "a1", name: "Marcus" }), { id: "a1", name: "Marcus" });
check("null passes through", stripPin(null), null);

// T46: the same rule on the GATEWAY's write path. PostgREST returns
// return=representation, so a plain self-update on `athletes` handed the caller
// their own bcrypt PIN hash. It is only ever their own row, but a bcrypt hash of
// a four-digit pin is a 10,000-candidate offline crack and must not leave the
// server. Confirmed against prod 2026-08-11 before the fix.
const { stripPins } = await import("../api/data.js");
check("gateway strips the pin from a single returned row", stripPins({ id: "a1", name: "Marcus", pin: "$2a$10$x" }), { id: "a1", name: "Marcus" });
check("gateway strips the pin from EVERY row of an array", stripPins([{ id: "a1", pin: "$2a$10$x" }, { id: "a2", pin: "$2a$10$y" }]), [{ id: "a1" }, { id: "a2" }]);
check("gateway passes a pin-free payload through untouched", stripPins([{ id: "a1", goal: "strength" }]), [{ id: "a1", goal: "strength" }]);
check("gateway tolerates null/minimal bodies", stripPins(null), null);

// ── billing-endpoint token authorization ────────────────────────────────────
// tokenAthleteId IS the authorization rule for the three money endpoints now that
// they accept a session token instead of demanding the plaintext PIN. Every case
// here is "can this token act as this athlete" — a loosened predicate would let a
// coach token, or a token minted for someone else, drive a checkout.
const { tokenAthleteId } = await import("../api/_stripe.js");
console.log("\ntokenAthleteId — who may drive a billing call:");
{
  const athleteTok = mintSessionToken("athlete", "ath-1");
  const coachTok = mintSessionToken("coach", "co-1");
  const authFor = (role, id, token) => ({ role, id, token });
  check("own token authorizes own athlete", tokenAthleteId(authFor("athlete", "ath-1", athleteTok), "ath-1"), "ath-1");
  check("token with no athleteId in the body still resolves", tokenAthleteId(authFor("athlete", "ath-1", athleteTok), undefined), "ath-1");
  check("token cannot act on a DIFFERENT athlete", tokenAthleteId(authFor("athlete", "ath-1", athleteTok), "ath-2"), null);
  check("a COACH token is never an athlete", tokenAthleteId(authFor("coach", "co-1", coachTok), "co-1"), null);
  check("a coach token cannot be relabelled as an athlete", tokenAthleteId(authFor("athlete", "co-1", coachTok), "co-1"), null);
  check("no auth → PIN fallback (null)", tokenAthleteId(undefined, "ath-1"), null);
  check("auth without a token → PIN fallback", tokenAthleteId({ role: "athlete", id: "ath-1" }, "ath-1"), null);
  check("a tampered token → PIN fallback", tokenAthleteId(authFor("athlete", "ath-1", athleteTok.slice(0, -3) + "aaa"), "ath-1"), null);
  check("an expired token → PIN fallback", tokenAthleteId(authFor("athlete", "ath-9", ["v1", "athlete", "ath-9", String(Date.now() - 1000), "sig"].join(".")), "ath-9"), null);
}


// ── create-athlete rate-limit contract (T57 s6 team-scale dry run) ───────────
// The live dry run proved a roster on one school-wifi IP bricks at athlete #11
// under a flat 10/hr cap. These pin the fix at the source level: school signups
// carry roster headroom, and the refusal copy states the real one-hour window.
console.log("create-athlete rate-limit contract:");
{
  const { readFileSync } = await import("node:fs");
  const identity = readFileSync(new URL("../api/identity.js", import.meta.url), "utf8");
  check("every signup gets roster headroom (40/hr per IP — Will's 08-20 widening)", /max: 40,\n    windowMin: 60/.test(identity), true);
  check("the refusal copy states the real one-hour window", identity.includes("wait an hour"), true);
  const supa = readFileSync(new URL("../api/_supa.js", import.meta.url), "utf8");
  check("rateLimit supports a per-limiter message", /message \|\| "Too many attempts/.test(supa), true);
}

// ── per-target login throttle (App Store review, 2026-09-29) ────────────────
// PINs are 4 digits, and the existing athlete-login limiter is keyed by
// IP+name, so an attacker rotating IPs was unthrottled against one target
// name. Source-contract checks only — exercising the real throttle needs a
// live rate_limits table (see NEEDS_CREDENTIALS suites), so this pins the
// SHAPE of the fix: an IP-independent key, a real max, reset on success,
// and recorded only on an actual wrong-PIN guess (never on a typo'd name
// that matches nobody, and never on the "ambiguous, PIN was right for two
// rows" branch).
console.log("\nper-target athlete-login throttle (source contract):");
{
  const { readFileSync } = await import("node:fs");
  const identity = readFileSync(new URL("../api/identity.js", import.meta.url), "utf8");
  const fn = identity.slice(identity.indexOf("async function athleteLogin"), identity.indexOf("async function coachLogin"));
  check("the target key has no IP in it (rotating IPs can't reset it)",
    /athlete-login-target:\$\{name\.toLowerCase\(\)\}/.test(fn), true);
  check("authThrottle (failure-only) guards the target key, not the plain rateLimit",
    /authThrottle\(targetKey, \{ max: 15, windowMin: 15 \}\)/.test(fn), true);
  check("a successful login clears the target counter too",
    /rateLimitReset\(targetKey\)/.test(fn), true);
  check("a failure is recorded only when the name matched a real athlete",
    /if \(byName\.length\) await recordTargetFail\(\);/.test(fn), true);
  check("the ambiguous branch (PIN WAS right, for two rows) returns before any target-fail record",
    /reason: "ambiguous" \}\);\s*\}/.test(fn) && fn.indexOf('reason: "ambiguous"') < fn.indexOf("recordTargetFail()"), true);
}

console.log(`\n${fail === 0 ? "All" : ""} ${pass} auth-logic checks pass${fail ? `, ${fail} FAILED` : "."}`);
process.exit(fail === 0 ? 0 : 1);
