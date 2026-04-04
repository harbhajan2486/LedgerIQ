// Supabase Edge Function: process-correction
// Triggered after every human correction in the review queue.
// This is the core of the learning engine:
//   1. Generate a vector embedding for the correction
//   2. Store it in correction_vectors for future few-shot injection
//   3. Check if vendor profile should be updated (3+ corrections for same vendor+field)
//   4. Check if Layer 2 promotion threshold is met (10+ tenants with same pattern)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  try {
    const {
      correctionId,
      extractionId,
      tenantId,
      documentId,
      fieldName,
      wrongValue,
      correctValue,
      docFingerprint,
    } = await req.json();

    if (!correctionId || !tenantId) {
      return new Response(JSON.stringify({ error: "correctionId and tenantId are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ----------------------------------------------------------------
    // STEP 1 — Generate embedding for this correction
    // We embed the document fingerprint + field name + correct value
    // This captures the structural pattern, not the financial value
    // ----------------------------------------------------------------
    const textToEmbed = [
      `fingerprint:${docFingerprint ?? "unknown"}`,
      `field:${fieldName}`,
      `correct:${correctValue}`,
    ].join(" | ");

    // Use Supabase's built-in AI for embeddings (Transformers.js, 384 dimensions, free)
    const embeddingRes = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-embedding`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ text: textToEmbed }),
      }
    );

    let embedding: number[] | null = null;
    if (embeddingRes.ok) {
      const embData = await embeddingRes.json();
      embedding = embData.embedding ?? null;
    }

    // Store the correction vector
    if (embedding) {
      await supabase.from("correction_vectors").insert({
        tenant_id: tenantId,
        doc_fingerprint: docFingerprint,
        correction_embedding: JSON.stringify(embedding),
        correction_record_id: correctionId,
      });
    }

    // ----------------------------------------------------------------
    // STEP 2 — Check if vendor profile needs updating
    // If 3+ corrections for the same vendor + field name → update profile
    // ----------------------------------------------------------------
    if (docFingerprint) {
      const { data: similarCorrections } = await supabase
        .from("corrections")
        .select("correct_value, extraction_id")
        .eq("tenant_id", tenantId)
        .eq("doc_fingerprint", docFingerprint)
        .filter("extraction_id", "in",
          // Get all extraction IDs for this field name in this tenant
          `(SELECT id FROM extractions WHERE tenant_id = '${tenantId}' AND field_name = '${fieldName}')`
        );

      const correctionCount = (similarCorrections ?? []).length;

      if (correctionCount >= 3) {
        // Find the vendor name from the document's extractions
        const { data: vendorExtraction } = await supabase
          .from("extractions")
          .select("extracted_value")
          .eq("document_id", documentId)
          .eq("field_name", "vendor_name")
          .single();

        const vendorName = vendorExtraction?.extracted_value;

        if (vendorName) {
          // Most common correct value for this field from this vendor
          const valueCounts: Record<string, number> = {};
          for (const c of similarCorrections ?? []) {
            valueCounts[c.correct_value] = (valueCounts[c.correct_value] ?? 0) + 1;
          }
          const dominantValue = Object.entries(valueCounts)
            .sort(([, a], [, b]) => b - a)[0]?.[0];

          if (dominantValue) {
            // Upsert vendor profile with the learned quirk
            const { data: existing } = await supabase
              .from("vendor_profiles")
              .select("id, invoice_quirks")
              .eq("tenant_id", tenantId)
              .eq("vendor_name", vendorName)
              .single();

            const quirks = (existing?.invoice_quirks ?? {}) as Record<string, string>;
            quirks[fieldName] = dominantValue;

            if (existing) {
              await supabase
                .from("vendor_profiles")
                .update({ invoice_quirks: quirks, last_updated: new Date().toISOString() })
                .eq("id", existing.id);
            } else {
              await supabase.from("vendor_profiles").insert({
                tenant_id: tenantId,
                vendor_name: vendorName,
                invoice_quirks: quirks,
              });
            }
          }
        }
      }
    }

    // ----------------------------------------------------------------
    // STEP 3 — Check Layer 2 promotion threshold
    // If 10+ independent tenants made the same correction for the same
    // doc fingerprint + field → add to super-admin's promotion queue
    // ----------------------------------------------------------------
    if (docFingerprint) {
      const { data: crossTenantCorrections } = await supabase
        .from("corrections")
        .select("tenant_id")
        .eq("doc_fingerprint", docFingerprint)
        .filter("extraction_id", "in",
          `(SELECT id FROM extractions WHERE field_name = '${fieldName}')`
        )
        .eq("correct_value", correctValue);

      const uniqueTenants = new Set(
        (crossTenantCorrections ?? []).map((c) => c.tenant_id)
      );

      if (uniqueTenants.size >= 10) {
        // Check if this pattern is already in the promotion queue
        const { data: existing } = await supabase
          .from("global_rules")
          .select("id, tenant_count")
          .eq("layer", 2)
          .eq("rule_type", "correction_pattern")
          .filter("rule_json->>doc_fingerprint", "eq", docFingerprint)
          .filter("rule_json->>field_name", "eq", fieldName)
          .single();

        if (existing) {
          // Update tenant count
          await supabase
            .from("global_rules")
            .update({ tenant_count: uniqueTenants.size })
            .eq("id", existing.id);
        } else {
          // Add to Layer 2 promotion queue (inactive until super-admin approves)
          await supabase.from("global_rules").insert({
            layer: 2,
            rule_type: "correction_pattern",
            rule_json: {
              doc_fingerprint: docFingerprint,
              field_name: fieldName,
              correct_value: correctValue,
              tenant_count: uniqueTenants.size,
            },
            tenant_count: uniqueTenants.size,
            active: false, // super-admin must review and activate
          });
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, embeddingGenerated: !!embedding }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[process-correction] error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
