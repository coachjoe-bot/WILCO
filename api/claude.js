// ─── AUTHENTICATED CLAUDE PROXY ──────────────────────────────────────────────
// The browser can't hold the Anthropic key, so all AI calls route through here.
//
// This REPLACES the old Supabase edge function (supabase/functions/claude-proxy),
// which forwarded ANY request body straight to api.anthropic.com gated only by the
// PUBLIC anon key — i.e. anyone on the internet who read the bundle could run up
// the Anthropic bill with any model and any token count. This version:
//   1. requires a logged-in athlete/coach (same auth as the write gateway),
//   2. rate-limits per user,
//   3. allowlists the model (ignores client-chosen expensive models),
//   4. caps max_tokens,
//   5. forwards ONLY the fields we expect (model/max_tokens/system/messages).
//
// POST { auth:{role,id,pin}, model?, max_tokens?, system?, messages:[...] }

import { applyCors, httpErr, authCaller, rateLimit } from "./_supa.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;

// Models the app is allowed to request. Anything else falls back to DEFAULT_MODEL
// so a stray/malicious model id can't reach a pricier model — without breaking the app.
const DEFAULT_MODEL = "claude-sonnet-4-5";
const ALLOWED_MODELS = new Set([
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
]);

// The app's largest legitimate call asks for 1000 tokens; cap above that with headroom.
const MAX_TOKENS_CAP = 1500;
// Per-user ceiling: far above any human's real usage, low enough to bound a stolen
// session's spend. Every call (success or not) counts — each one costs money.
const RATE = { max: 100, windowMin: 15 };

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "AI is not configured" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};

  try {
    // 1) Require a real logged-in athlete/coach (bcrypt PIN verified server-side).
    const caller = await authCaller(body.auth);

    // 2) Per-user rate limit — a compromised account can't burn the bill unbounded.
    await rateLimit(`claude:${caller.role}:${caller.id}`, RATE);

    // 3) Never trust the client's model / token count — clamp both.
    const reqModel = String(body.model || "");
    const model = ALLOWED_MODELS.has(reqModel) ? reqModel : DEFAULT_MODEL;
    const max_tokens = Math.min(Math.max(parseInt(body.max_tokens, 10) || 600, 1), MAX_TOKENS_CAP);

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw httpErr(400, "messages required");
    }

    // 4) Forward ONLY the fields we expect — strip anything else the client sent.
    const payload = { model, max_tokens, messages: body.messages };
    if (typeof body.system === "string" && body.system) payload.system = body.system;

    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || "Server error" });
  }
}
