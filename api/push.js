// ─── WEB PUSH ENDPOINT (v1) ───────────────────────────────────────────────────
// One route for everything push: the client enables/disables notifications and
// fires a test through POST actions (athlete-authenticated, same token/PIN
// pattern as api/data.js), and the daily inactivity-nudge cron hits GET with the
// CRON_SECRET bearer (same gate as api/trigger-proof-feed.js).
//
// POST { action:"vapid-public-key" }                        -> { publicKey }   (public, no auth)
// POST { auth, action:"subscribe", subscription }           -> { ok }          (upsert by endpoint, bound to caller)
// POST { auth, action:"unsubscribe", endpoint }             -> { ok }          (deletes caller's own row only)
// POST { auth, action:"test" }                              -> { sent, pruned }(immediate test push to caller's devices)
// GET  Authorization: Bearer <CRON_SECRET>                  -> { checked, nudged, pruned }
//
// The nudge run finds athletes who have push enabled, haven't logged a workout
// in >3 days, and haven't been nudged in >3 days, and sends each ONE short
// Coach Joe message. Dead subscriptions (push service says 404/410) are pruned
// wherever a send fails, so the table self-cleans as devices churn.
//
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET,
//      SUPABASE_URL + SUPABASE_SERVICE_KEY (via ./_supa.js).

import webpush from "web-push";
import {
  applyCors, httpErr, str, sbSelect, sbWrite, sbDelete,
  authCaller, tryTokenAuth, authThrottle, clientIp, logError,
} from "./_supa.js";

const enc = encodeURIComponent;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:coachwill@trainwilco.com";

let vapidReady = false;
function ensureVapid() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw httpErr(500, "Push not configured");
  if (!vapidReady) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidReady = true;
  }
}

// How long an athlete (and a nudge cooldown) can sit quiet before Joe pings.
const STALE_DAYS = 3;
const staleCutoff = () => new Date(Date.now() - STALE_DAYS * 864e5).toISOString();

// Coach Joe inactivity nudges — short, human, one per run, rotated at random.
const NUDGE_VARIANTS = [
  "Been a few days. What are we training today?",
  "Haven't seen a log from you in a bit. Let's get one in today.",
  "Your last session is getting old. Time to stack another one.",
  "Consistency wins. Get a session in and log it for me today.",
];

// Send one push to one subscription row. Returns "sent", "pruned", or "failed".
// 404/410 from the push service mean the subscription is dead — delete the row.
// Any other failure is logged and swallowed so one bad device can't break a batch.
async function sendTo(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return "sent";
  } catch (e) {
    const code = e && e.statusCode;
    if (code === 404 || code === 410) {
      try { await sbDelete("push_subscriptions", `?id=eq.${enc(sub.id)}`); } catch { /* prune is best-effort */ }
      return "pruned";
    }
    console.error(`[push] send failed (${code || "network"}) for sub ${sub.id}:`, e?.message);
    return "failed";
  }
}

// ── Daily nudge run (GET, cron-only) ──────────────────────────────────────────
async function runNudges(res) {
  ensureVapid();
  const subs = await sbSelect("push_subscriptions", "?select=*");
  if (subs.length === 0) return res.status(200).json({ checked: 0, nudged: 0, pruned: 0 });

  // Group subscriptions per athlete; an athlete gets ONE nudge across devices.
  const byAthlete = {};
  for (const s of subs) (byAthlete[s.athlete_id] = byAthlete[s.athlete_id] || []).push(s);
  const athleteIds = Object.keys(byAthlete);
  const idList = athleteIds.map((id) => `"${id}"`).join(",");

  // Anyone with a workout in the last STALE_DAYS is active — skip them. Athletes
  // with NO workouts ever count as stale too (they clearly need the nudge), but
  // a brand-new subscription gets a grace period so nobody is pinged the same
  // week they turned notifications on without ever going quiet.
  const cutoff = staleCutoff();
  const recent = await sbSelect(
    "workouts",
    `?athlete_id=in.(${idList})&created_at=gte.${enc(cutoff)}&select=athlete_id`
  );
  const active = new Set(recent.map((w) => w.athlete_id));

  let nudged = 0;
  let pruned = 0;
  for (const [athleteId, rows] of Object.entries(byAthlete)) {
    if (active.has(athleteId)) continue;
    // Cooldown: skip if ANY of their rows was nudged within the window.
    if (rows.some((r) => r.last_nudged_at && r.last_nudged_at >= cutoff)) continue;
    // Grace period: newest subscription must itself be older than the window.
    if (rows.every((r) => r.created_at && r.created_at >= cutoff)) continue;

    const body = NUDGE_VARIANTS[Math.floor(Math.random() * NUDGE_VARIANTS.length)];
    const payload = { title: "Coach Joe", body, url: "/" };
    let sentAny = false;
    for (const sub of rows) {
      const outcome = await sendTo(sub, payload);
      if (outcome === "sent") sentAny = true;
      if (outcome === "pruned") pruned++;
    }
    if (sentAny) nudged++;
    // Stamp the cooldown even if every device failed — retrying a broken endpoint
    // nightly just burns the run; the rows self-heal (prune) or the athlete re-enables.
    try {
      await sbWrite({
        method: "PATCH", table: "push_subscriptions",
        query: `?athlete_id=eq.${enc(athleteId)}`,
        body: { last_nudged_at: new Date().toISOString() },
        prefer: "return=minimal",
      });
    } catch { /* cooldown stamp is best-effort */ }
  }

  return res.status(200).json({ checked: athleteIds.length, nudged, pruned });
}

