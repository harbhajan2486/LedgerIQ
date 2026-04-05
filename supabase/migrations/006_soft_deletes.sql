-- ============================================================
-- Migration 006: Soft Deletes
-- Adds deleted_at column to documents and bank_transactions.
-- RLS policies updated to filter out deleted rows automatically.
-- Hard-deleted rows are invisible to the app but recoverable
-- by a super-admin within 30 days.
-- ============================================================

-- ── documents ────────────────────────────────────────────────
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Update RLS policy for documents to exclude soft-deleted rows.
-- Drop existing and recreate to include deleted_at filter.
DROP POLICY IF EXISTS "Tenants can view their own documents" ON documents;
CREATE POLICY "Tenants can view their own documents" ON documents
  FOR SELECT USING (
    auth.uid() IN (
      SELECT id FROM users WHERE tenant_id = documents.tenant_id
    )
    AND deleted_at IS NULL
  );

DROP POLICY IF EXISTS "Tenants can insert their own documents" ON documents;
CREATE POLICY "Tenants can insert their own documents" ON documents
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT id FROM users WHERE tenant_id = documents.tenant_id
    )
  );

DROP POLICY IF EXISTS "Tenants can update their own documents" ON documents;
CREATE POLICY "Tenants can update their own documents" ON documents
  FOR UPDATE USING (
    auth.uid() IN (
      SELECT id FROM users WHERE tenant_id = documents.tenant_id
    )
    AND deleted_at IS NULL
  );

-- Prevent hard deletes via RLS — use soft delete (set deleted_at) instead.
DROP POLICY IF EXISTS "Tenants can delete their own documents" ON documents;
CREATE POLICY "Tenants can delete their own documents" ON documents
  FOR DELETE USING (false);

-- ── bank_transactions ─────────────────────────────────────────
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

DROP POLICY IF EXISTS "Tenants can view their own bank transactions" ON bank_transactions;
CREATE POLICY "Tenants can view their own bank transactions" ON bank_transactions
  FOR SELECT USING (
    auth.uid() IN (
      SELECT id FROM users WHERE tenant_id = bank_transactions.tenant_id
    )
    AND deleted_at IS NULL
  );

-- ── Index for fast queries filtering out deleted rows ─────────
CREATE INDEX IF NOT EXISTS idx_documents_active
  ON documents (tenant_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bank_transactions_active
  ON bank_transactions (tenant_id, status)
  WHERE deleted_at IS NULL;
