-- Migration 013: Seed TDS section rules into global_rules
-- These are statutory rates under Income Tax Act 1961
-- Applied as Layer 1 (law-based, confidence = 1.0)

INSERT INTO global_rules (rule_type, pattern, action, confidence, source, is_active)
VALUES

-- ─── TDS on Professional / Technical Services ────────────────────────────────
('tds_section',
 '{"section":"194J","description":"Professional/technical services","keywords":["advocate","lawyer","legal","attorney","solicitor","chartered accountant","ca firm","audit","consultant","advisory","architect","doctor","physician","surgeon","hospital","clinic","medical","it service","software","technology","technical"]}',
 '{"rate":10,"threshold_single":30000,"threshold_aggregate":null,"notes":"Fee, royalty, or any sum under professional/technical services"}',
 1.0, 'Income Tax Act 1961, Section 194J', true),

-- ─── TDS on Contractors / Sub-contractors ────────────────────────────────────
('tds_section',
 '{"section":"194C","description":"Payments to contractors","keywords":["transport","courier","logistics","freight","cargo","delivery","shipping","contractor","construction","civil","builder","fabricat","manufactur","printing","advertis","media","catering","housekeeping","security guard","manpower","labour"]}',
 '{"rate_company":2,"rate_individual":1,"threshold_single":30000,"threshold_aggregate":100000,"notes":"Individual/HUF 1%, Company/others 2%"}',
 1.0, 'Income Tax Act 1961, Section 194C', true),

-- ─── TDS on Rent ─────────────────────────────────────────────────────────────
('tds_section',
 '{"section":"194I","description":"Rent for land, building, furniture","keywords":["rent","rental","lease","premises","office space","warehouse","godown","property"]}',
 '{"rate_land_building":10,"rate_plant_machinery":2,"threshold_aggregate":240000,"notes":"Land/building/furniture 10%, Plant/machinery 2%"}',
 1.0, 'Income Tax Act 1961, Section 194I', true),

-- ─── TDS on Commission / Brokerage ───────────────────────────────────────────
('tds_section',
 '{"section":"194H","description":"Commission or brokerage","keywords":["commission","brokerage","broker","agent","referral fee","dealership","franchise"]}',
 '{"rate":5,"threshold_aggregate":15000,"notes":"5% on commission or brokerage payments"}',
 1.0, 'Income Tax Act 1961, Section 194H', true),

-- ─── TDS on Interest ─────────────────────────────────────────────────────────
('tds_section',
 '{"section":"194A","description":"Interest other than interest on securities","keywords":["interest","fd interest","fixed deposit","ncd interest","deposit interest","loan interest"]}',
 '{"rate":10,"threshold_bank":40000,"threshold_other":5000,"notes":"Bank 40k threshold, others 5k threshold"}',
 1.0, 'Income Tax Act 1961, Section 194A', true),

-- ─── TDS on Insurance Commission ─────────────────────────────────────────────
('tds_section',
 '{"section":"194D","description":"Insurance commission","keywords":["insurance commission","lic commission","insurance agent","insurance broker"]}',
 '{"rate":5,"threshold_aggregate":15000}',
 1.0, 'Income Tax Act 1961, Section 194D', true),

-- ─── TDS on Purchase of Goods ────────────────────────────────────────────────
('tds_section',
 '{"section":"194Q","description":"Purchase of goods (194Q)","keywords":["purchase","goods purchase","material purchase","raw material","stock purchase"]}',
 '{"rate":0.1,"threshold_aggregate":5000000,"notes":"Applicable if annual purchase from single seller exceeds 50 lakhs"}',
 1.0, 'Income Tax Act 1961, Section 194Q', true),

-- ─── TDS on E-commerce ───────────────────────────────────────────────────────
('tds_section',
 '{"section":"194O","description":"E-commerce operator payments","keywords":["amazon","flipkart","zomato","swiggy","meesho","myntra","snapdeal","paytm mall","e-commerce","ecommerce"]}',
 '{"rate":1,"threshold_aggregate":500000,"notes":"1% on gross sale amount via e-commerce platform"}',
 1.0, 'Income Tax Act 1961, Section 194O', true)

ON CONFLICT DO NOTHING;

-- Also add a migration marker comment for tracking
COMMENT ON TABLE global_rules IS 'Seeded through migration 013: TDS sections 194J, 194C, 194I, 194H, 194A, 194D, 194Q, 194O';
