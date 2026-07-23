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

console.log(`\n${fail === 0 ? "All" : ""} ${pass} auth-logic checks pass${fail ? `, ${fail} FAILED` : "."}`);
process.exit(fail === 0 ? 0 : 1);
