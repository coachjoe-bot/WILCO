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

## Not here yet (future phases)
Engagement/session events, app errors, non-AI costs (email), materialized daily
rollups. The ledger shape already accommodates them — see `SCALE-NOTES.md`.
