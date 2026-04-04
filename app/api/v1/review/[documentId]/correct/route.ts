import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// POST — record a correction or acceptance for a single field
// This is the core of the learning engine — every correction is persisted immediately
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { documentId } = await params;
  const { extractionId, action, correctValue } = await request.json();
  // action: "accept" | "correct"
  // correctValue: required when action === "correct"

  if (!extractionId || !action) {
    return NextResponse.json({ error: "extractionId and action are required" }, { status: 400 });
  }

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
}
