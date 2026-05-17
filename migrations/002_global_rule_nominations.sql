-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002: Cross-tenant global rule nomination system
-- Run this in your Supabase SQL editor (Settings → SQL Editor)
-- ─────────────────────────────────────────────────────────────────────────────

-- Global rule nominations: crowd-sourced mapping suggestions from multiple tenants
-- Only PII-safe patterns (no person names) are nominated here.
-- An admin must approve before a nomination joins the effective Layer 1.
CREATE TABLE IF NOT EXISTS global_rule_nominations (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Normalised narration key (already stripped of names by PII-safety check)
  pattern          text        NOT NULL,
  -- The ledger this pattern maps to (e.g. "Salary Expenses", "GTA Freight")
  ledger_name      text        NOT NULL,
  -- Optional industry context — null means "applies across industries"
  industry_name    text,
  -- Tax attributes (captured from the confirming invoice documents)
  rcm_applicable   boolean     DEFAULT false,
  tds_section      text,          -- e.g. "194C", "194J"
  suggested_gst_rate numeric(5,2), -- e.g. 18.00, 5.00
  -- Voting metadata
  tenant_count     integer     NOT NULL DEFAULT 1,
  total_confirmations integer  NOT NULL DEFAULT 1,
  -- Lifecycle: nominated → approved / rejected
  status           text        NOT NULL DEFAULT 'nominated'
                               CHECK (status IN ('nominated','approved','rejected')),
  rejection_reason text,
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- One nomination per (pattern, ledger) pair
  UNIQUE(pattern, ledger_name)
);

-- Track which tenants have voted on each nomination (prevents double-counting)
CREATE TABLE IF NOT EXISTS global_rule_nomination_votes (
  nomination_id  uuid  NOT NULL REFERENCES global_rule_nominations(id) ON DELETE CASCADE,
  tenant_id      uuid  NOT NULL,
  voted_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (nomination_id, tenant_id)
);

-- Fast lookups: approved rules (for Layer 1 augmentation at query time)
CREATE INDEX IF NOT EXISTS idx_global_nominations_approved
  ON global_rule_nominations(status) WHERE status = 'approved';

-- Fast lookups: nominated rules sorted by tenant_count for admin queue
CREATE INDEX IF NOT EXISTS idx_global_nominations_status_count
  ON global_rule_nominations(status, tenant_count DESC);

-- Enable RLS — admins see all, regular users see only approved rules
ALTER TABLE global_rule_nominations ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_rule_nomination_votes ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read approved nominations (used for Layer 1 augmentation)
CREATE POLICY "approved_rules_public_read"
  ON global_rule_nominations FOR SELECT
  USING (status = 'approved');

-- Service role (admin actions only) can do everything — handled in API with service key
-- Regular tenant users can insert votes for their own tenant_id
CREATE POLICY "tenants_can_vote"
  ON global_rule_nomination_votes FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "votes_read_own"
  ON global_rule_nomination_votes FOR SELECT
  USING (auth.uid() IS NOT NULL);
