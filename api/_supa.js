// ─── SHARED SERVER HELPERS (auth-layer endpoints) ────────────────────────────
// Used by api/identity.js (and future authenticated data endpoints). The leading
// underscore tells Vercel NOT to expose this file as its own serverless route.
//
// Why this file exists: the browser may no longer read `athletes`/`coaches`
// directly (RLS now blocks the anon key). These helpers let our trusted server
// functions read/write with the Supabase SERVICE key, after verifying the caller.

// ── Env ──────────────────────────────────────────────────────────────────────
const SB_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

// MUST be the service_role key for athletes/coaches reads to bypass RLS.
// Falls back to anon only so non-RLS tables still work in misconfigured envs.
const SB_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.VITE_SUPABASE_KEY;

const sbHeaders = () => ({
  "Content-Type": "application/json",
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
});

import bcrypt from "bcryptjs";

// ── PIN hashing ──────────────────────────────────────────────────────────────
// PINs are stored as bcrypt hashes. verifyPin compares a typed PIN against the
// stored value; it falls back to plain-equality only if the stored value isn't a
// bcrypt hash (defensive — shouldn't happen now that all PINs are hashed).
export async function verifyPin(plain, stored) {
  if (stored == null) return false;
  const s = String(stored);
  if (s.startsWith("$2")) return bcrypt.compare(String(plain), s);
  return String(plain) === s;
}

export async function hashPin(plain) {
  return bcrypt.hash(String(plain), 10);
}

// ── Signed session tokens (SCALE-NOTES #1) ───────────────────────────────────
// Every gateway request used to pay a Supabase lookup + a bcrypt compare
// (~100-250ms) just to re-prove the same identity. Login now mints an HMAC
// token (role.id.exp signed with a key derived from the service-role key, and
// domain-separated so the raw key is never used directly as a MAC key elsewhere).
// authCaller verifies it with pure CPU: no DB read, no bcrypt.
//
// The PIN path stays as a full fallback: old clients / expired tokens simply
// degrade to the exact pre-token behavior, so nothing breaks on deploy.
// Tradeoff accepted: a token stays valid for its lifetime even if the PIN is
// changed — bounded by the short expiry (tokens are re-minted at every login,
// and the client never persists a session across page loads).
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const SESSION_TOKEN_DAYS = 7;
// FAIL CLOSED: sign ONLY with a server-secret (the service-role key). The general
// SB_KEY chain can fall through to the PUBLIC anon key (VITE_SUPABASE_KEY, shipped
// in the browser bundle); using that to sign would let anyone forge a token for any
// account. So we derive the signing secret from the service key alone and refuse to
// sign/verify if it's absent — better a token outage (PIN fallback still works) than
// a forgeable one. In prod SB_KEY already resolves to this same service key, so the
// derived secret is byte-identical to before — no live token is invalidated.
const SB_SIGNING_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const sessionSecret = () => {
  if (!SB_SIGNING_KEY) throw httpErr(500, "Session signing key unavailable");
  return createHmac("sha256", SB_SIGNING_KEY).update("wilco-session-v1").digest();
};
const signSession = (payload) =>
  createHmac("sha256", sessionSecret()).update(payload).digest("base64url");

