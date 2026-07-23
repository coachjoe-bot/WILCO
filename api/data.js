// ─── AUTHENTICATED WRITE GATEWAY ──────────────────────────────────────────────
// All app writes route through here so the database can deny the public (anon)
// key entirely. The caller proves identity (athlete or coach id + PIN); the write
// itself runs server-side with the service key.
//
// POST { auth:{role,id,pin}, op:"insert"|"update"|"delete"|"upsert", table, data?, id?, params?, conflict? }
//
// Phase 1   closed the ANONYMOUS write hole (a valid logged-in caller is required).
// Phase 1b  adds per-row OWNERSHIP scoping for ATHLETE callers: an athlete may only
//           write rows they own (athlete_id == their id, or the athletes row whose
//           id == their id) and only the athlete-owned tables. Enforced two ways:
//           (1) insert/upsert payloads must carry the caller's own id in the
//               ownership column (every row);
//           (2) update/delete queries get an extra "&<col>=eq.<callerId>" filter
//               appended, so a stray/forged client filter can only ever match the
//               caller's own rows — PostgREST ANDs repeated column filters, so a
//               mismatched id matches zero rows (a silent no-op, not a cross-write).
//
// COACH-role writes ARE now per-row scoped too (see the "Coach write scoping" block):
//       master → all; admin → their school; regular coach → their own roster only.
//       schools are master-only, and coaches-table writes are admin-only (own school).

import { applyCors, httpErr, str, sbWrite, sbSelect, authCaller, tryTokenAuth, logError, authThrottle, clientIp } from "./_supa.js";

const enc = encodeURIComponent;

// Coach alert sender, imported LAZILY: ./_push.js pulls in web-push (~34ms of
// module init), and this is the app's hottest route — every write and every
// scoped read lands here, while a coach alert fires only on the rare workout
// row carrying pain flags or a genuinely-improved PR. Loading it on demand
// keeps that cost off the cold start of the other 99% of calls.
const notifyCoachLazy = async (...args) => {
  const { notifyCoach } = await import("./_push.js");
  return notifyCoach(...args);
};

// Tables the app legitimately writes. Anything else is rejected outright.
const WRITABLE = new Set([
  "athletes", "workouts", "prs", "coaches", "schools",
  "manual_one_rms", "program_modifications", "athlete_goals",
  "legal_acceptances", "deletion_requests", "athlete_context",
  "push_subscriptions", "proof_digests",
  // Coach dashboard overhaul: the coach's own self-service data + the locked-program
  // request loop. Scoping enforced below (coach_context/coach_push_subscriptions =
  // own coach_id; program_change_requests = athlete inserts own, coach updates status).
  "coach_context", "coach_push_subscriptions", "program_change_requests",
  // Parsed-program cache: the coach dashboard parses missing/stale programs on
  // demand (Haiku via api/claude.js, hash-keyed) and upserts the result here —
  // same row shape parseProgramIfNeeded writes on the proof cron. Ownership-scoped
  // like the raw athlete tables.
  "program_prescriptions",
]);

// ─── Phase 1b(b): scoped READS ────────────────────────────────────────────────
// Tables the app reads through this gateway with per-row OWNERSHIP scoping, so we
// can deny the anon key SELECT on them (they hold athletes' — incl. minors' — PII).
// Each maps to the column that identifies the owning athlete. The server forces an
// ownership filter onto every read; the client's own filters are ANDed on top
// (PostgREST ANDs repeated column filters), so a forged client filter can only ever
// NARROW to rows the caller already owns — never widen.
const READ_OWN_COL = {
  workouts: "athlete_id",
  prs: "athlete_id",
  proof_digests: "athlete_id",
  manual_one_rms: "athlete_id",
  athlete_goals: "athlete_id",
  athlete_context: "athlete_id",
  // Parsed structured program cache (Haiku-parsed program_text, hash-keyed). Read-
  // only for the coach dashboard's Overview adherence math (load %×1RM band). Scoped
  // by athlete_id exactly like the raw tables, so a coach only sees their roster's
  // prescriptions. Written by the proof cron (service key) AND by the coach
  // dashboard's on-demand parse (gateway upsert, ownership-scoped).
  program_prescriptions: "athlete_id",
  // Server-side session-count rollup (SQL port of groupIntoSessions, verified to
  // match the client row-for-row). Read-only VIEW; scoped by athlete_id exactly
  // like the raw tables, so a coach only sees their own roster's counts. Lets the
  // coach dashboard show session totals without pulling every raw workout to the
  // browser (see docs/coach-experience-roadmap.md for the dashboard wiring).
  v_athlete_session_counts: "athlete_id",
  // Coach overhaul. coach_context + coach_push_subscriptions are the coach's OWN
  // rows (coach_id); program_change_requests is read by the ATHLETE by athlete_id
  // (their own filed requests) and by the COACH by coach_id (their inbox — the coach
  // branch below overrides the scope column to coach_id).
  coach_context: "coach_id",
  coach_push_subscriptions: "coach_id",
  program_change_requests: "athlete_id",
};

