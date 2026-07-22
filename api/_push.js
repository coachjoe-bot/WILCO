// ─── WEB PUSH — shared send helper ────────────────────────────────────────────
// Extracted from api/push.js (v1) so every push-sending caller (the subscribe/test
// endpoint, the inactivity-nudge cron, the Proof Feed engine, and the coach
// programming-update cron) shares ONE implementation of "send to a subscription,
// prune dead endpoints, never throw." Underscore-prefixed — Vercel does not route
// this as its own function.
//
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.

import webpush from "web-push";
import { httpErr, sbDelete, sbSelect } from "./_supa.js";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:coachwill@trainwilco.com";

let vapidReady = false;
export function ensureVapid() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw httpErr(500, "Push not configured");
  if (!vapidReady) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidReady = true;
  }
}

export function vapidPublicKey() {
  return VAPID_PUBLIC_KEY;
}

// Every push payload gets the same WILCO icon/badge so notifications look
// consistent across the four allowed types + test — "branding" is the icon,
// the title convention, and copy quality; the OS controls everything else about
// how the bubble renders.
const ICON = "/icon-192.png";

// tag scopes which OS notification slot a push lands in — two pushes with the
// SAME tag replace each other in the tray (renotify:true still buzzes, but only
// the newer one is visible). Each notification type gets its own tag so, e.g.,
// a feed-live push can never silently swallow a still-unread coach-update push.
// Explicit map (not a free-form string) keeps these the only types that exist.
// Policy v2.1 (Will sign-off 2026-07-22): the three coach alert types (injury,
// big PR, athlete-gone-quiet) join the original four athlete types + the coach
// digest — they back the Settings toggles that previously controlled nothing.
const TAGS = {
  feed: "wilco-feed",
  nudge14: "wilco-nudge-14",
  nudge30: "wilco-nudge-30",
  program: "wilco-program",
  test: "wilco-test",
  coach_digest: "wilco-coach-digest",
  coach_injury: "wilco-coach-injury",
  coach_pr: "wilco-coach-pr",
  coach_quiet: "wilco-coach-quiet",
};

// Build a standard payload. `title` varies by type (branding convention: "Coach
// Joe" for Joe-voice pushes — feed/nudges/test — vs "Program Update" for the
// coach-authored one, so an athlete can tell at a glance who's talking); `type`
// selects the tag from TAGS above (falls back to the generic proof-feed tag if
// omitted, matching the pre-v2 payload shape).
export function pushPayload({ title, body, url = "/", type }) {
  return { title, body, url, icon: ICON, badge: ICON, tag: TAGS[type] || "wilco-proof-feed" };
}

// Send one push to one subscription row. Returns "sent", "pruned", or "failed".
// 404/410 from the push service mean the subscription is dead — delete the row.
// Any other failure is logged and swallowed so one bad device can't break a batch.
// `table` is where the row came from: athlete devices live in push_subscriptions
// (the default), coach devices in coach_push_subscriptions — the prune must
// target the row's OWN table (it used to hard-code the athlete table, so dead
// coach endpoints were never actually deleted and got retried forever).
export async function sendTo(sub, payload, table = "push_subscriptions") {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return "sent";
  } catch (e) {
    const code = e && e.statusCode;
    if (code === 404 || code === 410) {
      try { await sbDelete(table, `?id=eq.${encodeURIComponent(sub.id)}`); } catch { /* prune is best-effort */ }
      return "pruned";
    }
    console.error(`[push] send failed (${code || "network"}) for sub ${sub.id}:`, e?.message);
    return "failed";
  }
}

// ── Coach alert fanout (policy v2.1, Will-approved 2026-07-22) ────────────────
// Send one payload to every device of ONE coach, gated on that coach's own
// notification_prefs[prefKey] (undefined counts as enabled — matching the
// Settings toggle's `!==false` rendering and the digest gate in the proof cron).
// Reads the coach row + subscriptions itself. Best-effort: never throws, so a
// failed alert can never break the athlete write or cron run that triggered it.
export async function notifyCoach(coachId, prefKey, msg) {
  if (!coachId) return { sent: 0 };
  try {
    ensureVapid();
    const enc = encodeURIComponent;
    const coach = (await sbSelect("coaches", `?id=eq.${enc(coachId)}&select=id,notification_prefs`))[0];
    if (!coach || (coach.notification_prefs || {})[prefKey] === false) return { sent: 0 };
    const subs = await sbSelect("coach_push_subscriptions", `?coach_id=eq.${enc(coachId)}&select=*`);
    if (!subs.length) return { sent: 0 };
    const payload = pushPayload(msg);
    let sent = 0;
    for (const s of subs) {
      if ((await sendTo(s, payload, "coach_push_subscriptions")) === "sent") sent++;
    }
    return { sent };
  } catch (e) {
    console.error(`[push] coach alert (${prefKey}) failed:`, e?.message);
    return { sent: 0 };
  }
}

// Send one payload to every subscription row for an athlete (all their devices).
// Returns { sentAny, pruned } — sentAny is true if at least one device got it.
export async function sendToAthlete(rows, payload) {
  let sentAny = false;
  let pruned = 0;
  for (const sub of rows || []) {
    const outcome = await sendTo(sub, payload);
    if (outcome === "sent") sentAny = true;
    if (outcome === "pruned") pruned++;
  }
  return { sentAny, pruned };
}
