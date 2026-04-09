-- Migration 010: Link bank transactions to clients
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bank_txns_client_id ON bank_transactions(client_id) WHERE client_id IS NOT NULL;