// Tables read/written by COACH callers scoped to their OWN coach_id (not their
// roster's athlete_ids) — the coach's own data + the aggregate/inbox rows.
const COACH_SELF_SCOPED = new Set([
  "proof_digests", "coach_context", "coach_push_subscriptions", "program_change_requests",
]);

// Tables an ATHLETE caller may write, each mapped to the column that must equal
// their own id. Any table NOT listed here is denied outright for athlete callers.
const ATHLETE_OWN_COL = {
  athletes: "id",
  workouts: "athlete_id",
  prs: "athlete_id",
  manual_one_rms: "athlete_id",
  athlete_goals: "athlete_id",
  program_modifications: "athlete_id",
  athlete_context: "athlete_id",
  push_subscriptions: "athlete_id",
  proof_digests: "athlete_id",
  legal_acceptances: "athlete_id",
  deletion_requests: "athlete_id",
  // An athlete may FILE a program-change request on their own locked program.
  program_change_requests: "athlete_id",
  // Parse-cache rows (see WRITABLE note). Listing here scopes COACH writes to their
  // roster; it also permits an athlete to (re)write their OWN row — same trust as
  // them writing the workouts that feed the same adherence math.
  program_prescriptions: "athlete_id",
};

// ── Per-COLUMN allowlist for athlete writes to sensitive tables ───────────────
// Row-ownership scoping (above) stops an athlete writing ANOTHER account's row, but
// not WHICH COLUMNS they set on their OWN row. `athletes` holds coach/billing/role
// fields an athlete must never self-set — tier escalation, program_locked, role,
// pin, stripe ids. For any table listed here, every key in the write payload must be
// allowlisted or the write is rejected: a hard server-side boundary independent of
// what the client (or an AI extractor parsing free-text chat) sends. Columns NOT
// listed are denied; tables not in this map keep plain row-only scoping.
const ATHLETE_COL_ALLOW = {
  athletes: {
    cols: new Set([
      // profile / onboarding (set during signup + profile completion)
      "goal", "coach_name", "coach_email", "coach_id", "school_id",
      "birthday", "age", "height_inches", "gender", "training_days_per_week",
      "equipment", "position_or_event", "injury_history", "recruiting_intent",
      // self-service settings + app-maintained state
      "weight_lbs", "weight_unit", "height_finalized", "ask_weight",
      "program_text", "temp_program_text", "first_chat_complete", "resolved_pain",
      "proof_enabled", "proof_schedule_dow", "proof_schedule_hour", "proof_timezone",
      // gamification counters the app maintains as the athlete logs sessions
      "total_sessions_logged", "certified_badge_earned_at",
      "tier",
    ]),
    // Value guards: an athlete may only ever DOWNGRADE their own tier to "free"
    // (paid tiers are granted server-side by Stripe), never self-grant pro/elite.
    values: { tier: (v) => v === "free" },
  },
  // A filed request is AI-extracted from free-text chat — pin down what the athlete
  // side may set so it can never self-resolve (status) or misroute. status defaults
  // to 'pending' in the DB; only the coach flips it (coach write path below).
  program_change_requests: {
    cols: new Set(["coach_id", "items", "reason", "source"]),
    values: { source: (v) => ["plateau", "pr", "pain", "feedback"].includes(v) },
  },
};

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

  let caller = null;
  try {
    // Fast path: a valid signed session token authenticates with zero DB work —
    // no throttle lookup, no bcrypt. Tokens aren't brute-forceable (HMAC over a
    // 256-bit key, vs a 4-digit PIN space), so the throttle isn't needed here.
    caller = tryTokenAuth(body.auth);
    if (!caller) {
      // Brute-force guard: refuse once an IP has too many recent failed PIN attempts,
      // and record THIS attempt only if it fails (legit callers send the right PIN and
      // are never throttled). Must run before authCaller so a locked IP skips bcrypt.
      const recordAuthFail = await authThrottle(`data-authfail:${clientIp(req)}`);
      try {
        caller = await authCaller(body.auth);
      } catch (e) {
        if (e.status === 401) await recordAuthFail();
        throw e;
      }
    }

    // ── Phase 1b(b): scoped READ ─────────────────────────────────────────────
    // Routed here so the anon key can be denied SELECT on these PII tables. The
    // server forces an ownership scope; athletes see only their own rows, coaches
    // see only their athletes' rows (master sees all — mirrors coach-dashboard).
    if (body.op === "read") {
      const rtable = String(body.table || "");
      const col = READ_OWN_COL[rtable];
      if (!col) throw httpErr(400, `Table not readable: ${rtable}`);

      let scope = "";
      if (caller.role === "athlete") {
        scope = `&${col}=eq.${enc(caller.id)}`;
      } else if (caller.role === "coach") {
        // The DB role (master/admin/regular) is the source of truth for breadth —
        // authCaller only proves the caller IS a coach, not which kind.
        const me = (await sbSelect("coaches", `?id=eq.${enc(caller.id)}&select=id,role`))[0];
        if (!me) throw httpErr(401, "Not authorized");
        if (me.role !== "master") {
          // proof_digests carry the owning coach_id on BOTH per-athlete digests and
          // the team-aggregate coach reports (weekly_coach/monthly_coach, which have
          // a NULL athlete_id). Scope those by coach_id so a coach gets their whole
          // report set — athlete-id membership would drop the aggregate rows.
          if (COACH_SELF_SCOPED.has(rtable)) {
            // The coach's own aggregate/inbox/context rows carry coach_id directly —
            // scope by it (athlete-id membership would drop coach-owned rows).
            scope = `&coach_id=eq.${enc(caller.id)}`;
          } else {
            // Other PII tables: non-master coaches (incl. admins) see only their own
            // athletes' rows — the set coach-dashboard returns and the client filtered to.
            const aths = await sbSelect("athletes", `?coach_id=eq.${enc(caller.id)}&select=id`);
            const ids = aths.map((a) => a.id);
            if (ids.length === 0) return res.status(200).json([]);
            scope = `&${col}=in.(${ids.map((id) => `"${id}"`).join(",")})`;
          }
        }
        // master: no scope → all rows.
      } else {
        throw httpErr(403, "This account can't read that data");
      }

      // Client's params (order/limit/select/own filters) ride along; the forced
      // ownership scope is ANDed on top so it can only narrow, never widen.
      let query = typeof body.params === "string" && body.params ? body.params : "?select=*";
      if (!query.startsWith("?")) query = "?" + query;
      // Defense-in-depth: this read runs with the SERVICE key (bypasses RLS), so block
      // PostgREST embeds (select=foo,bar(...)) — an embedded resource is fetched without
      // RLS and could surface related rows/columns the public key is denied. The app's
      // selects are always flat column lists; parentheses only ever mean an embed here.
      const rawSelect = (/[?&]select=([^&]*)/i.exec(query) || [])[1] || "";
      if (/[()]|%28|%29/i.test(rawSelect)) throw httpErr(400, "Embedded selects are not allowed");
      const json = await sbSelect(rtable, query + scope);
      return res.status(200).json(json);
    }

    const table = String(body.table || "");
    if (!WRITABLE.has(table)) throw httpErr(400, `Table not writable: ${table}`);

    // ── Phase 1b: athlete ownership scoping ──────────────────────────────────
    // ownFilter is appended to update/delete queries (stays "" for coach callers,
    // which preserves their existing behavior exactly).
    let ownFilter = "";
    let coachIsMaster = false;
    if (caller.role === "athlete") {
      const col = ATHLETE_OWN_COL[table];
      if (!col) throw httpErr(403, "This account can't write that data");
      ownFilter = `&${col}=eq.${enc(caller.id)}`;
      // insert/upsert: every row must declare the caller as the owner.
      if (body.op === "insert" || body.op === "upsert") {
        const rows = Array.isArray(body.data) ? body.data : [body.data];
        for (const r of rows) {
          if (!r || typeof r !== "object") throw httpErr(400, `${body.op} requires data`);
          if (String(r[col]) !== String(caller.id)) {
            throw httpErr(403, "Cannot write another account's data");
          }
        }
      }
      // Per-column allowlist on sensitive tables (e.g. athletes): reject any field
      // the athlete isn't permitted to self-set, and enforce per-column value guards.
      const colRule = ATHLETE_COL_ALLOW[table];
      if (colRule && body.op !== "delete") {
        const rows = Array.isArray(body.data) ? body.data : [body.data];
        for (const r of rows) {
          if (!r || typeof r !== "object") throw httpErr(400, `${body.op} requires data`);
          for (const k of Object.keys(r)) {
            if (k === col) continue; // ownership column — already validated above
            if (!colRule.cols.has(k)) throw httpErr(403, `Field not editable: ${k}`);
            if (colRule.values && colRule.values[k] && !colRule.values[k](r[k])) {
              throw httpErr(403, `Value not allowed for ${k}`);
            }
          }
        }
      }
    }

    // ── Coach write scoping ───────────────────────────────────────────────────
    // Mirrors the READ scoping above: a coach may only WRITE within their remit.
    //   master → everything (no scope)
    //   admin  → their school (coaches + athletes + those athletes' data)
    //   coach  → their own roster only (athletes where coach_id == them, + that data)
    // Without this, ANY coach could write ANY row — another coach's athletes, other
    // schools, even create/delete coaches. ownFilter is ANDed onto update/delete so a
    // forged client filter can only narrow; insert/upsert payloads are checked row-by-row.
    if (caller.role === "coach") {
      const me = (await sbSelect("coaches", `?id=eq.${enc(caller.id)}&select=id,role,school_id`))[0];
      if (!me) throw httpErr(401, "Not authorized");
      coachIsMaster = me.role === "master";
      const isAdmin = me.role === "admin";

      if (!coachIsMaster) {
        const sid = me.school_id;
        const writeRows = () => (Array.isArray(body.data) ? body.data : [body.data]);
        // For insert/upsert, assert every row satisfies the ownership predicate.
        const assertRows = (ok) => {
          if (body.op !== "insert" && body.op !== "upsert") return;
          for (const r of writeRows()) {
            if (!r || typeof r !== "object") throw httpErr(400, `${body.op} requires data`);
            if (!ok(r)) throw httpErr(403, "Cannot write another account's data");
          }
        };

        if (table === "schools") {
          // School records (tier, limits, codes) are master-only.
          throw httpErr(403, "This account can't write that data");
        } else if (table === "coaches") {
          if (!isAdmin) {
            // Managing coaches is admin-only — EXCEPT a coach may update their OWN
            // notification_prefs (self-service settings). Only that column, only their row.
            const keys = Object.keys(body.data || {});
            if (body.op === "update" && keys.length && keys.every((k) => k === "notification_prefs")) {
              ownFilter = `&id=eq.${enc(caller.id)}`;
            } else {
              throw httpErr(403, "This account can't write that data");
            }
          } else {
            // admin → coaches within their own school.
            ownFilter = `&school_id=eq.${enc(sid)}`;
            assertRows((r) => String(r.school_id) === String(sid));
            // Seat limit (schools.max_coaches) is what the school tier bills for —
            // enforce it server-side, not just in the Account tab UI. Count matches
            // the client's atLimit gate (non-admin rows), minus soft-removed seats
            // (access_code REMOVED_*) so the server is never STRICTER than the UI —
            // the happy path can't hit this, keeping the change invisible.
            if (body.op === "insert" || body.op === "upsert") {
              const school = (await sbSelect("schools", `?id=eq.${enc(sid)}&select=max_coaches`))[0];
              const maxCoaches = school?.max_coaches || 3;
              const seated = (await sbSelect("coaches", `?school_id=eq.${enc(sid)}&select=id,role,access_code`))
                .filter((c) => c.role !== "admin" && !String(c.access_code || "").startsWith("REMOVED_"))
                .length;
              const adding = writeRows().filter((r) => r && r.role !== "admin").length;
              if (seated + adding > maxCoaches) {
                throw httpErr(403, `Coach limit reached for your plan (${maxCoaches} max).`);
              }
            }
          }
        } else if (table === "athletes") {
          // admin → any athlete in their school; coach → only their own roster.
          ownFilter = isAdmin ? `&school_id=eq.${enc(sid)}` : `&coach_id=eq.${enc(caller.id)}`;
          assertRows((r) => (isAdmin ? String(r.school_id) === String(sid) : String(r.coach_id) === String(caller.id)));
        } else if (table === "coach_context" || table === "coach_push_subscriptions" || table === "program_change_requests" || table === "proof_digests") {
          // The coach's OWN data (context notes, push subs), their request inbox, and
          // their reports — all carry coach_id (per-athlete digests carry the owning
          // coach_id too, so this also lets a coach mark those read without widening).
          // A regular coach may write these for themselves — the self-service carve-out
          // around the coaches-table admin-only rule. Scope + assert on coach_id.
          ownFilter = `&coach_id=eq.${enc(caller.id)}`;
          assertRows((r) => String(r.coach_id) === String(caller.id));
        } else {
          // Athlete-owned data tables: scope to the coach's athlete set (the same set
          // the read path returns), keyed by athlete_id.
          const col = ATHLETE_OWN_COL[table];
          if (!col) throw httpErr(403, "This account can't write that data");
          const roster = isAdmin
            ? await sbSelect("athletes", `?school_id=eq.${enc(sid)}&select=id`)
            : await sbSelect("athletes", `?coach_id=eq.${enc(caller.id)}&select=id`);
          const ids = roster.map((a) => String(a.id));
          // Empty roster → a sentinel uuid that never matches a real row, so update/
          // delete become safe no-ops and insert/upsert payloads are rejected below.
          const inList = ids.length ? ids.map((id) => `"${id}"`).join(",") : `"00000000-0000-0000-0000-000000000000"`;
          ownFilter = `&${col}=in.(${inList})`;
          assertRows((r) => ids.includes(String(r[col])));
        }
      }
    }

    if (body.op === "insert") {
      if (body.data == null || typeof body.data !== "object") throw httpErr(400, "insert requires data");
      // Coach alert context must be computed BEFORE the rows land (the pain-dedupe
      // and PR-improvement checks compare against pre-insert state). Best-effort:
      // a failure here can never block or fail the athlete's write.
      let coachAlert = null;
      try { coachAlert = await prepCoachAlert(caller, table, body.data); }
      catch (e) { console.error("[data] coach alert prep failed:", e.message); }
      const json = await sbWrite({ method: "POST", table, body: body.data });
      if (coachAlert) {
        try { await notifyCoachLazy(coachAlert.coachId, coachAlert.prefKey, coachAlert.msg); }
        catch (e) { console.error("[data] coach alert send failed:", e.message); }
      }
      return res.status(200).json(json);
    }

    if (body.op === "update") {
      if (body.data == null || typeof body.data !== "object") throw httpErr(400, "update requires data");
      // Update by an explicit PostgREST filter (e.g. "?coach_id=eq.<uuid>") or by id.
      const base = typeof body.params === "string" && body.params
        ? body.params
        : `?id=eq.${enc(str(body.id, { max: 64, name: "id" }))}`;
      const json = await sbWrite({ method: "PATCH", table, query: base + ownFilter, body: body.data });

      // ── Coach programming-update notification hook (notification policy v2) ──
      // ONLY a COACH-authored write to an athlete's program_text/temp_program_text
      // enqueues a debounced push (api/notify-program-changes.js, 15-min batching).
      // Deliberately narrow: `program_locked` (a lock TOGGLE, not programming
      // content) does not qualify on its own, and athlete/Joe self-edits to the
      // same columns never reach this branch (caller.role is "athlete" there).
      // The client always updates ONE athlete per call here (coach.jsx's bulk
      // assign loops one sbUpdate per athlete_id) — body.id is the athlete_id.
      if (caller.role === "coach" && table === "athletes" && body.id &&
          ("program_text" in body.data || "temp_program_text" in body.data)) {
        try {
          await sbWrite({
            method: "POST", table: "program_change_events", prefer: "return=minimal",
            body: { athlete_id: body.id },
          });
        } catch (e) { console.error("[data] program_change_events enqueue failed:", e.message); } // best-effort, never blocks the save
      }

      return res.status(200).json(json);
    }

    if (body.op === "upsert") {
      if (body.data == null || typeof body.data !== "object") throw httpErr(400, "upsert requires data");
      const conflict = str(body.conflict, { max: 120, name: "conflict" });
      // Athlete upserts may ONLY conflict on their ownership column. The per-row check
      // above forces the payload's ownership column to equal the caller, but on_conflict
      // chooses WHICH existing row gets merged — so a conflict on a different unique key
      // (e.g. "id") could overwrite ANOTHER athlete's row while the payload still claims
      // the caller as owner. Pinning conflict to the ownership column means a merge can
      // only ever land on the caller's own row. The app only upserts on athlete_id.
      if (caller.role === "athlete" && conflict !== ATHLETE_OWN_COL[table]) {
        throw httpErr(403, "Upsert not allowed on that key");
      }
      // Non-master coaches have no legitimate upsert path (the app never coach-upserts),
      // and upsert applies no ownFilter — so block it rather than leave an unscoped write.
      if (caller.role === "coach" && !coachIsMaster) {
        throw httpErr(403, "Upsert not allowed for this account");
      }
      const json = await sbWrite({
        method: "POST",
        table,
        query: `?on_conflict=${enc(conflict)}`,
        body: body.data,
        prefer: "resolution=merge-duplicates,return=representation",
      });
      return res.status(200).json(json);
    }

    if (body.op === "delete") {
      // The app passes a PostgREST filter string (e.g. "?athlete_id=eq.<uuid>").
      const base = typeof body.params === "string" && body.params
        ? body.params
        : (body.id ? `?id=eq.${enc(str(body.id, { max: 64, name: "id" }))}` : "");
      if (!base) throw httpErr(400, "delete requires params or id");
      await sbWrite({ method: "DELETE", table, query: base + ownFilter, prefer: "return=minimal" });
      return res.status(200).json({ ok: true });
    }

    throw httpErr(400, "Unknown op");
  } catch (e) {
    return handleErr(e, res, caller, body);
  }
}

