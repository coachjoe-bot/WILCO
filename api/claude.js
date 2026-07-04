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
//   5. forwards ONLY the fields we build here (model/max_tokens/system/messages
//      + server-chosen inference params) — never the client's raw body.
//
// POST { auth:{role,id,pin}, model?, max_tokens?, system?, messages:[...] }

import { applyCors, httpErr, authCaller, tryTokenAuth, rateLimit, sbSelect, sbInsert, logError, authThrottle, clientIp } from "./_supa.js";

const enc = encodeURIComponent;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;

// ─── MODEL CONFIG ────────────────────────────────────────────────────────────
// Single source of truth for which models the app may use. Anything the client
// asks for that isn't here falls back to DEFAULT_MODEL, so a stray/malicious
// model id can't reach a pricier model — without breaking the app.
//
// claude-sonnet-4-6 is kept allowlisted for one release so rollback is a
// one-line DEFAULT_MODEL flip rather than a redeploy of the client too.
const DEFAULT_MODEL = "claude-sonnet-5";
const ALLOWED_MODELS = new Set([
  "claude-sonnet-5",
  // Haiku 4.5 is used ONLY for mechanical, never-seen extraction calls
  // (parseWorkout, goal parsing) — ~3x cheaper. modelParams() below gives it
  // no effort param (effort is invalid on Haiku). Coaching voice is Sonnet 5.
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
]);

// Per-model inference params, chosen SERVER-side (the client never picks these).
// Sonnet 4.6 defaults effort to "high" and supports thinking; Sonnet 4.5 had
// neither. WILCO's calls are mechanical extraction + short coaching replies, so
// a naive 4.6 swap would raise cost/latency for no quality gain. Pin effort low
// and thinking off to keep the 4.5-equivalent fast/cheap profile.
//   NOTE (Phase 2): effort is INVALID on Haiku 4.5 — if a call is ever routed to
//   Haiku, it must NOT receive `output_config.effort`. Gate on the model id here.
//   If any feature later needs more reasoning, bump effort to "medium" for that
//   model — do not remove the gate.
//   NOTE (Sonnet 5): omitting `thinking` on Sonnet 5 turns adaptive thinking ON
//   by default — thinking tokens would then eat into max_tokens and could truncate
//   parse JSON. Keep thinking explicitly disabled on every Sonnet model.
function modelParams(model) {
  if (model === "claude-sonnet-5" || model === "claude-sonnet-4-6") {
    return { output_config: { effort: "low" }, thinking: { type: "disabled" } };
  }
  return {};
}

// The app's largest legitimate call asks for 1300 tokens; cap above that with
// headroom. (Sonnet 5's tokenizer yields ~30% more tokens for the same text than
// 4.6, so the old 1500 cap was too tight for the biggest calls.) Raised to 4000
// on the Vercel Pro upgrade: the 10s function wall (which made long generations
// risky) is gone (maxDuration=60 above), so richer replies / reports can complete.
// This is a CEILING, not a default — the per-call max_tokens is still whatever the
// client asks for (clamped here), so it doesn't raise cost unless a call needs it,
// and the per-user rate limit + auth still bound a stolen session's spend.
const MAX_TOKENS_CAP = 4000;
// Per-user ceiling: far above any human's real usage, low enough to bound a stolen
// session's spend. Every call (success or not) counts — each one costs money.
const RATE = { max: 100, windowMin: 15 };

// ─── COST TRACKING (Phase 1) ──────────────────────────────────────────────────
// Every call is logged to usage_costs (token counts + metadata, NO content) so we
// can answer "what does each user/feature/school cost us in Claude spend." Cost in
// $ is computed at read time from the ai_pricing table — see the migration.
// Logging is best-effort: a failure here must NEVER break or slow the user's AI
// response, so it's wrapped in try/catch and the snapshot read runs concurrently
// with the Anthropic call (so it adds ~no wall-clock).
const FEATURES = new Set([
  "workout_parse", "joebot_chat", "program_extract", "program_generate",
  "pr_ack", "goal_parse", "video_form_review", "monthly_recap",
  // Proof Feed engine (server-side, via askClaudeServer in _supa.js). Listed here
  // too so the cost-feature vocabulary stays in one place across both AI paths.
  // proof_answer_extract runs from the CLIENT (guided-chat answer parsing) through
  // this proxy, so it MUST be allowlisted here or it would fall back to "other".
  "proof_weekly", "proof_monthly", "proof_coach", "program_parse", "proof_answer_extract",
  // Quick Log: draft = prefill today's log from program+history; edit = revise the
  // draft per an athlete instruction ("I did day 2", "all bench at 185").
  "quick_log_draft", "quick_log_edit",
]);

