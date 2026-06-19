// Vercel serverless function — daily dispatcher for Supabase edge jobs.
// Triggered by Vercel Cron once a day (see vercel.json), or manually via GET.
//
// Fires TWO edge functions, independently (one failing never aborts the other):
//   1. proof-feed-daily  — generates weekly/monthly proof digests.
//   2. process-deletions — drains the 30-day account-deletion queue
//                          (Privacy Policy §4/§5).
//
// WHY BOTH LIVE HERE: the Vercel Hobby plan caps a deployment at 12 Serverless
// Functions and the project is already at that limit, so deletions reuse this
// existing daily cron route rather than adding a 13th function. The two edge
// functions stay fully separate on the Supabase side.

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["authorization"] !== `Bearer ${cronSecret}` && req.headers["x-vercel-cron"] !== "1") {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  // Must be the SERVICE ROLE key (not the anon key) — these edge functions read and
  // write across all athletes, which requires bypassing per-user scoping.
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  console.log("[trigger-daily] triggered —", new Date().toISOString());
  console.log("[trigger-daily] env check — SUPABASE_URL:", !!SUPABASE_URL, "| SERVICE_KEY:", !!SERVICE_KEY);

  if (!SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
  if (!SERVICE_KEY)  return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY — add this in Vercel → Settings → Environment Variables (Project Settings → API → service_role key in Supabase)" });

  const invoke = async (fn) => {
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}`, "apikey": SERVICE_KEY },
        body: "{}",
      });
      let data; try { data = await r.json(); } catch { data = null; }
      console.log(`[trigger-daily] ${fn} →`, r.status, JSON.stringify(data));
      return { fn, status: r.status, ok: r.ok, data };
    } catch (e) {
      console.error(`[trigger-daily] ${fn} failed:`, e.message);
      return { fn, status: 500, ok: false, error: e.message };
    }
  };

  // Run both regardless of each other's outcome.
  const results = await Promise.all([invoke("proof-feed-daily"), invoke("process-deletions")]);
  const allOk = results.every((r) => r.ok);
  return res.status(allOk ? 200 : 207).json({ results });
}
