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
    .select("doc_fingerprint, type")
    .eq("id", documentId)
    .single();

  if (action === "accept") {
    // Mark field as accepted
    await supabase
      .from("extractions")
      .update({ status: "accepted" })
      .eq("id", extractionId);

    // Audit log
    await supabase.from("audit_log").insert({
      tenant_id: profile?.tenant_id,
      user_id: user.id,
      action: "accept_extraction",
      entity_type: "extraction",
      entity_id: extractionId,
    });

    return NextResponse.json({ success: true, action: "accepted" });
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

    // Trigger async: check if vendor profile should be updated + generate embedding
    // Fire and forget — don't block the reviewer
    if (correctionRecord?.id) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (serviceKey) {
        fetch(`${supabaseUrl}/functions/v1/process-correction`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            correctionId: correctionRecord.id,
            extractionId,
            tenantId: profile?.tenant_id,
            documentId,
            fieldName: extraction.field_name,
            wrongValue: extraction.extracted_value,
            correctValue,
            docFingerprint: doc?.doc_fingerprint,
          }),
        }).catch((err) => console.error("[correct] Failed to trigger process-correction:", err));
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
