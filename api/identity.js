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
  sbSelect, rateLimit, rateLimitReset,
} from "./_supa.js";

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
  const rows = await sbSelect("coaches", `?id=eq.${enc(id)}&pin=eq.${enc(p)}&select=*`);
  if (!rows.length) throw httpErr(401, "Not authorized");
  return rows[0];
}

// ── athlete-login ─────────────────────────────────────────────────────────────
async function athleteLogin(req, res, body) {
  const name = str(body.name, { max: 100, name: "Name" });
  const pin = pin4(body.pin);
  const key = `athlete-login:${clientIp(req)}:${name.toLowerCase()}`;
  await rateLimit(key, { max: 5, windowMin: 15 });

  const found = await sbSelect("athletes", `?name=ilike.${enc(name)}&pin=eq.${enc(pin)}&select=*`);
  if (found.length) {
    await rateLimitReset(key);
    return res.status(200).json({ athlete: found[0] }); // own record: pin kept for self-refresh auth
  }
  const byName = await sbSelect("athletes", `?name=ilike.${enc(name)}&select=id`);
  return res.status(200).json({ athlete: null, reason: byName.length ? "wrong_pin" : "not_found" });
}

// ── coach-login (pin only, matching existing behavior) ───────────────────────
async function coachLogin(req, res, body) {
  const pin = pin4(body.pin);
  // Key on IP so an attacker is capped across ALL pins (defends the 4-digit space).
  await rateLimit(`coach-login:${clientIp(req)}`, { max: 10, windowMin: 15 });
  const found = await sbSelect("coaches", `?pin=eq.${enc(pin)}&select=*`);
  return res.status(200).json({ coach: found[0] || null });
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
  const found = await sbSelect("athletes", `?id=eq.${enc(id)}&pin=eq.${enc(pin)}&select=*`);
  return res.status(200).json({ athlete: found[0] || null });
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
