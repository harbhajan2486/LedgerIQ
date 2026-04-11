import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — fetch document with all extractions for review
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { documentId } = await params;

  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .single();

  // RLS ensures tenant isolation
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("id, original_filename, document_type, status, storage_path, doc_fingerprint, processed_at")
    .eq("id", documentId)
    .eq("tenant_id", profile?.tenant_id)
    .single();

  if (docError || !doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const { data: allExtractions } = await supabase
    .from("extractions")
    .select("id, field_name, extracted_value, confidence, status, created_at")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false }); // newest first

  // Deduplicate: one row per field. Priority: pending (human hasn't reviewed yet)
  // over accepted/corrected, and within same status pick newest row.
  const seen = new Set<string>();
  const pendingByField = new Map<string, typeof allExtractions extends null ? never : (typeof allExtractions)[0]>();
  const resolvedByField = new Map<string, typeof allExtractions extends null ? never : (typeof allExtractions)[0]>();

  for (const row of allExtractions ?? []) {
    if (row.status === "pending" && !pendingByField.has(row.field_name)) {
      pendingByField.set(row.field_name, row);
    } else if (row.status !== "pending" && !resolvedByField.has(row.field_name)) {
      resolvedByField.set(row.field_name, row);
    }
  }

  // Prefer pending over resolved (pending = fresh extraction, needs review)
  const extractions = [...new Set([...pendingByField.keys(), ...resolvedByField.keys()])]
    .map(field => pendingByField.get(field) ?? resolvedByField.get(field)!);

  // Generate signed URL for the original document (15-minute expiry)
  const { data: signedUrl } = await supabase.storage
    .from("documents")
    .createSignedUrl(doc.storage_path, 900);

  return NextResponse.json({
    document: { ...doc, signedUrl: signedUrl?.signedUrl },
    extractions,
  });
  } catch (err) {
    console.error("[review/document] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
