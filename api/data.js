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
// NOTE: COACH-role writes are NOT yet per-row scoped (the coach/admin/school
//       hierarchy needs its own mapping — next follow-up). This is acceptable
//       because athletes CANNOT assume the coach role (authCaller verifies a coach
//       PIN against the coaches table), so athlete-vs-athlete tampering — the
//       high-volume vector, including minors — is fully removed here.

import { applyCors, httpErr, str, sbWrite, sbSelect, authCaller } from "./_supa.js";

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

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};

  try {
    const caller = await authCaller(body.auth);

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
          // Non-master coaches (incl. admins) see only their own athletes' rows —
          // exactly the set coach-dashboard returns and the client used to filter to.
          const aths = await sbSelect("athletes", `?coach_id=eq.${enc(caller.id)}&select=id`);
          const ids = aths.map((a) => a.id);
          if (ids.length === 0) return res.status(200).json([]);
          scope = `&${col}=in.(${ids.map((id) => `"${id}"`).join(",")})`;
        }
        // master: no scope → all rows.
      } else {
        throw httpErr(403, "This account can't read that data");
      }

      // Client's params (order/limit/select/own filters) ride along; the forced
      // ownership scope is ANDed on top so it can only narrow, never widen.
      let query = typeof body.params === "string" && body.params ? body.params : "?select=*";
      if (!query.startsWith("?")) query = "?" + query;
      const json = await sbSelect(rtable, query + scope);
      return res.status(200).json(json);
    }

    const table = String(body.table || "");
    if (!WRITABLE.has(table)) throw httpErr(400, `Table not writable: ${table}`);

    // ── Phase 1b: athlete ownership scoping ──────────────────────────────────
    // ownFilter is appended to update/delete queries (stays "" for coach callers,
    // which preserves their existing behavior exactly).
    let ownFilter = "";
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
    return res.status(e.status || 500).json({ error: e.message || "Server error" });
  }
}
