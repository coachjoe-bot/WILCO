// ─── IDENTITY ENDPOINT ────────────────────────────────────────────────────────
// Server-side reads of `athletes` / `coaches` that the browser can no longer do
// directly (RLS now blocks the anon key). Every action validates input, and the
// privileged reads happen here with the SERVICE key — never in the browser.
//
// Actions (POST { action, ... }):
//   athlete-login        { name, pin }                  -> { athlete } | { athlete:null, reason }
//   coach-login          { pin }                         -> { coach }   | { coach:null }
//   resolve-coach-code   { code }                        -> { coach }   | { coach:null }   (pin hidden, pin_set flag)
//   check-athlete-name   { name }                        -> { exists }
//   get-athlete          { athleteId, pin }              -> { athlete } | { athlete:null }  (self refresh)
//   coach-dashboard      { coachId, pin }                -> { athletes, coaches, school, schoolsAll }
//   coach-athlete-fields { coachId, pin, athleteId }     -> { fields } | { fields:null }

import {
  applyCors, httpErr, str, pin4, clientIp, stripPin,
  sbSelect, sbWrite, rateLimit, rateLimitReset, verifyPin, hashPin,
  authCaller, mintSessionToken, logError, logEvents,
} from "./_supa.js";
import { EVENT_SOURCES } from "./_stripe.js";

const enc = encodeURIComponent;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};

  try {
    switch (body.action) {
      case "athlete-login":        return await athleteLogin(req, res, body);
      case "coach-login":          return await coachLogin(req, res, body);
      case "resolve-coach-code":   return await resolveCoachCode(req, res, body);
      case "check-athlete-name":   return await checkAthleteName(req, res, body);
      case "get-athlete":          return await getAthlete(req, res, body);
      case "coach-dashboard":      return await coachDashboard(req, res, body);
      case "coach-athlete-fields": return await coachAthleteFields(req, res, body);
      case "hash-pin":             return await hashPinAction(req, res, body);
      case "create-athlete":       return await createAthleteAction(req, res, body);
      case "set-coach-pin":        return await setCoachPinAction(req, res, body);
      case "log-error":            return await logErrorAction(req, res, body);
      case "log-events":           return await logEventsAction(req, res, body);
      default:                     return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || "Server error" });
  }
}

// ── Verify a coach by id + pin, return the DB record (source of truth for role) ─
async function authCoach(coachId, pin) {
  const id = str(coachId, { max: 64, name: "coachId" });
  const p = pin4(pin);
  const rows = await sbSelect("coaches", `?id=eq.${enc(id)}&select=*`);
  const me = rows[0];
  if (!me || !(await verifyPin(p, me.pin))) throw httpErr(401, "Not authorized");
  return me;
}

// ── athlete-login ─────────────────────────────────────────────────────────────
async function athleteLogin(req, res, body) {
  const name = str(body.name, { max: 100, name: "Name" });
  const pin = pin4(body.pin);
  const key = `athlete-login:${clientIp(req)}:${name.toLowerCase()}`;
  await rateLimit(key, { max: 5, windowMin: 15 });

  // PINs are bcrypt-hashed, so we can't filter by them — match by name, then compare.
  const byName = await sbSelect("athletes", `?name=ilike.${enc(name)}&select=*`);
  for (const a of byName) {
    if (await verifyPin(pin, a.pin)) {
      await rateLimitReset(key);
      // token: signed session credential so subsequent gateway calls skip bcrypt.
      return res.status(200).json({ athlete: stripPin(a), token: mintSessionToken("athlete", a.id) }); // never send the hash to the browser
    }
  }
  return res.status(200).json({ athlete: null, reason: byName.length ? "wrong_pin" : "not_found" });
}

// ── coach-login (pin only, matching existing behavior) ───────────────────────
async function coachLogin(req, res, body) {
  const pin = pin4(body.pin);
  // Key on IP so an attacker is capped across ALL pins (defends the 4-digit space).
  await rateLimit(`coach-login:${clientIp(req)}`, { max: 10, windowMin: 15 });
  // Hashed PINs can't be queried — pull coaches that have a PIN set and compare.
  const coaches = await sbSelect("coaches", `?pin=not.is.null&select=*`);
  for (const c of coaches) {
    if (await verifyPin(pin, c.pin)) {
      return res.status(200).json({ coach: stripPin(c), token: mintSessionToken("coach", c.id) });
    }
  }
  return res.status(200).json({ coach: null });
}

