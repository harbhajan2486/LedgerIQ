import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { mappings } = await request.json();

  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .single();

  if (!profile?.tenant_id) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
  }

  // Upsert each ledger mapping
  const rows = Object.entries(mappings)
    .filter(([, v]) => v && (v as string).trim() !== "")
    .map(([standard_account, tally_ledger_name]) => ({
      tenant_id: profile.tenant_id,
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
    tenant_id: profile.tenant_id,
    user_id: user.id,
    action: "update_ledger_mappings",
    entity_type: "tenant",
    entity_id: profile.tenant_id,
    new_value: { mappings_saved: rows.length },
  });

  return NextResponse.json({ success: true });
}
