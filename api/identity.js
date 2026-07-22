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
  applyCors, httpErr, str, pin4, clientIp, stripPin, escapeLike,
  sbSelect, sbWrite, rateLimit, rateLimitReset, verifyPin, hashPin,
  authCaller, authThrottle, mintSessionToken, logError, logEvents,
} from "./_supa.js";
import { EVENT_SOURCES } from "./_stripe.js";
// Telemetry ingestion moved to api/telemetry.js (Vercel Pro lifted the fn cap). These
// cases stay here as a DEPRECATED fallback so cached PWA clients still posting to
// /api/identity keep working; new clients post to /api/telemetry. Remove a release
// later once old clients age out. Logic is shared in ./_telemetry.js.
import { handleLogError, handleLogEvents } from "./_telemetry.js";

const enc = encodeURIComponent;

// Marketing attribution values originate in the query string (UTMs), so they're
// user-controllable — keep them URL-safe and bounded before they reach the DB or
// (via create-subscription) Stripe metadata.
const sanitizeSignupSource = (s) =>
  String(s || "").replace(/[^A-Za-z0-9/:._=-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);

// Vercel Pro: cap this function's execution time. Was implicitly the Hobby 10s
// wall; 20s gives external Stripe/email/DB calls room without paying for idle time.
export const maxDuration = 20;

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
      case "log-error":            return await handleLogError(req, res, body);
      case "log-events":           return await handleLogEvents(req, res, body);
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

// Brute-force guard around authCoach, mirroring api/data.js: pre-check the IP's
// recent FAILED attempts (refusing — and skipping bcrypt — once locked), record
// this attempt only if auth fails. Successful requests record nothing, so the
// dashboard's 30s poll and every legit load are never throttled.
async function authCoachThrottled(req, coachId, pin) {
  const recordAuthFail = await authThrottle(`identity-authfail:${clientIp(req)}`);
  try {
    return await authCoach(coachId, pin);
  } catch (e) {
    if (e.status === 401) await recordAuthFail();
    throw e;
  }
}

// ── athlete-login ─────────────────────────────────────────────────────────────
async function athleteLogin(req, res, body) {
  const name = str(body.name, { max: 100, name: "Name" });
  const pin = pin4(body.pin);
  const key = `athlete-login:${clientIp(req)}:${name.toLowerCase()}`;
  await rateLimit(key, { max: 5, windowMin: 15 });

  // PINs are bcrypt-hashed, so we can't filter by them — match by name, then compare.
  // escapeLike: the name is user input headed into an ilike pattern (see _supa.js).
  const byName = await sbSelect("athletes", `?name=ilike.${enc(escapeLike(name))}&select=*`);
  // bcrypt compares run in parallel — wall time is ~one compare instead of N. The
  // first matching index wins, same row the old sequential loop would have picked.
  const compared = await Promise.all(byName.map((a) => verifyPin(pin, a.pin)));
  const hit = compared.indexOf(true);
  if (hit !== -1) {
    const a = byName[hit];
    await rateLimitReset(key);
    // token: signed session credential so subsequent gateway calls skip bcrypt.
    return res.status(200).json({ athlete: stripPin(a), token: mintSessionToken("athlete", a.id) }); // never send the hash to the browser
  }
  return res.status(200).json({ athlete: null, reason: byName.length ? "wrong_pin" : "not_found" });
}

// ── coach-login (pin only, matching existing behavior) ───────────────────────
async function coachLogin(req, res, body) {
  const pin = pin4(body.pin);
  // Key on IP so an attacker is capped across ALL pins (defends the 4-digit space).
  await rateLimit(`coach-login:${clientIp(req)}`, { max: 10, windowMin: 15 });
  // Hashed PINs can't be queried — pull coaches that have a PIN set and compare.
  // bcrypt compares run in parallel (wall time ~one compare instead of one per
  // coach); first matching index wins, same as the old sequential loop.
  const coaches = await sbSelect("coaches", `?pin=not.is.null&select=*`);
  const compared = await Promise.all(coaches.map((c) => verifyPin(pin, c.pin)));
  const hit = compared.indexOf(true);
  if (hit !== -1) {
    const c = coaches[hit];
    return res.status(200).json({ coach: stripPin(c), token: mintSessionToken("coach", c.id) });
  }
  return res.status(200).json({ coach: null });
}

// ── resolve-coach-code (setup + signup school resolution) ────────────────────
async function resolveCoachCode(req, res, body) {
  const code = str(body.code, { max: 40, name: "Access code" }).toUpperCase();
  // Access codes are short/guessable — cap enumeration per IP. Legit traffic is one
  // call per competitive signup (step 4) + one per coach first-time setup submit,
  // so 30/15min never touches real users.
  await rateLimit(`resolve-coach-code:${clientIp(req)}`, { max: 30, windowMin: 15 });
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
  // Anti-enumeration cap. Legit traffic is one call per signup name submit (plus
  // retries on a taken name); 60/15min per IP leaves headroom for a whole team
  // signing up behind one gym/school NAT while still killing bulk scraping.
  await rateLimit(`check-athlete-name:${clientIp(req)}`, { max: 60, windowMin: 15 });
  // escapeLike: wildcards in the name would otherwise probe substrings of every row.
  const found = await sbSelect("athletes", `?name=ilike.${enc(escapeLike(name))}&select=id`);
  return res.status(200).json({ exists: found.length > 0 });
}

// ── get-athlete (an athlete refreshing THEIR OWN record) ─────────────────────
async function getAthlete(req, res, body) {
  const id = str(body.athleteId, { max: 64, name: "athleteId" });
  const pin = pin4(body.pin);
  // Brute-force guard (failure-only, mirroring api/data.js): without it a known
  // athlete id could walk the whole 10,000-PIN space here, bypassing the
  // athlete-login rate limit. The boot-time refresh sends the right PIN, succeeds,
  // records nothing — real users never accumulate failures.
  const recordAuthFail = await authThrottle(`identity-authfail:${clientIp(req)}`);
  const found = await sbSelect("athletes", `?id=eq.${enc(id)}&select=*`);
  const a = found[0];
  if (a && (await verifyPin(pin, a.pin))) {
    return res.status(200).json({ athlete: stripPin(a), token: mintSessionToken("athlete", a.id) });
  }
  await recordAuthFail();
  return res.status(200).json({ athlete: null });
}

// ── coach-dashboard (role-scoped bulk read) ──────────────────────────────────
async function coachDashboard(req, res, body) {
  const me = await authCoachThrottled(req, body.coachId, body.pin);
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
  "sport", "billing", "level", "birthday", "age", "height_inches", "weight_lbs", "gender",
  "training_days_per_week", "equipment", "position_or_event", "injury_history",
  "recruiting_intent", "graduation_year", "first_chat_complete",
];
async function createAthleteAction(req, res, body) {
  const pin = pin4(body.pin);
  const a = body.athlete || {};
  const name = str(a.name, { max: 100, name: "Name" });
  const email = str(a.email, { max: 200, name: "Email" });
  await rateLimit(`create-athlete:${clientIp(req)}`, { max: 10, windowMin: 60 });

  // Server-side duplicate-name re-check. The client checks at wizard step 1, but a
  // race (two devices), a back-navigation minutes later, or a direct API call can
  // still land here with a taken name — and athlete-login disambiguates same-name
  // rows by PIN alone, so a colliding PIN would shadow another account. Same
  // message the step-1 check shows, surfaced via the client's setErr(e.message).
  const dupes = await sbSelect("athletes", `?name=ilike.${enc(escapeLike(name))}&select=id`);
  if (dupes.length) throw httpErr(409, "That name is already registered. Go to Athlete Login instead.");

  const row = { name, email: email.toLowerCase(), pin: await hashPin(pin) };
  for (const k of ATHLETE_FIELDS) if (a[k] !== undefined) row[k] = a[k];
  row.tier = body.isSchool ? "school" : "free"; // never set from the client's tier
  if (body.isSchool && body.schoolPriceId) row.stripe_price_id = str(body.schoolPriceId, { max: 120, name: "price" });
  // Marketing attribution (go-forward only — existing rows stay null). An exact
  // event key (QR → landing → signup) is stored as-is; it also gates the event
  // trial in create-subscription, so it's matched strictly against the event
  // config. Any other value is a free-form first-touch source (UTMs or referrer)
  // and is sanitized/truncated since it's user-controllable input.
  if (body.signupSource) {
    const raw = String(body.signupSource);
    if (Object.prototype.hasOwnProperty.call(EVENT_SOURCES, raw)) {
      row.signup_source = raw;
    } else {
      const clean = sanitizeSignupSource(raw);
      if (clean) row.signup_source = clean;
    }
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

// (log-error / log-events handlers + their helpers moved to ./_telemetry.js;
// the switch above delegates to handleLogError/handleLogEvents.)

// ── coach-athlete-fields (dashboard polling one athlete's program) ───────────
async function coachAthleteFields(req, res, body) {
  const me = await authCoachThrottled(req, body.coachId, body.pin);
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
