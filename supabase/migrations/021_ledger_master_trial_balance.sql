-- Migration 021: Add trial balance columns to ledger_masters
-- Allows importing closing/opening balances from a client's Tally trial balance export.

ALTER TABLE ledger_masters
  ADD COLUMN IF NOT EXISTS opening_balance NUMERIC,
  ADD COLUMN IF NOT EXISTS closing_balance NUMERIC,
  ADD COLUMN IF NOT EXISTS balance_type    TEXT CHECK (balance_type IN ('Dr', 'Cr')),
  ADD COLUMN IF NOT EXISTS financial_year  TEXT,   -- e.g. "2024-25"
  ADD COLUMN IF NOT EXISTS tally_group     TEXT;   -- raw Tally group name, e.g. "Indirect Expenses"
