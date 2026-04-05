import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  try {
  const { ruleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (profile?.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error } = await sb
    .from("global_rules")
    .update({ is_active: true, approved_by: user.id, approved_at: new Date().toISOString() })
    .eq("id", ruleId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit log
  await sb.from("audit_log").insert({
    user_id: user.id,
    action: "approve_global_rule",
    entity_type: "global_rule",
    entity_id: ruleId,
    new_value: { approved: true },
  });

  return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[admin/knowledge/approve] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
