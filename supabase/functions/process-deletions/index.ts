// ─── PROCESS DELETIONS EDGE FUNCTION ─────────────────────────────────────────
// Supabase Edge Function — drains the deletion_requests queue, honoring the
// Privacy Policy's 30-day account-deletion right (Privacy Policy §4 / §5).
//
// For every deletion_requests row that is `pending` AND whose
// scheduled_deletion_at has passed, it hard-deletes all data tied to that
// athlete, deletes the athlete row, then marks the request `completed`. A row
// that fails is left `pending` so it retries on the next run.
//
// Deploy:  supabase functions deploy process-deletions
// Invoked daily by Vercel Cron via /api/trigger-process-deletions (see
// vercel.json), mirroring the proof-feed-daily pattern. Can also be scheduled
// directly with pg_cron if preferred.
//
// Required secrets (Supabase Dashboard → Settings → Edge Functions → Secrets):
//   SUPABASE_URL — your project URL
//   SERVICE_KEY  — service role key (full DB access; same secret proof-feed uses)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SERVICE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const sbH = {
  "Content-Type": "application/json",
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
};

const sbGet = async (path: string) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbH });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
};
const sbDelete = async (path: string) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "DELETE", headers: sbH });
  if (!r.ok) throw new Error(`DELETE ${path} → ${r.status} ${await r.text()}`);
};
const sbPatch = async (path: string, body: unknown) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...sbH, "Prefer": "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} → ${r.status} ${await r.text()}`);
};

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const summary = { processed: 0, deleted: 0, failed: 0, skipped_orphan: 0 };

  try {
    const nowIso = new Date().toISOString();
    // Due = pending AND scheduled_deletion_at <= now.
    const due = await sbGet(
      `deletion_requests?status=eq.pending&scheduled_deletion_at=lte.${nowIso}&select=id,athlete_id`,
    );

    for (const reqRow of due) {
      summary.processed++;
      const aid = reqRow.athlete_id;

      // Orphan request (athlete already gone) — just close it out.
      if (!aid) {
        try {
          await sbPatch(`deletion_requests?id=eq.${reqRow.id}`, { status: "completed", completed_at: new Date().toISOString() });
          summary.skipped_orphan++;
        } catch (e) {
          console.error(`[process-deletions] orphan close failed for ${reqRow.id}:`, (e as Error).message);
          summary.failed++;
        }
        continue;
      }

      try {
        // 1. Delete all athlete-scoped data.
        for (const tbl of ATHLETE_TABLES) {
          await sbDelete(`${tbl}?athlete_id=eq.${aid}`);
        }
        // 2. Delete the athlete row itself (cascades any remaining FK children).
        await sbDelete(`athletes?id=eq.${aid}`);
        // 3. Mark the request completed. athlete_id is now NULL (ON DELETE SET
        //    NULL) but the request row survives as an audit record.
        await sbPatch(`deletion_requests?id=eq.${reqRow.id}`, { status: "completed", completed_at: new Date().toISOString() });
        summary.deleted++;
      } catch (e) {
        // Leave the row `pending` so it retries next run.
        console.error(`[process-deletions] deletion failed for athlete ${aid} (request ${reqRow.id}):`, (e as Error).message);
        summary.failed++;
      }
    }

    console.log("[process-deletions] done —", JSON.stringify(summary));
    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[process-deletions] fatal:", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message, summary }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