// ── Coach alert fanouts (notification policy v2.1, Will-approved 2026-07-22) ──
// The Settings toggles "Athlete injury" and "Big PR" previously controlled pushes
// that were never sent. Two of the three new coach alert types hook the athlete
// write path here (the third — "athlete goes quiet" — rides the inactivity cron
// in api/push.js). notifyCoach gates on the coach's own notification_prefs.
const getPD = (r) => {
  const pd = r?.parsed_data;
  if (typeof pd === "string") { try { return JSON.parse(pd); } catch { return {}; } }
  return pd || {};
};
// Lift grouping goes through the SAME canonical funnel as every other surface
// (resolveLift, see the taxonomy header in src/grit.js). Keying by raw lowercased
// name here would repeat the exact defect this release fixes on the client: a PR
// on "Squats"/"RDL"/"DB Bench" would compare against an empty bucket and the
// coach's big-PR alert would silently never fire for those lifts. Imported
// lazily alongside the sender so the hot path doesn't pay for it.
const epley = (w, r) => (!w || w <= 0) ? 0 : Math.round(w * (1 + (r || 1) / 30));
const toLbsSrv = (w, unit) => (unit === "kg" ? Math.round(Number(w || 0) * 2.20462) : Number(w || 0));

// Which of `rows` beat the athlete's existing best for the SAME canonical lift?
// Pure (resolveLift injected) so scripts/test-coach-alerts.mjs can exercise it
// without a DB or the web-push import. A lift with no prior row returns nothing:
// a first-ever PR is a baseline, not news worth pushing to a coach.
export function pickImprovedPRs(existing, rows, resolveLift) {
  const e1Of = (p) => p.estimated_1rm || epley(toLbsSrv(p.weight, p.unit), p.reps);
  const bestByEx = {};
  for (const p of existing || []) {
    const k = resolveLift(p.exercise || "").id;
    const e1 = e1Of(p);
    if (e1 > (bestByEx[k] || 0)) bestByEx[k] = e1;
  }
  return (rows || []).filter((r) => {
    const k = resolveLift(r.exercise || "").id;
    return bestByEx[k] && e1Of(r) > bestByEx[k];
  });
}

