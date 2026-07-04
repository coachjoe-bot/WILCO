// ─── TELEMETRY ENDPOINT ───────────────────────────────────────────────────────
// Browser telemetry ingestion split off from api/identity.js (Vercel Pro lifted the
// 12-fn cap that forced them to share the login endpoint). Keeping high-volume,
// anon-accepting error/event capture OUT of the auth-critical path means a bug here
// can't take down login/signup. The handler logic is shared in ./_telemetry.js so
// identity.js can keep delegating to it for cached PWA clients still posting there.
//
// Actions (POST { action, ... }):
//   log-error   { auth?, event }   -> { ok:true }   (reliability, error_events)
//   log-events  { auth?, events }  -> { ok:true }   (engagement, usage_events)
import { applyCors } from "./_supa.js";
import { handleLogError, handleLogEvents } from "./_telemetry.js";

// Fast, DB-light writes; a small budget is plenty. Guard test enforces its presence.
export const maxDuration = 15;

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
      case "log-error":  return await handleLogError(req, res, body);
      case "log-events": return await handleLogEvents(req, res, body);
      default:           return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    // Telemetry is fire-and-forget; never surface a failure to the user.
    return res.status(200).json({ ok: true });
  }
}