// Vercel Pro: cap this function's execution time. 60s gives the nudge run room
// to fan out sends (each is a network call to a browser push service).
export const maxDuration = 60;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  // ── Cron path: GET gated SOLELY by the CRON_SECRET bearer Vercel injects ──
  // (same gate as api/trigger-proof-feed.js — never the forgeable x-vercel-cron).
  if (req.method === "GET") {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return res.status(500).json({ error: "Missing CRON_SECRET" });
    if (req.headers["authorization"] !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Not authorized" });
    }
    try {
      return await runNudges(res);
    } catch (e) {
      console.error("[push] nudge run failed:", e);
      logError({
        source: "server", severity: "error", area: "sync", route: "api/push",
        error_type: `http_${e.status || 500}`, message: e.message, status_code: e.status || 500,
      });
      return res.status(e.status || 500).json({ error: e.message || "Server error" });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};

  // Public: the VAPID public key is by definition public — no auth needed.
  if (body.action === "vapid-public-key") {
    if (!VAPID_PUBLIC_KEY) return res.status(500).json({ error: "Push not configured" });
    return res.status(200).json({ publicKey: VAPID_PUBLIC_KEY });
  }

  let caller = null;
  try {
    // Same auth pattern as api/data.js: token fast path, throttled PIN fallback.
    caller = tryTokenAuth(body.auth);
    if (!caller) {
      const recordAuthFail = await authThrottle(`push-authfail:${clientIp(req)}`);
      try {
        caller = await authCaller(body.auth);
      } catch (e) {
        if (e.status === 401) await recordAuthFail();
        throw e;
      }
    }
    if (caller.role !== "athlete") throw httpErr(403, "Only athletes can manage notifications");

    if (body.action === "subscribe") {
      const sub = body.subscription;
      if (!sub || typeof sub !== "object") throw httpErr(400, "subscription is required");
      const endpoint = str(sub.endpoint, { max: 1000, name: "endpoint" });
      if (!/^https:\/\//.test(endpoint)) throw httpErr(400, "endpoint must be an https URL");
      const keys = sub.keys || {};
      const p256dh = str(keys.p256dh, { max: 300, name: "p256dh" });
      const auth = str(keys.auth, { max: 300, name: "auth" });
      await sbWrite({
        method: "POST", table: "push_subscriptions",
        query: "?on_conflict=endpoint",
        body: {
          athlete_id: caller.id, endpoint, p256dh, auth,
          user_agent: String(req.headers["user-agent"] || "").slice(0, 200) || null,
        },
        prefer: "resolution=merge-duplicates,return=minimal",
      });
      return res.status(200).json({ ok: true });
    }

    if (body.action === "unsubscribe") {
      const endpoint = str(body.endpoint, { max: 1000, name: "endpoint" });
      // Scoped to the caller: you can only ever delete your own subscription row.
      await sbWrite({
        method: "DELETE", table: "push_subscriptions",
        query: `?endpoint=eq.${enc(endpoint)}&athlete_id=eq.${enc(caller.id)}`,
        prefer: "return=minimal",
      });
      return res.status(200).json({ ok: true });
    }

    if (body.action === "test") {
      ensureVapid();
      const rows = await sbSelect("push_subscriptions", `?athlete_id=eq.${enc(caller.id)}&select=*`);
      if (rows.length === 0) return res.status(200).json({ sent: 0, pruned: 0 });
      const payload = { title: "Coach Joe", body: "Notifications are on. I'll keep you posted.", url: "/" };
      let sent = 0;
      let pruned = 0;
      for (const sub of rows) {
        const outcome = await sendTo(sub, payload);
        if (outcome === "sent") sent++;
        if (outcome === "pruned") pruned++;
      }
      return res.status(200).json({ sent, pruned });
    }

    throw httpErr(400, "Unknown action");
  } catch (e) {
    const status = e.status || 500;
    // Mirror api/data.js: log genuine reliability events (5xx) only — routine
    // 4xx auth/validation results are normal user flow, not failures.
    if (status >= 500) {
      logError({
        source: "server", severity: "error", area: "sync", route: "api/push",
        error_type: `http_${status}`, message: e.message, status_code: status,
        role: caller?.role, actor_id: caller?.id,
        athlete_id: caller?.role === "athlete" ? caller.id : null,
        meta: { action: body.action },
      });
    }
    return res.status(status).json({ error: e.message || "Server error" });
  }
}
