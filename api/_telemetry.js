// ─── TELEMETRY INGESTION (shared) ─────────────────────────────────────────────
// The log-error (reliability) + log-events (engagement) handlers. Moved out of
// api/identity.js on the Vercel Pro upgrade (the 12-fn cap that forced them to share
// the auth-critical login endpoint is gone) so a bug in high-volume, anon-accepting
// telemetry can't touch login/signup. Both api/telemetry.js (the new home) and
// api/identity.js (kept as a deprecated fallback for cached PWA clients) import these.
//
// Security is unchanged from when this lived in identity.js: the browser still cannot
// touch error_events / usage_events with the anon key (RLS denies it). These POST
// metadata; the server validates, rate-limits per IP, derives ALL attribution
// server-side (never from the client body), and writes with the SERVICE key.
import { waitUntil } from "@vercel/functions";
import { rateLimit, clientIp, logError, logEvents, authCaller, sbSelect } from "./_supa.js";

const enc = encodeURIComponent;

// Host a legitimate production error can originate from. Errors POSTed from a retired
// Vercel alias (e.g. fortis-ten.vercel.app) are a stale-install artifact, not real
// traffic — they were inflating the nav error rate. We read the Origin/Referer of THIS
// request (not the client body), so it catches old clients running pre-fix code. Fail
// OPEN: unknown origin → keep the error rather than risk dropping a real one.
const CANONICAL_ERROR_HOST = "app.trainwilco.com";
function requestOriginHost(req) {
  const raw = req.headers["origin"] || req.headers["referer"] || "";
  if (!raw) return null;
  try { return new URL(raw).hostname; } catch { return null; }
}

// Keep only the path of a route — query strings / fragments can carry tokens/ids.
const stripQuery = (r) => (typeof r === "string" ? r.split(/[?#]/)[0] : r);

// Server-trusted attribution + snapshots for a verified caller (mirrors the snapshot
// read in api/claude.js so cost and error rows attribute identically).
//
// Module-scope TTL cache, same shape and rationale as loadSnapshot in
// api/claude.js (its flush-changes twin): this read exists purely for ledger
// attribution, the snapshot is "at event time" by design, and tier/school/coach
// changes are rare — so a 60s TTL is well inside the accepted drift tolerance.
// Telemetry is the higher-volume caller of the two (every batched usage_events
// flush and every error report), so warm instances skipping the Supabase round
// trip matters more here than it does on the AI path. Keyed by role:id (athlete
// and coach ids live in different tables, so the role prefix also prevents
// cross-table collisions); failures are never cached.
const ATTR_TTL_MS = 60_000;
const attrCache = new Map(); // `${role}:${id}` -> { at, attr }
async function enrichFromCaller(caller) {
  if (caller.role !== "athlete" && caller.role !== "coach") return { role: "anon" };
  const cacheKey = `${caller.role}:${caller.id}`;
  const hit = attrCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ATTR_TTL_MS) return hit.attr;

  let attr;
  if (caller.role === "athlete") {
    const s = (await sbSelect("athletes", `?id=eq.${enc(caller.id)}&select=tier,school_id,coach_id`))[0] || {};
    attr = {
      role: "athlete", actor_id: caller.id, athlete_id: caller.id,
      tier: s.tier ?? null, school_id: s.school_id ?? null, coach_id: s.coach_id ?? null,
    };
  } else {
    const s = (await sbSelect("coaches", `?id=eq.${enc(caller.id)}&select=school_id`))[0] || {};
    attr = { role: "coach", actor_id: caller.id, coach_id: caller.id, school_id: s.school_id ?? null };
  }
  // Crude growth bound for very long-lived instances; far above real user counts.
  if (attrCache.size > 1000) attrCache.clear();
  attrCache.set(cacheKey, { at: Date.now(), attr });
  return attr;
}

// ── log-error (Phase 1.5 reliability ingestion) ──────────────────────────────
// Accepts UNAUTHENTICATED callers on purpose: the most important failures happen
// pre-login or when auth itself is broken. Auth is OPTIONAL ENRICHMENT, never a gate
// (absent/invalid → role='anon'). Always returns 200 (fire-and-forget).
export async function handleLogError(req, res, body) {
  // Drop errors reported from a non-canonical origin (stale installs on old Vercel
  // aliases). Unknown origin → keep (fail open). localhost dev never reaches here.
  const originHost = requestOriginHost(req);
  if (originHost && originHost !== CANONICAL_ERROR_HOST &&
      originHost !== "localhost" && originHost !== "127.0.0.1") {
    return res.status(200).json({ ok: true, dropped: "non_canonical_origin" });
  }

  // Bound abuse / storage-flooding. The client also dedups + throttles before sending.
  try {
    await rateLimit(`log-error:${clientIp(req)}`, { max: 60, windowMin: 15 });
  } catch {
    return res.status(200).json({ ok: true, dropped: "rate_limited" });
  }

  const ev = body.event && typeof body.event === "object" ? body.event : {};

  // Optional auth enrichment — SOFT: bad creds fall back to anon (an auth-failure
  // error must still be logged).
  let enrich = { role: "anon" };
  if (body.auth && typeof body.auth === "object") {
    try { enrich = await enrichFromCaller(await authCaller(body.auth)); } catch { /* keep anon */ }
  }

  // This endpoint ALWAYS returns 200 regardless of write outcome (logError already
  // swallows its own failures) — so the write is pure background bookkeeping.
  // Respond first, finish the insert in the background via waitUntil.
  waitUntil(
    logError({
      source: "client",
      severity: ev.severity,
      area: ev.area,
      route: stripQuery(ev.route),
      component: ev.component,
      error_type: ev.error_type,
      message: ev.message,
      status_code: ev.status_code,
      app_version: ev.app_version,
      meta: ev.meta,
      // Server-derived — client-supplied role/ids/snapshots are intentionally ignored.
      user_agent: req.headers["user-agent"],
      ...enrich,
    })
  );

  return res.status(200).json({ ok: true });
}

// ── log-events (Phase 2 engagement ingestion) ────────────────────────────────
// Batched: the client flushes an ARRAY of allowlisted events. Same anon-optional
// enrichment + server-side lockdown as log-error. Always returns 200.
export async function handleLogEvents(req, res, body) {
  // Batches carry many events, so cap batches/IP (per-batch volume is capped in logEvents()).
  try {
    await rateLimit(`log-events:${clientIp(req)}`, { max: 120, windowMin: 15 });
  } catch {
    return res.status(200).json({ ok: true, dropped: "rate_limited" });
  }

  const events = Array.isArray(body.events) ? body.events : [];

  let enrich = { role: "anon" };
  if (body.auth && typeof body.auth === "object") {
    try { enrich = await enrichFromCaller(await authCaller(body.auth)); } catch { /* keep anon */ }
  }

  // Same reasoning as handleLogError: always 200, so the batch insert can finish
  // in the background after the response goes out. user_agent is read server-side
  // (never trusted from the client body).
  waitUntil(logEvents(events, { ...enrich, user_agent: req.headers["user-agent"] }));

  return res.status(200).json({ ok: true });
}
