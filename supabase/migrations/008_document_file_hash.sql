-- Migration 008: Add file_hash to documents for duplicate detection
-- SHA-256 hex digest of the file contents, computed at upload time.
-- Unique per tenant — same file can exist across different tenants.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS file_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_tenant_hash
  ON documents(tenant_id, file_hash)
  WHERE file_hash IS NOT NULL;
