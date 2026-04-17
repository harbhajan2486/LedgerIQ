import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

// GET  /api/v1/ledger-rules?clientId=...  → all rules for tenant (client + industry)
// DELETE /api/v1/ledger-rules/:id         → handled in [id]/route.ts
// PATCH  /api/v1/ledger-rules/:id         → handled in [id]/route.ts

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");

    let query = supabase
      .from("ledger_mapping_rules")
      .select("id, client_id, industry_name, pattern, ledger_name, match_count, confirmed, updated_at")
      .eq("tenant_id", profile.tenant_id)
      .order("updated_at", { ascending: false });

    if (clientId) {
      // Return rules for this specific client + industry rules that apply to them
      const { data: clientRow } = await supabase
        .from("clients").select("industry_name").eq("id", clientId).single();
      const industryName = clientRow?.industry_name ?? null;

      // Client-level rules
      const { data: clientRules } = await supabase
        .from("ledger_mapping_rules")
        .select("id, client_id, industry_name, pattern, ledger_name, match_count, confirmed, updated_at")
        .eq("tenant_id", profile.tenant_id)
        .eq("client_id", clientId)
        .order("updated_at", { ascending: false });

      // Industry-level rules
      let industryRules: typeof clientRules = [];
      if (industryName) {
        const { data: ir } = await supabase
          .from("ledger_mapping_rules")
          .select("id, client_id, industry_name, pattern, ledger_name, match_count, confirmed, updated_at")
          .eq("tenant_id", profile.tenant_id)
          .eq("industry_name", industryName)
          .is("client_id", null)
          .order("updated_at", { ascending: false });
        industryRules = ir ?? [];
      }

      return NextResponse.json({
        client_rules: clientRules ?? [],
        industry_rules: industryRules,
        industry_name: industryName,
      });
    }

    // No clientId: return all rules for tenant grouped
    const { data: allRules } = await query;

    const clientRules = (allRules ?? []).filter((r) => r.client_id !== null);
    const industryRules = (allRules ?? []).filter((r) => r.client_id === null && r.industry_name !== null);

    return NextResponse.json({ client_rules: clientRules, industry_rules: industryRules });
  } catch (err) {
    console.error("[ledger-rules GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

const createSchema = z.object({
  client_id: z.string().uuid().nullable().optional(),
  industry_name: z.string().nullable().optional(),
  pattern: z.string().min(1).max(50),
  ledger_name: z.string().min(1),
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
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });

    const { client_id, industry_name, pattern, ledger_name } = parsed.data;

    const { data, error } = await supabase
      .from("ledger_mapping_rules")
      .insert({
        tenant_id: profile.tenant_id,
        client_id: client_id ?? null,
        industry_name: industry_name ?? null,
        pattern: pattern.toLowerCase().trim(),
        ledger_name,
        match_count: 1,
        confirmed: true, // manually created rules are auto-confirmed
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ rule: data });
  } catch (err) {
    console.error("[ledger-rules POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
