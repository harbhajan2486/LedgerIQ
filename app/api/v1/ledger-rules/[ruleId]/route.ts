import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const patchSchema = z.object({
  ledger_name: z.string().min(1).optional(),
  pattern: z.string().min(1).max(50).optional(),
  confirmed: z.boolean().optional(),
  promote_to_industry: z.boolean().optional(), // if true, creates/upserts an industry-level rule
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

    const { promote_to_industry, ...updateFields } = parsed.data;

    // If promote_to_industry, fetch the rule + its client's industry, then upsert industry rule
    if (promote_to_industry) {
      const { data: rule } = await supabase
        .from("ledger_mapping_rules")
        .select("pattern, ledger_name, client_id")
        .eq("id", ruleId)
        .eq("tenant_id", profile.tenant_id)
        .single();
      if (!rule) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
      if (!rule.client_id) return NextResponse.json({ error: "Only client rules can be promoted" }, { status: 400 });

      const { data: clientRow } = await supabase
        .from("clients").select("industry_name").eq("id", rule.client_id).single();
      if (!clientRow?.industry_name) return NextResponse.json({ error: "Client has no industry set" }, { status: 400 });

      const { error: promoteError } = await supabase
        .from("ledger_mapping_rules")
        .upsert({
          tenant_id: profile.tenant_id,
          client_id: null,
          industry_name: clientRow.industry_name,
          pattern: rule.pattern,
          ledger_name: updateFields.ledger_name ?? rule.ledger_name,
          match_count: 1,
          confirmed: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,pattern,client_id" });
      if (promoteError) return NextResponse.json({ error: promoteError.message }, { status: 500 });
      return NextResponse.json({ success: true, promoted_to: clientRow.industry_name });
    }

    const { error } = await supabase
      .from("ledger_mapping_rules")
      .update({ ...updateFields, updated_at: new Date().toISOString() })
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
