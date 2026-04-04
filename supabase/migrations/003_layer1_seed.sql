-- Migration 003: Layer 1 Knowledge Base Seed
-- Global rules seeded from Indian tax law — available to ALL tenants on day one.
-- This is the "75% day-one accuracy" moat: every new firm starts smarter than
-- a blank-slate competitor system.
--
-- Contents:
--   A. GST rate mappings (HSN → CGST/SGST/IGST rates)
--   B. SAC code mappings (services → GST rates)
--   C. TDS section rules (section → rate, threshold, description)
--   D. Reverse charge rules
--   E. Invoice matching heuristics
--   F. ITC eligibility rules

-- ============================================================
-- A. GST RATE RULES — HSN code ranges → applicable rates
-- ============================================================

INSERT INTO global_rules (rule_type, pattern, action, confidence, source, is_active) VALUES

-- Zero-rated / exempt items
('hsn_gst_rate', '{"hsn_prefix": "0101", "description": "Live horses, asses, mules"}',          '{"cgst_rate": 0, "sgst_rate": 0, "igst_rate": 0, "exempt": true}', 1.0, 'CGST Act Schedule I', true),
('hsn_gst_rate', '{"hsn_prefix": "0201", "description": "Meat of bovine animals, fresh"}',      '{"cgst_rate": 0, "sgst_rate": 0, "igst_rate": 0, "exempt": true}', 1.0, 'CGST Act Schedule I', true),
('hsn_gst_rate', '{"hsn_prefix": "0701", "description": "Potatoes, fresh or chilled"}',         '{"cgst_rate": 0, "sgst_rate": 0, "igst_rate": 0, "exempt": true}', 1.0, 'CGST Act Schedule I', true),
('hsn_gst_rate', '{"hsn_prefix": "1001", "description": "Wheat and meslin"}',                   '{"cgst_rate": 0, "sgst_rate": 0, "igst_rate": 0, "exempt": true}', 1.0, 'CGST Act Schedule I', true),

-- 5% GST items (2.5% CGST + 2.5% SGST or 5% IGST)
('hsn_gst_rate', '{"hsn_prefix": "0302", "description": "Fish, fresh or chilled"}',             '{"cgst_rate": 2.5, "sgst_rate": 2.5, "igst_rate": 5}', 1.0, 'CGST Act Schedule II', true),
('hsn_gst_rate', '{"hsn_prefix": "0801", "description": "Coconuts, cashew nuts, Brazil nuts"}', '{"cgst_rate": 2.5, "sgst_rate": 2.5, "igst_rate": 5}', 1.0, 'CGST Act Schedule II', true),
('hsn_gst_rate', '{"hsn_prefix": "1701", "description": "Cane or beet sugar"}',                 '{"cgst_rate": 2.5, "sgst_rate": 2.5, "igst_rate": 5}', 1.0, 'CGST Act Schedule II', true),
('hsn_gst_rate', '{"hsn_prefix": "2501", "description": "Salt"}',                               '{"cgst_rate": 2.5, "sgst_rate": 2.5, "igst_rate": 5}', 1.0, 'CGST Act Schedule II', true),
('hsn_gst_rate', '{"hsn_prefix": "4901", "description": "Printed books, newspapers"}',          '{"cgst_rate": 0, "sgst_rate": 0, "igst_rate": 0, "exempt": true}', 1.0, 'CGST Act Schedule I', true),