// ── resolve-coach-code (setup + signup school resolution) ────────────────────
async function resolveCoachCode(req, res, body) {
  const code = str(body.code, { max: 40, name: "Access code" }).toUpperCase();
  const found = await sbSelect(
    "coaches",
    `?access_code=eq.${enc(code)}&select=id,school_id,name,role,coach_number,pin`
  );
  if (!found.length) return res.status(200).json({ coach: null });
  const c = found[0];
  // Never return the actual pin; expose only whether one is set.
  return res.status(200).json({
    coach: { id: c.id, school_id: c.school_id, name: c.name, role: c.role, coach_number: c.coach_number, pin_set: !!c.pin },
  });
}

// ── check-athlete-name (signup duplicate check) ──────────────────────────────
async function checkAthleteName(req, res, body) {
  const name = str(body.name, { max: 100, name: "Name" });
  const found = await sbSelect("athletes", `?name=ilike.${enc(name)}&select=id`);
  return res.status(200).json({ exists: found.length > 0 });
}

// ── get-athlete (an athlete refreshing THEIR OWN record) ─────────────────────
async function getAthlete(req, res, body) {
  const id = str(body.athleteId, { max: 64, name: "athleteId" });
  const pin = pin4(body.pin);
  const found = await sbSelect("athletes", `?id=eq.${enc(id)}&select=*`);
  const a = found[0];
  if (a && (await verifyPin(pin, a.pin))) {
    return res.status(200).json({ athlete: stripPin(a), token: mintSessionToken("athlete", a.id) });
  }
  return res.status(200).json({ athlete: null });
}

// ── coach-dashboard (role-scoped bulk read) ──────────────────────────────────
async function coachDashboard(req, res, body) {
  const me = await authCoach(body.coachId, body.pin);
  const isMaster = me.role === "master";
  const isAdmin = me.role === "admin";

  const athletes = isMaster
    ? await sbSelect("athletes", "?order=created_at.desc&select=*")
    : await sbSelect("athletes", `?coach_id=eq.${enc(me.id)}&order=created_at.desc&select=*`);

  let coaches = [];
  if (isMaster) coaches = await sbSelect("coaches", "?order=created_at.asc&select=*");
  else if (isAdmin && me.school_id)
    coaches = await sbSelect("coaches", `?school_id=eq.${enc(me.school_id)}&order=created_at.asc&select=*`);

  const school = !isMaster && me.school_id
    ? await sbSelect("schools", `?id=eq.${enc(me.school_id)}&select=*`)
    : [];
  const schoolsAll = isMaster ? await sbSelect("schools", "?select=*&order=created_at.asc") : [];

  // Coaches don't need athletes'/coaches' PINs — strip them.
  return res.status(200).json({
    athletes: athletes.map(stripPin),
    coaches: coaches.map(stripPin),
    school,
    schoolsAll,
  });
}

// ── hash-pin (legacy helper; kept for any caller still using it) ─────────────
async function hashPinAction(req, res, body) {
  const pin = pin4(body.pin);
  await rateLimit(`hash-pin:${clientIp(req)}`, { max: 30, windowMin: 15 });
  return res.status(200).json({ hash: await hashPin(pin) });
}

// ── create-athlete (signup: hash PIN + force tier server-side, then insert) ──
// Unauthenticated (the account doesn't exist yet) so it's rate-limited. Tier is
// set by the server (never trust a client claiming "elite"). Returns the row
// without the PIN; the browser keeps the plaintext PIN it just typed.
const ATHLETE_FIELDS = [
  "sport", "billing", "birthday", "age", "height_inches", "weight_lbs", "gender",
  "training_days_per_week", "equipment", "position_or_event", "injury_history",
  "recruiting_intent", "graduation_year", "first_chat_complete",
];
async function createAthleteAction(req, res, body) {
  const pin = pin4(body.pin);
  const a = body.athlete || {};
  const name = str(a.name, { max: 100, name: "Name" });
  const email = str(a.email, { max: 200, name: "Email" });
  await rateLimit(`create-athlete:${clientIp(req)}`, { max: 10, windowMin: 60 });

  const row = { name, email: email.toLowerCase(), pin: await hashPin(pin) };
  for (const k of ATHLETE_FIELDS) if (a[k] !== undefined) row[k] = a[k];
  row.tier = body.isSchool ? "school" : "free"; // never set from the client's tier
  if (body.isSchool && body.schoolPriceId) row.stripe_price_id = str(body.schoolPriceId, { max: 120, name: "price" });
  // Event attribution (QR → landing → signup). Validated against the server-side
  // event config, never stored free-form. Recorded even while the event is still
  // disabled (attribution shouldn't be losable); the longer trial itself is gated
  // separately in create-subscription.
  if (body.signupSource && Object.prototype.hasOwnProperty.call(EVENT_SOURCES, String(body.signupSource))) {
    row.signup_source = String(body.signupSource);
  }

  const created = await sbWrite({ method: "POST", table: "athletes", body: row });
  const athlete = Array.isArray(created) ? created[0] : created;
  return res.status(200).json({
    athlete: athlete ? stripPin(athlete) : null,
    token: athlete ? mintSessionToken("athlete", athlete.id) : null,
  });
}

