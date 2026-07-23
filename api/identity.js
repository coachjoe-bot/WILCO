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
      case "add-coach":            return await addCoachAction(req, res, body);
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

  // PINs are bcrypt-hashed, so we can't filter by them — match the identifier,
  // then compare. escapeLike: user input headed into an ilike pattern (_supa.js).
  //
  // Identifier is NAME **or** EMAIL. Name alone used to be the only way in, which
  // is what forced signup to hard-reject a second "John Smith" — a permanently
  // lost signup, worst on exactly the school rosters we sell to. Email is already
  // collected and stored on every row. Looked up only when the name matches
  // nothing, so existing name logins are byte-identical and can never be shadowed
  // by someone else's email. Email uses eq (not ilike) — it's an exact identifier
  // and that keeps it out of pattern-matching entirely.
  let byName = await sbSelect("athletes", `?name=ilike.${enc(escapeLike(name))}&select=*`);
  if (byName.length === 0 && name.includes("@")) {
    byName = await sbSelect("athletes", `?email=eq.${enc(name.toLowerCase())}&select=*`);
  }
  // bcrypt compares run in parallel — wall time is ~one compare instead of N. The
  // first matching index wins, same row the old sequential loop would have picked.
  const compared = await Promise.all(byName.map((a) => verifyPin(pin, a.pin)));
  const hit = compared.indexOf(true);
  // Two accounts can now share a name, so a shared PIN could make the match
  // ambiguous. NEVER pick the first — that is exactly how one athlete would land
  // in another's account. Ask for the email, which tells them apart.
  if (compared.filter(Boolean).length > 1) {
    return res.status(200).json({ athlete: null, reason: "ambiguous" });
  }
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

  // An ADMIN also sees their school's UNASSIGNED athletes. Removing a coach nulls
  // coach_id, and non-master coaches were scoped strictly to coach_id=eq.me — so
  // those athletes became invisible to the entire school and could only be
  // recovered from the master account. They are already writable by an admin in
  // their school (data.js), so this is read parity, not new authority. Deliberately
  // NOT "every athlete in the school": that would turn an admin's roster, triage
  // and brief into the whole school overnight. Just the orphans.
  const athletes = isMaster
    ? await sbSelect("athletes", "?order=created_at.desc&select=*")
    : (isAdmin && me.school_id)
      ? await sbSelect("athletes", `?or=(coach_id.eq.${enc(me.id)},and(coach_id.is.null,school_id.eq.${enc(me.school_id)}))&order=created_at.desc&select=*`)
      : await sbSelect("athletes", `?coach_id=eq.${enc(me.id)}&order=created_at.desc&select=*`);

  let coaches = [];
  if (isMaster) coaches = await sbSelect("coaches", "?order=created_at.asc&select=*");
  else if (isAdmin && me.school_id)
    coaches = await sbSelect("coaches", `?school_id=eq.${enc(me.school_id)}&order=created_at.asc&select=*`);

  const school = !isMaster && me.school_id
    ? await sbSelect("schools", `?id=eq.${enc(me.school_id)}&select=*`)
    : [];
  const schoolsAll = isMaster ? await sbSelect("schools", "?select=*&order=created_at.asc") : [];

  // Per-coach athlete counts for the school. The Account tab used to derive these
  // from the caller's own roster, which for an admin is their athletes plus the
  // unassigned bucket — so every OTHER coach read as "0 athletes", and the
  // remove-coach step would have offered no reassignment at exactly the moment a
  // whole roster was about to be orphaned. Counts only; no athlete data crosses
  // the boundary, so an admin's read scope is unchanged.
  let coachCounts = null;
  if ((isAdmin || isMaster) && (me.school_id || isMaster)) {
    const scope = isMaster ? "?select=coach_id" : `?school_id=eq.${enc(me.school_id)}&select=coach_id`;
    const rows = await sbSelect("athletes", scope);
    coachCounts = {};
    for (const r of rows) if (r.coach_id) coachCounts[r.coach_id] = (coachCounts[r.coach_id] || 0) + 1;
  }

  // Coaches don't need athletes'/coaches' PINs — strip them.
  return res.status(200).json({
    athletes: athletes.map(stripPin),
    coaches: coaches.map(stripPin),
    school,
    schoolsAll,
    coachCounts,
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

  // Duplicate handling. A shared NAME is allowed — blocking it made every common-name
  // collision a permanently lost signup, which bites hardest on the school rosters
  // (two "Jacob Miller"s on one team is near-certain). What must stay unique is the
  // (name, email) PAIR:
  //   • it is the true "this is the same person signing up twice" case
  //   • it keeps athlete-login's disambiguation sound — same-name rows are told
  //     apart by PIN, and if that is ever ambiguous the login path below refuses
  //     rather than guessing (a colliding PIN must never shadow another account)
  //   • it deliberately does NOT require globally unique email, so a parent can
  //     still register two children from one address
  const dupes = await sbSelect(
    "athletes",
    `?name=ilike.${enc(escapeLike(name))}&email=eq.${enc(email.toLowerCase())}&select=id`
  );
  if (dupes.length) throw httpErr(409, "You already have an account with that name and email. Go to Athlete Login instead.");

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

// ── add-coach (ONE server-side op for every add-coach flow) ──────────────────
// All three client flows (AccountTab, master SchoolsList, school onboarding) used
// to compute coach_number and access_code IN THE BROWSER from a possibly-stale
// coaches list, then plain-insert. Two admins adding at once, a double-tap racing
// the disabled flag, or adding before the roster refreshed could mint two coaches
// with the SAME access_code — and resolve-coach-code takes found[0], so one of
// them could never register. That is a silently unusable paid seat.
//
// Here the SERVER reads max(coach_number) for the school, assigns the code, checks
// the seat limit, and inserts. The unique index on coaches.access_code is what
// makes it actually atomic rather than merely narrower: if a concurrent insert
// wins the race, the insert fails and we retry with the next number.
const CODE_FOR = (schoolCode, n) => String(schoolCode||"???").toUpperCase() + String(n).padStart(2, "0");

async function addCoachAction(req, res, body) {
  const me = await authCoachThrottled(req, body.coachId, body.pin);
  const isMaster = me.role === "master";
  if (!isMaster && me.role !== "admin") throw httpErr(403, "Only an admin can add a coach");

  const schoolId = str(body.schoolId, { max: 64, name: "schoolId" });
  // An admin may only ever add into THEIR OWN school. Master can target any.
  if (!isMaster && me.school_id !== schoolId) throw httpErr(403, "Not your school");

  const name = str(body.name, { max: 100, name: "Coach name" });
  const email = str(body.email, { max: 200, name: "Coach email" }).toLowerCase();
  if (!email.includes("@")) throw httpErr(400, "Enter a valid coach email");
  const role = body.role === "admin" ? "admin" : "coach";

  const schools = await sbSelect("schools", `?id=eq.${enc(schoolId)}&select=id,code,name,max_coaches`);
  const school = schools[0];
  if (!school) throw httpErr(404, "School not found");

  const existing = await sbSelect("coaches", `?school_id=eq.${enc(schoolId)}&select=id,coach_number,access_code,role,email`);
  // Seat limit counts what the UI counts: assistant coaches, excluding the
  // soft-removed rows (access_code stamped REMOVED_*) that used to burn a seat.
  const active = existing.filter((c) => c.role !== "admin" && !String(c.access_code || "").startsWith("REMOVED_"));
  const max = school.max_coaches || 3;
  if (role !== "admin" && active.length >= max) throw httpErr(409, `Coach limit reached for this plan (${max}).`);
  // Adding the same person twice is a mistake, not a race — say so plainly.
  if (existing.some((c) => String(c.email || "").toLowerCase() === email && !String(c.access_code || "").startsWith("REMOVED_"))) {
    throw httpErr(409, "A coach with that email is already on this school.");
  }

  let n = existing.reduce((m, c) => Math.max(m, c.coach_number || 0), 0) + 1;
  // Retry on a unique-code collision (23505). Bounded — five losses in a row means
  // something else is wrong and we should fail loudly rather than spin.
  for (let attempt = 0; attempt < 5; attempt++) {
    const access_code = role === "admin" ? String(school.code || "???").toUpperCase() + "AD" : CODE_FOR(school.code, n);
    try {
      const created = await sbWrite({
        method: "POST", table: "coaches",
        body: { name, email, school_id: schoolId, coach_number: role === "admin" ? 0 : n, access_code, role },
      });
      const row = Array.isArray(created) ? created[0] : created;
      if (!row) throw httpErr(502, "Could not create coach. Try again.");
      return res.status(200).json({ coach: stripPin(row), accessCode: access_code, schoolName: school.name || "" });
    } catch (e) {
      const dup = /duplicate key|23505|already exists/i.test(e?.message || "");
      if (!dup || role === "admin") throw e;
      n += 1;   // someone else took this number between our read and our insert
    }
  }
  throw httpErr(409, "Couldn't assign a unique access code — try again.");
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
