// ─── COACH PROGRAM-UPDATE NOTIFICATIONS (debounced) ───────────────────────────
// One of the four notification types in policy v2 (see api/push.js header for the
// full list). When a COACH edits an athlete's program_text/temp_program_text
// (api/data.js inserts a row into program_change_events at that exact write —
// never for the athlete's own edits or Joe/AI-driven programming changes), this
// cron runs every 15 minutes and, for each athlete with pending (notified=false)
// rows whose NEWEST row is >= 15 minutes old, sends ONE push and marks every
// pending row for that athlete notified. A burst of quick coach edits (bulk
// assign to 20 athletes, or a coach tweaking one athlete's program several times
// in a few minutes) collapses into a single notification per athlete, not one
// per edit.
//
// Why "newest row >= 15 min old" (not "oldest"): a coach still actively editing
// keeps pushing the debounce window forward, so the notification fires once
// they've actually stopped — not mid-edit.
//
// Push is the preferred channel; an athlete push can't reach gets ONE email
// instead (see the EMAIL FALLBACK block below).
//
// GET Authorization: Bearer <CRON_SECRET> -> { checked, notified, pruned, emailed }
//
// Env: CRON_SECRET, VAPID_*, SUPABASE_URL + SUPABASE_SERVICE_KEY (via ./_supa.js),
//      RESEND_API_KEY + FROM_EMAIL + APP_URL (email fallback).

import { sbSelect, sbWrite, logError } from "./_supa.js";
import { ensureVapid, sendToAthlete, pushPayload } from "./_push.js";

const enc = encodeURIComponent;
const DEBOUNCE_MS = 15 * 60 * 1000;

// ── EMAIL FALLBACK ───────────────────────────────────────────────────────────
// This notice used to go out over web push ALONE: if the athlete had no
// subscription the event was still marked notified and the information was simply
// dropped. Push opt-in on an iOS PWA is the minority case, so most athletes never
// learned their coach had changed their program until they happened to open the
// app — which is the one thing a coach edit is supposed to be able to reach them
// about. Same once-per-debounce-window cap; nothing sends twice.
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "WILCO <noreply@trainwilco.com>";
const APP_URL = process.env.APP_URL || "https://app.trainwilco.com";

const programEmail = (name) => `<!doctype html><html><body style="margin:0;background:#04070f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
  <div style="color:#3a7bff;font-size:13px;letter-spacing:3px;font-weight:700">WILCO</div>
  <div style="color:#eef3fb;font-size:22px;font-weight:700;margin:18px 0 10px">Your coach updated your program</div>
  <div style="color:#9fb0cc;font-size:15px;line-height:1.65">
    ${name ? name + ", y" : "Y"}our coach made changes to your training program. Open WILCO and read it before your next session so you're not training off the old one.
  </div>
  <a href="${APP_URL}" style="display:inline-block;margin-top:22px;background:#3a7bff;color:#02040c;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:10px">Open my program</a>
  <div style="color:#5d6b85;font-size:12px;line-height:1.6;margin-top:28px">You're getting this because your coach edits your program in WILCO. Turn on notifications in the app to get these instantly instead.</div>
</div></body></html>`;

async function sendProgramEmail(to, name) {
  if (!RESEND_KEY || !to) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject: "Your coach updated your program", html: programEmail(name) }),
    });
    return r.ok;
  } catch (e) {
    console.error("[notify-program-changes] email failed:", e.message);
    return false;
  }
}

export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: "Missing CRON_SECRET" });
  if (req.headers["authorization"] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Not authorized" });
  }

  try {
    const pending = await sbSelect("program_change_events", "?notified=eq.false&select=*&order=changed_at.asc");
    if (pending.length === 0) return res.status(200).json({ checked: 0, notified: 0, pruned: 0 });

    const byAthlete = {};
    for (const row of pending) (byAthlete[row.athlete_id] = byAthlete[row.athlete_id] || []).push(row);

    const now = Date.now();
    let notified = 0, pruned = 0, emailed = 0;

    for (const [athleteId, rows] of Object.entries(byAthlete)) {
      const newest = rows.reduce((a, b) => (new Date(b.changed_at) > new Date(a.changed_at) ? b : a));
      const age = now - new Date(newest.changed_at).getTime();
      if (age < DEBOUNCE_MS) continue; // still inside the debounce window — a coach may still be editing

      const ids = rows.map((r) => `"${r.id}"`).join(",");
      try {
        const subs = await sbSelect("push_subscriptions", `?athlete_id=eq.${enc(athleteId)}&select=*`);
        // sendToAthlete.sentAny is what decides whether the email fallback fires —
        // not subs.length. An athlete whose only subscription is a dead endpoint
        // (phone wiped, permission revoked) has a row but is unreachable by push,
        // and a bare length check would call that "notified" and drop the message.
        let delivered = false;
        if (subs.length) {
          ensureVapid();
          const payload = pushPayload({ title: "Program Update", body: "Coach updated your program. Take a look before your next session.", url: "/", type: "program" });
          const r = await sendToAthlete(subs, payload);
          pruned += r.pruned || 0;
          delivered = !!r.sentAny;
        }
        if (!delivered) {
          const a = (await sbSelect("athletes", `?id=eq.${enc(athleteId)}&select=name,email`))[0];
          if (a?.email && await sendProgramEmail(a.email, a.name)) emailed++;
        }
        notified++;
      } catch (e) {
        console.error(`[notify-program-changes] send failed for athlete ${athleteId}:`, e.message);
      }

      // Mark ALL pending rows for this athlete notified, whether or not the send
      // itself succeeded — a permanently-broken subscription shouldn't leave the
      // queue growing forever; api/push.js's dead-endpoint pruning is the retry
      // mechanism for that, not re-attempting this debounce indefinitely.
      try {
        await sbWrite({
          method: "PATCH", table: "program_change_events",
          query: `?id=in.(${ids})`, prefer: "return=minimal",
          body: { notified: true },
        });
      } catch (e) { console.error(`[notify-program-changes] mark-notified failed for athlete ${athleteId}:`, e.message); }
    }

    return res.status(200).json({ checked: Object.keys(byAthlete).length, notified, pruned, emailed });
  } catch (e) {
    console.error("[notify-program-changes] run failed:", e);
    logError({
      source: "server", severity: "error", area: "sync", route: "api/notify-program-changes",
      error_type: `http_${e.status || 500}`, message: e.message, status_code: e.status || 500,
    });
    return res.status(e.status || 500).json({ error: e.message || "Server error" });
  }
}
