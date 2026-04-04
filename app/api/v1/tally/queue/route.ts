import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const tenantId = profile.tenant_id;

  // Get reviewed and reconciled documents ready for Tally posting
  const { data: docs } = await supabase
    .from("documents")
    .select("id, original_filename, document_type, created_at, status")
    .eq("tenant_id", tenantId)
    .in("status", ["reviewed", "reconciled"])
    .order("created_at", { ascending: false })
    .limit(100);

  if (!docs || docs.length === 0) return NextResponse.json({ documents: [] });

  const docIds = docs.map((d) => d.id);

  // Get key fields for each doc
  const { data: extractions } = await supabase
    .from("extractions")
    .select("document_id, field_name, extracted_value")
    .in("document_id", docIds)
    .in("field_name", ["vendor_name", "total_amount", "invoice_number", "invoice_date"])
    .eq("status", "accepted");

  const fieldMap: Record<string, Record<string, string>> = {};
  for (const ext of extractions ?? []) {
    if (!fieldMap[ext.document_id]) fieldMap[ext.document_id] = {};
    fieldMap[ext.document_id][ext.field_name] = ext.extracted_value ?? "";
  }

  // Get posting history
  const { data: postings } = await supabase
    .from("tally_postings")
    .select("document_id, status, posted_at")
    .in("document_id", docIds);

  const postingMap: Record<string, { status: string; posted_at: string | null }> = {};
  for (const p of postings ?? []) postingMap[p.document_id] = p;

  // Get Tally connection status
  const { data: tenant } = await supabase
    .from("tenants")
    .select("tally_endpoint")
    .eq("id", tenantId)
    .single();

  const documents = docs.map((doc) => ({
    id: doc.id,
    original_filename: doc.original_filename,
    document_type: doc.document_type,
    status: doc.status,
    vendor_name: fieldMap[doc.id]?.vendor_name ?? null,
    total_amount: fieldMap[doc.id]?.total_amount ?? null,
    invoice_number: fieldMap[doc.id]?.invoice_number ?? null,
    invoice_date: fieldMap[doc.id]?.invoice_date ?? null,
    posting: postingMap[doc.id] ?? null,
  }));

  return NextResponse.json({
    documents,
    tally_endpoint: tenant?.tally_endpoint ?? null,
  });
}
