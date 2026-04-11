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
    .select("id, original_filename, document_type, status, storage_path, doc_fingerprint, processed_at, client_id")
    .eq("id", documentId)
    .eq("tenant_id", profile?.tenant_id)
    .single();

  if (docError || !doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const { data: allExtractions } = await supabase
    .from("extractions")
    .select("id, field_name, extracted_value, confidence, status, created_at")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false }); // newest first

  // Deduplicate: one row per field. Newest pending wins; fall back to newest resolved.
  type ExtractionRow = { id: string; field_name: string; extracted_value: string | null; confidence: number; status: string; created_at: string };
  const pendingByField = new Map<string, ExtractionRow>();
  const resolvedByField = new Map<string, ExtractionRow>();

  for (const row of (allExtractions ?? []) as ExtractionRow[]) {
    if (row.status === "pending" && !pendingByField.has(row.field_name)) {
      pendingByField.set(row.field_name, row);
    } else if (row.status !== "pending" && !resolvedByField.has(row.field_name)) {
      resolvedByField.set(row.field_name, row);
    }
  }

  const allFields = new Set([...pendingByField.keys(), ...resolvedByField.keys()]);
  const extractions = [...allFields].map(f => pendingByField.get(f) ?? resolvedByField.get(f)!);

  // Generate signed URL for the original document (15-minute expiry)
  const { data: signedUrl } = await supabase.storage
    .from("documents")
    .createSignedUrl(doc.storage_path, 900);

  // Misclassification check: if vendor_name ≈ client's own name on a purchase invoice
  let possibleMisclassification = false;
  if (doc.client_id && doc.document_type === "purchase_invoice") {
    const { data: clientRecord } = await supabase
      .from("clients").select("client_name").eq("id", doc.client_id).single();
    const vendorName = (extractions.find(e => e.field_name === "vendor_name")?.extracted_value ?? "").toLowerCase();
    const clientName = (clientRecord?.client_name ?? "").toLowerCase();
    if (vendorName && clientName) {
      const clientWords = clientName.split(/\s+/).filter((w: string) => w.length > 3);
      possibleMisclassification = clientWords.some((word: string) => vendorName.includes(word));
    }
  }

  return NextResponse.json({
    document: { ...doc, signedUrl: signedUrl?.signedUrl },
    extractions,
    possibleMisclassification,
  });
  } catch (err) {
    console.error("[review/document] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
