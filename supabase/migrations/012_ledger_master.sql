-- Migration 012: Ledger master, mapping rules, and ledger_name on bank transactions

-- Per-client chart of accounts
CREATE TABLE IF NOT EXISTS ledger_masters (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  ledger_name TEXT NOT NULL,
  ledger_type TEXT NOT NULL CHECK (ledger_type IN ('expense','income','asset','liability','capital','bank','tax')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, client_id, ledger_name)
);

-- Auto-learned mapping rules: narration pattern → ledger
CREATE TABLE IF NOT EXISTS ledger_mapping_rules (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  pattern     TEXT NOT NULL,           -- normalised narration prefix/keyword
  ledger_name TEXT NOT NULL,
  match_count INTEGER DEFAULT 1,
  confirmed   BOOLEAN DEFAULT false,   -- true once match_count >= 3
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, client_id, pattern)
);

-- Add ledger_name to bank transactions
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS ledger_name TEXT;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ledger_masters_client   ON ledger_masters(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_ledger_rules_client     ON ledger_mapping_rules(tenant_id, client_id);

-- RLS
ALTER TABLE ledger_masters       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_mapping_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY ledger_masters_tenant_isolation ON ledger_masters
  USING (tenant_id = (SELECT tenant_id FROM users WHERE id = auth.uid()));
CREATE POLICY ledger_rules_tenant_isolation ON ledger_mapping_rules
  USING (tenant_id = (SELECT tenant_id FROM users WHERE id = auth.uid()));
