#!/usr/bin/env node
// ─── Guard: every routed Vercel function declares an explicit maxDuration ──────
// On the Vercel Pro upgrade the old implicit 10s Hobby wall is gone. Declaring a
// maxDuration on each routed function (api/*.js, excluding `_`-prefixed helpers,
// which Vercel doesn't route) keeps long AI/vision/Stripe/email calls from being
// killed mid-flight and makes each function's time budget explicit + reviewable.
// This runs on `npm run build` (prebuild) and can be run standalone: npm run check:api
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "api");
const files = readdirSync(apiDir)
  .filter((f) => f.endsWith(".js") && !f.startsWith("_"))
  .sort();

let failed = 0;
for (const f of files) {
  const src = readFileSync(join(apiDir, f), "utf8");
  const m = src.match(/export\s+const\s+maxDuration\s*=\s*(\d+)/);
  if (!m) {
    console.error(`  ✗ ${f}: missing "export const maxDuration"`);
    failed++;
    continue;
  }
  const n = Number(m[1]);
  if (n < 5 || n > 300) {
    console.error(`  ✗ ${f}: maxDuration ${n}s outside sane range [5, 300]`);
    failed++;
    continue;
  }
  console.log(`  ✓ ${f}: maxDuration ${n}s`);
}

if (failed) {
  console.error(`\n${failed} routed function(s) failed the config guard.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} routed functions declare a valid maxDuration.`);
