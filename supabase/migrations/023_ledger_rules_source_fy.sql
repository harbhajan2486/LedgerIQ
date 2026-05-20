-- Migration 023: Add source and financial_year to ledger_mapping_rules
-- source: "bank_book_import" | "manual" | "auto_learned"
-- financial_year: "2024-25" | "2023-24" etc. (April-March Indian FY)

ALTER TABLE ledger_mapping_rules
  ADD COLUMN IF NOT EXISTS source        TEXT,
  ADD COLUMN IF NOT EXISTS financial_year TEXT;

-- Index to find all rules from a specific import year
CREATE INDEX IF NOT EXISTS idx_ledger_rules_fy ON ledger_mapping_rules(tenant_id, client_id, financial_year);
