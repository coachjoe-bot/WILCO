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

// Analytics ledgers carry athlete_id/actor_id but have NO foreign key to athletes,
// so nothing cleans them on delete — they'd keep the personal linkage forever. We
// don't hard-delete them (that would erase a churned athlete's cost/usage from the
// aggregate business metrics); instead we ANONYMIZE — null the identifiers so the
// row survives as an unattributed usage count. Honors the deletion promise (no
// personal linkage remains) without wrecking the rollups.
const ANON_TABLES = ["usage_costs", "error_events", "usage_events"];

async function anonymizeAnalytics(aid) {
  for (const tbl of ANON_TABLES) {
    // Rows scoped to this athlete → drop the athlete link.
    await sbWrite({
      method: "PATCH", table: tbl, query: `?athlete_id=eq.${enc(aid)}`,
      body: { athlete_id: null }, prefer: "return=minimal",
    });
    // Rows the athlete themselves initiated (actor_id == their id) → drop the actor
    // link too. Scoped to actor_id=aid so a COACH acting on this athlete keeps theirs.
    await sbWrite({
      method: "PATCH", table: tbl, query: `?actor_id=eq.${enc(aid)}`,
      body: { actor_id: null }, prefer: "return=minimal",
    });
  }
}

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
      // 1b. Anonymize the FK-less analytics ledgers (keep the counts, drop the link).
      await anonymizeAnalytics(aid);
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

  // ── rate_limits janitor (piggybacks on this daily cron) ─────────────────────
  // rateLimit()/authThrottle() in api/_supa.js insert a rate_limits row on every
  // AI proxy call, telemetry batch, and login attempt, but nothing ever deleted
  // old rows (only per-key resets on successful login), so the table grew
  // forever — and every windowed rate-limit check scans it in the hot path of
  // every AI call. All windows in use are 15-60 minutes; 25h keeps a full day of
  // slack beyond the longest window, so sweeping older rows can never change a
  // rate-limit decision. Best-effort: a failed sweep never blocks the deletion
  // queue and simply retries tomorrow.
  try {
    const cutoff = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await sbDelete("rate_limits", `?created_at=lt.${enc(cutoff)}`);
    summary.rate_limits_swept = true;
  } catch (e) {
    console.error("[process-deletions] rate_limits sweep failed:", e.message);
    summary.rate_limits_swept = false;
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
