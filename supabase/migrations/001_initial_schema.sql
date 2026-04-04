-- ============================================================
-- LedgerIQ — Initial Database Schema
-- Migration 001: All core tables, RLS policies, indexes
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- fuzzy vendor name matching

-- ============================================================
-- TENANTS
-- ============================================================
CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter','professional','business','enterprise')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','cancelled')),
  tally_endpoint  TEXT,
  stripe_customer_id TEXT,
  monthly_doc_limit INTEGER NOT NULL DEFAULT 200,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at    TIMESTAMPTZ,
  delete_after    TIMESTAMPTZ -- set to cancelled_at + 90 days on cancellation
);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'reviewer' CHECK (role IN ('super_admin','admin','senior_reviewer','reviewer')),
  mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  last_login      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDUSTRY PROFILES (Layer 1 = global, Layer 2 = promoted, Layer 3 = tenant-built)
-- ============================================================
CREATE TABLE industry_profiles (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  industry_name             TEXT NOT NULL,
  item_classification_rules JSONB NOT NULL DEFAULT '{}',
  default_hsn_map           JSONB NOT NULL DEFAULT '{}',
  default_tds_categories    JSONB NOT NULL DEFAULT '{}',
  layer                     INTEGER NOT NULL CHECK (layer IN (1,2,3)),
  base_profile_id           UUID REFERENCES industry_profiles(id),
  tenant_id                 UUID REFERENCES tenants(id), -- NULL for Layer 1 & 2
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed Layer 1 industry profiles
INSERT INTO industry_profiles (industry_name, layer) VALUES
  ('Restaurant & Food Service', 1),
  ('IT Services', 1),
  ('Manufacturing', 1),
  ('Healthcare', 1),
  ('Real Estate & Construction', 1),
  ('Retail / Trading', 1);

-- ============================================================
-- CLIENTS (end-clients of the CA firm)
-- ============================================================
CREATE TABLE clients (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_name         TEXT NOT NULL,
  gstin               TEXT,
  pan                 TEXT,
  industry_profile_id UUID REFERENCES industry_profiles(id),
  custom_rules        JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DOCUMENTS
-- ============================================================
CREATE TABLE documents (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id           UUID REFERENCES clients(id),
  industry_profile_id UUID REFERENCES industry_profiles(id),
  type                TEXT NOT NULL CHECK (type IN ('purchase_invoice','sales_invoice','expense','bank_statement','credit_note','debit_note')),
  file_s3_key         TEXT NOT NULL, -- Supabase Storage path: {tenant_id}/invoices/{file_id}
  file_name           TEXT NOT NULL,
  file_size_bytes     INTEGER,
  mime_type           TEXT,
  status              TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','extracting','review_required','reviewed','reconciled','posted','failed')),
  uploaded_by         UUID REFERENCES users(id),
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at        TIMESTAMPTZ,
  ai_model_used       TEXT,
  doc_fingerprint     TEXT -- vendor + template hash for vector lookup
);

-- ============================================================
-- EXTRACTIONS (one row per extracted field per document)
-- ============================================================
CREATE TABLE extractions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  field_name       TEXT NOT NULL,
  extracted_value  TEXT,
  confidence       NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','corrected')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CORRECTIONS (immutable — never updated or deleted)
-- ============================================================
CREATE TABLE corrections (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  extraction_id    UUID NOT NULL REFERENCES extractions(id),
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  industry_id      UUID REFERENCES industry_profiles(id),
  wrong_value      TEXT,
  correct_value    TEXT NOT NULL,
  corrected_by     UUID NOT NULL REFERENCES users(id),
  corrected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  doc_fingerprint  TEXT,
  original_confidence NUMERIC(3,2)
);

-- ============================================================
-- VENDOR PROFILES
-- ============================================================
CREATE TABLE vendor_profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_name     TEXT NOT NULL,
  gstin           TEXT,
  tds_category    TEXT,
  invoice_quirks  JSONB NOT NULL DEFAULT '{}', -- learned field patterns
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, vendor_name)
);

