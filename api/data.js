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

import { applyCors, httpErr, str, sbSelect, verifyPin, sbWrite } from "./_supa.js";

const enc = encodeURIComponent;

// Tables the app legitimately writes. Anything else is rejected outright.
const WRITABLE = new Set([
  "athletes", "workouts", "prs", "coaches", "schools",
  "manual_one_rms", "program_modifications", "athlete_goals",
  "legal_acceptances", "deletion_requests", "athlete_context",
]);

// Verify the caller is a real athlete/coach with a matching PIN.
async function authCaller(auth) {
  if (!auth || typeof auth !== "object") throw httpErr(401, "Sign in required");
  const id = str(auth.id, { max: 64, name: "auth.id" });
  const table = auth.role === "coach" ? "coaches" : auth.role === "athlete" ? "athletes" : null;
  if (!table) throw httpErr(401, "Invalid auth role");
  const rows = await sbSelect(table, `?id=eq.${enc(id)}&select=id,pin`);
  if (!rows[0] || !(await verifyPin(auth.pin, rows[0].pin))) throw httpErr(401, "Not authorized");
  return { role: auth.role, id };
}

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
      const id = str(body.id, { max: 64, name: "id" });
      if (body.data == null || typeof body.data !== "object") throw httpErr(400, "update requires data");
      const json = await sbWrite({ method: "PATCH", table, query: `?id=eq.${enc(id)}`, body: body.data });
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
