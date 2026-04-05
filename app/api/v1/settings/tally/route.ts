import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

async function getTenantId(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", userId)
    .single();
  return profile?.tenant_id ?? null;
}

export async function GET() {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const tenantId = await getTenantId(supabase, user.id);
  if (!tenantId) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const { data: tenant } = await supabase
    .from("tenants")
    .select("tally_endpoint, tally_company_name")
    .eq("id", tenantId)
    .single();

  return NextResponse.json({
    endpoint: tenant?.tally_endpoint ?? "",
    company: tenant?.tally_company_name ?? "",
  });
  } catch (err) {
    console.error("[settings/tally] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const tenantId = await getTenantId(supabase, user.id);
  if (!tenantId) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const { endpoint, company } = await request.json();

  const updates: Record<string, string> = {};
  if (endpoint !== undefined) updates.tally_endpoint = endpoint;
  if (company !== undefined) updates.tally_company_name = company;

  const { error } = await supabase
    .from("tenants")
    .update(updates)
    .eq("id", tenantId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("audit_log").insert({
    tenant_id: tenantId,
    user_id: user.id,
    action: "update_tally_config",
    entity_type: "tenant",
    entity_id: tenantId,
    new_value: updates,
  });

  return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[settings/tally] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
