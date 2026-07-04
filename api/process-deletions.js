// ─── ACCOUNT DELETION PROCESSOR (Vercel) ─────────────────────────────────────
// Drains the deletion_requests queue, honoring the Privacy Policy's 30-day
// account-deletion right (Privacy Policy §4 / §5).
//
// For every deletion_requests row that is `pending` AND whose
// scheduled_deletion_at has passed, it hard-deletes all data tied to that
// athlete, deletes the athlete row, then marks the request `completed`. A row
// that fails is left `pending` so it retries on the next run.
//
// HISTORY: this used to run as a Supabase Edge Function (supabase/functions/
// process-deletions), invoked by a fetch from api/trigger-proof-feed.js's cron
// path (both jobs shared one Vercel route because of the old Hobby 12-function
// cap). That edge function was never actually deployed (`supabase functions
// deploy process-deletions` was a manual step that didn't happen), so every
// cron run's deletion leg silently 404'd and did nothing — the queue was never
// draining. This route replaces it: same logic, moved verbatim, now a real
// Vercel cron with its own schedule (see vercel.json), reusing the same
// SUPABASE_SERVICE_KEY + REST helpers every other api/*.js function uses.
//
// GET Authorization: Bearer <CRON_SECRET> -> { processed, deleted, failed, skipped_orphan }
// (same gate as api/trigger-proof-feed.js / api/push.js — the CRON_SECRET
// bearer Vercel injects into cron invocations, never the forgeable x-vercel-cron).
//
// Env: CRON_SECRET, SUPABASE_URL + SUPABASE_SERVICE_KEY (via ./_supa.js).

import { sbSelect, sbDelete, sbWrite, logError } from "./_supa.js";

const enc = encodeURIComponent;

// Every table that holds athlete-scoped data. Tables with an ON DELETE CASCADE FK
// to athletes(id) would be cleaned by the athletes delete anyway, but we delete
// them explicitly so the function is correct even if a prod FK is missing. Order
// doesn't matter — all are keyed by athlete_id and deleted before the parent row.
const ATHLETE_TABLES = [
  "prs",
  "workouts",
  "athlete_goals",
  "manual_one_rms",
  "program_modifications",
  "proof_digests",
  "athlete_context",
  "push_subscriptions",
  "legal_acceptances",
];

async function runDeletions() {
  const summary = { processed: 0, deleted: 0, failed: 0, skipped_orphan: 0 };

  const nowIso = new Date().toISOString();
  // Due = pending AND scheduled_deletion_at <= now.
  const due = await sbSelect(
    "deletion_requests",
    `?status=eq.pending&scheduled_deletion_at=lte.${enc(nowIso)}&select=id,athlete_id`
  );

  for (const reqRow of due) {
    summary.processed++;
    const aid = reqRow.athlete_id;

    // Orphan request (athlete already gone) — just close it out.
    if (!aid) {
      try {
        await sbWrite({
          method: "PATCH", table: "deletion_requests", query: `?id=eq.${enc(reqRow.id)}`,
          body: { status: "completed", completed_at: new Date().toISOString() },
          prefer: "return=minimal",
        });
        summary.skipped_orphan++;
      } catch (e) {
        console.error(`[process-deletions] orphan close failed for ${reqRow.id}:`, e.message);
        summary.failed++;
      }
      continue;
    }

    try {
      // 1. Delete all athlete-scoped data.
      for (const tbl of ATHLETE_TABLES) {
        await sbDelete(tbl, `?athlete_id=eq.${enc(aid)}`);
      }
      // 2. Delete the athlete row itself (cascades any remaining FK children).
      await sbDelete("athletes", `?id=eq.${enc(aid)}`);
      // 3. Mark the request completed. athlete_id is now NULL (ON DELETE SET
      //    NULL) but the request row survives as an audit record.
      await sbWrite({
        method: "PATCH", table: "deletion_requests", query: `?id=eq.${enc(reqRow.id)}`,
        body: { status: "completed", completed_at: new Date().toISOString() },
        prefer: "return=minimal",
      });
      summary.deleted++;
    } catch (e) {
      // Leave the row `pending` so it retries next run.
      console.error(`[process-deletions] deletion failed for athlete ${aid} (request ${reqRow.id}):`, e.message);
      summary.failed++;
    }
  }

  console.log("[process-deletions] done —", JSON.stringify(summary));
  return summary;
}

// Fast, DB-only writes; the daily queue is small. A small budget is plenty, but
// give it real room in case the queue backs up (each deletion is ~10 sequential
// REST calls).
export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // Cron-only: gated SOLELY by the CRON_SECRET bearer Vercel injects (same gate
  // as api/trigger-proof-feed.js and api/push.js — never the forgeable
  // x-vercel-cron header, and never a "secret unset → open" fail-open).
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: "Missing CRON_SECRET" });
  if (req.headers["authorization"] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Not authorized" });
  }

  try {
    const summary = await runDeletions();
    return res.status(200).json(summary);
  } catch (e) {
    console.error("[process-deletions] fatal:", e);
    logError({
      source: "server", severity: "error", area: "other", route: "api/process-deletions",
      error_type: `http_${e.status || 500}`, message: e.message, status_code: e.status || 500,
    });
    return res.status(500).json({ error: e.message });
  }
}
