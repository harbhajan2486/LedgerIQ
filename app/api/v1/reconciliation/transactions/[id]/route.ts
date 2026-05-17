import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { extractPattern, ledgerToMeta } from "@/lib/ledger-rules";
import { tryNominate } from "@/lib/global-rules";

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

    // When ledger_name is being set, also sync category + voucher_type
    const updatePayload: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.ledger_name && !parsed.data.category) {
      const meta = ledgerToMeta(parsed.data.ledger_name);
      if (meta) { updatePayload.category = meta.category; updatePayload.voucher_type = meta.voucher_type; }
    }

    const { error } = await supabase
      .from("bank_transactions")
      .update(updatePayload)
      .eq("id", id)
      .eq("tenant_id", profile.tenant_id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    let ruleJustConfirmed = false;
    let rulePattern = "";
    let ruleLedger = "";
    let ruleMatchCount = 0;

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
          ruleJustConfirmed = newCount === 3;
          ruleMatchCount = newCount;
          rulePattern = pattern;
          ruleLedger = parsed.data.ledger_name;

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

                  // ── Layer 2 → cross-tenant nomination ─────────────────────────
                  // Nominate this pattern for global Layer 1 (admin must approve).
                  // Tax metadata (RCM, TDS section) fetched from linked invoice if available.
                  try {
                    const { data: relatedDoc } = await supabase
                      .from("reconciliations")
                      .select("document_id")
                      .eq("tenant_id", profile.tenant_id)
                      .eq("bank_transaction_id", id)
                      .single();
                    let rcmApplicable = false;
                    let tdsSection: string | null = null;
                    let suggestedGstRate: number | null = null;
                    if (relatedDoc?.document_id) {
                      const { data: taxExts } = await supabase
                        .from("extractions")
                        .select("field_name, extracted_value")
                        .eq("document_id", relatedDoc.document_id)
                        .in("field_name", ["reverse_charge", "tds_section", "gst_rate"])
                        .in("status", ["accepted", "corrected"]);
                      for (const e of taxExts ?? []) {
                        if (e.field_name === "reverse_charge" && e.extracted_value?.toLowerCase() === "yes") rcmApplicable = true;
                        if (e.field_name === "tds_section") tdsSection = e.extracted_value;
                        if (e.field_name === "gst_rate") suggestedGstRate = parseFloat(e.extracted_value) || null;
                      }
                    }
                    void tryNominate({
                      pattern,
                      ledgerName: parsed.data.ledger_name,
                      industryName: industry,
                      tenantId: profile.tenant_id,
                      rcmApplicable,
                      tdsSection,
                      suggestedGstRate,
                    });
                  } catch { /* best-effort */ }
                }
              }
            }
          } catch {
            // Industry promotion is best-effort; never block the main save
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      // Always return match progress so UI can show "Learning (X/3)"
      ...(ruleMatchCount > 0 ? {
        match_count: ruleMatchCount,
        rule_confirmed: ruleJustConfirmed,
        pattern: rulePattern,
        ledger: ruleLedger,
      } : {}),
    });
  } catch (err) {
    console.error("[transactions/patch]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
