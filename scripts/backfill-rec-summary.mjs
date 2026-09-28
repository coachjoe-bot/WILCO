// ─── BACKFILL: rec.summary for pre-T64 program_drafts rows ───────────────────
// T64 Fix 3b split one field ("why") that was doing two jobs into two: `summary`
// (short, factual, athlete-facing — new) and `why` (the model's own reasoning,
// internal only, unchanged). Every real rec on prod today has `why` but no
// `summary`. The render already falls back gracefully (recSummaryFallback:
// summary, else names pulled from the swaps, else title — see src/recs.js), so
// this backfill is a quality pass, not a correctness requirement: it makes old
// cards read as well as new ones instead of leaning on the generic fallback.
//
// DRY RUN BY DEFAULT — prints every before/after and writes NOTHING. This
// session does not run it against prod (see the T64-S3 handoff); the
// integrator runs it with --apply when ready.
//
//   node --env-file=.env scripts/backfill-rec-summary.mjs            (dry run)
//   node --env-file=.env scripts/backfill-rec-summary.mjs --apply    (writes)
//   node --env-file=.env scripts/backfill-rec-summary.mjs --apply --limit=5
//
// Summary source: tries a cheap Haiku call (same shape as programHistory.js's
// SUMMARY_SYS one-liner) when ANTHROPIC_KEY is available in this environment;
// local dev has no Anthropic key (project convention — see memory
// project-wilco-build-and-preview-traps.md), so it falls back to
// recSummaryFallback's code-derived line (built from the swap exercise names,
// the same funnel the render itself uses for a row with no summary at all).
// Either way the result is validated through validateRecPayload's own
// summary cap before being written, so a backfilled row can never violate the
// 12-word contract new rows are held to.
import { sbSelect, sbWrite, askClaudeServer } from "../api/_supa.js";
import { recSummaryFallback, validateRecPayload } from "../src/recs.js";

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

const SUMMARY_BACKFILL_SYS =
  "You write ONE short, factual, second-person-free line for an athlete's program-change card, 12 " +
  "words or fewer, hard limit. State WHAT changed - no reasoning, no naming the athlete (\"Will " +
  "wants...\"). You are given a title, the drafter's internal reasoning, and the swaps that were made; " +
  "use them only to describe the change itself. Plain text, no quotes, no preamble.";

async function generateSummary(rec) {
  const hasKey = !!(process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);
  if (hasKey) {
    try {
      const user = `TITLE: ${rec.title || ""}\nREASONING (internal, do not repeat verbatim): ${rec.why || ""}\nSWAPS:\n${
        (rec.swaps || []).map((s) => `- was: ${s.find}\n  now: ${s.replace}`).join("\n")
      }`;
      const line = await askClaudeServer({ system: SUMMARY_BACKFILL_SYS, user, maxTokens: 60, model: "claude-haiku-4-5", feature: "program_summary" });
      const trimmed = (line || "").trim();
      if (trimmed) return { text: trimmed, source: "ai" };
    } catch (e) {
      console.error(`  (Haiku call failed, falling back to code-derived: ${e?.message || e})`);
    }
  }
  return { text: recSummaryFallback(rec), source: "code-fallback" };
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}${Number.isFinite(LIMIT) ? `, limit ${LIMIT}` : ""}`);
  const rows = await sbSelect(
    "program_drafts",
    `?status=in.(rec,rec_applied)&blueprint->rec->>why=not.is.null&order=updated_at.desc&select=id,title,blueprint`
  );
  const candidates = (rows || []).filter((r) => r?.blueprint?.rec && !String(r.blueprint.rec.summary || "").trim());
  console.log(`Found ${candidates.length} rec row(s) with "why" but no "summary".`);

  let done = 0;
  for (const row of candidates.slice(0, LIMIT)) {
    const rec = row.blueprint.rec;
    const { text, source } = await generateSummary(rec);
    const validated = validateRecPayload({ ...rec, summary: text });
    const summary = validated.ok ? validated.rec.summary : "";
    console.log(`\n[${row.id}] "${row.title || rec.title || ""}" (${source})`);
    console.log(`  why:     ${String(rec.why || "").slice(0, 140)}`);
    console.log(`  summary: ${summary || "(none generated)"}`);
    if (!summary) continue;
    if (APPLY) {
      await sbWrite({
        method: "PATCH",
        table: "program_drafts",
        query: `?id=eq.${row.id}`,
        body: { blueprint: { ...row.blueprint, rec: { ...rec, summary } }, updated_at: new Date().toISOString() },
        prefer: "return=minimal",
      });
      done++;
    }
  }
  console.log(`\n${APPLY ? `Wrote ${done} row(s).` : `Dry run only — would have written up to ${candidates.length} row(s). Re-run with --apply to write.`}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