export function mintSessionToken(role, id) {
  const exp = Date.now() + SESSION_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${role}.${id}.${exp}`;
  return `v1.${payload}.${signSession(payload)}`;
}

// Verify auth.token against auth.{role,id}. Returns {role,id} on success, null on
// ANY mismatch/expiry/malformation — callers fall back to the PIN path, never throw.
export function tryTokenAuth(auth) {
  try {
    if (!auth || typeof auth !== "object" || typeof auth.token !== "string") return null;
    const parts = auth.token.split(".");
    if (parts.length !== 5 || parts[0] !== "v1") return null;
    const [, role, id, expStr, sig] = parts;
    if (role !== "athlete" && role !== "coach") return null;
    if (role !== auth.role || String(id) !== String(auth.id)) return null;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || Date.now() > exp) return null;
    const expected = Buffer.from(signSession(`${role}.${id}.${expStr}`));
    const given = Buffer.from(String(sig));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return { role, id };
  } catch {
    return null;
  }
}

// ── Checkout handoff tokens (T18 iOS payments surgery) ───────────────────────
// The native iOS app can't ship the embedded Stripe Elements PaymentStep (App
// Review 3.1.1), so it hands an athlete off to a standalone web checkout page
// (app.trainwilco.com/upgrade) via the system browser. That page needs to know
// WHICH athlete arrived, without the URL ever carrying a bare athleteId (no
// enumeration) or a long-lived credential (a 7-day session token sitting in a
// URL is a much worse leak surface than one in memory/localStorage).
//
// This token is a SEPARATE credential from the session token above: a distinct
// HMAC domain ("checkout:" vs "wilco-session-v1") so a checkout token can never
// be replayed as a session token or vice versa even though both derive from the
// same server secret, a short fixed lifetime (15 min — just long enough to
// background-switch into Safari and load the page), and a random `jti` that the
// caller (api/identity.js) persists on the athlete row and clears ATOMICALLY on
// first successful use (PATCH ... WHERE checkout_token_jti = <jti>, mirroring
// the claimGiftGeneration compare-and-swap in api/_stripe.js) — so a copied or
// revisited link can be redeemed exactly once. This module only signs/verifies
// the token's shape and its own embedded expiry (self-contained — no DB read
// needed to reject a stale token); one-time-use is enforced by the caller via
// the atomic claim against athletes.checkout_token_jti/_exp, which it also
// stores as a record of the token's expiry for support/debugging purposes.
const CHECKOUT_TOKEN_MIN = 15;
const signCheckout = (payload) =>
  createHmac("sha256", sessionSecret()).update(`checkout:${payload}`).digest("base64url");

export function mintCheckoutToken(athleteId) {
  const jti = randomBytes(9).toString("base64url");
  const exp = Date.now() + CHECKOUT_TOKEN_MIN * 60 * 1000;
  const payload = `${athleteId}.${exp}.${jti}`;
  return { token: `c1.${payload}.${signCheckout(payload)}`, jti, exp };
}

// Pure signature/shape verification — does NOT check one-time-use or consult
// the DB. Returns {athleteId, exp, jti} on a structurally + cryptographically
// valid, unexpired token; null on ANY problem (never throws).
export function parseCheckoutToken(token) {
  try {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 5 || parts[0] !== "c1") return null;
    const [, athleteId, expStr, jti, sig] = parts;
    if (!athleteId || !jti) return null;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || Date.now() > exp) return null;
    const expected = Buffer.from(signCheckout(`${athleteId}.${expStr}.${jti}`));
    const given = Buffer.from(String(sig));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return { athleteId, exp, jti };
  } catch {
    return null;
  }
}

// ── Errors ───────────────────────────────────────────────────────────────────
export function httpErr(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

// ── CORS: same-origin app calls need nothing; this only blocks OTHER origins ──
const ALLOWED_ORIGINS = new Set([
  "https://app.trainwilco.com",
  "http://localhost:3000",
  "http://localhost:5173",
  // The Capacitor iOS shell's WebView origin — its API calls are cross-origin
  // by construction (client twin: src/nativeFetch.js rewrites relative /api).
  "capacitor://localhost",
]);

export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

// ── Input validation ─────────────────────────────────────────────────────────
export function str(v, { min = 1, max = 200, name = "field" } = {}) {
  if (typeof v !== "string") throw httpErr(400, `${name} must be text`);
  const t = v.trim();
  if (t.length < min) throw httpErr(400, `${name} is required`);
  if (t.length > max) throw httpErr(400, `${name} is too long`);
  return t;
}

export function pin4(v) {
  const s = String(v ?? "");
  if (!/^\d{4}$/.test(s)) throw httpErr(400, "PIN must be exactly 4 digits");
  return s;
}

// Escape LIKE/ILIKE pattern characters in user-supplied text before it is
// interpolated into a PostgREST `ilike.` filter. Without this, name="%" (or "_")
// matches EVERY row — turning a single login attempt into a PIN check against the
// whole table. `*` is included because PostgREST rewrites `*` to `%` in like/ilike
// patterns, so a bare `*` is the same wildcard through that door; `\*` survives as
// a literal either way. Normal names (letters, spaces, hyphens, apostrophes,
// periods) contain none of these characters and are passed through unchanged.
export const escapeLike = (s) => String(s).replace(/[\\%_*]/g, (m) => "\\" + m);

export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// Drop secret columns before returning a row to the browser.
export const stripPin = (row) => {
  if (!row || typeof row !== "object") return row;
  const { pin, ...rest } = row;
  return rest;
};

// ── Supabase REST (service key) ──────────────────────────────────────────────
export async function sbSelect(table, query = "") {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${query}`, { headers: sbHeaders() });
  const rows = await r.json().catch(() => null);
  if (!r.ok) throw httpErr(502, rows?.message || `Database read failed (${r.status})`);
  return Array.isArray(rows) ? rows : [];
}

