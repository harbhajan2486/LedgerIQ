import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET  — list nominations (admin only)
// POST — approve or reject a nomination
export async function GET(_request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id, role").eq("id", user.id).single();
    if (profile?.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });

    const { data: nominations } = await supabase
      .from("global_rule_nominations")
      .select("id, pattern, ledger_name, industry_name, rcm_applicable, tds_section, suggested_gst_rate, tenant_count, total_confirmations, status, rejection_reason, approved_at, created_at, updated_at")
      .order("tenant_count", { ascending: false });

    return NextResponse.json({ nominations: nominations ?? [] });
  } catch (err) {
    console.error("[admin/nominations GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id, role").eq("id", user.id).single();
    if (profile?.role !== "admin") return NextResponse.json({ error: "Admin only" }, { status: 403 });

    const { nominationId, action, rejectionReason } = await request.json();
    if (!nominationId || !["approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "nominationId and action (approve|reject) required" }, { status: 400 });
    }

    const update =
      action === "approve"
        ? { status: "approved", approved_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        : { status: "rejected", rejection_reason: rejectionReason ?? null, updated_at: new Date().toISOString() };

    const { error } = await supabase
      .from("global_rule_nominations")
      .update(update)
      .eq("id", nominationId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await supabase.from("audit_log").insert({
      tenant_id: profile.tenant_id,
      user_id: user.id,
      action: `global_rule_${action}`,
      entity_type: "global_rule_nomination",
      entity_id: nominationId,
      new_value: update,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[admin/nominations POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
