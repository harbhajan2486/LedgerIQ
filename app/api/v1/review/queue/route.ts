import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users")
      .select("tenant_id")
      .eq("id", user.id)
      .single();

    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { data: documents, error } = await supabase
      .from("documents")
      .select(`
        id, original_filename, document_type, status, uploaded_at,
        extractions(id, field_name, extracted_value, confidence, status)
      `)
      .eq("tenant_id", profile.tenant_id)
      .eq("status", "review_required")
      .order("uploaded_at", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Compute per-document summary
    const queue = (documents ?? []).map((doc) => {
      const extractions = (doc.extractions ?? []) as Array<{
        id: string; field_name: string; extracted_value: string;
        confidence: number; status: string;
      }>;
      const lowConfidence = extractions.filter((e) => e.confidence < 0.7).length;
      const avgConfidence = extractions.length > 0
        ? extractions.reduce((s, e) => s + e.confidence, 0) / extractions.length
        : 0;

      return {
        id: doc.id,
        fileName: doc.original_filename,
        type: doc.document_type,
        uploadedAt: doc.uploaded_at,
        totalFields: extractions.length,
        lowConfidenceFields: lowConfidence,
        avgConfidence: Math.round(avgConfidence * 100),
      };
    });

    return NextResponse.json({ queue });
  } catch (err) {
    console.error("[review/queue] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
