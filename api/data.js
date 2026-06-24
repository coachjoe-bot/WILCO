// ─── AUTHENTICATED WRITE GATEWAY ──────────────────────────────────────────────
// All app writes route through here so the database can deny the public (anon)
// key entirely. The caller proves identity (athlete or coach id + PIN); the write
// itself runs server-side with the service key.
//
// POST { auth:{role,id,pin}, op:"insert"|"update"|"delete", table, data?, id?, params? }
//
// NOTE (Phase 1): this requires a VALID logged-in caller, which closes the
// catastrophic ANONYMOUS write hole. Per-row ownership scoping (so an authed
// athlete can't write another athlete's row) is a follow-up (Phase 1b).

import { applyCors, httpErr, str, sbWrite, authCaller } from "./_supa.js";

const enc = encodeURIComponent;

// Tables the app legitimately writes. Anything else is rejected outright.
const WRITABLE = new Set([
  "athletes", "workouts", "prs", "coaches", "schools",
  "manual_one_rms", "program_modifications", "athlete_goals",
  "legal_acceptances", "deletion_requests", "athlete_context",
  "push_subscriptions", "proof_digests",
]);

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};

  try {
    await authCaller(body.auth);

    const table = String(body.table || "");
    if (!WRITABLE.has(table)) throw httpErr(400, `Table not writable: ${table}`);

    if (body.op === "insert") {
      if (body.data == null || typeof body.data !== "object") throw httpErr(400, "insert requires data");
      const json = await sbWrite({ method: "POST", table, body: body.data });
      return res.status(200).json(json);
    }

    if (body.op === "update") {
      if (body.data == null || typeof body.data !== "object") throw httpErr(400, "update requires data");
      // Update by an explicit PostgREST filter (e.g. "?coach_id=eq.<uuid>") or by id.
      const query = typeof body.params === "string" && body.params
        ? body.params
        : `?id=eq.${enc(str(body.id, { max: 64, name: "id" }))}`;
      const json = await sbWrite({ method: "PATCH", table, query, body: body.data });
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
      const query = typeof body.params === "string" && body.params
        ? body.params
        : (body.id ? `?id=eq.${enc(str(body.id, { max: 64, name: "id" }))}` : "");
      if (!query) throw httpErr(400, "delete requires params or id");
      await sbWrite({ method: "DELETE", table, query, prefer: "return=minimal" });
      return res.status(200).json({ ok: true });
    }

    throw httpErr(400, "Unknown op");
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || "Server error" });
  }
}
