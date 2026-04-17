-- Migration 017: Industry-level ledger mapping rules
-- Extends ledger_mapping_rules to support industry-scoped rules (Layer 2)
-- Priority chain: client rule > industry rule > global keyword (Layer 1)

-- Add industry_name column (NULL = client-level rule, populated = industry-level rule)
ALTER TABLE ledger_mapping_rules ADD COLUMN IF NOT EXISTS industry_name TEXT;

-- Drop the old UNIQUE constraint that only covers (tenant_id, client_id, pattern)
-- because client_id NULL + industry_name NULL would conflict across industry rules
ALTER TABLE ledger_mapping_rules DROP CONSTRAINT IF EXISTS ledger_mapping_rules_tenant_id_client_id_pattern_key;

-- Partial unique index for client-level rules (client_id IS NOT NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_rules_client_unique
  ON ledger_mapping_rules (tenant_id, client_id, pattern)
  WHERE client_id IS NOT NULL;

-- Partial unique index for industry-level rules (client_id IS NULL, industry_name IS NOT NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_rules_industry_unique
  ON ledger_mapping_rules (tenant_id, industry_name, pattern)
  WHERE client_id IS NULL AND industry_name IS NOT NULL;

-- Index for industry rule lookups
CREATE INDEX IF NOT EXISTS idx_ledger_rules_industry
  ON ledger_mapping_rules (tenant_id, industry_name)
  WHERE client_id IS NULL AND industry_name IS NOT NULL;
