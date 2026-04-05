import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("role").eq("id", user.id).single();
    if (profile?.role !== "super_admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Count vendor profiles per tenant
    const { data: profiles } = await supabase
      .from("vendor_profiles")
      .select("tenant_id");

    // Count corrections per tenant
    const { data: corrections } = await supabase
      .from("corrections")
      .select("tenant_id");

    // Count tenants that have at least 1 vendor profile
    const tenantProfileCounts: Record<string, number> = {};
    (profiles ?? []).forEach((p) => {
      tenantProfileCounts[p.tenant_id] = (tenantProfileCounts[p.tenant_id] ?? 0) + 1;
    });

    const tenantCorrectionCounts: Record<string, number> = {};
    (corrections ?? []).forEach((c) => {
      tenantCorrectionCounts[c.tenant_id] = (tenantCorrectionCounts[c.tenant_id] ?? 0) + 1;
    });

    const tenantIds = Object.keys(tenantProfileCounts);

    // Get tenant names
    const { data: tenants } = await supabase
      .from("tenants")
      .select("id, name")
      .in("id", tenantIds.length > 0 ? tenantIds : ["00000000-0000-0000-0000-000000000000"]);

    const tenantNameMap: Record<string, string> = {};
    (tenants ?? []).forEach((t) => { tenantNameMap[t.id] = t.name; });

    const topTrained = Object.entries(tenantProfileCounts)
      .map(([tid, profileCount]) => ({
        tenant_name: tenantNameMap[tid] ?? "Unknown",
        profile_count: profileCount,
        correction_count: tenantCorrectionCounts[tid] ?? 0,
      }))
      .sort((a, b) => b.correction_count - a.correction_count)
      .slice(0, 10);

    return NextResponse.json({
      tenant_count: tenantIds.length,
      total_vendor_profiles: profiles?.length ?? 0,
      total_corrections: corrections?.length ?? 0,
      top_trained_tenants: topTrained,
    });
  } catch (err) {
    console.error("[admin/knowledge/layer3]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