// ── set-coach-pin (first-time coach setup: prove access code, set hashed PIN) ─
async function setCoachPinAction(req, res, body) {
  const coachId = str(body.coachId, { max: 64, name: "coachId" });
  const accessCode = str(body.accessCode, { max: 40, name: "Access code" }).toUpperCase();
  const pin = pin4(body.pin);
  await rateLimit(`set-coach-pin:${clientIp(req)}`, { max: 10, windowMin: 60 });

  const rows = await sbSelect("coaches", `?id=eq.${enc(coachId)}&access_code=eq.${enc(accessCode)}&select=id,pin`);
  const c = rows[0];
  if (!c) throw httpErr(401, "Invalid coach or access code");
  if (c.pin) throw httpErr(409, "This account already has a PIN set");
  await sbWrite({ method: "PATCH", table: "coaches", query: `?id=eq.${enc(coachId)}`, body: { pin: await hashPin(pin) }, prefer: "return=minimal" });
  // Proving the access code + setting the PIN IS an authentication event — mint a
  // session token so this first coach session skips per-request bcrypt too.
  return res.status(200).json({ ok: true, token: mintSessionToken("coach", coachId) });
}

// ── log-error (Phase 1.5 reliability ingestion) ──────────────────────────────
// The single error-capture entry point for the browser. Deliberately accepts
// UNAUTHENTICATED callers: many of the most important failures happen pre-login or
// when auth itself is broken, and we must still capture those. Auth is OPTIONAL
// ENRICHMENT, never a gate — a present+valid auth attaches the account + snapshot
// so the future coach dashboard can scope by athlete/school; an absent or invalid
// auth simply logs as role='anon'.
//
// This does NOT reopen the Phase-1 anon-write hole: the browser still cannot touch
// error_events with the anon key (RLS denies it). It POSTs metadata here; the
// server validates, rate-limits per IP, and writes with the SERVICE key. ALL
// attribution (role/ids/snapshots) is derived server-side and never read from the
// client body, so per-athlete / per-school numbers can't be forged.
//
// Always returns 200 — the client treats this as fire-and-forget and must never
// surface a logging failure (or rate-limit) to the user.
// Host that a legitimate production error can originate from. Errors POSTed from a
// retired Vercel alias (e.g. fortis-ten.vercel.app) are a stale-install artifact,
// not real production traffic — they were inflating the nav error rate. We read the
// Origin/Referer of THIS request (not the client body), so it catches old clients
// running pre-fix code too. Fail OPEN: if we can't determine the origin, we keep the
// error rather than risk dropping a real one.
const CANONICAL_ERROR_HOST = "app.trainwilco.com";
function requestOriginHost(req) {
  const raw = req.headers["origin"] || req.headers["referer"] || "";
  if (!raw) return null;
  try { return new URL(raw).hostname; } catch { return null; }
}

