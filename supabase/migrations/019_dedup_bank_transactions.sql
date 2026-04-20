-- Migration 019: Unique constraint on bank_transactions to prevent duplicate uploads
-- Uses a partial unique index on (tenant_id, narration, transaction_date, debit_amount, credit_amount)
-- so the same transaction can never be inserted twice regardless of upload source.

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_txn_dedup
  ON bank_transactions (tenant_id, transaction_date, narration, debit_amount, credit_amount)
  WHERE narration IS NOT NULL;
