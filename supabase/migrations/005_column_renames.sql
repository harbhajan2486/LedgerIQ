-- Migration 005: Rename columns to match application code
-- No data exists yet so renames are safe.

-- ============================================================
-- documents table
-- ============================================================
ALTER TABLE documents RENAME COLUMN file_name    TO original_filename;
ALTER TABLE documents RENAME COLUMN file_s3_key  TO storage_path;
ALTER TABLE documents RENAME COLUMN type         TO document_type;

-- Update the CHECK constraint on document_type
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_document_type_check
  CHECK (document_type IN ('purchase_invoice','sales_invoice','expense','bank_statement','credit_note','debit_note'));

-- ============================================================
-- bank_transactions table
-- ============================================================
ALTER TABLE bank_transactions RENAME COLUMN date                  TO transaction_date;
ALTER TABLE bank_transactions RENAME COLUMN utr                   TO ref_number;
ALTER TABLE bank_transactions RENAME COLUMN reconciliation_status TO status;

-- Drop old status constraint and add new one (includes 'possible_match')
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_reconciliation_status_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_status_check
  CHECK (status IN ('unmatched','matched','possible_match','manual_match','exception'));

-- Add debit_amount and credit_amount columns
-- (amount + type='debit'/'credit' → split into two columns for easier querying)
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS debit_amount  NUMERIC(15,2);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS credit_amount NUMERIC(15,2);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS bank_name     TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS balance       NUMERIC(15,2);

-- ============================================================
-- reconciliations table
-- ============================================================
ALTER TABLE reconciliations RENAME COLUMN invoice_id TO document_id;

-- Drop old status constraint and add new one (includes 'possible_match')
ALTER TABLE reconciliations DROP CONSTRAINT IF EXISTS reconciliations_status_check;
ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_status_check
  CHECK (status IN ('pending','matched','possible_match','manual_match','unmatched','exception'));

-- Add match_reasons if not already added by migration 004
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS match_reasons  TEXT[];
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS matched_by     UUID REFERENCES auth.users(id);

-- ============================================================
-- Backfill billing columns for existing tenants
-- (migration 004 added subscription_plan/status but existing rows are NULL)
-- ============================================================
UPDATE tenants
SET subscription_plan   = plan,
    subscription_status = CASE status WHEN 'active' THEN 'active' WHEN 'suspended' THEN 'past_due' ELSE 'canceled' END
WHERE subscription_plan IS NULL;
