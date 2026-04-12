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

  // Misclassification check: vendor GSTIN = client's own GSTIN → purchase invoice is in wrong folder
  // Only GSTIN equality is a reliable signal. Name-based heuristics produce false positives.
  let possibleMisclassification = false;
  if (doc.client_id && doc.document_type === "purchase_invoice") {
    const { data: clientRecord } = await supabase
      .from("clients").select("gstin").eq("id", doc.client_id).single();
    const vendorGstin = (extractions.find(e => e.field_name === "vendor_gstin")?.extracted_value ?? "").trim().toUpperCase();
    const clientGstin = (clientRecord?.gstin ?? "").trim().toUpperCase();
    if (vendorGstin && clientGstin) {
      possibleMisclassification = vendorGstin === clientGstin;
    }
  }

  // Duplicate invoice detection: same invoice_number + vendor_name in another document for same client
  let possibleDuplicate = false;
  let duplicateDocId: string | null = null;
  if (doc.client_id) {
    const invoiceNumber = extractions.find(e => e.field_name === "invoice_number")?.extracted_value;
    const vendorNameRaw = extractions.find(e => e.field_name === "vendor_name")?.extracted_value;
    if (invoiceNumber && vendorNameRaw) {
      // Find other documents for same client with same invoice number
      const { data: otherDocs } = await supabase
        .from("documents")
        .select("id")
        .eq("client_id", doc.client_id)
        .neq("id", documentId)
        .in("status", ["review_required", "reviewed", "reconciled", "posted"]);
      const otherDocIds = (otherDocs ?? []).map((d: { id: string }) => d.id);
      if (otherDocIds.length > 0) {
        const { data: dupCheck } = await supabase
          .from("extractions")
          .select("document_id")
          .in("document_id", otherDocIds)
          .eq("field_name", "invoice_number")
          .eq("extracted_value", invoiceNumber)
          .not("status", "eq", "rejected")
          .limit(1)
          .maybeSingle();
        if (dupCheck) {
          // Verify vendor also matches
          const { data: vendorCheck } = await supabase
            .from("extractions")
            .select("document_id")
            .eq("document_id", dupCheck.document_id)
            .eq("field_name", "vendor_name")
            .ilike("extracted_value", `%${vendorNameRaw.split(" ")[0]}%`)
            .not("status", "eq", "rejected")
            .maybeSingle();
          if (vendorCheck) {
            possibleDuplicate = true;
            duplicateDocId = dupCheck.document_id;
          }
        }
      }
    }
  }

  return NextResponse.json({
    document: { ...doc, signedUrl: signedUrl?.signedUrl },
    extractions,
    possibleMisclassification,
    possibleDuplicate,
    duplicateDocId,
  });
  } catch (err) {
    console.error("[review/document] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