-- ============================================================
-- BANK TRANSACTIONS
-- ============================================================
CREATE TABLE bank_transactions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id             UUID REFERENCES clients(id),
  date                  DATE NOT NULL,
  amount                NUMERIC(15,2) NOT NULL,
  type                  TEXT NOT NULL CHECK (type IN ('debit','credit')),
  narration             TEXT,
  utr                   TEXT,
  reconciliation_status TEXT NOT NULL DEFAULT 'unmatched' CHECK (reconciliation_status IN ('unmatched','matched','manual_match')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- RECONCILIATIONS
-- ============================================================
CREATE TABLE reconciliations (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id           UUID NOT NULL REFERENCES documents(id),
  bank_transaction_id  UUID REFERENCES bank_transactions(id),
  match_score          NUMERIC(5,2),
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','matched','manual_match','unmatched','exception')),
  exception_type       TEXT,
  matched_by           UUID REFERENCES users(id),
  matched_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TALLY POSTINGS
-- ============================================================
CREATE TABLE tally_postings (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id),
  voucher_type  TEXT NOT NULL CHECK (voucher_type IN ('purchase','sales','payment','receipt','journal')),
  tally_xml     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','failed')),
  posted_at     TIMESTAMPTZ,
  posted_by     UUID REFERENCES users(id),
  tally_response TEXT,
  UNIQUE (document_id) -- idempotency: one posting record per document
);

-- ============================================================
-- GLOBAL RULES (Layer 1 + Layer 2 knowledge)
-- ============================================================
CREATE TABLE global_rules (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  layer                 INTEGER NOT NULL CHECK (layer IN (1,2)),
  rule_type             TEXT NOT NULL, -- 'gst_rate', 'tds_section', 'invoice_pattern', etc.
  rule_json             JSONB NOT NULL,
  industry_id           UUID REFERENCES industry_profiles(id),
  created_from_tenant_id UUID REFERENCES tenants(id),
  approved_by           UUID REFERENCES users(id),
  tenant_count          INTEGER DEFAULT 0, -- how many tenants confirmed this pattern
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CORRECTION VECTORS (for few-shot injection)
-- ============================================================
CREATE TABLE correction_vectors (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  doc_fingerprint      TEXT NOT NULL,
  correction_embedding vector(384), -- Supabase Transformers.js produces 384-dim vectors
  correction_record_id UUID NOT NULL REFERENCES corrections(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AI USAGE TRACKING (cost guard)
-- ============================================================
CREATE TABLE ai_usage (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID REFERENCES tenants(id) ON DELETE SET NULL,
  document_id  UUID REFERENCES documents(id) ON DELETE SET NULL,
  model        TEXT NOT NULL, -- 'claude-haiku-4-5' or 'claude-sonnet-4-6'
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  cost_usd     NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOG (append-only — NO update/delete grants for app user)
-- ============================================================
CREATE TABLE audit_log (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID REFERENCES tenants(id),
  user_id      UUID REFERENCES users(id),
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    UUID,
  old_value    JSONB,
  new_value    JSONB,
  ip_address   TEXT,
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TALLY LEDGER MAPPINGS (per tenant)
-- ============================================================
CREATE TABLE tally_ledger_mappings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  standard_account TEXT NOT NULL, -- e.g. 'input_igst_18'
  tally_ledger_name TEXT NOT NULL, -- e.g. 'Input IGST @18%'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, standard_account)
);

-- ============================================================
-- NOTIFICATION LOG
-- ============================================================
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id),
  user_id     UUID REFERENCES users(id),
  type        TEXT NOT NULL, -- 'exception_found', 'queue_full', 'cost_warning', 'new_signup'
  title       TEXT NOT NULL,
  body        TEXT,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at     TIMESTAMPTZ
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_documents_tenant_status      ON documents(tenant_id, status);
CREATE INDEX idx_documents_client             ON documents(client_id);
CREATE INDEX idx_extractions_document         ON extractions(document_id);
CREATE INDEX idx_extractions_tenant_status    ON extractions(tenant_id, status);
CREATE INDEX idx_corrections_tenant           ON corrections(tenant_id);
CREATE INDEX idx_corrections_fingerprint      ON corrections(doc_fingerprint);
CREATE INDEX idx_bank_transactions_tenant     ON bank_transactions(tenant_id, date);
CREATE INDEX idx_reconciliations_tenant       ON reconciliations(tenant_id, status);
CREATE INDEX idx_tally_postings_tenant        ON tally_postings(tenant_id, status);
CREATE INDEX idx_audit_log_tenant_time        ON audit_log(tenant_id, timestamp DESC);
CREATE INDEX idx_ai_usage_tenant_month        ON ai_usage(tenant_id, created_at);
CREATE INDEX idx_vendor_profiles_tenant_name  ON vendor_profiles USING gin(vendor_name gin_trgm_ops);
CREATE INDEX idx_correction_vectors_tenant    ON correction_vectors(tenant_id, doc_fingerprint);

-- Vector similarity index
CREATE INDEX idx_correction_vectors_embedding ON correction_vectors
  USING ivfflat (correction_embedding vector_cosine_ops)
  WITH (lists = 100);

-- ============================================================
-- ROW LEVEL SECURITY
-- All accounting tables are isolated by tenant_id.
-- Two independent locks: app middleware + DB RLS.
-- ============================================================

ALTER TABLE documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE extractions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections         ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_postings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE correction_vectors  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage            ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients             ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_ledger_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications       ENABLE ROW LEVEL SECURITY;

-- Helper function: get current user's tenant_id from the users table
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS UUID AS $$
  SELECT tenant_id FROM users WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper function: check if current user is super_admin
CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Apply tenant isolation policy to each table
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'documents','extractions','corrections','vendor_profiles',
    'bank_transactions','reconciliations','tally_postings',
    'audit_log','correction_vectors','ai_usage','clients',
    'tally_ledger_mappings','notifications'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id() OR is_super_admin())',
      tbl
    );
  END LOOP;
END$$;

-- Users can only see their own tenant's users (or super_admin sees all)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = current_tenant_id() OR is_super_admin() OR id = auth.uid());

-- Global rules and industry profiles are readable by all authenticated users
ALTER TABLE global_rules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry_profiles    ENABLE ROW LEVEL SECURITY;

CREATE POLICY global_rules_read ON global_rules
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY global_rules_write ON global_rules
  FOR ALL USING (is_super_admin());

CREATE POLICY industry_profiles_read ON industry_profiles
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY industry_profiles_write ON industry_profiles
  FOR ALL USING (
    is_super_admin()
    OR (layer = 3 AND tenant_id = current_tenant_id())
  );

-- ============================================================
-- AUDIT LOG: revoke UPDATE and DELETE from app role
-- (Run after creating your Supabase service role)
-- REVOKE UPDATE, DELETE ON audit_log FROM authenticated;
-- ============================================================
