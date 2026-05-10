-- Migration 022: Cross-tenant structural correction signals
-- Stores ONLY: document fingerprint pattern + field name + tenant count
-- Zero financial data, zero client-specific mapping, zero actual values
-- This is the cross-CA learning layer — each firm's data stays isolated,
-- only the structural signal ("this field is often wrong on Infosys invoices") is shared.

-- ── Table ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS global_field_signals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  doc_fingerprint TEXT NOT NULL,       -- e.g. "document_type:purchase_invoice vendor:infosys industry:it services"
  field_name      TEXT NOT NULL,       -- e.g. "tds_section" — NEVER wrong/correct values
  tenant_count    INTEGER NOT NULL DEFAULT 0,  -- distinct tenants that flagged this
  promoted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (doc_fingerprint, field_name)
);

-- ── RLS: any authenticated user can read; no direct writes allowed ────────────
ALTER TABLE global_field_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY global_signals_read ON global_field_signals
  FOR SELECT USING (auth.role() = 'authenticated');

-- No INSERT/UPDATE policy — app code cannot write directly.
-- All writes go through the SECURITY DEFINER function below,
-- which enforces the no-financial-data contract at the database level.

-- ── SECURITY DEFINER: promote a structural signal ─────────────────────────────
-- Accepts only fingerprint + field_name + count — never values, never client data.
CREATE OR REPLACE FUNCTION promote_to_global_signal(
  p_fingerprint  TEXT,
  p_field_name   TEXT,
  p_tenant_count INTEGER
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO global_field_signals (doc_fingerprint, field_name, tenant_count, updated_at)
  VALUES (p_fingerprint, p_field_name, p_tenant_count, NOW())
  ON CONFLICT (doc_fingerprint, field_name)
  DO UPDATE SET
    tenant_count = EXCLUDED.tenant_count,
    updated_at   = NOW();
END;
$$;

-- ── Helper: count distinct tenants that corrected a field on a fingerprint ────
-- SECURITY DEFINER so it can read corrections across tenants for counting only.
-- Returns a plain integer — no financial data, no tenant IDs, no values exposed.
CREATE OR REPLACE FUNCTION count_tenants_correcting_field(
  p_fingerprint TEXT,
  p_field_name  TEXT
)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT COUNT(DISTINCT c.tenant_id)::INTEGER
  FROM corrections c
  JOIN extractions e ON e.id = c.extraction_id
  WHERE c.doc_fingerprint = p_fingerprint
    AND e.field_name = p_field_name;
$$;

-- ── Index for fast fingerprint lookups at extraction time ─────────────────────
CREATE INDEX IF NOT EXISTS idx_global_signals_fingerprint
  ON global_field_signals (doc_fingerprint);