async function prepCoachAlert(caller, table, data) {
  if (caller.role !== "athlete") return null;
  const rows = Array.isArray(data) ? data : [data];

  if (table === "workouts") {
    const areas = [...new Set(rows.flatMap((r) => (getPD(r).pain_flags || []).map((p) => p && p.area).filter(Boolean)))];
    if (!areas.length) return null;
    const athlete = (await sbSelect("athletes", `?id=eq.${enc(caller.id)}&select=id,name,coach_id`))[0];
    if (!athlete?.coach_id) return null;
    // One injury alert per athlete per day: skip if an earlier row today already
    // flagged pain (multi-message sessions would otherwise ping the coach per message).
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const today = await sbSelect("workouts", `?athlete_id=eq.${enc(caller.id)}&created_at=gte.${dayStart.toISOString()}&select=parsed_data&limit=50`);
    if (today.some((w) => (getPD(w).pain_flags || []).length)) return null;
    return {
      coachId: athlete.coach_id, prefKey: "injury",
      msg: { title: "WILCO", body: `${athlete.name} flagged ${areas.join(", ")} pain in today's log.`, url: "/", type: "coach_injury" },
    };
  }

  if (table === "prs") {
    // "Big PR" = a true improvement over an existing best (first-ever PR rows are
    // baselines, not news). Compare against pre-insert state, grouped by canonical
    // lift id, with both sides converted to lbs so a kg-logged row ranks correctly.
    const existing = await sbSelect("prs", `?athlete_id=eq.${enc(caller.id)}&select=exercise,weight,reps,unit,estimated_1rm`);
    if (!existing.length) return null;
    const { resolveLift } = await import("./_grit.js");
    const improved = pickImprovedPRs(existing, rows, resolveLift);
    if (!improved.length) return null;
    const athlete = (await sbSelect("athletes", `?id=eq.${enc(caller.id)}&select=id,name,coach_id`))[0];
    if (!athlete?.coach_id) return null;
    const top = improved[0];
    const extra = improved.length > 1 ? ` (+${improved.length - 1} more)` : "";
    return {
      coachId: athlete.coach_id, prefKey: "big_pr",
      msg: { title: "WILCO", body: `${athlete.name} just hit a new ${top.exercise} PR — ${top.weight} × ${top.reps || 1}.${extra}`, url: "/", type: "coach_pr" },
    };
  }

  return null;
}

function handleErr(e, res, caller, body) {
    const status = e.status || 500;
    // Log only genuine reliability events (5xx — e.g. a Supabase write/read that
    // failed). Routine 4xx (auth/validation) are normal user flow, not failures, so
    // logging them would just create noise. We deliberately do NOT read the DB to
    // snapshot school/tier here — we may be in this catch *because* the DB failed —
    // so we attribute only with what authCaller already gave us (in memory).
    if (status >= 500) {
      logError({
        source: "server", severity: "error", area: "data", route: "api/data",
        error_type: `http_${status}`, message: e.message, status_code: status,
        role: caller?.role, actor_id: caller?.id,
        athlete_id: caller?.role === "athlete" ? caller.id : null,
        meta: { op: body.op, table: body.table },
      });
    }
    return res.status(status).json({ error: e.message || "Server error" });
}
