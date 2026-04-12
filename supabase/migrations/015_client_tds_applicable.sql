-- Add tds_applicable flag to clients table
-- Used to mark clients whose annual turnover is below the TDS deduction threshold
-- Default true = TDS deduction is applicable (the standard case)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tds_applicable boolean NOT NULL DEFAULT true;
