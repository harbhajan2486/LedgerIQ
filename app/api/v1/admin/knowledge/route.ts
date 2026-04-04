import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

export async function GET() {
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
    .select("id, rule_type, pattern, action, confidence, source, created_at")
    .eq("is_active", false)
    .order("created_at", { ascending: false });

  // For each pending rule, count how many tenants triggered it
  // The source field contains tenant info when promoted from Layer 2
  const pending = (rules ?? []).map((r) => ({
    id: r.id,
    rule_type: r.rule_type,
    pattern: r.pattern,
    action: r.action,
    confidence: r.confidence,
    tenant_count: r.source?.tenant_count ?? 10,
    example_tenants: r.source?.example_tenants ?? [],
    created_at: r.created_at,
  }));

  return NextResponse.json({ pending });
}
