import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const tenantId = profile.tenant_id;
  const url = new URL(request.url);
  const fromDate  = url.searchParams.get("from");
  const toDate    = url.searchParams.get("to");
  const clientId  = url.searchParams.get("clientId");

  // Get reviewed and reconciled documents ready for Tally posting
  let docQuery = supabase
    .from("documents")
    .select("id, original_filename, document_type, uploaded_at, status, client_id, clients(client_name)")
    .eq("tenant_id", tenantId)
    .in("status", ["reviewed", "reconciled"])
    .order("uploaded_at", { ascending: false })
    .limit(500);
  if (fromDate)  docQuery = docQuery.gte("uploaded_at", fromDate);
  if (toDate)    docQuery = docQuery.lte("uploaded_at", toDate + "T23:59:59");
  if (clientId)  docQuery = docQuery.eq("client_id", clientId);
  const { data: docs } = await docQuery;

  if (!docs || docs.length === 0) return NextResponse.json({ documents: [] });

  const docIds = docs.map((d) => d.id);

  // Get key fields for each doc — include corrected extractions (corrected wins over accepted)
  const { data: extractions } = await supabase
    .from("extractions")
    .select("document_id, field_name, extracted_value, status")
    .in("document_id", docIds)
    .in("field_name", ["vendor_name", "total_amount", "invoice_number", "invoice_date"])
    .in("status", ["accepted", "corrected"])
    .order("status", { ascending: true }); // corrected overwrites accepted

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

  type DocRow = typeof docs extends (infer T)[] | null ? T : never;
  const documents = (docs ?? []).map((doc: DocRow) => {
    const client = Array.isArray((doc as { clients: unknown }).clients)
      ? ((doc as { clients: { client_name: string }[] }).clients[0]?.client_name ?? null)
      : ((doc as { clients: { client_name: string } | null }).clients?.client_name ?? null);
    return {
      id: doc.id,
      original_filename: doc.original_filename,
      document_type: doc.document_type,
      uploaded_at: doc.uploaded_at,
      status: doc.status,
      client_id: doc.client_id,
      client_name: client,
      vendor_name:    fieldMap[doc.id]?.vendor_name    ?? null,
      total_amount:   fieldMap[doc.id]?.total_amount   ?? null,
      invoice_number: fieldMap[doc.id]?.invoice_number ?? null,
      invoice_date:   fieldMap[doc.id]?.invoice_date   ?? null,
      posting: postingMap[doc.id] ?? null,
    };
  });

  // Unique clients in the result for filter dropdown
  const clientsInQueue = [...new Map(
    documents.filter(d => d.client_id && d.client_name)
      .map(d => [d.client_id, { id: d.client_id, name: d.client_name }])
  ).values()];

  return NextResponse.json({
    documents,
    tally_endpoint: tenant?.tally_endpoint ?? null,
    clients_in_queue: clientsInQueue,
  });
  } catch (err) {
    console.error("[tally/queue] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
