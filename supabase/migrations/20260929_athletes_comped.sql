-- Comped accounts (Will, 2026-09-29): "Every account up till now should be free.
-- Never ask to charge them or anyone I give a 100% discount to."
--
-- `comped` is SERVER-ONLY. It is not in api/data.js ATHLETE_COL_ALLOW, and the
-- gateway rejects it for every caller (athlete, coach, master). It is set by
-- this migration, by the Stripe webhook / create-subscription when a 100%-off
-- FOREVER coupon lands on the account, or by hand in SQL. Nothing ever sets it
-- back to false automatically. Tiers are NOT changed by it: a comped athlete
-- keeps exactly the tier and features they have.
alter table public.athletes add column if not exists comped boolean not null default false;

-- ALREADY RAN ON PROD ON 2026-09-29. DO NOT RE-RUN this update later: it would
-- comp every account created after that date. It is kept here so a fresh
-- database (preview branch, local reset) matches prod. On a fresh database
-- there are no rows yet and the statement is a no-op.
update public.athletes set comped = true where created_at <= now();

comment on column public.athletes.comped is 'Server-only. True = never ask this account to pay (founding accounts as of 2026-09-29, and holders of a 100% off FOREVER coupon). Tier is unaffected.';
