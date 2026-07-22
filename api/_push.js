// ─── WEB PUSH — shared send helper ────────────────────────────────────────────
// Extracted from api/push.js (v1) so every push-sending caller (the subscribe/test
// endpoint, the inactivity-nudge cron, the Proof Feed engine, and the coach
// programming-update cron) shares ONE implementation of "send to a subscription,
// prune dead endpoints, never throw." Underscore-prefixed — Vercel does not route
// this as its own function.
//
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.

import webpush from "web-push";
import { httpErr, sbDelete } from "./_supa.js";

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
// the newer one is visible). Each of the four notification types gets its own
// tag so, e.g., a feed-live push can never silently swallow a still-unread
// coach-update push. Explicit map (not a free-form string) keeps the four types
// the only ones that exist, per notification policy v2.
const TAGS = {
  feed: "wilco-feed",
  nudge14: "wilco-nudge-14",
  nudge30: "wilco-nudge-30",
  program: "wilco-program",
  test: "wilco-test",
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
