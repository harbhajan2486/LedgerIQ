import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { z } from "zod";
import { log } from "@/lib/logger";

const correctSchema = z.object({
  extractionId: z.string().uuid(),
  action: z.enum(["accept", "correct"]),
  correctValue: z.string().optional(),
});

// POST — record a correction or acceptance for a single field
// This is the core of the learning engine — every correction is persisted immediately
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const rl = await checkRateLimit(user.id);
  if (!rl.allowed) return rateLimitResponse(rl.resetAt);

  const { documentId } = await params;

  const body = await request.json();
  const parsed = correctSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const { extractionId, action, correctValue } = parsed.data;

  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .single();

  // Verify the extraction belongs to this tenant's document (RLS + explicit check)
  const { data: extraction, error: extError } = await supabase
    .from("extractions")
    .select("id, field_name, extracted_value, confidence, status, document_id")
    .eq("id", extractionId)
    .eq("tenant_id", profile?.tenant_id)
    .single();

  if (extError || !extraction) {
    return NextResponse.json({ error: "Extraction not found" }, { status: 404 });
  }

  const { data: doc } = await supabase
    .from("documents")
    .select("doc_fingerprint, document_type")
    .eq("id", documentId)
    .single();

  if (action === "accept") {
    await supabase.from("extractions").update({ status: "accepted" }).eq("id", extractionId);

    // ── Acceptance learning ────────────────────────────────────────────────────
    // After 7 acceptances of the same vendor+field+value, promote to vendor profile.
    // But first check for L1/L2 conflicts — if the accepted value opposes a global
    // rule, flag it instead of silently learning a potentially wrong value.
    const VENDOR_LEARNABLE_FIELDS = new Set([
      "vendor_gstin", "tds_section", "tds_rate", "reverse_charge",
      "place_of_supply", "cgst_rate", "sgst_rate", "igst_rate", "suggested_ledger",
    ]);

    let acceptanceWarning: string | null = null;

    if (VENDOR_LEARNABLE_FIELDS.has(extraction.field_name) && extraction.extracted_value) {
      // Get vendor name for this document
      const { data: vendorExt } = await supabase
        .from("extractions").select("extracted_value")
        .eq("document_id", documentId).eq("field_name", "vendor_name")
        .eq("tenant_id", profile?.tenant_id).maybeSingle();
      const vendorName = vendorExt?.extracted_value;

      if (vendorName) {
        // Find all documents for this vendor
        const { data: vendorDocExts } = await supabase
          .from("extractions").select("document_id")
          .eq("tenant_id", profile?.tenant_id).eq("field_name", "vendor_name")
          .ilike("extracted_value", `%${vendorName.split(" ").slice(0, 2).join("%")}%`);
        const vendorDocIds = [...new Set((vendorDocExts ?? []).map((e: { document_id: string }) => e.document_id))];

        if (vendorDocIds.length > 0) {
          const { count: priorAcceptCount } = await supabase
            .from("extractions").select("*", { count: "exact", head: true })
            .eq("tenant_id", profile?.tenant_id).eq("field_name", extraction.field_name)
            .eq("extracted_value", extraction.extracted_value).eq("status", "accepted")
            .in("document_id", vendorDocIds);

          // +1 for current acceptance — threshold is 7
          if ((priorAcceptCount ?? 0) + 1 >= 7) {
            // Check L1 / L2 conflict before promoting
            const { data: globalRules } = await supabase
              .from("global_rules").select("layer, rule_type, rule_json")
              .in("layer", [1, 2]).eq("is_active", true);

            let conflictLayer: number | null = null;
            for (const rule of globalRules ?? []) {
              const rj = rule.rule_json as Record<string, unknown>;
              // L2 correction pattern for same field on this doc fingerprint with different value
              if (rule.rule_type === "correction_pattern" &&
                  rj.field_name === extraction.field_name &&
                  rj.correct_value !== extraction.extracted_value &&
                  rj.doc_fingerprint === doc?.doc_fingerprint) {
                conflictLayer = 2; break;
              }
              // L1 TDS rule specifying a different section for this field
              if (rule.rule_type === "tds_section" && extraction.field_name === "tds_section") {
                const ruleSection = rj.section as string | undefined;
                if (ruleSection && ruleSection !== extraction.extracted_value) {
                  conflictLayer = 1; break;
                }
              }
            }

            if (conflictLayer !== null) {
              // Red-flag: log conflict, do NOT promote to vendor profile
              await supabase.from("audit_log").insert({
                tenant_id: profile?.tenant_id, user_id: user.id,
                action: "acceptance_conflicts_global_rule",
                entity_type: "extraction", entity_id: extractionId,
                new_value: {
                  vendor: vendorName, field: extraction.field_name,
                  accepted_value: extraction.extracted_value,
                  conflict_layer: conflictLayer,
                  note: `7 acceptances reached but conflicts with Layer ${conflictLayer} knowledge`,
                },
              });
              acceptanceWarning = `Accepted value conflicts with a Layer ${conflictLayer} global rule — flagged for admin review. Vendor profile not updated.`;
            } else {
              // No conflict — promote accepted value to vendor profile
              const { data: existingProfile } = await supabase
                .from("vendor_profiles").select("id, invoice_quirks, tds_category")
                .eq("tenant_id", profile?.tenant_id).ilike("vendor_name", vendorName).maybeSingle();
              const quirks = { ...(existingProfile?.invoice_quirks as Record<string, string> ?? {}), [extraction.field_name]: extraction.extracted_value };
              if (existingProfile) {
                await supabase.from("vendor_profiles").update({
                  invoice_quirks: quirks,
                  tds_category: extraction.field_name === "tds_section" ? extraction.extracted_value : existingProfile.tds_category,
                  last_updated: new Date().toISOString(),
                }).eq("id", existingProfile.id);
              } else {
                await supabase.from("vendor_profiles").insert({
                  tenant_id: profile?.tenant_id, vendor_name: vendorName,
                  tds_category: extraction.field_name === "tds_section" ? extraction.extracted_value : null,
                  invoice_quirks: quirks, last_updated: new Date().toISOString(),
                });
              }
            }
          }
        }
      }
    }

    await supabase.from("audit_log").insert({
      tenant_id: profile?.tenant_id, user_id: user.id,
      action: "accept_extraction", entity_type: "extraction", entity_id: extractionId,
    });

    return NextResponse.json({ success: true, action: "accepted", ...(acceptanceWarning ? { warning: acceptanceWarning } : {}) });
  }

  if (action === "correct") {
    if (!correctValue && correctValue !== "") {
      return NextResponse.json({ error: "correctValue is required when action is correct" }, { status: 400 });
    }

    // Update extraction with corrected value
    await supabase
      .from("extractions")
      .update({ status: "corrected", extracted_value: correctValue })
      .eq("id", extractionId);

    // Record the correction — this is immutable, never deleted
    const { data: correctionRecord } = await supabase
      .from("corrections")
      .insert({
        extraction_id: extractionId,
        tenant_id: profile?.tenant_id,
        wrong_value: extraction.extracted_value,
        correct_value: correctValue,
        corrected_by: user.id,
        doc_fingerprint: doc?.doc_fingerprint,
        original_confidence: extraction.confidence,
      })
      .select("id")
      .single();

    // Audit log
    await supabase.from("audit_log").insert({
      tenant_id: profile?.tenant_id,
      user_id: user.id,
      action: "correct_extraction",
      entity_type: "extraction",
      entity_id: extractionId,
      old_value: { value: extraction.extracted_value, confidence: extraction.confidence },
      new_value: { value: correctValue, field: extraction.field_name },
    });

    // Update vendor profile with this correction so future invoices benefit immediately
    // Only fields that are vendor-specific and stable are worth learning
    const VENDOR_LEARNABLE_FIELDS = new Set([
      "vendor_gstin", "tds_section", "tds_rate", "reverse_charge",
      "place_of_supply", "cgst_rate", "sgst_rate", "igst_rate",
    ]);

    if (VENDOR_LEARNABLE_FIELDS.has(extraction.field_name) && correctValue) {
      // Get vendor_name from extractions for this document
      const { data: vendorExt } = await supabase
        .from("extractions")
        .select("extracted_value")
        .eq("document_id", documentId)
        .eq("field_name", "vendor_name")
        .eq("tenant_id", profile?.tenant_id)
        .maybeSingle();

      const vendorName = vendorExt?.extracted_value;

      if (vendorName) {
        // Get vendor GSTIN if already extracted
        const { data: gstinExt } = await supabase
          .from("extractions")
          .select("extracted_value")
          .eq("document_id", documentId)
          .eq("field_name", "vendor_gstin")
          .eq("tenant_id", profile?.tenant_id)
          .maybeSingle();

        // Upsert vendor profile — update invoice_quirks with the corrected field
        const { data: existingProfile } = await supabase
          .from("vendor_profiles")
          .select("id, invoice_quirks, tds_category")
          .eq("tenant_id", profile?.tenant_id)
          .ilike("vendor_name", vendorName)
          .maybeSingle();

        if (existingProfile) {
          const updatedQuirks = {
            ...(existingProfile.invoice_quirks as Record<string, string> ?? {}),
            [extraction.field_name]: correctValue,
          };
          await supabase
            .from("vendor_profiles")
            .update({
              invoice_quirks: updatedQuirks,
              tds_category: extraction.field_name === "tds_section" ? correctValue : existingProfile.tds_category,
              gstin: gstinExt?.extracted_value || undefined,
              last_updated: new Date().toISOString(),
            })
            .eq("id", existingProfile.id);
        } else {
          await supabase
            .from("vendor_profiles")
            .insert({
              tenant_id: profile?.tenant_id,
              vendor_name: vendorName,
              gstin: gstinExt?.extracted_value || null,
              tds_category: extraction.field_name === "tds_section" ? correctValue : null,
              invoice_quirks: { [extraction.field_name]: correctValue },
              last_updated: new Date().toISOString(),
            });
        }
      }
    }

    return NextResponse.json({ success: true, action: "corrected" });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    log.error("correction_failed", { error: String(err) });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
