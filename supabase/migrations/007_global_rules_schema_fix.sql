-- Migration 007: Fix global_rules schema + add clients.industry_name column
-- The original migration 003 used column names (pattern, action, confidence, source, is_active)
-- that don't exist in the migration 001 schema (which used rule_json, active).
-- This migration adds the missing columns and re-seeds Layer 1 data correctly.

-- Add missing columns to global_rules
ALTER TABLE global_rules ADD COLUMN IF NOT EXISTS pattern    JSONB;
ALTER TABLE global_rules ADD COLUMN IF NOT EXISTS action     JSONB;
ALTER TABLE global_rules ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,3) DEFAULT 1.0;
ALTER TABLE global_rules ADD COLUMN IF NOT EXISTS source     TEXT;
ALTER TABLE global_rules ADD COLUMN IF NOT EXISTS is_active  BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE global_rules ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- Add industry_name directly on clients for simpler querying (avoids join)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS industry_name TEXT;

-- Seed Layer 1 TDS rules (most important for invoice extraction)
INSERT INTO global_rules (layer, rule_type, rule_json, pattern, action, confidence, source, is_active) VALUES

-- TDS Section 194C — Contractor (most common)
(1, 'tds_section',
 '{"section":"194C","description":"Payment to contractors","rate_individual":1,"rate_company":2,"threshold_single":30000,"threshold_aggregate":100000}',
 '{"section":"194C","description":"Payment to contractors"}',
 '{"rate_individual":1,"rate_huf":1,"rate_company":2,"threshold_inr_single":30000,"threshold_inr_aggregate":100000,"notes":"1% individuals/HUF, 2% companies"}',
 1.0, 'Income Tax Act 1961 S.194C', true),

-- TDS Section 194J — Professional/Technical (very common)
(1, 'tds_section',
 '{"section":"194J","description":"Professional or technical fees","rate_professional":10,"rate_technical":2,"threshold":30000}',
 '{"section":"194J","description":"Professional or technical fees, royalty"}',
 '{"rate_professional":10,"rate_technical":2,"rate_royalty":10,"threshold_inr":30000,"notes":"10% professional; 2% technical services"}',
 1.0, 'Income Tax Act 1961 S.194J', true),

-- TDS Section 194I — Rent
(1, 'tds_section',
 '{"section":"194I","description":"Rent","rate_land_building":10,"rate_plant_machinery":2,"threshold":240000}',
 '{"section":"194I","description":"Rent of land, building, furniture, or plant & machinery"}',
 '{"rate_land_building":10,"rate_plant_machinery":2,"threshold_inr":240000,"notes":"10% land/building, 2% plant & machinery per year"}',
 1.0, 'Income Tax Act 1961 S.194I', true),

-- TDS Section 194Q — Purchase of goods
(1, 'tds_section',
 '{"section":"194Q","description":"Purchase of goods > 50 lakhs","rate":0.1,"threshold":5000000}',
 '{"section":"194Q","description":"Purchase of goods exceeding 50 lakhs from single seller"}',
 '{"rate_individual":0.1,"rate_company":0.1,"threshold_inr":5000000,"notes":"0.1% on amount exceeding Rs 50 lakhs, buyer turnover > 10Cr"}',
 1.0, 'Income Tax Act 1961 S.194Q', true),

-- GST SAC 9983/9984/9985 — IT/Professional/Support services = 18%
(1, 'sac_gst_rate',
 '{"sac_prefix":"9983","cgst_rate":9,"sgst_rate":9,"igst_rate":18}',
 '{"sac_prefix":"9983","description":"IT and professional/technical services"}',
 '{"cgst_rate":9,"sgst_rate":9,"igst_rate":18}',
 1.0, 'CGST Act Schedule IV', true),

(1, 'sac_gst_rate',
 '{"sac_prefix":"9984","cgst_rate":9,"sgst_rate":9,"igst_rate":18}',
 '{"sac_prefix":"9984","description":"Telecom and broadcasting services"}',
 '{"cgst_rate":9,"sgst_rate":9,"igst_rate":18}',
 1.0, 'CGST Act Schedule IV', true),

(1, 'sac_gst_rate',
 '{"sac_prefix":"9985","cgst_rate":9,"sgst_rate":9,"igst_rate":18}',
 '{"sac_prefix":"9985","description":"Support services incl. security, cleaning"}',
 '{"cgst_rate":9,"sgst_rate":9,"igst_rate":18}',
 1.0, 'CGST Act Schedule IV', true),

-- GST SAC 9972 — Real estate = 12%
(1, 'sac_gst_rate',
 '{"sac_prefix":"9972","cgst_rate":6,"sgst_rate":6,"igst_rate":12}',
 '{"sac_prefix":"9972","description":"Real estate services"}',
 '{"cgst_rate":6,"sgst_rate":6,"igst_rate":12}',
 1.0, 'CGST Act Schedule III', true),

-- RCM — GTA
(1, 'reverse_charge',
 '{"service":"GTA","sac":"9965","rcm_applicable":true,"rate":5}',
 '{"service":"Goods Transport Agency (GTA)","sac":"9965"}',
 '{"rcm_applicable":true,"recipient_pays_gst":true,"rate":5,"notes":"GTA to registered person — recipient pays 5% RCM"}',
 1.0, 'Notification 13/2017-CT(Rate)', true),

-- RCM — Legal services
(1, 'reverse_charge',
 '{"service":"Legal services","sac":"998211","rcm_applicable":true,"rate":18}',
 '{"service":"Legal services by advocate","sac":"998211"}',
 '{"rcm_applicable":true,"recipient_pays_gst":true,"rate":18,"notes":"Legal services by individual advocate — RCM 18%"}',
 1.0, 'Notification 13/2017-CT(Rate)', true)

ON CONFLICT DO NOTHING;

SELECT 'Migration 007 applied: global_rules schema fixed, Layer 1 re-seeded' AS result;