async function logErrorAction(req, res, body) {
  // Drop errors reported from a non-canonical origin (stale installs on old Vercel
  // aliases). Unknown origin → keep (fail open). localhost dev never reaches here.
  const originHost = requestOriginHost(req);
  if (originHost && originHost !== CANONICAL_ERROR_HOST &&
      originHost !== "localhost" && originHost !== "127.0.0.1") {
    return res.status(200).json({ ok: true, dropped: "non_canonical_origin" });
  }

  // Bound abuse / storage-flooding. Generous (a janky client can burst) but capped.
  // The client also dedups + throttles before sending (see App.jsx reportError).
  try {
    await rateLimit(`log-error:${clientIp(req)}`, { max: 60, windowMin: 15 });
  } catch {
    return res.status(200).json({ ok: true, dropped: "rate_limited" });
  }

  const ev = body.event && typeof body.event === "object" ? body.event : {};

  // Optional auth enrichment — SOFT: authCaller throws on bad creds, but an
  // auth-failure error must still be logged, so we swallow and fall back to anon.
  let enrich = { role: "anon" };
  if (body.auth && typeof body.auth === "object") {
    try {
      enrich = await enrichFromCaller(await authCaller(body.auth));
    } catch { /* keep anon */ }
  }

  await logError({
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
  });

  return res.status(200).json({ ok: true });
}

// ── log-events (Phase 2 engagement ingestion) ────────────────────────────────
// The single engagement-capture entry point for the browser. Batched: the client
// buffers allowlisted events and flushes an ARRAY here (on a timer / when full / on
// page-hide), so this is ~one request per flush, not one per event. Like log-error
// it accepts UNAUTHENTICATED callers (app_open / session_start / signup_start are
// captured pre-login) — auth is OPTIONAL ENRICHMENT, never a gate.
//
// Same lockdown as log-error: the browser cannot touch usage_events with the anon
// key (RLS denies it). It POSTs metadata here; the server validates against the
// EVENT_NAMES allowlist, rate-limits per IP, derives ALL attribution server-side,
// and bulk-writes with the SERVICE key. Always returns 200 — fire-and-forget.
async function logEventsAction(req, res, body) {
  // Bound abuse / storage-flooding. A batch carries many events, so this caps
  // batches/IP (event volume is additionally capped per-batch in logEvents()).
  try {
    await rateLimit(`log-events:${clientIp(req)}`, { max: 120, windowMin: 15 });
  } catch {
    return res.status(200).json({ ok: true, dropped: "rate_limited" });
  }

  const events = Array.isArray(body.events) ? body.events : [];

  // Optional auth enrichment — SOFT: bad creds fall back to anon (pre-login events
  // are the whole point), exactly like log-error.
  let enrich = { role: "anon" };
  if (body.auth && typeof body.auth === "object") {
    try {
      enrich = await enrichFromCaller(await authCaller(body.auth));
    } catch { /* keep anon */ }
  }

  // user_agent is read server-side (never trusted from the client body).
  await logEvents(events, { ...enrich, user_agent: req.headers["user-agent"] });

  return res.status(200).json({ ok: true });
}

// Server-trusted attribution + snapshots for a verified caller (mirrors the
// snapshot read in api/claude.js so cost and error rows attribute identically).
async function enrichFromCaller(caller) {
  if (caller.role === "athlete") {
    const s = (await sbSelect("athletes", `?id=eq.${enc(caller.id)}&select=tier,school_id,coach_id`))[0] || {};
    return {
      role: "athlete", actor_id: caller.id, athlete_id: caller.id,
      tier: s.tier ?? null, school_id: s.school_id ?? null, coach_id: s.coach_id ?? null,
    };
  }
  if (caller.role === "coach") {
    const s = (await sbSelect("coaches", `?id=eq.${enc(caller.id)}&select=school_id`))[0] || {};
    return { role: "coach", actor_id: caller.id, coach_id: caller.id, school_id: s.school_id ?? null };
  }
  return { role: "anon" };
}

// Keep only the path of a route — query strings / fragments can carry tokens/ids.
const stripQuery = (r) => (typeof r === "string" ? r.split(/[?#]/)[0] : r);

// ── coach-athlete-fields (dashboard polling one athlete's program) ───────────
async function coachAthleteFields(req, res, body) {
  const me = await authCoach(body.coachId, body.pin);
  const athleteId = str(body.athleteId, { max: 64, name: "athleteId" });
  const rows = await sbSelect(
    "athletes",
    `?id=eq.${enc(athleteId)}&select=id,coach_id,program_text,program_locked,temp_program_text`
  );
  const a = rows[0];
  if (!a) return res.status(200).json({ fields: null });
  if (me.role !== "master" && a.coach_id !== me.id) throw httpErr(403, "Not your athlete");
  return res.status(200).json({
    fields: {
      program_text: a.program_text,
      program_locked: a.program_locked,
      temp_program_text: a.temp_program_text,
    },
  });
}
