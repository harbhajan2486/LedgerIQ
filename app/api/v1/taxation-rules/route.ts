import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/v1/taxation-rules
// Returns all global_rules for the taxation display: tds_section, hsn_gst_rate, sac_gst_rate, reverse_charge, itc_eligibility
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data, error } = await supabase
      .from("global_rules")
      .select("id, rule_type, pattern, action, source, confidence, is_active")
      .in("rule_type", ["tds_section", "hsn_gst_rate", "sac_gst_rate", "reverse_charge", "itc_eligibility"])
      .eq("is_active", true)
      .order("rule_type")
      .order("id");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = data ?? [];
    return NextResponse.json({
      tds_sections:    rows.filter(r => r.rule_type === "tds_section"),
      hsn_gst_rates:   rows.filter(r => r.rule_type === "hsn_gst_rate"),
      sac_gst_rates:   rows.filter(r => r.rule_type === "sac_gst_rate"),
      reverse_charges: rows.filter(r => r.rule_type === "reverse_charge"),
      itc_eligibility: rows.filter(r => r.rule_type === "itc_eligibility"),
    });
  } catch (err) {
    console.error("[taxation-rules GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