-- 12% GST items (6% CGST + 6% SGST or 12% IGST)
('hsn_gst_rate', '{"hsn_prefix": "0402", "description": "Milk and cream, concentrated"}',       '{"cgst_rate": 6, "sgst_rate": 6, "igst_rate": 12}', 1.0, 'CGST Act Schedule III', true),
('hsn_gst_rate', '{"hsn_prefix": "2106", "description": "Food preparations NEC"}',              '{"cgst_rate": 6, "sgst_rate": 6, "igst_rate": 12}', 1.0, 'CGST Act Schedule III', true),
('hsn_gst_rate', '{"hsn_prefix": "3004", "description": "Medicaments (excluding goods of heading 30.02, 30.05 or 30.06)"}', '{"cgst_rate": 6, "sgst_rate": 6, "igst_rate": 12}', 1.0, 'CGST Act Schedule III', true),
('hsn_gst_rate', '{"hsn_prefix": "6101", "description": "Mens/boys overcoats, cloaks"}',        '{"cgst_rate": 6, "sgst_rate": 6, "igst_rate": 12}', 1.0, 'CGST Act Schedule III', true),
('hsn_gst_rate', '{"hsn_prefix": "6201", "description": "Mens/boys overcoats (not knit)"}',     '{"cgst_rate": 6, "sgst_rate": 6, "igst_rate": 12}', 1.0, 'CGST Act Schedule III', true),

