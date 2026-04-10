-- Migration 011: Add unique constraint on reconciliations for upsert support
-- Previous migrations (004/005) already renamed invoice_id→document_id and added match_reasons.
-- The missing piece is the unique constraint needed for ON CONFLICT upsert in auto-match.

ALTER TABLE reconciliations DROP CONSTRAINT IF EXISTS reconciliations_tenant_txn_unique;
ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_tenant_txn_unique
  UNIQUE (tenant_id, bank_transaction_id);

-- Also ensure possible_match is in the status CHECK (004/005 may not have included it)
ALTER TABLE reconciliations DROP CONSTRAINT IF EXISTS reconciliations_status_check;
ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_status_check
  CHECK (status IN ('pending', 'matched', 'possible_match', 'manual_match', 'unmatched', 'exception'));

CREATE INDEX IF NOT EXISTS idx_reconciliations_document ON reconciliations(document_id);
