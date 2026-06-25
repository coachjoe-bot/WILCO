# WILCO Analytics — Cost Data Schema (Phase 1)

Contract for anything that reads WILCO's cost data — primarily the **local
business-reporting agent**, and later a coach dashboard. This is the **cost &
usage** side only; **revenue lives in Stripe** (and the marketing scheduled
task), and margin is computed downstream by joining the two.

Migration: `supabase/migrations/20260625_usage_costs.sql`.

## How to read it

Everything is in Supabase Postgres. Read with the **service-role key** (bypasses
RLS — the tables have no anon access). Either PostgREST (`/rest/v1/<view>`) or a
direct SQL connection. The agent should read the **views**, not raw `usage_costs`,
so it gets computed dollar costs.

## Tables

### `usage_costs` — the cost ledger (one row per billable event)
Phase 1 only writes `source='claude'` (one row per AI call). Metadata + token
counts only — **no prompt/response content**.

| column | type | notes |
|---|---|---|
| `id` | bigint | PK |
| `created_at` | timestamptz | when the call happened |
| `source` | text | `claude` now; `email`/etc. later |
| `feature` | text | see feature list below |
| `role` | text | `athlete` \| `coach` |
| `actor_id` | uuid | athletes.id or coaches.id (server-verified) |
| `athlete_id` | uuid | ownership column for scoped reads; null for coach-initiated calls |
| `school_id` | uuid | **snapshot** at call time |
| `coach_id` | uuid | **snapshot** at call time |
| `tier` | text | **snapshot**: `free`\|`pro`\|`elite`\|`school` (athletes only) |
| `model` | text | resolved Anthropic model id |
| `input_tokens` / `output_tokens` | int | |
| `cache_read_tokens` / `cache_write_tokens` | int | 0 until prompt caching is added |
| `latency_ms` | int | Anthropic round-trip time |
| `status` | text | `ok` \| `error_<httpstatus>` |
| `quantity` / `meta` | numeric / jsonb | for non-AI sources (unused in Phase 1) |

**Features:** `workout_parse`, `joebot_chat`, `program_extract`,
`program_generate`, `pr_ack`, `goal_parse`, `video_form_review`, `monthly_recap`,
`other`.

### `ai_pricing` — model → $/MTok (joined by the views)
`model`, `input_per_mtok`, `output_per_mtok`, `cache_read_per_mtok`,
`cache_write_per_mtok`. Update this when Anthropic rates change — costs reprice
automatically, no row rewrites.

## Views (read these)

| view | grain | key fields |
|---|---|---|
| `v_ai_costs` | per call | all ledger columns + `est_cost_usd` |
| `v_ai_cost_by_user` | per athlete | `calls`, `cost_usd`, tokens, `errors`, first/last call |
| `v_ai_cost_by_feature` | per feature | `calls`, `cost_usd`, `avg_cost_per_call`, `avg_latency_ms`, `errors` |
| `v_ai_cost_by_tier` | per tier | `users`, `cost_usd`, `cost_per_user` |
| `v_ai_cost_by_school` | per school | `athletes`, `cost_usd`, `cost_per_athlete` |
| `v_ai_cost_by_model` | per model | tokens + `cost_usd` |
| `v_ai_cost_daily` | per day × feature | `calls`, `cost_usd`, `total_tokens` |

## Joins the agent will want
- **Cost per active user / per workout** → join `v_ai_cost_by_user.athlete_id` to
  `athletes` / `workouts` (activity lives in those existing tables).
- **Margin** → `v_ai_cost_by_user` (cost) + Stripe revenue (external) keyed by
  `athletes.stripe_customer_id`.
- **Segment any cost view** by `tier` / `school_id` / `coach_id` — already on the rows.

## Example queries
```sql
-- Total Claude spend, last 30 days
SELECT SUM(est_cost_usd) FROM v_ai_costs WHERE created_at > now() - interval '30 days';

-- Cost per feature this month
SELECT * FROM v_ai_cost_by_feature ORDER BY cost_usd DESC;

-- Top 20 most expensive users
SELECT * FROM v_ai_cost_by_user ORDER BY cost_usd DESC LIMIT 20;

-- Daily spend trend
SELECT day, SUM(cost_usd) FROM v_ai_cost_daily GROUP BY day ORDER BY day DESC LIMIT 30;
```

---

# WILCO Reliability — Error Data Schema (Phase 1.5)

Contract for reading WILCO's **error / "technical difficulties"** data — the
reliability counterpart to the cost ledger above. Same read model: Supabase
Postgres, **service-role key** (RLS denies anon all access), read the **views**.

