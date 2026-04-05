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

  const { data: mappings } = await supabase
    .from("tally_ledger_mappings")
    .select("standard_account, tally_ledger_name")
    .eq("tenant_id", tenantId);

  return NextResponse.json({ mappings: mappings ?? [] });
  } catch (err) {
    console.error("[settings/ledger-mapping] Unhandled error:", err);
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

  const { mappings } = await request.json();

  const rows = Object.entries(mappings)
    .filter(([, v]) => v && (v as string).trim() !== "")
    .map(([standard_account, tally_ledger_name]) => ({
      tenant_id: tenantId,
      standard_account,
      tally_ledger_name,
    }));

  if (rows.length > 0) {
    const { error } = await supabase
      .from("tally_ledger_mappings")
      .upsert(rows, { onConflict: "tenant_id,standard_account" });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await supabase.from("audit_log").insert({
    tenant_id: tenantId,
    user_id: user.id,
    action: "update_ledger_mappings",
    entity_type: "tenant",
    entity_id: tenantId,
    new_value: { mappings_saved: rows.length },
  });

  return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[settings/ledger-mapping] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
