import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

// POST /api/v1/ledger-rules/copy
// Copy confirmed client rules from one client to another
const schema = z.object({
  from_client_id: z.string().uuid(),
  to_client_id: z.string().uuid(),
  rule_ids: z.array(z.string().uuid()).optional(), // if omitted, copy all confirmed rules
});

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });

    const { from_client_id, to_client_id, rule_ids } = parsed.data;
    if (from_client_id === to_client_id) return NextResponse.json({ error: "Source and target client must differ" }, { status: 400 });

    // Verify both clients belong to this tenant
    const { data: clientCheck } = await supabase
      .from("clients")
      .select("id")
      .eq("tenant_id", profile.tenant_id)
      .in("id", [from_client_id, to_client_id]);
    if ((clientCheck ?? []).length < 2) return NextResponse.json({ error: "Client not found" }, { status: 404 });

    // Fetch source rules
    let query = supabase
      .from("ledger_mapping_rules")
      .select("pattern, ledger_name")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", from_client_id)
      .eq("confirmed", true);
    if (rule_ids?.length) query = query.in("id", rule_ids);
    const { data: sourceRules } = await query;

    if (!sourceRules?.length) return NextResponse.json({ copied: 0 });

    // Get existing patterns for target client to avoid duplicates
    const { data: existing } = await supabase
      .from("ledger_mapping_rules")
      .select("pattern")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", to_client_id);
    const existingPatterns = new Set((existing ?? []).map(r => r.pattern));

    const toInsert = sourceRules
      .filter(r => !existingPatterns.has(r.pattern))
      .map(r => ({
        tenant_id: profile.tenant_id,
        client_id: to_client_id,
        pattern: r.pattern,
        ledger_name: r.ledger_name,
        match_count: 1,
        confirmed: true,
      }));

    if (toInsert.length === 0) return NextResponse.json({ copied: 0, skipped: sourceRules.length });

    const { error } = await supabase.from("ledger_mapping_rules").insert(toInsert);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ copied: toInsert.length, skipped: sourceRules.length - toInsert.length });
  } catch (err) {
    console.error("[ledger-rules/copy POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
