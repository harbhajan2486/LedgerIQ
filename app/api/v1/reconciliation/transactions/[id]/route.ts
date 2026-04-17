import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { extractPattern } from "@/lib/ledger-rules";

const patchSchema = z.object({
  category:     z.string().optional(),
  voucher_type: z.string().optional(),
  ledger_name:  z.string().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { id } = await params;
    const body = await request.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

    const { error } = await supabase
      .from("bank_transactions")
      .update(parsed.data)
      .eq("id", id)
      .eq("tenant_id", profile.tenant_id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // If ledger_name was set, learn the pattern for this client
    if (parsed.data.ledger_name) {
      const { data: txn } = await supabase
        .from("bank_transactions")
        .select("narration, client_id")
        .eq("id", id)
        .single();

      if (txn?.narration && txn.client_id) {
        const pattern = extractPattern(txn.narration);
        if (pattern) {
          // ── Layer 3: upsert client-level rule ──────────────────────────────
          const { data: existing } = await supabase
            .from("ledger_mapping_rules")
            .select("id, match_count")
            .eq("tenant_id", profile.tenant_id)
            .eq("client_id", txn.client_id)
            .eq("pattern", pattern)
            .single();

          let newCount = 1;
          if (existing) {
            newCount = (existing.match_count ?? 1) + 1;
            await supabase
              .from("ledger_mapping_rules")
              .update({ ledger_name: parsed.data.ledger_name, match_count: newCount, confirmed: newCount >= 3, updated_at: new Date().toISOString() })
              .eq("id", existing.id);
          } else {
            await supabase.from("ledger_mapping_rules").insert({
              tenant_id: profile.tenant_id,
              client_id: txn.client_id,
              pattern,
              ledger_name: parsed.data.ledger_name,
              match_count: 1,
              confirmed: false,
            });
          }

          // ── Industry promotion: check if 3+ confirmed clients in same industry share this pattern → ledger ──
          try {
            // Get industry for this client
            const { data: clientRow } = await supabase
              .from("clients")
              .select("industry_name")
              .eq("id", txn.client_id)
              .single();

            const industry = clientRow?.industry_name;
            if (industry) {
              // Count distinct confirmed client rules for this pattern+ledger in this industry
              const { data: clientsInIndustry } = await supabase
                .from("clients")
                .select("id")
                .eq("tenant_id", profile.tenant_id)
                .eq("industry_name", industry);

              const industryClientIds = (clientsInIndustry ?? []).map((c) => c.id);
              if (industryClientIds.length >= 3) {
                const { data: confirmedRules } = await supabase
                  .from("ledger_mapping_rules")
                  .select("client_id")
                  .eq("tenant_id", profile.tenant_id)
                  .eq("pattern", pattern)
                  .eq("ledger_name", parsed.data.ledger_name)
                  .eq("confirmed", true)
                  .in("client_id", industryClientIds);

                if ((confirmedRules ?? []).length >= 3) {
                  // Promote to industry rule (Layer 2)
                  await supabase.from("ledger_mapping_rules").upsert(
                    {
                      tenant_id: profile.tenant_id,
                      client_id: null,
                      industry_name: industry,
                      pattern,
                      ledger_name: parsed.data.ledger_name,
                      match_count: (confirmedRules ?? []).length,
                      confirmed: true,
                      updated_at: new Date().toISOString(),
                    },
                    { onConflict: "tenant_id,industry_name,pattern" }
                  );
                }
              }
            }
          } catch {
            // Industry promotion is best-effort; never block the main save
          }
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[transactions/patch]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
