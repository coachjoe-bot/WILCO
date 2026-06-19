// Vercel serverless function — triggers the Supabase "process-deletions" edge
// function. Triggered by Vercel Cron once a day (see vercel.json), or manually
// via GET. Same pattern as trigger-proof-feed.js.
//
// The edge function drains the deletion_requests queue, hard-deleting accounts
// whose 30-day window has elapsed (Privacy Policy §4/§5).

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["authorization"] !== `Bearer ${cronSecret}` && req.headers["x-vercel-cron"] !== "1") {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  // Must be the SERVICE ROLE key — the edge function deletes across every athlete
  // table and removes the athlete row, which the anon key cannot do.
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  console.log("[trigger-process-deletions] triggered —", new Date().toISOString());
  console.log("[trigger-process-deletions] env check — SUPABASE_URL:", !!SUPABASE_URL, "| SERVICE_KEY:", !!SERVICE_KEY);

  if (!SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
  if (!SERVICE_KEY)  return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY — add this in Vercel → Settings → Environment Variables (Project Settings → API → service_role key in Supabase)" });

  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/process-deletions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "apikey": SERVICE_KEY,
      },
      body: "{}",
    });
    const data = await r.json();
    console.log("[trigger-process-deletions] edge function result:", JSON.stringify(data));
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("[trigger-process-deletions] failed:", e);
    return res.status(500).json({ error: e.message });
  }
}
