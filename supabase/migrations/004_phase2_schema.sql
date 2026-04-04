-- Migration 004: Phase 2 schema additions
-- Adds tables and columns needed for bank reconciliation,
-- Tally posting, billing, rate limiting, and admin portal.

-- ============================================================
-- rate_limit_log — lightweight sliding window rate limiter
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_limit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_user_time ON rate_limit_log(user_id, created_at DESC);

-- RLS: users can only insert their own rows; no SELECT needed
ALTER TABLE rate_limit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rate_limit_insert_own" ON rate_limit_log
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "rate_limit_delete_own" ON rate_limit_log
  FOR DELETE USING (user_id = auth.uid());

-- ============================================================
-- tenants — add billing and Tally company columns
-- ============================================================
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS tally_company_name     text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id      text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  text,
  ADD COLUMN IF NOT EXISTS subscription_plan       text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS subscription_status     text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS subscription_period_end timestamptz;

-- ============================================================
-- global_rules — add approval tracking columns
-- ============================================================
ALTER TABLE global_rules
  ADD COLUMN IF NOT EXISTS approved_by  uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS approved_at  timestamptz;

-- ============================================================
-- reconciliations — add matched_by column
-- ============================================================
ALTER TABLE reconciliations
  ADD COLUMN IF NOT EXISTS matched_by  uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS match_reasons  text[];

-- ============================================================
-- bank_transactions — add columns used by the parser
-- ============================================================
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS ref_number   text,
  ADD COLUMN IF NOT EXISTS bank_name    text,
  ADD COLUMN IF NOT EXISTS balance      numeric(15,2);

-- ============================================================
-- tally_postings — add posted_by and response columns
-- ============================================================
ALTER TABLE tally_postings
  ADD COLUMN IF NOT EXISTS posted_by      uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS tally_response text;

-- ============================================================
-- users — add full_name and email columns if missing
-- ============================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS full_name  text,
  ADD COLUMN IF NOT EXISTS email      text;

-- Create unique index on email for invite dedup check
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email
  ON users(tenant_id, email)
  WHERE email IS NOT NULL;

-- ============================================================
-- notifications — ensure columns exist
-- ============================================================
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS body text;

-- ============================================================
-- Cleanup: auto-purge rate_limit_log older than 10 minutes
-- This runs as a scheduled job if pg_cron is enabled.
-- If not available, the app handles cleanup inline.
-- ============================================================
-- SELECT cron.schedule('purge-rate-limit', '*/5 * * * *',
--   $$DELETE FROM rate_limit_log WHERE created_at < now() - interval '10 minutes'$$);