-- 18% GST items (9% CGST + 9% SGST or 18% IGST) — most B2B services and goods
('hsn_gst_rate', '{"hsn_prefix": "8471", "description": "Computers and peripherals"}',          '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'CGST Act Schedule IV', true),
('hsn_gst_rate', '{"hsn_prefix": "8517", "description": "Telephone sets, smartphones"}',        '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'CGST Act Schedule IV', true),
('hsn_gst_rate', '{"hsn_prefix": "8528", "description": "Monitors and projectors"}',            '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'CGST Act Schedule IV', true),
('hsn_gst_rate', '{"hsn_prefix": "9403", "description": "Furniture and parts thereof"}',        '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'CGST Act Schedule IV', true),
('hsn_gst_rate', '{"hsn_prefix": "3401", "description": "Soap, organic surface-active products"}','{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'CGST Act Schedule IV', true),
('hsn_gst_rate', '{"hsn_prefix": "3305", "description": "Hair preparations"}',                  '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'CGST Act Schedule IV', true),
('hsn_gst_rate', '{"hsn_prefix": "2710", "description": "Petroleum oils"}',                     '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'CGST Act Schedule IV', true),

-- 28% GST items (14% CGST + 14% SGST or 28% IGST) — luxury / sin goods
('hsn_gst_rate', '{"hsn_prefix": "8703", "description": "Motor cars and vehicles"}',            '{"cgst_rate": 14, "sgst_rate": 14, "igst_rate": 28}', 1.0, 'CGST Act Schedule V', true),
('hsn_gst_rate', '{"hsn_prefix": "2402", "description": "Cigars, cigarettes, tobacco"}',        '{"cgst_rate": 14, "sgst_rate": 14, "igst_rate": 28}', 1.0, 'CGST Act Schedule V', true),
('hsn_gst_rate', '{"hsn_prefix": "2203", "description": "Beer made from malt"}',                '{"cgst_rate": 14, "sgst_rate": 14, "igst_rate": 28}', 1.0, 'CGST Act Schedule V', true),
('hsn_gst_rate', '{"hsn_prefix": "9504", "description": "Games, video games, gambling machines"}','{"cgst_rate": 14, "sgst_rate": 14, "igst_rate": 28}', 1.0, 'CGST Act Schedule V', true),

-- ============================================================
-- B. SAC CODE RULES — service codes → GST rates
-- ============================================================

('sac_gst_rate', '{"sac": "9954", "description": "Construction services"}',                    '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9961", "description": "Wholesale trade services"}',                  '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9962", "description": "Retail trade services"}',                     '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9971", "description": "Financial and related services"}',            '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9972", "description": "Real estate services"}',                      '{"cgst_rate": 6, "sgst_rate": 6, "igst_rate": 12}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9973", "description": "Leasing or rental services"}',                '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9983", "description": "Other professional/technical services"}',     '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9984", "description": "Telecom and broadcasting services"}',         '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9985", "description": "Support services"}',                          '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9986", "description": "Agriculture, forestry support services"}',    '{"cgst_rate": 0, "sgst_rate": 0, "igst_rate": 0, "exempt": true}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9992", "description": "Education services"}',                        '{"cgst_rate": 0, "sgst_rate": 0, "igst_rate": 0, "exempt": true}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9993", "description": "Human health and social care services"}',     '{"cgst_rate": 0, "sgst_rate": 0, "igst_rate": 0, "exempt": true}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9995", "description": "Recreational, cultural services"}',           '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "9997", "description": "Other services NEC"}',                        '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),

-- IT services (common in B2B invoices)
('sac_gst_rate', '{"sac": "998313", "description": "IT design and development services"}',      '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "998314", "description": "IT infrastructure and network mgmt"}',      '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "998315", "description": "IT support services"}',                     '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),

-- Professional services (CA firms bill and receive these often)
('sac_gst_rate', '{"sac": "998211", "description": "Legal advisory and representation"}',       '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "998221", "description": "Accounting and bookkeeping services"}',     '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "998222", "description": "Auditing services"}',                       '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "998223", "description": "Tax consultancy and preparation"}',         '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),
('sac_gst_rate', '{"sac": "998231", "description": "Management consulting services"}',          '{"cgst_rate": 9, "sgst_rate": 9, "igst_rate": 18}', 1.0, 'SAC Schedule', true),

-- ============================================================
-- C. TDS SECTION RULES
-- ============================================================

-- Section 192 — Salary (not invoice-based, but useful for payroll documents)
('tds_section', '{"section": "192", "description": "Salaries"}',
  '{"rate_individual": 0, "rate_company": 0, "threshold_inr": 250000, "notes": "Rate as per slab; threshold is basic exemption limit"}', 1.0, 'Income Tax Act 1961', true),

-- Section 193 — Interest on securities
('tds_section', '{"section": "193", "description": "Interest on securities"}',
  '{"rate_individual": 10, "rate_company": 10, "threshold_inr": 10000, "notes": "10% on interest exceeding Rs 10,000"}', 1.0, 'Income Tax Act 1961', true),

-- Section 194 — Dividend
('tds_section', '{"section": "194", "description": "Dividend"}',
  '{"rate_individual": 10, "rate_company": 10, "threshold_inr": 5000, "notes": "10% on dividend exceeding Rs 5,000"}', 1.0, 'Income Tax Act 1961', true),

-- Section 194A — Interest (other than securities)
('tds_section', '{"section": "194A", "description": "Interest other than on securities"}',
  '{"rate_individual": 10, "rate_company": 10, "threshold_inr": 40000, "notes": "Threshold Rs 40,000 for banks; Rs 5,000 others. 20% if no PAN."}', 1.0, 'Income Tax Act 1961', true),

-- Section 194B — Lottery winnings
('tds_section', '{"section": "194B", "description": "Winnings from lottery, crossword puzzle"}',
  '{"rate_individual": 30, "rate_company": 30, "threshold_inr": 10000, "notes": "30% on winnings exceeding Rs 10,000"}', 1.0, 'Income Tax Act 1961', true),

-- Section 194C — Contractor payments (most common in B2B invoices)
('tds_section', '{"section": "194C", "description": "Payment to contractors"}',
  '{"rate_individual": 1, "rate_huf": 1, "rate_company": 2, "threshold_inr_single": 30000, "threshold_inr_aggregate": 100000, "notes": "1% for individuals/HUF, 2% for companies. No TDS if single payment < 30K AND aggregate < 1L."}', 1.0, 'Income Tax Act 1961', true),

-- Section 194D — Insurance commission
('tds_section', '{"section": "194D", "description": "Insurance commission"}',
  '{"rate_individual": 5, "rate_company": 10, "threshold_inr": 15000, "notes": ""}', 1.0, 'Income Tax Act 1961', true),

-- Section 194G — Commission on sale of lottery tickets
('tds_section', '{"section": "194G", "description": "Commission on lottery tickets"}',
  '{"rate_individual": 5, "rate_company": 5, "threshold_inr": 15000, "notes": ""}', 1.0, 'Income Tax Act 1961', true),

-- Section 194H — Commission or brokerage
('tds_section', '{"section": "194H", "description": "Commission or brokerage"}',
  '{"rate_individual": 5, "rate_company": 5, "threshold_inr": 15000, "notes": "Excludes insurance commission (194D) and securities brokerage"}', 1.0, 'Income Tax Act 1961', true),

-- Section 194I — Rent (very common in CA firm client invoices)
('tds_section', '{"section": "194I", "description": "Rent"}',
  '{"rate_land_building": 10, "rate_plant_machinery": 2, "threshold_inr": 240000, "notes": "10% on rent of land/building/furniture; 2% on plant & machinery. Threshold Rs 2,40,000 per year."}', 1.0, 'Income Tax Act 1961', true),

-- Section 194IA — Transfer of immovable property
('tds_section', '{"section": "194IA", "description": "Transfer of immovable property (other than agricultural land)"}',
  '{"rate_individual": 1, "rate_company": 1, "threshold_inr": 5000000, "notes": "1% on sale consideration exceeding Rs 50 lakhs"}', 1.0, 'Income Tax Act 1961', true),

-- Section 194IB — Rent by individual/HUF (monthly)
('tds_section', '{"section": "194IB", "description": "Rent paid by individual/HUF (not liable for tax audit)"}',
  '{"rate_individual": 5, "threshold_inr_monthly": 50000, "notes": "5% if monthly rent exceeds Rs 50,000. One-time deduction at end of year or tenancy."}', 1.0, 'Income Tax Act 1961', true),

-- Section 194J — Professional/technical fees (very common)
('tds_section', '{"section": "194J", "description": "Professional or technical fees, royalty, non-compete"}',
  '{"rate_professional": 10, "rate_technical": 2, "rate_royalty": 10, "threshold_inr": 30000, "notes": "10% on professional fees; 2% on technical services. Threshold Rs 30,000 per year. Directors: no threshold."}', 1.0, 'Income Tax Act 1961', true),

-- Section 194K — Income from mutual fund units
('tds_section', '{"section": "194K", "description": "Income from mutual fund units"}',
  '{"rate_individual": 10, "rate_company": 10, "threshold_inr": 5000, "notes": "10% on income exceeding Rs 5,000"}', 1.0, 'Income Tax Act 1961', true),

-- Section 194LA — Compensation on compulsory acquisition
('tds_section', '{"section": "194LA", "description": "Compensation on compulsory acquisition of immovable property"}',
  '{"rate_individual": 10, "rate_company": 10, "threshold_inr": 250000, "notes": "10% on compensation exceeding Rs 2,50,000"}', 1.0, 'Income Tax Act 1961', true),

-- Section 194LB — Interest from infrastructure debt fund
('tds_section', '{"section": "194LB", "description": "Interest from infrastructure debt fund"}',
  '{"rate_individual": 5, "rate_company": 5, "threshold_inr": 0, "notes": "5% — no threshold"}', 1.0, 'Income Tax Act 1961', true),

-- Section 194M — Payment by individual/HUF (contractor + professional > 50L)
('tds_section', '{"section": "194M", "description": "Payment by individual/HUF to contractor/professional > 50L"}',
  '{"rate_individual": 5, "rate_huf": 5, "threshold_inr": 5000000, "notes": "5% where aggregate payment > Rs 50 lakhs in a year. Applies only to individual/HUF not liable for audit."}', 1.0, 'Income Tax Act 1961', true),

-- Section 194N — Cash withdrawal from bank
('tds_section', '{"section": "194N", "description": "Cash withdrawal exceeding threshold"}',
  '{"rate_with_itr": 2, "rate_without_itr": 5, "threshold_inr": 10000000, "notes": "2% if ITR filed for last 3 years; 5% otherwise. On cash withdrawal > Rs 1 crore from a bank in a year."}', 1.0, 'Income Tax Act 1961', true),

-- Section 194O — E-commerce payments
('tds_section', '{"section": "194O", "description": "E-commerce operator payments to participant"}',
  '{"rate_individual": 1, "rate_company": 1, "threshold_inr": 500000, "notes": "1% on gross sale by e-commerce participants > Rs 5 lakhs"}', 1.0, 'Income Tax Act 1961', true),

-- Section 194Q — Purchase of goods
('tds_section', '{"section": "194Q", "description": "Purchase of goods exceeding 50 lakhs"}',
  '{"rate_individual": 0.1, "rate_company": 0.1, "threshold_inr": 5000000, "notes": "0.1% on amount exceeding Rs 50 lakhs from a single seller in a year. Buyer must have turnover > 10Cr."}', 1.0, 'Income Tax Act 1961', true),

-- ============================================================
-- D. REVERSE CHARGE MECHANISM (RCM) RULES
-- ============================================================

('reverse_charge', '{"service": "Goods Transport Agency (GTA)", "sac": "9965"}',
  '{"rcm_applicable": true, "recipient_pays_gst": true, "rate": 5, "notes": "GTA services to registered person — recipient pays 5% GST under RCM if GTA opts for 5% without ITC"}', 1.0, 'Notification 13/2017-CT(Rate)', true),

('reverse_charge', '{"service": "Legal services by advocate", "sac": "998211"}',
  '{"rcm_applicable": true, "recipient_pays_gst": true, "rate": 18, "notes": "Legal services by individual advocate/firm to business entity — RCM applies at 18%"}', 1.0, 'Notification 13/2017-CT(Rate)', true),

('reverse_charge', '{"service": "Director services to company", "sac": "998511"}',
  '{"rcm_applicable": true, "recipient_pays_gst": true, "rate": 18, "notes": "Services by director to company — company pays GST under RCM at 18%"}', 1.0, 'Notification 13/2017-CT(Rate)', true),

('reverse_charge', '{"service": "Import of services", "sac": "any"}',
  '{"rcm_applicable": true, "recipient_pays_gst": true, "rate_igst": 18, "notes": "All service imports from outside India — IGST at applicable rate under RCM by Indian recipient"}', 1.0, 'IGST Act Section 5(3)', true),

('reverse_charge', '{"service": "Security services by unregistered person", "sac": "9985"}',
  '{"rcm_applicable": true, "recipient_pays_gst": true, "rate": 18, "notes": "Security services by unregistered person to registered business — RCM at 18%"}', 1.0, 'Notification 29/2018-CT(Rate)', true),

('reverse_charge', '{"service": "Renting of residential dwelling", "sac": "9972"}',
  '{"rcm_applicable": true, "recipient_pays_gst": true, "rate": 18, "notes": "Registered person renting residential property from unregistered owner — RCM at 18% from Jul 2022"}', 1.0, 'Notification 05/2022-CT(Rate)', true),

-- ============================================================
-- E. INVOICE MATCHING HEURISTICS
-- ============================================================

('matching_heuristic', '{"name": "exact_amount_match", "priority": 1}',
  '{"score": 50, "description": "Invoice total matches bank transaction amount exactly (±0.01 rounding)", "confidence_boost": 0.4}', 1.0, 'LedgerIQ matching engine', true),

('matching_heuristic', '{"name": "close_amount_match", "priority": 2}',
  '{"score": 30, "description": "Invoice total within ±2% of bank transaction (TDS/GST rounding diff)", "confidence_boost": 0.2}', 1.0, 'LedgerIQ matching engine', true),

('matching_heuristic', '{"name": "date_within_30_days", "priority": 3}',
  '{"score": 20, "description": "Bank transaction date within 30 days of invoice date (payment cycle)", "confidence_boost": 0.15}', 1.0, 'LedgerIQ matching engine', true),

('matching_heuristic', '{"name": "date_within_7_days", "priority": 4}',
  '{"score": 30, "description": "Bank transaction date within 7 days of invoice due date", "confidence_boost": 0.25}', 1.0, 'LedgerIQ matching engine', true),

('matching_heuristic', '{"name": "invoice_number_in_reference", "priority": 5}',
  '{"score": 40, "description": "Invoice number appears in bank transaction narration/reference", "confidence_boost": 0.35}', 1.0, 'LedgerIQ matching engine', true),

('matching_heuristic', '{"name": "vendor_name_in_reference", "priority": 6}',
  '{"score": 25, "description": "Vendor name (or abbreviation) appears in bank transaction narration", "confidence_boost": 0.2}', 1.0, 'LedgerIQ matching engine', true),

('matching_heuristic', '{"name": "neft_imps_rtgs_utr", "priority": 7}',
  '{"score": 35, "description": "UTR/NEFT/RTGS reference number in invoice payment_reference matches bank UTR", "confidence_boost": 0.35}', 1.0, 'LedgerIQ matching engine', true),

('matching_heuristic', '{"name": "tds_deducted_amount", "priority": 8}',
  '{"score": 20, "description": "Bank amount = invoice_total - tds_amount (payment after TDS deduction)", "confidence_boost": 0.2}', 1.0, 'LedgerIQ matching engine', true),

-- ============================================================
-- F. ITC ELIGIBILITY RULES
-- ============================================================

('itc_eligibility', '{"category": "Motor vehicles for personal use"}',
  '{"itc_allowed": false, "reason": "Section 17(5)(a): ITC blocked on motor vehicles for < 13 persons (excluding driver) unless used for supply of vehicles, transport, driving school or related services"}', 1.0, 'CGST Act Section 17(5)', true),

('itc_eligibility', '{"category": "Food and beverages"}',
  '{"itc_allowed": false, "reason": "Section 17(5)(b): ITC blocked on food, beverages, outdoor catering unless recipient makes same category supply"}', 1.0, 'CGST Act Section 17(5)', true),

('itc_eligibility', '{"category": "Health and fitness club membership"}',
  '{"itc_allowed": false, "reason": "Section 17(5)(b): ITC blocked on health services, cosmetic/plastic surgery, life insurance unless employee benefit is statutory obligation"}', 1.0, 'CGST Act Section 17(5)', true),

('itc_eligibility', '{"category": "Construction of immovable property"}',
  '{"itc_allowed": false, "reason": "Section 17(5)(d): ITC blocked on goods/services used for construction of immovable property (own use), even if capitalised in books"}', 1.0, 'CGST Act Section 17(5)', true),

('itc_eligibility', '{"category": "Works contract for immovable property"}',
  '{"itc_allowed": false, "reason": "Section 17(5)(c): ITC on works contract for construction/renovation of immovable property blocked (exceptions: further supply of works contract)"}', 1.0, 'CGST Act Section 17(5)', true),

('itc_eligibility', '{"category": "Employee benefits — gifts > 50,000"}',
  '{"itc_allowed": false, "reason": "Section 17(5)(h): ITC blocked on gifts/free samples given to any person. Gifts up to Rs 50,000 per person per year are blocked."}', 1.0, 'CGST Act Section 17(5)', true),

('itc_eligibility', '{"category": "Capital goods for exempt supplies"}',
  '{"itc_allowed": false, "reason": "Section 17(2): ITC on capital goods used exclusively for exempt supplies is blocked. Proportionate ITC reversal for common use."}', 1.0, 'CGST Act Section 17(2)', true),

('itc_eligibility', '{"category": "Professional services — legal, accounting, IT"}',
  '{"itc_allowed": true, "reason": "ITC fully allowed when used for business purposes (taxable supply). Vendor must be GST-registered and invoice must be valid."}', 1.0, 'CGST Act Section 16', true),

('itc_eligibility', '{"category": "Office supplies and stationery"}',
  '{"itc_allowed": true, "reason": "ITC allowed on office supplies when used for business (taxable supply). No blocking provision applies."}', 1.0, 'CGST Act Section 16', true),

('itc_eligibility', '{"category": "Plant and machinery"}',
  '{"itc_allowed": true, "reason": "ITC allowed on plant & machinery unless used exclusively for personal or exempt supply. Proportionate reversal for mixed use."}', 1.0, 'CGST Act Section 17', true),

('itc_eligibility', '{"category": "Rent for office space"}',
  '{"itc_allowed": true, "reason": "ITC allowed on commercial rent. For residential property under RCM (from Jul 2022), ITC available if used for business."}', 1.0, 'CGST Act Section 16', true);
