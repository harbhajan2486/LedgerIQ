import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

    const tenantId = profile.tenant_id;

    // Fetch all vendor profiles for this tenant
    const { data: vendors } = await supabase
      .from("vendor_profiles")
      .select("id, vendor_name, gstin, tds_category, invoice_quirks, last_updated")
      .eq("tenant_id", tenantId)
      .order("last_updated", { ascending: false });

    // Count corrections per vendor by matching vendor_name through extractions→documents
    const { data: corrections } = await supabase
      .from("corrections")
      .select("id, extraction_id, wrong_value, correct_value, corrected_at, extractions(field_name, documents(original_filename))")
      .eq("tenant_id", tenantId)
      .order("corrected_at", { ascending: false })
      .limit(500);

    // Group corrections by vendor name (from vendor_profiles.invoice_quirks keys cross-ref)
    // Simple approach: count all corrections per document, then surface totals
    const totalCorrections = corrections?.length ?? 0;

    // Build per-vendor correction counts by checking if vendor name appears in corrections context
    const vendorData = (vendors ?? []).map((v) => {
      const quirks = v.invoice_quirks as Record<string, string>;
      const learnedFields = Object.keys(quirks);
      return {
        id: v.id,
        vendor_name: v.vendor_name,
        gstin: v.gstin,
        tds_category: v.tds_category,
        learned_fields: learnedFields,
        learned_values: quirks,
        last_updated: v.last_updated,
        field_count: learnedFields.length,
      };
    });

    return NextResponse.json({
      vendors: vendorData,
      total_vendors: vendorData.length,
      total_corrections: totalCorrections,
      total_learned_fields: vendorData.reduce((s, v) => s + v.field_count, 0),
    });
  } catch (err) {
    console.error("[knowledge/vendors]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
