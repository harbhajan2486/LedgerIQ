import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const TDS_RULES = [
  {
    rule_type: "tds_section",
    pattern: { section: "194J", description: "Professional/technical services", keywords: ["advocate","lawyer","legal","attorney","solicitor","chartered accountant","ca firm","audit","consultant","advisory","architect","doctor","physician","surgeon","hospital","clinic","medical","it service","software","technology","technical service"] },
    action: { rate: 10, threshold_single: 30000, notes: "Professional/technical services fee, royalty" },
    source: "Income Tax Act 1961, Section 194J",
  },
  {
    rule_type: "tds_section",
    pattern: { section: "194C", description: "Payments to contractors", keywords: ["transport","courier","logistics","freight","cargo","delivery","shipping","contractor","construction","civil","builder","fabricat","manufactur","printing","advertis","media","catering","housekeeping","security guard","manpower","labour"] },
    action: { rate_company: 2, rate_individual: 1, threshold_single: 30000, threshold_aggregate: 100000, notes: "Individual/HUF 1%, Company/others 2%" },
    source: "Income Tax Act 1961, Section 194C",
  },
  {
    rule_type: "tds_section",
    pattern: { section: "194I", description: "Rent", keywords: ["rent","rental","lease","premises","office space","warehouse","godown","property"] },
    action: { rate_land_building: 10, rate_plant_machinery: 2, threshold_aggregate: 240000, notes: "Land/building/furniture 10%, Plant/machinery 2%" },
    source: "Income Tax Act 1961, Section 194I",
  },
  {
    rule_type: "tds_section",
    pattern: { section: "194H", description: "Commission or brokerage", keywords: ["commission","brokerage","broker","agent","referral fee","dealership","franchise"] },
    action: { rate: 5, threshold_aggregate: 15000, notes: "5% on commission or brokerage" },
    source: "Income Tax Act 1961, Section 194H",
  },
  {
    rule_type: "tds_section",
    pattern: { section: "194A", description: "Interest other than on securities", keywords: ["interest","fd interest","fixed deposit","ncd interest","deposit interest","loan interest"] },
    action: { rate: 10, threshold_bank: 40000, threshold_other: 5000, notes: "Bank 40k threshold, others 5k" },
    source: "Income Tax Act 1961, Section 194A",
  },
  {
    rule_type: "tds_section",
    pattern: { section: "194D", description: "Insurance commission", keywords: ["insurance commission","lic commission","insurance agent","insurance broker"] },
    action: { rate: 5, threshold_aggregate: 15000 },
    source: "Income Tax Act 1961, Section 194D",
  },
  {
    rule_type: "tds_section",
    pattern: { section: "194Q", description: "Purchase of goods", keywords: ["purchase","goods purchase","material purchase","raw material","stock purchase"] },
    action: { rate: 0.1, threshold_aggregate: 5000000, notes: "Annual purchase from single seller exceeds 50 lakhs" },
    source: "Income Tax Act 1961, Section 194Q",
  },
  {
    rule_type: "tds_section",
    pattern: { section: "194O", description: "E-commerce operator payments", keywords: ["amazon","flipkart","zomato","swiggy","meesho","myntra","snapdeal","paytm mall","ecommerce"] },
    action: { rate: 1, threshold_aggregate: 500000, notes: "1% on gross sale via e-commerce platform" },
    source: "Income Tax Act 1961, Section 194O",
  },
];

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const rows = TDS_RULES.map((r) => ({
    rule_type:  r.rule_type,
    pattern:    r.pattern,
    action:     r.action,
    confidence: 1.0,
    source:     r.source,
    is_active:  true,
    layer:      1,
  }));

  const { error } = await supabase
    .from("global_rules")
    .upsert(rows, { ignoreDuplicates: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ seeded: rows.length });
}
