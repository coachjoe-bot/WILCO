#!/usr/bin/env node
// ─── Guard: every routed Vercel function declares an explicit maxDuration ──────
// On the Vercel Pro upgrade the old implicit 10s Hobby wall is gone. Declaring a
// maxDuration on each routed function (api/*.js, excluding `_`-prefixed helpers,
// which Vercel doesn't route) keeps long AI/vision/Stripe/email calls from being
// killed mid-flight and makes each function's time budget explicit + reviewable.
// This runs on `npm run build` (prebuild), on every Vercel build (vercel.json
// buildCommand runs it explicitly — that command bypasses npm run build, so the
// prebuild hook alone would never fire in production), and standalone: npm run check:api
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(root, "api");
const files = readdirSync(apiDir)
  .filter((f) => f.endsWith(".js") && !f.startsWith("_"))
  .sort();

// Two ceilings, because the two kinds of routed function have different risk.
// A USER-FACING route holding a request open for minutes is a bug, so it keeps
// the tight cap. A CRON function has no waiting human — it fans out or sweeps a
// roster — and Vercel Pro/Enterprise allow up to 800s GA on fluid compute (Hobby
// still caps at 300s). See https://vercel.com/docs/functions/configuring-functions/duration.
// The cron set is READ FROM vercel.json rather than hardcoded, so adding a cron
// entry moves that function to the higher cap automatically and dropping one
// pulls it back down.
const MIN = 5;
const ROUTE_MAX = 300;
const CRON_MAX = 800; // Vercel Pro GA ceiling (the 1800s tier is still beta)

const crons = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")).crons || [];
const cronFiles = new Set(crons.map((c) => `${c.path.replace(/^\/api\//, "")}.js`));

let failed = 0;

// A cron pointing at a function that doesn't exist fails silently in production
// (Vercel just 404s the scheduled hit), so check it here while we have the list.
for (const f of cronFiles) {
  if (!files.includes(f)) {
    console.error(`  ✗ vercel.json cron targets /api/${f.replace(/\.js$/, "")}, but api/${f} does not exist`);
    failed++;
  }
}

for (const f of files) {
  const src = readFileSync(join(apiDir, f), "utf8");
  const m = src.match(/export\s+const\s+maxDuration\s*=\s*(\d+)/);
  if (!m) {
    console.error(`  ✗ ${f}: missing "export const maxDuration"`);
    failed++;
    continue;
  }
  const isCron = cronFiles.has(f);
  const max = isCron ? CRON_MAX : ROUTE_MAX;
  const n = Number(m[1]);
  if (n < MIN || n > max) {
    const kind = isCron ? "cron" : "user-facing route";
    console.error(`  ✗ ${f}: maxDuration ${n}s outside sane range [${MIN}, ${max}] for a ${kind}`);
    failed++;
    continue;
  }
  console.log(`  ✓ ${f}: maxDuration ${n}s${isCron ? " (cron)" : ""}`);
}

if (failed) {
  console.error(`\n${failed} routed function(s) failed the config guard.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} routed functions declare a valid maxDuration.`);
