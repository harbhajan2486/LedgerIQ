import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { endpoint, companyName } = await request.json();

  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .single();

  if (!profile?.tenant_id) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
  }

  const { error } = await supabase
    .from("tenants")
    .update({ tally_endpoint: endpoint })
    .eq("id", profile.tenant_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("audit_log").insert({
    tenant_id: profile.tenant_id,
    user_id: user.id,
    action: "update_tally_config",
    entity_type: "tenant",
    entity_id: profile.tenant_id,
    new_value: { endpoint, companyName },
  });

  return NextResponse.json({ success: true });
}
