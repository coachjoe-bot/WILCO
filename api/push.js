// ─── WEB PUSH ENDPOINT (v2 — notification policy v2) ──────────────────────────
// One route for everything push: the client enables/disables notifications and
// fires a test through POST actions (athlete-authenticated, same token/PIN
// pattern as api/data.js), and the daily inactivity-nudge cron hits GET with the
// CRON_SECRET bearer (same gate as api/trigger-proof-feed.js).
//
// POST { action:"vapid-public-key" }                        -> { publicKey }   (public, no auth)
// POST { auth, action:"subscribe", subscription }           -> { ok }          (upsert by endpoint, bound to caller)
// POST { auth, action:"unsubscribe", endpoint }             -> { ok }          (deletes caller's own row only)
// POST { auth, action:"test" }                              -> { sent, pruned }(immediate test push to caller's devices)
// GET  Authorization: Bearer <CRON_SECRET>                  -> { checked, nudged14, nudged30, pruned }
//
// NOTIFICATION POLICY v2 (Will, 2026-07-04): WILCO sends exactly FOUR kinds of
// push, ever, without Will's explicit sign-off — feed-live (api/trigger-proof-feed.js),
// inactivity (this file), coach programming-update (api/notify-program-changes.js),
// and this file's user-initiated "test." Nothing else.
//
// INACTIVITY POLICY (replaces the old repeating 3-day nudge): exactly TWO touches
// per quiet streak — one at 14 days since the athlete's last logged workout, one
// at 30 days — then silence until they log again, which resets the streak and
// re-arms both touches. Tracked in athlete_nudge_state (one row per athlete,
// NOT per device): stage_14_sent_at / stage_30_sent_at record whether each touch
// has already fired for the CURRENT streak, and last_workout_at is the streak
// anchor. A per-athlete table (rather than overloading push_subscriptions,
// which is per-DEVICE) is what makes "have we sent the 14-day touch for THIS
// streak" unambiguous across an athlete's multiple devices — see the migration's
// header for the fuller rationale.
//
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET,
//      SUPABASE_URL + SUPABASE_SERVICE_KEY (via ./_supa.js).

import {
  applyCors, httpErr, str, sbSelect, sbWrite, sbDelete,
  authCaller, tryTokenAuth, authThrottle, clientIp, logError,
} from "./_supa.js";
import { ensureVapid, vapidPublicKey, sendTo, sendToAthlete, pushPayload } from "./_push.js";

const enc = encodeURIComponent;

// Streak thresholds (days since last logged workout).
const STAGE_14_DAYS = 14;
const STAGE_30_DAYS = 30;
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

// Coach Joe inactivity nudges — simple encouragement, no guilt-tripping, rotated
// at random. Two distinct banks (14-day touch is a lighter check-in; 30-day is a
// last honest nudge before we go quiet) so the two touches don't feel identical.
const NUDGE_14_VARIANTS = [
  "Haven't seen a log from you in a couple weeks. No pressure, just checking in — let's get back to it.",
  "It's been 14 days since your last session. Whenever you're ready, I'm here.",
  "Two weeks since we've trained together. Let's get one in today.",
];
const NUDGE_30_VARIANTS = [
  "It's been a month since your last log. Whenever life settles, come back — I'll pick up right where we left off.",
  "30 days quiet. No judgment — just know the door's open whenever you want back in.",
  "It's been a while. If you're ready to start again, I'm ready to coach.",
];

