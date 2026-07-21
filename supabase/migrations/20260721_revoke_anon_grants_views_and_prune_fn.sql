-- ─── DB-permissions hardening: v_* analytics views + prune_web_ledgers() ────────
-- From the 2026-07-21 security check. Three related gaps, all the same root cause:
-- objects created by past migrations inherited Supabase's stock default privileges
-- (ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated, and
-- Postgres's own GRANT EXECUTE ON FUNCTIONS TO PUBLIC) and nobody revoked them.
--
--   1. public.prune_web_ledgers() — the SECURITY DEFINER prune function added by
--      20260720_web_ledgers_prune.sql. Meant to run only from pg_cron, but it is
--      reachable at /rest/v1/rpc/prune_web_ledgers by anyone holding the public
--      bundle key. Calling it deletes every web_events / web_errors row older than
--      90 days — today a no-op (the ledgers are ~16 days old) but a live data-loss
--      button the moment the ledgers age past the window.
--
--   2. public.v_web_campaign_daily — the utm/campaign attribution view added with
--      the ad-attribution work (~2026-07-10). VERIFIED anon-SELECT-readable on prod
--      on 2026-07-21 (HTTP 200 with the anon key; all 33 other v_* views returned
--      401). It was simply missed when the other analytics views were locked down.
--
--   3. The other 33 v_* views had SELECT revoked but kept their default
--      INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER grants. Most are simple
--      enough to be auto-updatable, so those grants are not purely theoretical.
--
-- WHY THIS IS SAFE FOR THE APP: every app read of these views goes through the
-- service-role gateways (api/data.js, api/identity.js) and the report skills read
-- them with SUPABASE_SERVICE_KEY. service_role is not affected by these REVOKEs.
-- Confirmed 2026-07-21: no `.rpc(` call and no reference to v_web_campaign_daily or
-- prune_web_ledgers exists in ~/dev/WILCO or ~/dev/wilco-website outside this
-- migration set.
--
-- NOTE ON `FROM PUBLIC` FOR THE FUNCTION: Postgres grants EXECUTE on every new
-- function to PUBLIC. Revoking from anon/authenticated ALONE would leave that
-- inherited PUBLIC grant intact and the RPC would stay callable — so the function
-- revoke must name PUBLIC. Views need no PUBLIC revoke (Postgres grants no table
-- privileges to PUBLIC by default; Supabase grants them to the two roles by name).
-- The owner (postgres) keeps all privileges regardless, so the pg_cron job and the
-- SECURITY DEFINER context are unaffected.
--
-- Idempotent: REVOKE on an already-revoked privilege is a no-op.


-- ─── 1. The prune function: cron-only, not a public RPC ─────────────────────────
REVOKE ALL ON FUNCTION public.prune_web_ledgers() FROM PUBLIC, anon, authenticated;


-- ─── 2 + 3. Every v_* view/matview in public: strip anon + authenticated fully ──
-- Loops rather than hardcoding the current 34 names so it also catches any v_*
-- relation added between writing and running this.
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('v', 'm')          -- views and materialized views
       AND c.relname LIKE 'v\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', v.relname);
  END LOOP;
END $$;


-- ─── 4. Stop future functions inheriting the PUBLIC execute grant ───────────────
-- This is the recurrence guard for finding #1: without it, the next SECURITY
-- DEFINER cron helper someone adds is world-callable again by default.
-- Safe because no client-key code path in either repo calls any RPC (verified
-- 2026-07-21) — the app talks to the gateways, never to /rest/v1/rpc/*.
-- Applies to functions created by `postgres`, which is the role that runs
-- migrations via the dashboard SQL editor / MCP.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;


-- ─── DELIBERATELY NOT APPLIED: the same guard for TABLES ────────────────────────
-- The obvious companion to the above would be:
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     REVOKE ALL ON TABLES FROM anon, authenticated;
--
-- Postgres has no VIEWS-only bucket for default privileges — TABLES covers tables
-- AND views — and on this project anon table grants ARE load-bearing:
-- wilco-website's lib/supabase-server.ts builds its "server" client with
-- NEXT_PUBLIC_SUPABASE_ANON_KEY (not a service key), so the /api/telemetry,
-- /api/contact and /api/school-inquiry routes insert into web_events, web_errors,
-- contact_messages and school_inquiries AS THE ANON ROLE. Existing tables would be
-- unaffected (default privileges only touch future objects), but the next ledger
-- or form table added would silently lose its INSERT grant and start failing at
-- runtime. Left off pending a decision to move the website onto a service key —
-- which is the better fix, and would then make this line safe to add.


-- ─── EMERGENCY UNDO — run ONLY if something unexpectedly breaks ─────────────────
-- GRANT EXECUTE ON FUNCTION public.prune_web_ledgers() TO anon, authenticated;
-- DO $$
-- DECLARE
--   v record;
-- BEGIN
--   FOR v IN
--     SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--      WHERE n.nspname = 'public' AND c.relkind IN ('v','m') AND c.relname LIKE 'v\_%'
--   LOOP
--     EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', v.relname);
--   END LOOP;
-- END $$;
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--   GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
