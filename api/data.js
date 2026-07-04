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

// Tables the app legitimately writes. Anything else is rejected outright.
const WRITABLE = new Set([
  "athletes", "workouts", "prs", "coaches", "schools",
  "manual_one_rms", "program_modifications", "athlete_goals",
  "legal_acceptances", "deletion_requests", "athlete_context",
  "push_subscriptions", "proof_digests",
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
  // Server-side session-count rollup (SQL port of groupIntoSessions, verified to
  // match the client row-for-row). Read-only VIEW; scoped by athlete_id exactly
  // like the raw tables, so a coach only sees their own roster's counts. Lets the
  // coach dashboard show session totals without pulling every raw workout to the
  // browser (see docs/coach-experience-roadmap.md for the dashboard wiring).
  v_athlete_session_counts: "athlete_id",
};

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
          if (rtable === "proof_digests") {
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
          // Managing coaches is admin-only, and only within the admin's own school.
          if (!isAdmin) throw httpErr(403, "This account can't write that data");
          ownFilter = `&school_id=eq.${enc(sid)}`;
          assertRows((r) => String(r.school_id) === String(sid));
        } else if (table === "athletes") {
          // admin → any athlete in their school; coach → only their own roster.
          ownFilter = isAdmin ? `&school_id=eq.${enc(sid)}` : `&coach_id=eq.${enc(caller.id)}`;
          assertRows((r) => (isAdmin ? String(r.school_id) === String(sid) : String(r.coach_id) === String(caller.id)));
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
      const json = await sbWrite({ method: "POST", table, body: body.data });
      return res.status(200).json(json);
    }

    if (body.op === "update") {
      if (body.data == null || typeof body.data !== "object") throw httpErr(400, "update requires data");
      // Update by an explicit PostgREST filter (e.g. "?coach_id=eq.<uuid>") or by id.
      const base = typeof body.params === "string" && body.params
        ? body.params
        : `?id=eq.${enc(str(body.id, { max: 64, name: "id" }))}`;
      const json = await sbWrite({ method: "PATCH", table, query: base + ownFilter, body: body.data });
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
}
