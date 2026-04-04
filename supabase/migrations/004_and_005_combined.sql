-- Combined Migration 004 + 005
-- Run this in Supabase SQL Editor in one go.

-- ============================================================
-- PART 1: New tables and columns (from migration 004)
-- ============================================================

-- Rate limiting table
CREATE TABLE IF NOT EXISTS rate_limit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_user_time ON rate_limit_log(user_id, created_at DESC);
ALTER TABLE rate_limit_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rate_limit_log' AND policyname='rate_limit_insert_own') THEN
    CREATE POLICY "rate_limit_insert_own" ON rate_limit_log FOR INSERT WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- Billing columns on tenants
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tally_company_name     text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_customer_id      text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_subscription_id  text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_plan       text NOT NULL DEFAULT 'free';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_status     text NOT NULL DEFAULT 'active';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_period_end timestamptz;

-- Global rules approval tracking
ALTER TABLE global_rules ADD COLUMN IF NOT EXISTS approved_by  uuid REFERENCES auth.users(id);
ALTER TABLE global_rules ADD COLUMN IF NOT EXISTS approved_at  timestamptz;

-- Users table extra columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name  text;

-- Notifications body column
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body text;

-- Tally postings extra columns
ALTER TABLE tally_postings ADD COLUMN IF NOT EXISTS posted_by      uuid REFERENCES auth.users(id);
ALTER TABLE tally_postings ADD COLUMN IF NOT EXISTS tally_response text;

-- Bank transactions extra columns (ref_number, bank_name, balance added here;
-- date/amount/type will be renamed below)
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS bank_name    text;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS balance      numeric(15,2);

-- ============================================================
-- PART 2: Column renames (from migration 005)
-- ============================================================

-- documents: rename file_name → original_filename, type → document_type, file_s3_key → storage_path
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='documents' AND column_name='file_name') THEN
    ALTER TABLE documents RENAME COLUMN file_name   TO original_filename;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='documents' AND column_name='file_s3_key') THEN
    ALTER TABLE documents RENAME COLUMN file_s3_key TO storage_path;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='documents' AND column_name='type') THEN
    ALTER TABLE documents RENAME COLUMN type        TO document_type;
  END IF;
END $$;

-- Update CHECK constraint on document_type
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_type_check;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_document_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_document_type_check
  CHECK (document_type IN ('purchase_invoice','sales_invoice','expense','bank_statement','credit_note','debit_note'));

-- bank_transactions: rename date → transaction_date, utr → ref_number, reconciliation_status → status
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bank_transactions' AND column_name='date') THEN
    ALTER TABLE bank_transactions RENAME COLUMN date TO transaction_date;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bank_transactions' AND column_name='utr') THEN
    ALTER TABLE bank_transactions RENAME COLUMN utr  TO ref_number;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bank_transactions' AND column_name='reconciliation_status') THEN
    ALTER TABLE bank_transactions RENAME COLUMN reconciliation_status TO status;
  END IF;
END $$;

-- Add debit_amount and credit_amount columns
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS debit_amount  numeric(15,2);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS credit_amount numeric(15,2);

-- Update bank_transactions status CHECK constraint
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_reconciliation_status_check;
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_status_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_status_check
  CHECK (status IN ('unmatched','matched','possible_match','manual_match','exception'));

-- reconciliations: rename invoice_id → document_id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reconciliations' AND column_name='invoice_id') THEN
    ALTER TABLE reconciliations RENAME COLUMN invoice_id TO document_id;
  END IF;
END $$;

-- Add match_reasons and update status CHECK on reconciliations
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS match_reasons text[];
ALTER TABLE reconciliations DROP CONSTRAINT IF EXISTS reconciliations_status_check;
ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_status_check
  CHECK (status IN ('pending','matched','possible_match','manual_match','unmatched','exception'));

-- ============================================================
-- PART 3: Backfill billing columns for existing tenants
-- ============================================================
UPDATE tenants
SET subscription_plan   = plan,
    subscription_status = CASE status
                            WHEN 'active'    THEN 'active'
                            WHEN 'suspended' THEN 'past_due'
                            ELSE 'canceled'
                          END
WHERE subscription_plan = 'free'
  AND plan IS NOT NULL;

-- Done!
SELECT 'Migrations 004 + 005 applied successfully' AS result;
