-- ============================================================
-- Migration 020: Documents — permanent soft-delete for compliance
-- CGST Act Section 35 requires accounting records for 6 years.
-- Documents are NEVER hard-deleted. Setting deleted_at archives
-- them; they remain in storage and DB indefinitely.
-- Hard DELETE from app layer is blocked via RLS.
-- Only a super-admin using the service role key can view archived docs.
-- ============================================================

-- Add deleted_at column if not already present (migration 006 may have added it)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- ── RLS: exclude archived documents from all tenant queries ──

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

-- Block hard DELETEs from the app layer.
-- The API must use UPDATE SET deleted_at = now() instead.
DROP POLICY IF EXISTS "Tenants can delete their own documents" ON documents;
CREATE POLICY "Tenants can delete their own documents" ON documents
  FOR DELETE USING (false);

-- ── Audit log: record every archive action ────────────────────
-- Handled in API layer (audit_log insert on soft-delete).

-- ── Index: fast queries on active documents ──────────────────
CREATE INDEX IF NOT EXISTS idx_documents_active_tenant
  ON documents (tenant_id, status)
  WHERE deleted_at IS NULL;
