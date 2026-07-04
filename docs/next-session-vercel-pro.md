# Vercel Pro — remaining work (execute-ready specs)

> Context: after the Pro upgrade (2026-07-04) the safe functionality shipped to `main`
> (explicit `maxDuration` on all 12 fns, upgraded form review, token headroom, guard
> test, server-side session-count view). These three items remain. The first two need a
> **preview-deployment verification cycle** (can't be exercised under `vite dev`, which
> doesn't serve `/api`), so they were held back from the live revenue path deliberately.

---

## 1. Streaming chat (Coach Joe-bot replies stream in) — HIGH value, needs preview verify

**Why held back:** SSE through Vercel→Anthropic and the cost-logging path (usage is
reported in the *final* stream event, not a JSON body) can't be verified under
`vite dev`. Build on a branch → Vercel **preview** deploy → test with a throwaway
athlete → merge. Do NOT ship blind to the live chat.

### Server — `api/claude.js`
- Add a `stream` boolean to the request contract. When `stream === true`:
  - Call Anthropic with `stream: true`.
  - Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
    `Connection: keep-alive`; `res.flushHeaders()`.
  - Pipe `content_block_delta` text events to the client as SSE (`data: {json}\n\n`).
  - **Cost logging:** accumulate `usage` from the `message_start` (input) and
    `message_delta`/`message_stop` (output) events, then call the SAME `logCost(...)`
    the non-streaming path uses (usage_costs must NOT regress — it's load-bearing for
    the app-health report). Log on `message_stop` AND on client-abort (`req.on('close')`).
  - Keep the existing model allowlist, `max_tokens` clamp (now 4000 cap), auth,
    rate-limit, and `feature` labelling — unchanged.
- `stream` is **opt-in**: every existing caller (form review, quick log, parse, goal
  extract) omits it and hits the unchanged JSON path. Only the main chat sets it.
- `maxDuration = 60` already set (long streams fit).

### Client — `src/App.jsx`
- Add `askClaudeStream(system, user, {onDelta, maxTokens, model, feature})` next to
  `askClaude`. Read the response body with a `ReadableStream` reader + `TextDecoder`,
  parse SSE lines, call `onDelta(textChunk)` per delta.
- In the athlete chat `send()`: append an empty assistant message, then
  `askClaudeStream(..., {onDelta: chunk => updateLastAssistant(prev => prev + chunk)})`.
  Scroll-to-bottom on each delta (throttle to animation frame).
- Fallback: if the stream errors/aborts mid-flight, fall back to the current
  non-streaming `askClaude` so a bad stream never leaves a blank reply.
- Only the conversational chat streams; keep form review / quick log / parse on `askClaude`.

### Verification (the reason this is its own session)
1. Branch → `git push` → Vercel preview URL.
2. Create a throwaway athlete via the `create-athlete` action against the preview.
3. Send a chat message; confirm tokens stream in, the final message persists, and a
   `usage_costs` row is written with the right `feature` + tokens (compare to a
   non-streamed call).
4. Test abort mid-stream (navigate away) → cost still logged, no hang.
5. Delete the throwaway athlete (FK: workouts before athlete). Merge to `main`.

---

## 2. Telemetry split — LOW risk, internal hygiene

Move `log-error` + `log-events` out of the auth-critical `api/identity.js` so a bug in
high-volume anon telemetry can't touch login. (They only live there because the old
Hobby 12-fn cap left no slot; Pro removes that.)

- New `api/_telemetry.js` (underscore = shared helper, not a routed fn) holding the
  `logErrorAction` + `logEventsAction` logic (+ the non-canonical-origin drop guard).
  Add `export const maxDuration` to the new routed file (guard test enforces it).
- New `api/telemetry.js` routed fn: `{action:"log-error"|"log-events"}` → delegates to
  `_telemetry.js`.
- `src/App.jsx`: point `reportError` + the engagement flush at `/api/telemetry`.
- **Backwards-compat:** KEEP the two cases in `identity.js` delegating to `_telemetry.js`
  so cached PWA clients still posting to `/api/identity` don't break. Remove them a
  release later once old clients age out.
- Verify: post both actions to the preview `/api/telemetry`; confirm rows land in
  `error_events` / `usage_events`; confirm old `/api/identity` path still works.

---

## 3. Dashboard toggles — Will only (I can't change billing/project settings)

On the `coachjoe-bots-projects` team → project `fortis`:
- **Spend Management / spend cap** — billing backstop (pairs with the still-open
  "confirm Anthropic spend cap" security item). Do this first.
- **Firewall / Attack Challenge Mode / WAF rate rules** on the public endpoints —
  edge abuse protection, complements the DB `rate_limits` + the self-pentest task.
- **Observability + log retention** — Hobby logs are ephemeral; turn on retention to
  make prod debugging real (pairs with `error_events`).
- **Fluid Compute** — better concurrency/cost for the AI functions.
- (Optional) Web Analytics / Speed Insights.

---

## Also see
- `docs/coach-experience-roadmap.md` — the big coach dashboard overhaul (incl. wiring
  the already-shipped `v_athlete_session_counts` view).
- CSP is deliberately kept **Report-Only** (Will's call 2026-07-04) — enforcing it
  risks the Stripe/fonts/Supabase paths; revisit with a watched rollout.
