// ─── T70 STATS — nightly rebuild of athlete_stats ────────────────────────────
// GET Authorization: Bearer <CRON_SECRET> [?force=1] -> rebuild summary.
// Recomputes every athlete whose summary row is missing, on an older shape
// version, or behind the workouts table (see api/_stats.js rebuildStale). The
// request-path refresh in api/data.js keeps rows current write by write; this is
// the backstop for anything that bypassed it (a direct SQL fix, a failed
// background refresh, a shape bump). Same CRON_SECRET gate as the other crons.

import { rebuildStale } from "./_stats.js";

export const maxDuration = 300;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: "Missing CRON_SECRET" });
  if (req.headers["authorization"] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Not authorized" });
  }
  try {
    const force = String(req.query?.force || "") === "1";
    const summary = await rebuildStale({ budgetMs: 240000, force });
    return res.status(200).json(summary);
  } catch (e) {
    console.error("[stats-rebuild] failed:", e.message);
    return res.status(500).json({ error: "Rebuild failed" });
  }
}
