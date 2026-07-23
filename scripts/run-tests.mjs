// ─── RUN EVERY NODE REGRESSION SUITE ─────────────────────────────────────────
// One command for the merge discipline: `npm test`. Runs the api-config check and
// every scripts/test-*.mjs suite, prints a summary, and exits non-zero if any
// failed — so "suites green" is a single verifiable step, not seven remembered
// ones. New suites are picked up automatically by the glob.
//
// Suites that need credentials (e.g. test-log-correction.mjs, which takes an
// athlete uuid + PIN) are skipped by name — they are manual tools, not CI checks.
//
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const NEEDS_CREDENTIALS = new Set(["test-log-correction.mjs", "test-event-trial.mjs"]);

const suites = readdirSync(here)
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs") && !NEEDS_CREDENTIALS.has(f))
  .sort();

const run = (label, file) => {
  const r = spawnSync(process.execPath, [join(here, file)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const ok = r.status === 0;
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) console.log(out.split("\n").filter((l) => l.includes("✗") || /FAIL/i.test(l)).map((l) => `    ${l}`).join("\n") || `    exit ${r.status}`);
  return ok;
};

console.log("── api config ──");
const cfg = spawnSync(process.execPath, [join(here, "check-api-config.mjs")], { encoding: "utf8" });
console.log(`${cfg.status === 0 ? "✓" : "✗"} check-api-config`);

console.log("\n── regression suites ──");
const failed = suites.filter((f) => !run(f.replace(/^test-|\.mjs$/g, ""), f));

const total = suites.length + 1;
const bad = failed.length + (cfg.status === 0 ? 0 : 1);
console.log(`\n${bad === 0 ? `All ${total} checks green.` : `${bad} of ${total} FAILED: ${failed.join(", ")}`}`);
process.exit(bad === 0 ? 0 : 1);
