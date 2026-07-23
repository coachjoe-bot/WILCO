// Boot-skeleton twin test — keeps index.html's inline gate and App.jsx's
// restoreAuthSession() agreeing about whether a session is live.
// Run with: node scripts/test-boot-skeleton.mjs
//
// These two read the SAME localStorage blob, independently, microseconds apart.
// index.html decides which skeleton to paint before React exists; App.jsx decides
// whether to actually restore the session. When they disagree the athlete watches
// a chat skeleton resolve into the login screen (or a splash flash into a
// dashboard) — the exact "fake promise the boot then yanks away" the gate was
// added to remove.
//
// This suite runs BOTH implementations against the same fixtures: the real
// restoreAuthSession path (imported from src/App.jsx is impossible — it's a React
// module — so the rule is re-derived here and pinned against the source text), and
// the inline script extracted from index.html and executed for real.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const app = readFileSync(join(root, "src/App.jsx"), "utf8");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("  ✗ " + msg); } };
const eq = (got, want, msg) => ok(Object.is(got, want), `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the constants must literally match ───────────────────────────────────────
console.log("shared constants:");
{
  const htmlKey = /var AUTH_KEY = "([^"]+)"/.exec(html)?.[1];
  const appKey = /const AUTH_SESSION_KEY = "([^"]+)"/.exec(app)?.[1];
  ok(!!htmlKey, "index.html declares AUTH_KEY");
  ok(!!appKey, "App.jsx declares AUTH_SESSION_KEY");
  eq(htmlKey, appKey, "both read the SAME localStorage key");
}
{
  // Both must read the expiry out of token part [3]. If App.jsx's token format
  // ever changes, the inline copy has to move with it.
  ok(/parts\.length >= 4 \? \(Number\(parts\[3\]\) \|\| 0\) : 0/.test(html),
     "index.html reads the token expiry from part [3]");
  ok(/p\.length>=4 \? \(Number\(p\[3\]\)\|\|0\) : 0/.test(app),
     "App.jsx reads the token expiry from part [3]");
}
{
  // Both gates require BOTH clocks: the rolling trust window AND the token expiry.
  ok(/now <= \(s\.trustedUntil \|\| 0\) && now <= tokenExpMs/.test(html),
     "index.html requires trustedUntil AND token expiry");
  ok(/Date\.now\(\) > \(s\.trustedUntil\|\|0\) \|\| Date\.now\(\) > tokenExpMs\(s\.token\)/.test(app),
     "App.jsx requires trustedUntil AND token expiry");
}
{
  // Only the two renderable roles are restored, matching the gate's athlete/coach
  // branches — anything else falls through to the splash on both sides.
  ok(/s\.role !== "athlete" && s\.role !== "coach"/.test(app), "App.jsx restores only athlete/coach");
}
{
  // Both require a record; App.jsx returns null without one, so the skeleton must
  // not promise a dashboard the restore won't deliver.
  ok(/s\.record/.test(html), "index.html requires a persisted record");
  ok(/!s\.token \|\| !s\.record/.test(app), "App.jsx requires a persisted record");
}

// ── run index.html's gate for real against fixtures ──────────────────────────
console.log("gate behavior:");
const inline = /\(function \(\) \{[\s\S]*?\}\)\(\);/.exec(html)?.[0];
ok(!!inline, "the inline boot gate is extractable from index.html");

const HOUR = 3600e3;
const token = (expMs) => `v1.athlete.a1.${expMs}.sig`;
// The App.jsx rule, transcribed. Pinned against the source by the assertions above.
const appRestores = (s, now) => {
  if (!s || !s.token || !s.record) return false;
  if (s.role !== "athlete" && s.role !== "coach") return false;  // WilcoRoot renders no other view
  const parts = String(s.token).split(".");
  const exp = parts.length >= 4 ? (Number(parts[3]) || 0) : 0;
  if (now > (s.trustedUntil || 0) || now > exp) return false;
  return true;
};

const runGate = (blob) => {
  const store = { [`wilco_auth_v1`]: blob == null ? null : JSON.stringify(blob) };
  const rootEl = { innerHTML: "" };
  const sandbox = {
    document: { getElementById: () => rootEl },
    localStorage: { getItem: (k) => (k in store ? store[k] : null) },
    Date,
    JSON,
    Number,
    String,
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function("document", "localStorage", inline);
  fn(sandbox.document, sandbox.localStorage);
  if (/boot-splash/.test(rootEl.innerHTML)) return "splash";
  if (/boot-cards/.test(rootEl.innerHTML)) return "coach";
  if (/boot-pills/.test(rootEl.innerHTML)) return "athlete";
  return "unknown";
};

const now = Date.now();
const live = (role) => ({ role, token: token(now + 7 * 24 * HOUR), record: { id: "a1" }, trustedUntil: now + 3 * HOUR });

const cases = [
  ["a live athlete session", live("athlete"), "athlete"],
  ["a live coach session", live("coach"), "coach"],
  ["no stored session at all", null, "splash"],
  ["a lapsed trust window", { ...live("athlete"), trustedUntil: now - 1000 }, "splash"],
  ["an expired token", { ...live("athlete"), token: token(now - 1000) }, "splash"],
  ["a session with no record", { ...live("athlete"), record: undefined }, "splash"],
  ["a session with no token", { ...live("athlete"), token: undefined }, "splash"],
  ["a malformed token", { ...live("athlete"), token: "garbage" }, "splash"],
  ["an unknown role", { ...live("athlete"), role: "alien" }, "splash"],
];
for (const [label, blob, want] of cases) {
  eq(runGate(blob), want, `gate: ${label}`);
  // …and the two implementations must AGREE about whether a session is live.
  const gatePainted = runGate(blob) !== "splash";
  eq(gatePainted, appRestores(blob, now), `agreement: ${label}`);
}

// Corrupt JSON must produce the splash, not an exception that leaves #root empty
// (an empty #root is a white screen until the bundle parses — the exact thing the
// skeleton exists to prevent).
{
  const rootEl = { innerHTML: "" };
  const fn = new Function("document", "localStorage", inline);
  let threw = false;
  try {
    fn({ getElementById: () => rootEl }, { getItem: () => "{not json" });
  } catch (_) { threw = true; }
  ok(!threw, "corrupt stored JSON does not throw out of the gate");
  ok(/boot-splash/.test(rootEl.innerHTML), "corrupt stored JSON still paints the splash");
}
{
  // localStorage itself throwing (Safari private mode) must be survivable too.
  const rootEl = { innerHTML: "" };
  const fn = new Function("document", "localStorage", inline);
  let threw = false;
  try {
    fn({ getElementById: () => rootEl }, { getItem: () => { throw new Error("denied"); } });
  } catch (_) { threw = true; }
  ok(!threw, "a hostile localStorage does not throw out of the gate");
  ok(/boot-splash/.test(rootEl.innerHTML), "a hostile localStorage still paints the splash");
}

// Every class the gate writes must actually be styled in the same file, or the
// skeleton paints as unstyled bare divs.
console.log("styles exist for every skeleton class:");
for (const cls of ["boot", "boot-brand", "boot-bar", "boot-pills", "boot-msg", "boot-head", "boot-cards", "boot-card", "boot-splash"]) {
  ok(html.includes(`.${cls}{`) || html.includes(`.${cls} `) || html.includes(`.${cls}.`),
     `.${cls} is styled in index.html`);
}

if (fail) { console.error(`\n${fail} FAILURE(S) (${pass} passed)`); process.exit(1); }
console.log(`\nAll ${pass} boot-skeleton checks pass.`);
