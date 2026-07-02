// Playwright smoke-test config — the pre-deploy functionality gate.
//
// Runs the app under `vite dev` on a DEDICATED port (5175) so it never collides
// with the interactive preview server (5174). Under vite dev the /api/* Vercel
// functions do NOT exist, so every spec mocks the API layer with route fixtures
// (see tests/smoke/mocks.js) — these tests exercise the CLIENT, not the backend.
//
// Deliberately strict for a gate: chromium only, 1 worker, 0 retries. If a spec
// flakes, fix the spec — don't retry past it.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/smoke",
  timeout: 45_000,            // per test — Stripe.js failure path alone burns ~2.5s per attempt cycle
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5175",
    // The app registers a PWA service worker (public/sw.js). A live SW would
    // handle fetches OUTSIDE Playwright's route interception and silently bypass
    // the API mocks — block it. (mocks.js also stubs register() so the page's
    // unguarded register() call can't produce an unhandled-rejection console error.)
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite --port 5175 --strictPort",
    port: 5175,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: "chromium" }],
});
