-- Migration 014: Add SAC 998313 (drone/aerial photography) and 194C drone/media keywords to Layer 1
-- Fixes Gap 1 (HSN/SAC) and Gap 2 (TDS 194C for drone services) identified in Drone 3E audit

INSERT INTO global_rules (layer, rule_type, rule_json, pattern, action, confidence, source, is_active) VALUES

-- SAC 998313: Drone photography / aerial videography / aerial survey @ 18% GST
(1, 'sac_gst_rate',
 '{"sac_prefix":"998313","description":"Drone photography, aerial videography and survey services","igst_rate":18}',
 '{"sac_prefix":"998313","description":"Drone photography, aerial videography, aerial survey, filming services","keywords":["drone","aerial photography","videography","aerial survey","filming","cinematography","photo shoot","video shoot","media production"]}',
 '{"cgst_rate":9,"sgst_rate":9,"igst_rate":18,"notes":"Aerial photography and videography services — SAC 998313, taxable at 18%"}',
 1.0, 'CGST Act Schedule IV — SAC 998313 (Aerial photography and videography services)', true),

-- 194C extended: drone, aerial, media production work contracts
(1, 'tds_section',
 '{"section":"194C","description":"Work contracts — drone services, media production, aerial survey","rate_company":2,"rate_individual":1,"threshold_single":30000,"threshold_aggregate":100000}',
 '{"section":"194C","description":"Drone photography, aerial videography, media production, content creation — these are work contracts under 194C per CBDT guidance","keywords":["drone","aerial photography","videography","filming","aerial survey","cinematography","photo shoot","video shoot","content production","media production"]}',
 '{"rate_company":2,"rate_individual":1,"rate_huf":1,"threshold_inr_single":30000,"threshold_inr_aggregate":100000,"notes":"Drone and media production services are work contracts under 194C. CBDT: drone-based execution of specific work/shoot = contract, not technical service. 2% for companies, 1% for individuals/HUF."}',
 1.0, 'Income Tax Act 1961 S.194C — CBDT guidance on drone/aerial/media work contracts', true),

-- SAC 998314: IT / software / data processing services @ 18%
(1, 'sac_gst_rate',
 '{"sac_prefix":"998314","description":"IT and software services","igst_rate":18}',
 '{"sac_prefix":"998314","description":"Information technology, software development, data processing, cloud services","keywords":["software","IT service","SaaS","technology","data processing","cloud","web development"]}',
 '{"cgst_rate":9,"sgst_rate":9,"igst_rate":18,"notes":"IT and information technology services — SAC 998314, 18% GST"}',
 1.0, 'CGST Act Schedule IV — SAC 998314 (IT and software services)', true),

-- SAC 998361: Advertising and media services @ 18%
(1, 'sac_gst_rate',
 '{"sac_prefix":"998361","description":"Advertising and media services","igst_rate":18}',
 '{"sac_prefix":"998361","description":"Advertising, media buying, PR, promotional services","keywords":["advertising","media agency","PR agency","promotional","campaign","media buying"]}',
 '{"cgst_rate":9,"sgst_rate":9,"igst_rate":18,"notes":"Advertising and related services — SAC 998361, 18% GST"}',
 1.0, 'CGST Act Schedule IV — SAC 998361 (Advertising services)', true)

ON CONFLICT DO NOTHING;

SELECT 'Migration 014 applied: SAC 998313 drone/aerial, extended 194C drone/media, SAC 998314 IT, SAC 998361 advertising added to Layer 1' AS result;
