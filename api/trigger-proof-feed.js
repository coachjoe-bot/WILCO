// Vercel serverless function — triggers the Supabase "proof-feed-daily" edge function.
// Triggered by Vercel Cron once a day (see vercel.json), or manually via GET.
//
// WHY THIS FILE EXISTS:
// The proof-feed-daily edge function was deployed to Supabase but nothing was ever
// scheduled to call it (no pg_cron job, no other trigger) — so proof_digests stayed
// empty forever and the Proof tab in the app had nothing to show. This route closes
// that gap using the same Vercel Cron pattern already used by send-weekly-report.js.

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["authorization"] !== `Bearer ${cronSecret}` && req.headers["x-vercel-cron"] !== "1") {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  // Must be the SERVICE ROLE key (not the anon key) — the edge function writes
  // proof_digests rows for every athlete, which requires bypassing RLS-less anon scoping
  // and reading across all athletes regardless of who's "logged in".
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  console.log("[trigger-proof-feed] triggered —", new Date().toISOString());
  console.log("[trigger-proof-feed] env check — SUPABASE_URL:", !!SUPABASE_URL, "| SERVICE_KEY:", !!SERVICE_KEY);

  if (!SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
  if (!SERVICE_KEY)  return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY — add this in Vercel → Settings → Environment Variables (Project Settings → API → service_role key in Supabase)" });

  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/proof-feed-daily`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "apikey": SERVICE_KEY,
      },
      body: "{}",
    });
    const data = await r.json();
    console.log("[trigger-proof-feed] edge function result:", JSON.stringify(data));
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("[trigger-proof-feed] failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