Migration: `supabase/migrations/20260625_error_events.sql`.

## `error_events` — the reliability ledger (one row per captured failure)
Captures client JS crashes, unhandled promise rejections, the client being unable
to reach our server, and unexpected **server 5xx** in `api/*`. **Metadata only** —
the `message` is sanitized + truncated server-side; no PINs/tokens/emails/content.

**Not in here (by design):** AI/Claude HTTP errors — those live in
`usage_costs.status` (Phase 1). The only AI-adjacent row here is
`area='ai', error_type='network'` = "the client couldn't reach our server at all"
(which produces no `usage_costs` row). So the two tables never double-count.

| column | type | notes |
|---|---|---|
| `id` | bigint | PK |
| `created_at` | timestamptz | when observed |
| `source` | text | `client` (browser) \| `server` (api/*) |
| `severity` | text | `info` \| `warn` \| `error` \| `fatal` |
| `area` | text | coarse area: `auth`,`workout_log`,`coach_dashboard`,`billing`,`ai`,`sync`,`nav`,`data`,`other` |
| `route` | text | client screen or api path, **query string stripped** |
| `component` | text | finer locus (component/function), optional |
| `error_type` | text | `TypeError`,`NetworkError`,`network`,`http_502`,`unhandledrejection`,… |
| `message` | text | **sanitized + truncated** (~500 chars) |
| `status_code` | int | HTTP status when applicable |
| `role` | text | `athlete` \| `coach` \| `anon` (pre-login / auth-broken) |
| `actor_id` | uuid | athletes.id / coaches.id (server-verified; null when anon) |
| `athlete_id` | uuid | ownership column for scoped reads; null for coach/anon |
| `school_id` / `coach_id` / `tier` | uuid / uuid / text | **snapshot** at write time (null when anon) |
| `app_version` | text | client build id |
| `user_agent` | text | read server-side, truncated |
| `fingerprint` | text | stable hash(area\|type\|message-prefix) for grouping duplicates |
| `meta` | jsonb | small sanitized extras (e.g. top stack frame), size-capped |

## Views (read these)

| view | grain | key fields |
|---|---|---|
| `v_errors` | per event | all columns + UTC `day` |
| `v_errors_by_area` | per area | `events`, severity split, `athletes_affected`, first/last seen |
| `v_errors_daily` | per day × severity | `events`, `athletes_affected` — the trend line |
| `v_errors_by_fingerprint` | per distinct issue | `events`, `athletes_affected`, `worst_severity`, sample message — **triage view** |
| `v_errors_by_school` | per school | `events`, `hard_errors`, `athletes_affected` (dashboard scope) |
| `v_ai_reliability_daily` | per day | `ai_calls`, `client_unreachable`, `unreachable_rate` (joins `usage_costs`) |

## Error COUNTS now, true RATES later
These views are **counts + trends**, which is honest. A true per-feature error
*rate* needs a denominator (attempts per feature). We only have that today for AI
(every call is a `usage_costs` row → `v_ai_reliability_daily`). General per-feature
rates arrive with **Phase 2 (`usage_events`)** as the denominator.

## Example queries
```sql
-- Top issues to fix, ranked by how many athletes they hit (last 7 days)
SELECT * FROM v_errors_by_fingerprint
WHERE last_seen > now() - interval '7 days'
ORDER BY athletes_affected DESC, events DESC LIMIT 20;

-- Reliability trend: hard errors per day
SELECT day, SUM(events) FILTER (WHERE severity IN ('error','fatal')) AS hard_errors
FROM v_errors_daily GROUP BY day ORDER BY day DESC LIMIT 30;

-- Where is the app breaking
SELECT * FROM v_errors_by_area ORDER BY events DESC;
```

## Not here yet (future phases)
Non-AI costs (email). The ledger shapes already accommodate them — see
`SCALE-NOTES.md`.

---

# WILCO Engagement — Usage Data Schema (Phase 2)

Contract for reading WILCO's **engagement / usage** data — the third leg of the
stack (cost + reliability + engagement). Same read model: Supabase Postgres,
**service-role key** (RLS denies anon all access), read the **views**.

Migration: `supabase/migrations/20260625_usage_events.sql`.

## `usage_events` — the engagement ledger (one row per captured event)
A curated **allowlist** of high-value events — app opens, sessions, key actions,
key screen views — NOT every tap. Events are **batched** on the client and flushed
together. **Metadata only** — no chat/workout content, no PINs/tokens/emails.

This table is also the **denominator** the other ledgers were missing: it shares
`error_events`'s coarse `area` vocabulary, so per-feature error *rates* (not just
counts) become computable — see `v_error_rate_by_area_daily`.

| column | type | notes |
|---|---|---|
| `id` | bigint | PK |
| `created_at` | timestamptz | **server** receive time; client flushes frequently so it tracks event time to ~30s |
| `source` | text | `client` (browser); `server` reserved |
| `event_name` | text | the granular verb — allowlisted (see below) |
| `area` | text | coarse area, **same set as `error_events.area`** (`auth`,`workout_log`,`coach_dashboard`,`billing`,`ai`,`sync`,`nav`,`other`) |
| `session_id` | text | client-generated UUID; new on app open + after ~30min idle |
| `route` | text | client screen/path, **query string stripped** |
| `role` | text | `athlete` \| `coach` \| `anon` (pre-login) |
| `actor_id` | uuid | athletes.id / coaches.id (server-verified; null when anon) |
| `athlete_id` | uuid | ownership column for scoped reads; null for coach/anon |
| `school_id` / `coach_id` / `tier` | uuid / uuid / text | **snapshot** at write time (null when anon) |
| `app_version` | text | client build id |
| `user_agent` | text | read server-side, truncated |
| `meta` | jsonb | small sanitized extras (e.g. `{"screen":"log"}`), size-capped |

**Event names (allowlist):** `app_open`, `session_start`, `login`, `signup_start`,
`signup_complete`, `workout_logged`, `chat_opened`, `chat_message_sent`,
`screen_view`, `coach_dashboard_view`. (Off-list events are dropped server-side.)

**Sessions & anon stitching:** pre-login events (`app_open`, `session_start`,
`signup_start`) log as `role='anon'` with only a random `session_id`. When the user
logs in, the `login` event carries the **same** `session_id`, so the agent can
attribute the anon prefix without prior rows being rewritten.

## Views (read these)

| view | grain | key fields |
|---|---|---|
| `v_usage` | per event | all columns + UTC `day` |
| `v_dau` | per day | `dau`, `sessions`, `events` (built on the matview) |
| `v_wau` / `v_mau` | single row | trailing-7 / trailing-30 distinct active athletes |
| `v_stickiness_daily` | per day | `dau`, `mau_trailing_30`, `stickiness` (DAU/MAU) |
| `v_sessions_daily` | per day | `sessions`, `events`, `events_per_session` |
| `v_feature_adoption` | per event | `athletes`, `sessions`, `events`, first/last seen — breadth |
| `v_feature_adoption_daily` | per day × event | `athletes`, `events` — adoption trend |
| `v_activation_funnel` | single row | `signup_started_sessions` → `accounts_created` → `logged_first_workout` → `used_chat` |
| `v_engagement_by_school` | per school | `athletes_active`, `sessions`, `events` (dashboard scope) |
| `v_error_rate_by_area_daily` | per day × area | `attempts`, `errors`, `hard_errors`, `error_rate` (**joins `error_events`**) |

`mv_daily_active_athletes` is a **materialized** rollup (one row per athlete per
active day) — the scale primitive behind `v_dau`/`v_wau`/`v_mau`. It is refreshed
**automatically nightly** (00:15 UTC) by the pg_cron job `engagement-rollups-nightly`
(migration `20260625_engagement_rollup_cron.sql`), which also prunes `usage_events`
older than 90 days. Manual refresh if ever needed:
`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_active_athletes;`

## Error COUNTS became RATES
The Phase-1.5 promise is now kept. `v_error_rate_by_area_daily` divides
`error_events` by `usage_events` attempts on `(area, day)`. AI also still has its
call-grained denominator via `usage_costs` (`v_ai_reliability_daily`).

## Example queries
```sql
-- DAU trend, last 30 days
SELECT * FROM v_dau LIMIT 30;

-- WAU / MAU right now
SELECT (SELECT wau FROM v_wau) AS wau, (SELECT mau FROM v_mau) AS mau;

-- Activation funnel
SELECT * FROM v_activation_funnel;

-- Where is the app breaking, as a RATE (last 7 days)
SELECT area, SUM(attempts) attempts, SUM(errors) errors,
       ROUND(SUM(errors)::numeric/NULLIF(SUM(attempts),0),4) AS error_rate
FROM v_error_rate_by_area_daily
WHERE day > now() - interval '7 days'
GROUP BY area ORDER BY error_rate DESC;
```
