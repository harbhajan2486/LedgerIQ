-- Migration 009: Bank transaction category, voucher type, and dedup hash
-- Adds category + voucher_type for accounting classification
-- Adds txn_hash for duplicate transaction prevention (checked in app code, not DB constraint)

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS voucher_type TEXT,
  ADD COLUMN IF NOT EXISTS txn_hash TEXT;

-- Regular index for fast hash lookups (dedup is enforced in application logic)
CREATE INDEX IF NOT EXISTS idx_bank_txns_tenant_hash
  ON bank_transactions(tenant_id, txn_hash)
  WHERE txn_hash IS NOT NULL;
