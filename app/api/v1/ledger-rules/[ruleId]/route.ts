import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const patchSchema = z.object({
  ledger_name: z.string().min(1).optional(),
  pattern: z.string().min(1).max(50).optional(),
  confirmed: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { ruleId } = await params;
    const body = await request.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

    const { error } = await supabase
      .from("ledger_mapping_rules")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", ruleId)
      .eq("tenant_id", profile.tenant_id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[ledger-rules PATCH]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ ruleId: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { ruleId } = await params;

    const { error } = await supabase
      .from("ledger_mapping_rules")
      .delete()
      .eq("id", ruleId)
      .eq("tenant_id", profile.tenant_id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[ledger-rules DELETE]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
