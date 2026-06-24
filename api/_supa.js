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