export async function sbInsert(table, obj) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify(obj),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw httpErr(502, e?.message || `Database write failed (${r.status})`);
  }
}

export async function sbDelete(table, query = "") {
  await fetch(`${SB_URL}/rest/v1/${table}${query}`, { method: "DELETE", headers: sbHeaders() });
}

// Generic write used by the authenticated write gateway (api/data.js). Mirrors a
// raw PostgREST call but with the service key, after the caller has been verified.
export async function sbWrite({ method, table, query = "", body, prefer = "return=representation" }) {
  const opts = { method, headers: { ...sbHeaders(), Prefer: prefer } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${SB_URL}/rest/v1/${table}${query}`, opts);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) throw httpErr(r.status, (json && json.message) || `Database write failed (${r.status})`);
  return json;
}

// ── AI permission (App Store 5.1.2(i)) ───────────────────────────────────────
// An athlete's data may only reach the AI provider after they tapped the
// permission: a legal_acceptances row with document 'ai_processing' (written at
// signup by recordAcceptances, or by the one-time card for existing accounts).
// The client gate blocks the app; this is the server half.
//
// POSITIVE results only are cached (warm function instances skip the read). A
// negative is never cached: an athlete who taps Allow must not wait out a TTL,
// and a "no" answer costs one indexed read. The row is never withdrawn short of
// account deletion, so a positive can only go stale for an account that no
// longer exists; the TTL and size bound are housekeeping, not correctness.
// A failed read THROWS (fail closed): callers must not treat "could not check"
// as "allowed".
const AI_CONSENT_TTL_MS = 6 * 3600_000;
const aiConsentYes = new Map(); // athleteId -> expires-at ms
const aiConsentFresh = (id) => { const t = aiConsentYes.get(id); return t !== undefined && t > Date.now(); };
const aiConsentRemember = (id) => {
  if (aiConsentYes.size > 5000) aiConsentYes.clear();
  aiConsentYes.set(id, Date.now() + AI_CONSENT_TTL_MS);
};

export async function hasAiConsent(athleteId) {
  const id = String(athleteId || "");
  if (!id) return false;
  if (aiConsentFresh(id)) return true;
  const rows = await sbSelect(
    "legal_acceptances",
    `?athlete_id=eq.${encodeURIComponent(id)}&document=eq.ai_processing&select=id&limit=1`
  );
  if (rows.length) { aiConsentRemember(id); return true; }
  return false;
}

// Batched form for the schedulers: returns the Set of ids that HAVE the row.
// The id list goes into the URL, so it is chunked (max 100 ids per request).
export async function aiConsentSet(athleteIds, { chunk = 100 } = {}) {
  const ids = [...new Set((athleteIds || []).map(String).filter(Boolean))];
  const yes = new Set();
  const need = [];
  for (const id of ids) (aiConsentFresh(id) ? yes.add(id) : need.push(id));
  for (let i = 0; i < need.length; i += chunk) {
    const part = need.slice(i, i + chunk);
    const list = part.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
    const rows = await sbSelect(
      "legal_acceptances",
      `?athlete_id=in.(${encodeURIComponent(list)})&document=eq.ai_processing&select=athlete_id&limit=1000`
    );
    for (const r of rows) { yes.add(r.athlete_id); aiConsentRemember(r.athlete_id); }
  }
  return yes;
}

// ── Server-side Claude call (background jobs) ────────────────────────────────
// For trusted server-to-server work (the Proof Feed engine) that runs with NO
// browser in the loop, so it can't use the same-origin client proxy api/claude.js.
// It calls Anthropic directly with the server key AND logs usage_costs itself, so
// background AI spend is attributed exactly like the proxy's (Phase 1 cost ledger).
//
// Inference params are pinned the SAME as api/claude.js: Sonnet 4.6, effort "low",
// thinking off — a version bump must not silently raise the cost of a daily job.
//
// `attribution` carries who the work is FOR (the athlete), so cost rolls up per
// athlete/school just like a user-initiated call. Cost logging is best-effort and
// never blocks the result. Throws on an Anthropic error so the caller can record a
// per-item failure; returns the assistant text on success.
export async function askClaudeServer({
  system,
  user,
  maxTokens = 1200,
  model = "claude-sonnet-5",
  feature = "other",
  attribution = {},
}) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;

  // Last line of defence, whoever the caller is: work done FOR an athlete never
  // leaves for the AI provider without that athlete's ai_processing row. The
  // schedulers filter earlier (api/trigger-proof-feed.js) so this normally passes
  // from cache; it exists so a future caller cannot forget. No env flag, on purpose.
  if (attribution.athlete_id && !(await hasAiConsent(attribution.athlete_id))) {
    throw httpErr(403, "AI permission required");
  }

  // Inference params chosen per model + feature, matching api/claude.js
  // modelParams() (keep the two in sync — every rule has a twin): extraction
  // stays effort "low" (cheap/fast, no quality loss), conversational/prose
  // surfaces get real reasoning effort — pinning chat-grade features at "low"
  // is where the self-contradicting Coach Joe replies came from (2026-08-10).
  // On Sonnet 5, omitting `thinking` turns adaptive thinking ON by default, so
  // the explicit disable is load-bearing there, not just a cost tweak. effort
  // is INVALID on Haiku 4.5 — it must receive neither field.
  const payload = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  };
  if (model === "claude-sonnet-5" || model === "claude-sonnet-4-6") {
    const effort = ["joebot_chat", "coach_checkin"].includes(feature) ? "high"
      : ["proof_weekly", "proof_monthly", "proof_coach"].includes(feature) ? "medium" : "low";
    payload.output_config = { effort };
    payload.thinking = { type: "disabled" };
  }

  const startedAt = Date.now();
  let data = {};
  let status = "ok";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    data = await r.json().catch(() => ({}));
    status = r.ok ? "ok" : `error_${r.status}`;
  } catch (e) {
    status = "error_network";
    data = { error: { message: e.message } };
  }
  const latency_ms = Date.now() - startedAt;

  // Best-effort cost log — mirrors api/claude.js logUsage() row shape exactly.
  try {
    const u = (data && data.usage) || {};
    await sbInsert("usage_costs", {
      source: "claude",
      feature,
      role: attribution.role || "athlete",
      actor_id: attribution.actor_id ?? null,
      athlete_id: attribution.athlete_id ?? null,
      school_id: attribution.school_id ?? null,
      coach_id: attribution.coach_id ?? null,
      tier: attribution.tier ?? null,
      model: (data && data.model) || model,
      input_tokens: u.input_tokens ?? null,
      output_tokens: u.output_tokens ?? null,
      cache_read_tokens: u.cache_read_input_tokens ?? null,
      cache_write_tokens: u.cache_creation_input_tokens ?? null,
      latency_ms,
      status,
    });
  } catch { /* cost tracking is non-critical — never break the job */ }

  if (data && data.error) throw httpErr(502, data.error.message || "AI call failed");
  return data.content?.[0]?.text || "";
}

// ── Rate limiting (backed by the `rate_limits` table) ────────────────────────
// Counts attempts for `key` within the window; throws 429 when over `max`.
// Stateless functions can't hold counters in memory, so we use the DB.
export async function rateLimit(key, { max = 5, windowMin = 15, message } = {}) {
  const since = new Date(Date.now() - windowMin * 60_000).toISOString();
  const rows = await sbSelect(
    "rate_limits",
    `?key=eq.${encodeURIComponent(key)}&created_at=gte.${encodeURIComponent(since)}&select=id`
  );
  if (rows.length >= max) {
    // The message must state the REAL window: the old fixed "15 minutes" copy on
    // a 60-minute limiter had someone retrying at minute 16 into another refusal.
    throw httpErr(429, message || "Too many attempts. Please wait 15 minutes and try again.");
  }
  await sbInsert("rate_limits", { key });
}

// Clear a key's attempts (call on successful login so a good user isn't penalized).
export async function rateLimitReset(key) {
  await sbDelete("rate_limits", `?key=eq.${encodeURIComponent(key)}`);
}

// ── Brute-force guard for the authenticated gateways ─────────────────────────
// authCaller() verifies a 4-digit PIN, but the login endpoints are the only place
// that throttles guesses — the data / claude gateways called authCaller with no
// lockout, so a known athlete/coach id could be PIN-brute-forced through them.
// This guards those paths WITHOUT penalizing legitimate users: it pre-checks the
// failure count (refusing — and skipping the bcrypt work — once an IP is locked),
// and returns a recordFailure() that the caller invokes ONLY when auth fails.
// Successful requests record nothing, so a heavy real user is never throttled.
export async function authThrottle(key, { max = 10, windowMin = 15 } = {}) {
  const since = new Date(Date.now() - windowMin * 60_000).toISOString();
  const rows = await sbSelect(
    "rate_limits",
    `?key=eq.${encodeURIComponent(key)}&created_at=gte.${encodeURIComponent(since)}&select=id`
  );
  if (rows.length >= max) {
    throw httpErr(429, "Too many attempts. Please wait 15 minutes and try again.");
  }
  return async () => { try { await sbInsert("rate_limits", { key }); } catch { /* never block on logging */ } };
}

// ── Caller authentication ─────────────────────────────────────────────────────
// Verify a request's `auth:{role,id,pin}` is a real athlete/coach with a matching
// (bcrypt) PIN. Shared by the write gateway (api/data.js) and the Claude proxy
// (api/claude.js) so "what counts as authenticated" lives in exactly one place.
// Returns { role, id } on success; throws 401 otherwise.
export async function authCaller(auth) {
  if (!auth || typeof auth !== "object") throw httpErr(401, "Sign in required");
  // Fast path: a valid signed session token proves identity with zero DB reads
  // and zero bcrypt. Invalid/expired tokens fall through to the PIN path below.
  const viaToken = tryTokenAuth(auth);
  if (viaToken) return viaToken;
  const id = str(auth.id, { max: 64, name: "auth.id" });
  const table = auth.role === "coach" ? "coaches" : auth.role === "athlete" ? "athletes" : null;
  if (!table) throw httpErr(401, "Invalid auth role");
  const rows = await sbSelect(table, `?id=eq.${encodeURIComponent(id)}&select=id,pin`);
  if (!rows[0] || !(await verifyPin(auth.pin, rows[0].pin))) throw httpErr(401, "Not authorized");
  return { role: auth.role, id };
}

// ── Reliability / error logging (Phase 1.5) ──────────────────────────────────
// Best-effort structured capture into error_events. Mirrors the cost logger in
// api/claude.js: it NEVER throws and NEVER blocks the user path — every call is
// wrapped so a logging failure can't itself become a user-facing error. Metadata
// only: the message is sanitized + truncated here; no content/secrets are stored.
// AI/Claude HTTP errors are NOT logged here (they live in usage_costs.status).

const SEVERITIES = new Set(["info", "warn", "error", "fatal"]);

// Redact secrets / PII from a free-text error message, then truncate. Defensive:
// messages can accidentally embed emails, API keys, tokens, JWTs, PINs, or phones.
export function sanitizeMessage(raw, max = 500) {
  if (raw == null) return null;
  let s = String(raw)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")            // emails
    .replace(/\b[sprk]k-[A-Za-z0-9_-]{8,}/g, "[token]")        // sk-/pk- style keys
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [token]") // bearer tokens
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, "[jwt]")             // JWTs
    .replace(/\$2[aby]\$[./A-Za-z0-9]{20,}/g, "[hash]")        // bcrypt hashes
    .replace(/\b\d{4,}\b/g, "[num]");                          // PINs / phones / long ids
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Short, stable, dependency-free grouping hash (djb2 → base36). The same
// area+type+message-prefix always yields the same fingerprint, so the agent /
// dashboard can collapse "the same error 10,000 times" into one counted row.
export function fingerprintOf({ area, error_type, message } = {}) {
  const basis = `${area || ""}|${error_type || ""}|${String(message || "").slice(0, 80)}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

// Insert one error row. The CALLER supplies server-derived attribution (role /
// actor_id / athlete_id / snapshots) — never let those come from a client body, or
// the dashboard's per-athlete/per-school numbers could be forged. Sanitizing and
// clamping happen here so every write path (client-reported and server-caught) is
// consistent. Returns nothing; swallows all failures.
export async function logError(e = {}) {
  try {
    const message = sanitizeMessage(e.message);
    const area = clip(e.area, 40);
    const error_type = clip(e.error_type, 60);

    const sc = parseInt(e.status_code, 10);

    // meta is a small structured extra — size-capped so it can't be used to dump
    // content or balloon storage. Dropped (not truncated) if oversized.
    let meta = null;
    if (e.meta && typeof e.meta === "object") {
      try { if (JSON.stringify(e.meta).length <= 1000) meta = e.meta; } catch { /* unserializable */ }
    }

    await sbInsert("error_events", {
      source: e.source === "server" ? "server" : "client",
      severity: SEVERITIES.has(e.severity) ? e.severity : "error",
      area,
      route: clip(e.route, 120),
      component: clip(e.component, 80),
      error_type,
      message,
      status_code: Number.isFinite(sc) ? sc : null,
      role: e.role === "athlete" || e.role === "coach" ? e.role : "anon",
      actor_id: e.actor_id ?? null,
      athlete_id: e.athlete_id ?? null,
      school_id: e.school_id ?? null,
      coach_id: e.coach_id ?? null,
      tier: clip(e.tier, 20),
      app_version: clip(e.app_version, 40),
      user_agent: clip(e.user_agent, 200),
      fingerprint: e.fingerprint || fingerprintOf({ area, error_type, message }),
      meta,
    });
  } catch { /* reliability logging must never break anything */ }
}

// ── Engagement logging (Phase 2) ──────────────────────────────────────────────
// Best-effort BATCH capture into usage_events. Mirrors logError: it NEVER throws
// and NEVER blocks the user path. Metadata only — no chat/workout content. This is
// the highest-volume ledger, so it's defended on three sides: a curated EVENT_NAMES
// allowlist (off-list events are dropped, not stored as 'other'), a per-batch row
// cap, and a single bulk insert (PostgREST accepts an array body) so a flush of N
// events is ONE write, not N.
//
// The CALLER supplies server-derived attribution (role/actor_id/athlete_id/snapshots)
// — never let those come from the client body, or per-athlete/per-school dashboard
// numbers could be forged. created_at is left to the DB default (server receive
// time); the client flushes frequently so it tracks event time to ~30s.

// Curated allowlist — adding an event is a code change here, never a migration.
export const EVENT_NAMES = new Set([
  "app_open", "session_start", "login", "signup_start", "signup_complete",
  // T37 billing funnel — the gap between signup_start and signup_complete used to
  // be totally dark, which is why one abandoned checkout took a three-system
  // autopsy to reconstruct. paywall_shown = plan screen; checkout_viewed = card
  // form mounted; then submitted → (confirm_failed?) → succeeded.
  "paywall_shown", "paywall_dismissed",
  "checkout_viewed", "checkout_card_submitted", "checkout_confirm_failed", "checkout_succeeded",
  "workout_logged", "chat_opened", "chat_message_sent", "screen_view",
  "coach_dashboard_view", "event_landing_view",
  "push_enabled", "push_disabled",
  // T51 delivery telemetry. push_sent/push_failed/push_pruned are written by the
  // SERVER at send time (logPushOutcome below); notification_opened is the only
  // one the client can raise, and it is what turns "we sent 40" into "8 people
  // actually came back." Before these existed, nobody could answer how many
  // notifications went out yesterday or how many failed — which is how the
  // subscription table sat stale for five weeks without anyone noticing.
  "push_sent", "push_failed", "push_pruned", "notification_opened",
  "self_change_applied", "change_request_sent",
  "tour_start", "tour_complete", "tour_skip",
]);
// Coarse area vocabulary — SAME set as error_events so v_error_rate_by_area_daily
// can divide errors by attempts on (area, day).
const AREAS = new Set([
  "auth", "workout_log", "coach_dashboard", "billing", "ai", "sync", "nav", "other",
]);

const MAX_EVENTS_PER_BATCH = 50;

// Build one sanitized usage_events row from a client-supplied event + the caller's
// server-derived attribution. Returns null if the event_name isn't allowlisted.
function buildEventRow(ev, attribution) {
  if (!ev || typeof ev !== "object") return null;
  if (!EVENT_NAMES.has(ev.event_name)) return null;        // off-list → drop

  let meta = null;
  if (ev.meta && typeof ev.meta === "object") {
    try { if (JSON.stringify(ev.meta).length <= 1000) meta = ev.meta; } catch { /* unserializable */ }
  }

  return {
    source: "client",
    event_name: ev.event_name,
    area: AREAS.has(ev.area) ? ev.area : null,
    session_id: clip(ev.session_id, 64),
    route: clip(stripQueryStr(ev.route), 120),
    app_version: clip(ev.app_version, 40),
    meta,
    // Server-derived — client-supplied role/ids/snapshots are intentionally ignored.
    role: attribution.role === "athlete" || attribution.role === "coach" ? attribution.role : "anon",
    actor_id: attribution.actor_id ?? null,
    athlete_id: attribution.athlete_id ?? null,
    school_id: attribution.school_id ?? null,
    coach_id: attribution.coach_id ?? null,
    tier: clip(attribution.tier, 20),
    user_agent: clip(attribution.user_agent, 200),
  };
}

// Insert a batch of engagement events in one write. Swallows all failures.
export async function logEvents(events, attribution = { role: "anon" }) {
  try {
    if (!Array.isArray(events) || events.length === 0) return;
    const rows = events
      .slice(0, MAX_EVENTS_PER_BATCH)
      .map((ev) => buildEventRow(ev, attribution))
      .filter(Boolean);
    if (rows.length === 0) return;
    await sbInsert("usage_events", rows);   // array body => bulk insert
  } catch { /* engagement logging must never break anything */ }
}

// ── Push delivery telemetry (T51) ─────────────────────────────────────────────
// Server-authored engagement rows for what actually happened on a send. Same
// ledger as the client events (so the existing usage_events dashboards and the
// v_push_* views can join them), but source="server" and NOT routed through
// buildEventRow: there is no untrusted client body here, and the attribution is
// the send itself.
//
// Deliberately metadata-only and one row per (send, outcome) — never per device
// body text, never the payload. Best-effort like every other ledger write: a
// telemetry failure must never break a push run.
//
// `outcomes` is the {sent, failed, pruned} shape sendToAthlete/notifyCoach return.
export async function logPushOutcome({ pushType, platform, outcomes, role = "athlete", athleteId = null, coachId = null }) {
  try {
    const rows = [];
    const base = {
      source: "server",
      area: "nav",
      role: role === "coach" ? "coach" : "athlete",
      actor_id: coachId || athleteId || null,
      athlete_id: athleteId,
      coach_id: coachId,
      meta: { push_type: pushType || null, platform: platform || null },
    };
    for (const [outcome, name] of [["sent", "push_sent"], ["failed", "push_failed"], ["pruned", "push_pruned"]]) {
      const n = Number(outcomes?.[outcome] || 0);
      // One row per DEVICE, so "how many notifications went out yesterday" is a
      // plain count and never needs a sum over a meta field.
      for (let i = 0; i < Math.min(n, 25); i++) rows.push({ ...base, event_name: name });
    }
    if (rows.length) await sbInsert("usage_events", rows);
  } catch { /* telemetry must never break a push run */ }
}

// Keep only the path of a route — query strings / fragments can carry tokens/ids.
const stripQueryStr = (r) => (typeof r === "string" ? r.split(/[?#]/)[0] : r);