// Snapshot the segmentation fields AT CALL TIME so cost stays correctly attributed
// even if the athlete later changes tier/school, and the future coach dashboard can
// scope by a single indexed column. Returns null on any failure (caller swallows).
async function loadSnapshot(caller) {
  if (caller.role === "athlete") {
    const rows = await sbSelect("athletes", `?id=eq.${enc(caller.id)}&select=tier,school_id,coach_id`);
    return rows[0] || null;
  }
  if (caller.role === "coach") {
    const rows = await sbSelect("coaches", `?id=eq.${enc(caller.id)}&select=school_id`);
    return rows[0] || null;
  }
  return null;
}

async function logUsage({ caller, feature, model, data, status, latency_ms, snapP }) {
  const snap = (await snapP) || {};
  const u = (data && data.usage) || {};
  await sbInsert("usage_costs", {
    source: "claude",
    feature,
    role: caller.role,
    actor_id: caller.id,
    athlete_id: caller.role === "athlete" ? caller.id : null,
    school_id: snap.school_id ?? null,
    coach_id: caller.role === "coach" ? caller.id : (snap.coach_id ?? null),
    tier: snap.tier ?? null,
    // Anthropic echoes the resolved model id; fall back to what we requested.
    model: (data && data.model) || model,
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    cache_read_tokens: u.cache_read_input_tokens ?? null,
    cache_write_tokens: u.cache_creation_input_tokens ?? null,
    latency_ms,
    status,
  });
}

