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
  feature = "other",
  attribution = {},
}) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
  const model = "claude-sonnet-4-6";

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
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        output_config: { effort: "low" },
        thinking: { type: "disabled" },
        system,
        messages: [{ role: "user", content: user }],
      }),
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
export async function rateLimit(key, { max = 5, windowMin = 15 } = {}) {
  const since = new Date(Date.now() - windowMin * 60_000).toISOString();
  const rows = await sbSelect(
    "rate_limits",
    `?key=eq.${encodeURIComponent(key)}&created_at=gte.${encodeURIComponent(since)}&select=id`
  );
  if (rows.length >= max) {
    throw httpErr(429, "Too many attempts. Please wait 15 minutes and try again.");
  }
  await sbInsert("rate_limits", { key });
}

// Clear a key's attempts (call on successful login so a good user isn't penalized).
export async function rateLimitReset(key) {
  await sbDelete("rate_limits", `?key=eq.${encodeURIComponent(key)}`);
}

// ── Caller authentication ─────────────────────────────────────────────────────
// Verify a request's `auth:{role,id,pin}` is a real athlete/coach with a matching
// (bcrypt) PIN. Shared by the write gateway (api/data.js) and the Claude proxy
// (api/claude.js) so "what counts as authenticated" lives in exactly one place.
// Returns { role, id } on success; throws 401 otherwise.
export async function authCaller(auth) {
  if (!auth || typeof auth !== "object") throw httpErr(401, "Sign in required");
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
  "workout_logged", "chat_opened", "chat_message_sent", "screen_view",
  "coach_dashboard_view",
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

// Keep only the path of a route — query strings / fragments can carry tokens/ids.
const stripQueryStr = (r) => (typeof r === "string" ? r.split(/[?#]/)[0] : r);
