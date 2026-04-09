-- Migration 011: Fix reconciliations table to match application code
-- Renames invoice_id → document_id, adds match_reasons, fixes status enum,
-- adds unique constraint needed for upsert ON CONFLICT

-- 1. Rename invoice_id → document_id (code uses document_id everywhere)
ALTER TABLE reconciliations RENAME COLUMN invoice_id TO document_id;

-- 2. Add match_reasons JSONB column (stores array of reason strings)
ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS match_reasons JSONB;

-- 3. Drop and recreate CHECK constraint to include possible_match
ALTER TABLE reconciliations DROP CONSTRAINT IF EXISTS reconciliations_status_check;
ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_status_check
  CHECK (status IN ('pending', 'matched', 'possible_match', 'manual_match', 'unmatched', 'exception'));

-- 4. Add unique constraint so upsert ON CONFLICT (tenant_id, bank_transaction_id) works
ALTER TABLE reconciliations DROP CONSTRAINT IF EXISTS reconciliations_tenant_txn_unique;
ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_tenant_txn_unique
  UNIQUE (tenant_id, bank_transaction_id);

-- 5. Index for fast lookups by document
CREATE INDEX IF NOT EXISTS idx_reconciliations_document ON reconciliations(document_id);