// Vercel Pro: cap this function's execution time. Was implicitly the Hobby 10s
// wall; 60s gives vision/form-review + long Claude generations room without paying for idle time.
export const maxDuration = 60;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "AI is not configured" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};

  let caller = null;
  try {
    // 0) Fast path: a valid signed session token authenticates with zero DB work
    //    (no throttle lookup, no bcrypt). HMAC tokens aren't brute-forceable, so
    //    the PIN throttle only matters on the fallback path below.
    caller = tryTokenAuth(body.auth);
    if (!caller) {
      // Brute-force guard: lock an IP with too many recent failed PIN attempts
      // before doing bcrypt work; record only failures so real users aren't throttled.
      const recordAuthFail = await authThrottle(`claude-authfail:${clientIp(req)}`);
      // Require a real logged-in athlete/coach (bcrypt PIN verified server-side).
      try {
        caller = await authCaller(body.auth);
      } catch (e) {
        if (e.status === 401) await recordAuthFail();
        throw e;
      }
    }

    // 2) Per-user rate limit — a compromised account can't burn the bill unbounded.
    await rateLimit(`claude:${caller.role}:${caller.id}`, RATE);

    // Cost tracking: validate the feature label and kick off the snapshot read NOW
    // so it overlaps the Anthropic call below (never throws — caller swallows).
    const feature = FEATURES.has(String(body.feature || "")) ? body.feature : "other";
    const snapP = loadSnapshot(caller).catch(() => null);

    // 3) Never trust the client's model / token count — clamp both.
    const reqModel = String(body.model || "");
    const model = ALLOWED_MODELS.has(reqModel) ? reqModel : DEFAULT_MODEL;
    const max_tokens = Math.min(Math.max(parseInt(body.max_tokens, 10) || 600, 1), MAX_TOKENS_CAP);

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw httpErr(400, "messages required");
    }

    // 4) Forward ONLY the fields we build here — strip anything else the client
    //    sent. Inference params (effort/thinking) are server-chosen per model.
    const payload = { model, max_tokens, messages: body.messages, ...modelParams(model) };
    // Prompt caching: `system_cached` is a STATIC system prefix (identical across
    // calls — e.g. the workout-parse rulebook) marked ephemeral so Anthropic caches
    // it (~90% input discount on hits, 5-min TTL); `system` stays the per-call
    // dynamic tail. Below the per-model minimum cacheable size the marker is a
    // no-op, never an error. usage_costs already records cache_read/write tokens.
    const sysBlocks = [];
    if (typeof body.system_cached === "string" && body.system_cached) {
      sysBlocks.push({ type: "text", text: body.system_cached, cache_control: { type: "ephemeral" } });
    }
    if (typeof body.system === "string" && body.system) {
      sysBlocks.push({ type: "text", text: body.system });
    }
    if (sysBlocks.length) payload.system = sysBlocks;

    // ── Streaming path (opt-in via body.stream) ──────────────────────────────
    // Used only by the conversational chat so replies render token-by-token. All
    // the guards above (token auth, rate limit, model/token clamp, feature label)
    // are shared. We relay Anthropic's text deltas to the client as SSE, then
    // reconstruct `usage` from the stream events and log to usage_costs with the
    // SAME logUsage() as the JSON path — cost tracking does NOT regress.
    if (body.stream === true) {
      const startedAt = Date.now();
      const upstream = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ ...payload, stream: true }),
      });
      // Upstream failed before any streaming — behave exactly like the JSON path:
      // record the error in usage_costs and return a JSON error (headers not sent yet).
      if (!upstream.ok || !upstream.body) {
        const errData = await upstream.json().catch(() => ({}));
        try { await logUsage({ caller, feature, model, data: errData, latency_ms: Date.now() - startedAt, status: `error_${upstream.status}`, snapP }); } catch {}
        return res.status(upstream.status).json(errData);
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // ask proxies not to buffer, so deltas flush live
      });
      const usage = { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null };
      let resolvedModel = model, aborted = false;
      req.on("close", () => { aborted = true; });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const dl = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!dl) continue;
            const raw = dl.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            let ev; try { ev = JSON.parse(raw); } catch { continue; }
            if (ev.type === "message_start" && ev.message) {
              resolvedModel = ev.message.model || resolvedModel;
              const mu = ev.message.usage || {};
              usage.input_tokens = mu.input_tokens ?? usage.input_tokens;
              usage.cache_read_input_tokens = mu.cache_read_input_tokens ?? usage.cache_read_input_tokens;
              usage.cache_creation_input_tokens = mu.cache_creation_input_tokens ?? usage.cache_creation_input_tokens;
            } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
              res.write(`data: ${JSON.stringify({ text: ev.delta.text || "" })}\n\n`);
            } else if (ev.type === "message_delta" && ev.usage) {
              usage.output_tokens = ev.usage.output_tokens ?? usage.output_tokens;
            }
          }
          if (aborted) { try { await reader.cancel(); } catch {} break; }
        }
      } catch {
        try { res.write(`event: error\ndata: ${JSON.stringify({ error: "stream_interrupted" })}\n\n`); } catch {}
      }
      try { res.write(`event: done\ndata: ${JSON.stringify({ done: true })}\n\n`); } catch {}
      try { res.end(); } catch {}
      try { await logUsage({ caller, feature, model: resolvedModel, data: { model: resolvedModel, usage }, latency_ms: Date.now() - startedAt, status: aborted ? "aborted" : "ok", snapP }); } catch {}
      return;
    }

    const startedAt = Date.now();
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    const latency_ms = Date.now() - startedAt;

    const data = await r.json().catch(() => ({}));

    // Best-effort cost log. Awaited so the serverless fn doesn't freeze mid-write,
    // but any failure is swallowed — logging must never break the AI response.
    try {
      await logUsage({
        caller, feature, model, data, latency_ms,
        status: r.ok ? "ok" : `error_${r.status}`,
        snapP,
      });
    } catch { /* tracking is non-critical */ }

    return res.status(r.status).json(data);
  } catch (e) {
    const status = e.status || 500;
    // Only log genuine 5xx reliability events (e.g. misconfig / unexpected throw).
    // NOTE: Anthropic HTTP errors do NOT reach here — they're returned above and
    // already recorded in usage_costs.status (Phase 1), so this can't double-log
    // them. Routine 4xx (auth/rate-limit/validation) are skipped as normal flow.
    if (status >= 500) {
      logError({
        source: "server", severity: "error", area: "ai", route: "api/claude",
        error_type: `http_${status}`, message: e.message, status_code: status,
        role: caller?.role, actor_id: caller?.id,
        athlete_id: caller?.role === "athlete" ? caller.id : null,
      });
    }
    return res.status(status).json({ error: e.message || "Server error" });
  }
}
