import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — fetch document with all extractions for review
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
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
    .select("id, file_name, type, status, file_s3_key, doc_fingerprint")
    .eq("id", documentId)
    .eq("tenant_id", profile?.tenant_id)
    .single();

  if (docError || !doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const { data: extractions } = await supabase
    .from("extractions")
    .select("id, field_name, extracted_value, confidence, status")
    .eq("document_id", documentId)
    .order("field_name");

  // Generate signed URL for the original document (15-minute expiry)
  const { data: signedUrl } = await supabase.storage
    .from("documents")
    .createSignedUrl(doc.file_s3_key, 900);

  return NextResponse.json({
    document: { ...doc, signedUrl: signedUrl?.signedUrl },
    extractions: extractions ?? [],
  });
}
