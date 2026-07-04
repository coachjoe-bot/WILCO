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
// GET Authorization: Bearer <CRON_SECRET> -> { checked, notified, pruned }
//
// Env: CRON_SECRET, VAPID_*, SUPABASE_URL + SUPABASE_SERVICE_KEY (via ./_supa.js).

import { sbSelect, sbWrite, logError } from "./_supa.js";
import { ensureVapid, sendToAthlete, pushPayload } from "./_push.js";

const enc = encodeURIComponent;
const DEBOUNCE_MS = 15 * 60 * 1000;

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
    let notified = 0, pruned = 0;

    for (const [athleteId, rows] of Object.entries(byAthlete)) {
      const newest = rows.reduce((a, b) => (new Date(b.changed_at) > new Date(a.changed_at) ? b : a));
      const age = now - new Date(newest.changed_at).getTime();
      if (age < DEBOUNCE_MS) continue; // still inside the debounce window — a coach may still be editing

      const ids = rows.map((r) => `"${r.id}"`).join(",");
      try {
        const subs = await sbSelect("push_subscriptions", `?athlete_id=eq.${enc(athleteId)}&select=*`);
        if (subs.length) {
          ensureVapid();
          const payload = pushPayload({ title: "Program Update", body: "Coach updated your program. Take a look before your next session.", url: "/", type: "program" });
          const { pruned: p } = await sendToAthlete(subs, payload);
          pruned += p;
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

    return res.status(200).json({ checked: Object.keys(byAthlete).length, notified, pruned });
  } catch (e) {
    console.error("[notify-program-changes] run failed:", e);
    logError({
      source: "server", severity: "error", area: "sync", route: "api/notify-program-changes",
      error_type: `http_${e.status || 500}`, message: e.message, status_code: e.status || 500,
    });
    return res.status(e.status || 500).json({ error: e.message || "Server error" });
  }
}