// ── Daily nudge run (GET, cron-only) ──────────────────────────────────────────
// Runs once/day. For each athlete with push subscriptions: find their most recent
// workout, and if none in 14/30 days AND the matching stage hasn't already fired
// for this streak, send it and stamp the stage. A workout since the last stage
// stamp resets last_workout_at (via upsert below) which naturally re-arms both
// stages for the NEXT streak — no separate "reset" branch needed, since the
// 14/30-day check is always relative to the CURRENT last_workout_at.
async function runNudges(res) {
  ensureVapid();
  const subs = await sbSelect("push_subscriptions", "?select=*");
  if (subs.length === 0) return res.status(200).json({ checked: 0, nudged14: 0, nudged30: 0, pruned: 0 });

  const byAthlete = {};
  for (const s of subs) (byAthlete[s.athlete_id] = byAthlete[s.athlete_id] || []).push(s);
  const athleteIds = Object.keys(byAthlete);
  const idList = athleteIds.map((id) => `"${id}"`).join(",");

  // Most recent workout per athlete (single query, then reduced client-side —
  // PostgREST has no native "latest per group," and this table is small enough).
  const recentWorkouts = await sbSelect(
    "workouts",
    `?athlete_id=in.(${idList})&select=athlete_id,created_at&order=created_at.desc`
  );
  const lastWorkoutAt = {};
  for (const w of recentWorkouts) {
    if (!lastWorkoutAt[w.athlete_id]) lastWorkoutAt[w.athlete_id] = w.created_at; // first hit per id = latest (query is DESC)
  }

  const stateRows = await sbSelect("athlete_nudge_state", `?athlete_id=in.(${idList})&select=*`);
  const stateByAthlete = Object.fromEntries(stateRows.map((r) => [r.athlete_id, r]));

  const cutoff14 = daysAgo(STAGE_14_DAYS);
  const cutoff30 = daysAgo(STAGE_30_DAYS);

  let nudged14 = 0, nudged30 = 0, pruned = 0;
  for (const [athleteId, rows] of Object.entries(byAthlete)) {
    const lastWorkout = lastWorkoutAt[athleteId] || null; // null = never logged a workout at all
    const state = stateByAthlete[athleteId] || null;

    // If the athlete's last workout is NEWER than what we have stamped as the
    // streak anchor (or we've never stamped one), the streak is fresh/reset —
    // clear any stage stamps so both touches are re-armed for THIS streak.
    const priorAnchor = state?.last_workout_at || null;
    const streakReset = lastWorkout && (!priorAnchor || new Date(lastWorkout) > new Date(priorAnchor));

    let stage14Sent = streakReset ? null : (state?.stage_14_sent_at || null);
    let stage30Sent = streakReset ? null : (state?.stage_30_sent_at || null);

    const isStale14 = !lastWorkout || lastWorkout <= cutoff14;
    const isStale30 = !lastWorkout || lastWorkout <= cutoff30;

    let stageToSend = null; // "14" | "30" | null
    if (isStale30 && !stage30Sent) stageToSend = "30";
    else if (isStale14 && !stage14Sent) stageToSend = "14";

    let patch = null;
    if (streakReset) patch = { athlete_id: athleteId, last_workout_at: lastWorkout, stage_14_sent_at: null, stage_30_sent_at: null };

    if (stageToSend) {
      const variants = stageToSend === "30" ? NUDGE_30_VARIANTS : NUDGE_14_VARIANTS;
      const body = variants[Math.floor(Math.random() * variants.length)];
      const payload = pushPayload({ title: "Coach Joe", body, url: "/", type: stageToSend === "30" ? "nudge30" : "nudge14" });
      const { pruned: p } = await sendToAthlete(rows, payload);
      pruned += p;
      // Stamp the stage even if every device failed — retrying a broken endpoint
      // tomorrow just burns the run; the rows self-heal (prune) or the athlete
      // re-subscribes, and this is a once-per-streak touch, not a repeating nudge.
      if (stageToSend === "30") { nudged30++; stage30Sent = new Date().toISOString(); }
      else { nudged14++; stage14Sent = new Date().toISOString(); }
      patch = { athlete_id: athleteId, last_workout_at: lastWorkout, stage_14_sent_at: stage14Sent, stage_30_sent_at: stage30Sent };
    }

    if (patch) {
      try {
        await sbWrite({
          method: "POST", table: "athlete_nudge_state", query: "?on_conflict=athlete_id",
          body: patch, prefer: "resolution=merge-duplicates,return=minimal",
        });
      } catch { /* state stamp is best-effort — worst case we re-evaluate next run */ }
    }
  }

  return res.status(200).json({ checked: athleteIds.length, nudged14, nudged30, pruned });
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
    const key = vapidPublicKey();
    if (!key) return res.status(500).json({ error: "Push not configured" });
    return res.status(200).json({ publicKey: key });
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
    if (caller.role !== "athlete" && caller.role !== "coach") throw httpErr(403, "This account can't manage notifications");
    // Coaches subscribe their own devices to a parallel table (the athlete table's
    // athlete_id is NOT NULL). Same actions, role-routed to the right table/column.
    const isCoachCaller = caller.role === "coach";
    const subTable = isCoachCaller ? "coach_push_subscriptions" : "push_subscriptions";
    const ownCol = isCoachCaller ? "coach_id" : "athlete_id";

    if (body.action === "subscribe") {
      const sub = body.subscription;
      if (!sub || typeof sub !== "object") throw httpErr(400, "subscription is required");
      const endpoint = str(sub.endpoint, { max: 1000, name: "endpoint" });
      if (!/^https:\/\//.test(endpoint)) throw httpErr(400, "endpoint must be an https URL");
      const keys = sub.keys || {};
      const p256dh = str(keys.p256dh, { max: 300, name: "p256dh" });
      const auth = str(keys.auth, { max: 300, name: "auth" });
      await sbWrite({
        method: "POST", table: subTable,
        query: "?on_conflict=endpoint",
        body: {
          [ownCol]: caller.id, endpoint, p256dh, auth,
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
        method: "DELETE", table: subTable,
        query: `?endpoint=eq.${enc(endpoint)}&${ownCol}=eq.${enc(caller.id)}`,
        prefer: "return=minimal",
      });
      return res.status(200).json({ ok: true });
    }

    // "welcome" fires automatically the moment notifications are turned on (client
    // enablePush); "test" is the legacy manual variant. Same payload.
    if (body.action === "test" || body.action === "welcome") {
      ensureVapid();
      const rows = await sbSelect(subTable, `?${ownCol}=eq.${enc(caller.id)}&select=*`);
      if (rows.length === 0) return res.status(200).json({ sent: 0, pruned: 0 });
      const payload = pushPayload({
        title: isCoachCaller ? "WILCO" : "Coach Joe",
        body: isCoachCaller ? "Notifications are on. I'll flag what needs you." : "Notifications are on. I'll keep you posted.",
        url: "/", type: body.action,
      });
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
