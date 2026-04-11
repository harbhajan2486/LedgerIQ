import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

export async function GET() {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (profile?.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Pending rules = global_rules where is_active = false (awaiting super_admin approval)
  const { data: rules } = await sb
    .from("global_rules")
    .select("id, rule_type, rule_json, pattern, action, confidence, source, created_at")
    .eq("is_active", false)
    .order("created_at", { ascending: false });

  // For each pending rule, count how many tenants triggered it
  // The source field contains tenant info when promoted from Layer 2
  const pending = (rules ?? []).map((r) => ({
    id: r.id,
    rule_type: r.rule_type,
    pattern: r.pattern ?? r.rule_json,
    action: r.action ?? {},
    confidence: r.confidence ?? 0.8,
    tenant_count: (r.rule_json as Record<string, unknown>)?.tenant_count ?? 0,
    example_tenants: (r.rule_json as Record<string, unknown>)?.example_tenants ?? [],
    created_at: r.created_at,
  }));

  return NextResponse.json({ pending });
  } catch (err) {
    console.error("[admin/knowledge] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
