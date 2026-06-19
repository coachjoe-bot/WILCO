-- ─── LEGAL COMPLIANCE: CONSENT + DELETION ────────────────────────────────────
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query → Run).
-- Idempotent — safe to re-run.
--
-- NOTE ON AUTH MODEL: WILCO authenticates athletes with a custom 4-digit PIN
-- against the `athletes` table — there is NO Supabase Auth / auth.users for
-- athletes. So these tables reference athletes(id), not auth.users(id), and we do
-- not use auth.uid()-based RLS (the app talks to PostgREST with a shared key, the
-- same model used by every existing table here, e.g. proof_digests). Access to
-- these tables is controlled the same way as the rest of the schema.

-- 1. legal_acceptances — immutable audit log of T&C / Privacy / parental consent.
--    One row per (athlete, document) captured at signup. Append-only.
CREATE TABLE IF NOT EXISTS legal_acceptances (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id   UUID        NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  document     TEXT        NOT NULL CHECK (document IN ('terms','privacy','parental_consent')),
  version      TEXT        NOT NULL,
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address   TEXT
);

CREATE INDEX IF NOT EXISTS legal_acceptances_athlete_idx ON legal_acceptances (athlete_id);

-- 2. deletion_requests — queue of account-deletion requests honoring the Privacy
--    Policy's 30-day deletion right. The process-deletions edge function drains
--    rows whose scheduled_deletion_at has passed.
--
--    athlete_id is ON DELETE SET NULL (NOT cascade) on purpose: after the athlete
--    row is hard-deleted, this request must survive so it can be marked
--    'completed' and remain as a compliance audit record.
CREATE TABLE IF NOT EXISTS deletion_requests (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id            UUID        REFERENCES athletes(id) ON DELETE SET NULL,
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_deletion_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  triggered_by          TEXT        NOT NULL DEFAULT 'user_request'
                                    CHECK (triggered_by IN ('user_request','subscription_cancellation')),
  status                TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending','completed')),
  completed_at          TIMESTAMPTZ
);

-- Drains "what's due now" — the edge function's exact query pattern.
CREATE INDEX IF NOT EXISTS deletion_requests_due_idx
  ON deletion_requests (status, scheduled_deletion_at);
CREATE INDEX IF NOT EXISTS deletion_requests_athlete_idx
  ON deletion_requests (athlete_id);
