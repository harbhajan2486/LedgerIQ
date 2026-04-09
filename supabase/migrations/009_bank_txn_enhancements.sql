-- Migration 009: Bank transaction category, voucher type, and dedup hash
-- Adds category + voucher_type for accounting classification
-- Adds txn_hash for duplicate transaction prevention

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS voucher_type TEXT,
  ADD COLUMN IF NOT EXISTS txn_hash TEXT;

-- Unique index for deduplication: one transaction per tenant per hash
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_txns_tenant_hash
  ON bank_transactions(tenant_id, txn_hash)
  WHERE txn_hash IS NOT NULL;
